import {
  createPublicKey,
  type KeyObject,
  timingSafeEqual,
  verify as verifySignature,
} from 'node:crypto';
import { chmod, lstat, mkdir, rmdir, unlink } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import {
  canonicalizeLocalRpc,
  LocalRpcPairRequestSchema,
  LocalRpcPairStatusRequestSchema,
  type LocalRpcRequest,
  LocalRpcRequestSchema,
  type LocalRpcResponse,
  LocalRpcResponseSchema,
  LocalRpcSignedRequestSchema,
  localRpcMethodScope,
  localRpcParamsDigest,
  localRpcSigningPayload,
} from '../shared/automation-protocol';
import { LOCAL_RPC_PROTOCOL_VERSION, MAX_LOCAL_RPC_FRAME_BYTES } from '../shared/constants';
import {
  ApprovalResolveInputSchema,
  type AutomationPairing,
  AutomationPairingSchema,
  IdSchema,
  ThreadIdInputSchema,
  ThreadListInputSchema,
  TurnMessageInputSchema,
  TurnStartInputSchema,
  TurnStopInputSchema,
} from '../shared/contracts';
import { createId, safeRecord, sha256 } from '../shared/security';
import type { AppDatabase } from './database';
import type { RuntimeSupervisor } from './runtime-supervisor';
import type { SessionService } from './session-service';
import type { TaskService } from './task-service';

const MAX_CONNECTIONS = 16;
const MAX_PENDING_PAIRINGS = 8;
const PAIRING_LIFETIME_MS = 5 * 60_000;
const REQUEST_SKEW_MS = 60_000;
const NONCE_LIFETIME_MS = 10 * 60_000;
const MAX_NONCES_PER_CLIENT = 1_024;
const MAX_REQUESTS_PER_MINUTE = 60;
const MAX_PAIR_REQUESTS_PER_MINUTE = 20;
const MAX_PAIR_STATUS_REQUESTS_PER_MINUTE = 120;
const PAIRING_RESULT_RETENTION_MS = 60_000;
const EXPORT_HANDLE_LIFETIME_MS = 5 * 60_000;
const MAX_EXPORT_CHUNK_BYTES = 64 * 1024;

interface PendingPairing extends AutomationPairing {
  publicKey: string;
}

class LocalRpcError extends Error {
  public constructor(
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'LocalRpcError';
  }
}

const canonicalBase64 = (value: string): Buffer => {
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length === 0 || bytes.toString('base64') !== value) {
    throw new LocalRpcError('invalid_key', 'The encoded key or signature is invalid.');
  }
  return bytes;
};

const parseEd25519PublicKey = (value: string): { key: KeyObject; fingerprint: string } => {
  const bytes = canonicalBase64(value);
  let key: KeyObject;
  try {
    key = createPublicKey({ key: bytes, format: 'der', type: 'spki' });
  } catch {
    throw new LocalRpcError('invalid_key', 'The pairing key is not valid SPKI data.');
  }
  if (key.asymmetricKeyType !== 'ed25519') {
    throw new LocalRpcError('invalid_key', 'Local automation requires an Ed25519 client key.');
  }
  const canonical = key.export({ format: 'der', type: 'spki' });
  if (!timingSafeEqual(Buffer.from(canonical), bytes)) {
    throw new LocalRpcError('invalid_key', 'The pairing key encoding is not canonical.');
  }
  return { key, fingerprint: sha256(bytes) };
};

const comparisonCode = (pairingId: string, fingerprint: string): string => {
  const value = Number.parseInt(sha256(`${pairingId}:${fingerprint}`).slice(0, 12), 16) % 1_000_000;
  const digits = String(value).padStart(6, '0');
  return `${digits.slice(0, 3)}-${digits.slice(3)}`;
};

const response = (
  requestId: string | null,
  input:
    | { ok: true; result: Record<string, unknown> }
    | { ok: false; code: string; message: string }
): LocalRpcResponse =>
  LocalRpcResponseSchema.parse(
    input.ok
      ? {
          version: LOCAL_RPC_PROTOCOL_VERSION,
          requestId,
          ok: true,
          result: input.result,
        }
      : {
          version: LOCAL_RPC_PROTOCOL_VERSION,
          requestId,
          ok: false,
          error: { code: input.code, message: input.message.slice(0, 500) },
        }
  );

export interface LocalRpcServerOptions {
  database: AppDatabase;
  tasks: TaskService;
  supervisor: RuntimeSupervisor;
  sessions: SessionService;
  userDataPath: string;
  appVersion: string;
  diagnostics: () => Promise<Record<string, unknown>>;
  platform?: NodeJS.Platform;
  now?: () => number;
}

export const localRpcDirectory = (
  userDataPath: string,
  platform: NodeJS.Platform = process.platform
): string | null => {
  if (platform === 'win32') return null;
  if (typeof process.getuid !== 'function') {
    throw new Error('A current-user identifier is required for local Unix automation.');
  }
  return join(
    '/tmp',
    `adrouter-agent-${process.getuid()}-${sha256(resolve(userDataPath)).slice(0, 16)}`
  );
};

export const localRpcEndpoint = (
  userDataPath: string,
  platform: NodeJS.Platform = process.platform
): string => {
  if (platform === 'win32') {
    return `\\\\.\\pipe\\adrouter-agent-${sha256(resolve(userDataPath)).slice(0, 16)}`;
  }
  const directory = localRpcDirectory(userDataPath, platform);
  if (!directory) throw new Error('The Unix automation directory is unavailable.');
  return join(directory, 'rpc-v1.sock');
};

const assertOwnerOnlyDirectory = async (directory: string): Promise<void> => {
  const metadata = await lstat(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error('The local automation endpoint directory is not a real directory.');
  }
  if (typeof process.getuid !== 'function' || metadata.uid !== process.getuid()) {
    throw new Error('The local automation endpoint directory is not owned by the current user.');
  }
  if ((metadata.mode & 0o777) !== 0o700) {
    await chmod(directory, 0o700);
    const secured = await lstat(directory);
    if (
      !secured.isDirectory() ||
      secured.isSymbolicLink() ||
      secured.uid !== process.getuid() ||
      (secured.mode & 0o777) !== 0o700
    ) {
      throw new Error('The local automation endpoint directory could not be secured.');
    }
  }
};

export class LocalRpcServer {
  private server?: Server;
  private readonly connections = new Set<Socket>();
  private readonly pendingPairings = new Map<string, PendingPairing>();
  private readonly nonces = new Map<string, Map<string, number>>();
  private readonly clientRequestTimes = new Map<string, number[]>();
  private readonly exportHandles = new Map<
    string,
    {
      clientId: string;
      content: Buffer;
      format: 'json' | 'html';
      expiresAt: number;
      nextOffset: number;
    }
  >();
  private pairRequestTimes: number[] = [];
  private pairStatusRequestTimes: number[] = [];
  private readonly platform: NodeJS.Platform;
  private readonly now: () => number;

  public readonly endpoint: string;

  public constructor(private readonly options: LocalRpcServerOptions) {
    this.platform = options.platform ?? process.platform;
    this.now = options.now ?? Date.now;
    this.endpoint = localRpcEndpoint(options.userDataPath, this.platform);
  }

  public async start(): Promise<void> {
    if (this.server) return;
    if (this.platform !== 'win32') {
      const directory = localRpcDirectory(this.options.userDataPath, this.platform);
      if (!directory) throw new Error('The Unix automation directory is unavailable.');
      try {
        await mkdir(directory, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      await assertOwnerOnlyDirectory(directory);
      try {
        const metadata = await lstat(this.endpoint);
        if (
          !metadata.isSocket() ||
          typeof process.getuid !== 'function' ||
          metadata.uid !== process.getuid()
        ) {
          throw new Error('The local automation endpoint path is occupied by a non-socket file.');
        }
        await unlink(this.endpoint);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    const server = createServer((socket) => this.accept(socket));
    server.maxConnections = MAX_CONNECTIONS;
    this.server = server;
    await new Promise<void>((resolveListen, rejectListen) => {
      const failed = (error: Error): void => rejectListen(error);
      server.once('error', failed);
      server.listen(this.endpoint, () => {
        server.off('error', failed);
        resolveListen();
      });
    });
    if (this.platform !== 'win32') {
      await chmod(this.endpoint, 0o600);
      const metadata = await lstat(this.endpoint);
      if (
        !metadata.isSocket() ||
        typeof process.getuid !== 'function' ||
        metadata.uid !== process.getuid() ||
        (metadata.mode & 0o777) !== 0o600
      ) {
        throw new Error('The local automation endpoint could not be secured.');
      }
    }
  }

  public async close(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    for (const socket of this.connections) socket.destroy();
    this.connections.clear();
    if (server) {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    }
    if (this.platform !== 'win32') {
      await unlink(this.endpoint).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      });
      const directory = localRpcDirectory(this.options.userDataPath, this.platform);
      if (directory) {
        await rmdir(directory).catch((error: NodeJS.ErrnoException) => {
          if (!['ENOENT', 'ENOTEMPTY'].includes(error.code ?? '')) throw error;
        });
      }
    }
  }

  public listPendingPairings(): AutomationPairing[] {
    this.prunePairings();
    return [...this.pendingPairings.values()]
      .filter((pairing) => pairing.status === 'pending')
      .map(({ publicKey: _publicKey, ...pairing }) => AutomationPairingSchema.parse(pairing));
  }

  public approvePairing(pairingId: string): AutomationPairing {
    this.prunePairings();
    const pairing = this.pendingPairings.get(pairingId);
    if (pairing?.status !== 'pending') {
      throw new Error('Pairing request is unavailable or no longer pending.');
    }
    const existing = this.options.database.getAutomationClientByFingerprint(
      pairing.publicKeyFingerprint
    );
    if (existing) throw new Error('This automation key was already paired.');
    const client = this.options.database.createAutomationClient({
      displayName: pairing.displayName,
      publicKey: pairing.publicKey,
      publicKeyFingerprint: pairing.publicKeyFingerprint,
      scopes: pairing.scopes,
    });
    pairing.status = 'approved';
    pairing.clientId = client.id;
    const { publicKey: _publicKey, ...safePairing } = pairing;
    return AutomationPairingSchema.parse(safePairing);
  }

  public denyPairing(pairingId: string): AutomationPairing {
    this.prunePairings();
    const pairing = this.pendingPairings.get(pairingId);
    if (pairing?.status !== 'pending') {
      throw new Error('Pairing request is unavailable or no longer pending.');
    }
    pairing.status = 'denied';
    const { publicKey: _publicKey, ...safePairing } = pairing;
    return AutomationPairingSchema.parse(safePairing);
  }

  public async handleRequest(raw: unknown): Promise<LocalRpcResponse> {
    const possibleRequestId = IdSchema.safeParse(safeRecord(raw).requestId);
    const requestId = possibleRequestId.success ? possibleRequestId.data : null;
    try {
      const request = LocalRpcRequestSchema.parse(raw);
      const result = await this.dispatch(request);
      return response(request.requestId, { ok: true, result });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return response(requestId, {
          ok: false,
          code: 'invalid_request',
          message: 'The local RPC request did not match protocol version 1.',
        });
      }
      const rpcError =
        error instanceof LocalRpcError
          ? error
          : new LocalRpcError(
              'request_failed',
              error instanceof Error ? error.message : 'The local RPC request failed.'
            );
      return response(requestId, { ok: false, code: rpcError.code, message: rpcError.message });
    }
  }

  private accept(socket: Socket): void {
    this.connections.add(socket);
    socket.once('close', () => this.connections.delete(socket));
    socket.setTimeout(30_000, () => socket.destroy());
    let buffered = Buffer.alloc(0);
    let frames = 0;
    socket.on('data', (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      if (buffered.byteLength > MAX_LOCAL_RPC_FRAME_BYTES) {
        socket.destroy();
        return;
      }
      let newline = buffered.indexOf(0x0a);
      while (newline >= 0) {
        const frame = buffered.subarray(0, newline);
        buffered = buffered.subarray(newline + 1);
        frames += 1;
        if (frames > 64 || frame.byteLength > MAX_LOCAL_RPC_FRAME_BYTES) {
          socket.destroy();
          return;
        }
        if (frame.byteLength > 0) {
          void this.processFrame(socket, frame);
        }
        newline = buffered.indexOf(0x0a);
      }
    });
  }

  private async processFrame(socket: Socket, frame: Buffer): Promise<void> {
    let raw: unknown;
    try {
      raw = JSON.parse(frame.toString('utf8'));
    } catch {
      const encoded = `${JSON.stringify(
        response(null, {
          ok: false,
          code: 'invalid_json',
          message: 'The local RPC frame is not valid JSON.',
        })
      )}\n`;
      socket.write(encoded);
      return;
    }
    let result = await this.handleRequest(raw);
    let encoded = `${JSON.stringify(result)}\n`;
    if (Buffer.byteLength(encoded) > MAX_LOCAL_RPC_FRAME_BYTES) {
      result = response(result.requestId, {
        ok: false,
        code: 'response_too_large',
        message: 'The bounded local RPC response would exceed 1 MiB.',
      });
      encoded = `${JSON.stringify(result)}\n`;
    }
    socket.write(encoded);
  }

  private async dispatch(request: LocalRpcRequest): Promise<Record<string, unknown>> {
    if (request.method === 'pair.request') {
      return { pairing: this.requestPairing(LocalRpcPairRequestSchema.parse(request)) };
    }
    if (request.method === 'pair.status') {
      const parsed = LocalRpcPairStatusRequestSchema.parse(request);
      this.prunePairings();
      this.pairStatusRequestTimes = this.pruneRate(this.pairStatusRequestTimes);
      if (this.pairStatusRequestTimes.length >= MAX_PAIR_STATUS_REQUESTS_PER_MINUTE) {
        throw new LocalRpcError('rate_limited', 'Too many pairing status requests were received.');
      }
      this.pairStatusRequestTimes.push(this.now());
      const pairing = this.pendingPairings.get(parsed.params.pairingId);
      if (!pairing) throw new LocalRpcError('pairing_not_found', 'Pairing request not found.');
      const { publicKey: _publicKey, ...safePairing } = pairing;
      return { pairing: AutomationPairingSchema.parse(safePairing) };
    }
    const signed = LocalRpcSignedRequestSchema.parse(request);
    const client = this.verifySignedRequest(signed);
    const result = await this.dispatchSigned(signed);
    this.options.database.touchAutomationClient(client.id, new Date(this.now()).toISOString());
    return result;
  }

  private requestPairing(request: z.infer<typeof LocalRpcPairRequestSchema>): AutomationPairing {
    this.prunePairings();
    this.pairRequestTimes = this.pruneRate(this.pairRequestTimes);
    if (this.pairRequestTimes.length >= MAX_PAIR_REQUESTS_PER_MINUTE) {
      throw new LocalRpcError('rate_limited', 'Too many pairing requests were received.');
    }
    this.pairRequestTimes.push(this.now());
    if (this.listPendingPairings().length >= MAX_PENDING_PAIRINGS) {
      throw new LocalRpcError('pairing_queue_full', 'Too many pairings await GUI review.');
    }
    const uniqueScopes = [...new Set(request.params.scopes)];
    if (uniqueScopes.length !== request.params.scopes.length) {
      throw new LocalRpcError('invalid_scopes', 'Pairing scopes must be unique.');
    }
    const { fingerprint } = parseEd25519PublicKey(request.params.publicKey);
    if (this.options.database.getAutomationClientByFingerprint(fingerprint)) {
      throw new LocalRpcError('already_paired', 'This automation key was already paired.');
    }
    const id = createId();
    const pairing: PendingPairing = {
      id,
      displayName: request.params.displayName,
      publicKey: request.params.publicKey,
      publicKeyFingerprint: fingerprint,
      comparisonCode: comparisonCode(id, fingerprint),
      scopes: uniqueScopes,
      status: 'pending',
      expiresAt: new Date(this.now() + PAIRING_LIFETIME_MS).toISOString(),
      clientId: null,
    };
    this.pendingPairings.set(id, pairing);
    const { publicKey: _publicKey, ...safePairing } = pairing;
    return AutomationPairingSchema.parse(safePairing);
  }

  private verifySignedRequest(request: z.infer<typeof LocalRpcSignedRequestSchema>) {
    const current = this.now();
    if (Math.abs(Date.parse(request.timestamp) - current) > REQUEST_SKEW_MS) {
      throw new LocalRpcError('request_skew', 'The signed request timestamp is outside the limit.');
    }
    if (localRpcParamsDigest(request.params) !== request.paramsDigest) {
      throw new LocalRpcError('params_changed', 'The signed request parameters changed.');
    }
    const client = this.options.database.getAutomationClient(request.clientId);
    if (!client || client.revokedAt) {
      throw new LocalRpcError('client_revoked', 'The automation client is unknown or revoked.');
    }
    const requiredScope = localRpcMethodScope[request.method];
    if (!client.scopes.includes(requiredScope)) {
      throw new LocalRpcError('scope_denied', `The client lacks ${requiredScope}.`);
    }
    const publicKey = parseEd25519PublicKey(client.publicKey).key;
    const signature = canonicalBase64(request.signature);
    const { params: _params, signature: _signature, ...signedFields } = request;
    if (
      !verifySignature(
        null,
        Buffer.from(localRpcSigningPayload(signedFields)),
        publicKey,
        signature
      )
    ) {
      throw new LocalRpcError('bad_signature', 'The local RPC signature is invalid.');
    }
    const requestTimes = this.pruneRate(this.clientRequestTimes.get(client.id) ?? []);
    if (requestTimes.length >= MAX_REQUESTS_PER_MINUTE) {
      throw new LocalRpcError('rate_limited', 'The automation client exceeded its rate limit.');
    }
    requestTimes.push(current);
    this.clientRequestTimes.set(client.id, requestTimes);
    const nonces = this.nonces.get(client.id) ?? new Map<string, number>();
    for (const [nonce, expiresAt] of nonces) {
      if (expiresAt <= current) nonces.delete(nonce);
    }
    if (nonces.has(request.nonce)) {
      throw new LocalRpcError('nonce_replay', 'The signed request nonce was already used.');
    }
    if (nonces.size >= MAX_NONCES_PER_CLIENT) {
      throw new LocalRpcError('nonce_capacity', 'The client has too many live request nonces.');
    }
    nonces.set(request.nonce, current + NONCE_LIFETIME_MS);
    this.nonces.set(client.id, nonces);
    return client;
  }

  private async dispatchSigned(
    request: z.infer<typeof LocalRpcSignedRequestSchema>
  ): Promise<Record<string, unknown>> {
    if (request.method === 'diagnostics.get') {
      return {
        protocolVersion: LOCAL_RPC_PROTOCOL_VERSION,
        appVersion: this.options.appVersion,
        endpointKind: this.platform === 'win32' ? 'named-pipe' : 'unix-socket',
        scheduler: this.options.supervisor.runtimeStatus,
        router: await this.options.diagnostics(),
      };
    }
    if (request.method === 'projects.list') {
      return { projects: this.options.database.listProjects() };
    }
    if (request.method === 'tasks.start') {
      return { turn: await this.options.tasks.start(TurnStartInputSchema.parse(request.params)) };
    }
    if (request.method === 'tasks.list') {
      const input = ThreadListInputSchema.parse(request.params);
      return { tasks: this.options.database.listThreads(input.projectId) };
    }
    if (request.method === 'tasks.get') {
      const input = ThreadIdInputSchema.parse(request.params);
      const detail = this.options.database.getThreadDetail(input.id);
      if (!detail) throw new LocalRpcError('task_not_found', 'Task not found.');
      return { task: detail };
    }
    if (request.method === 'tasks.events') {
      const input = z
        .object({
          threadId: IdSchema,
          afterSequence: z.number().int().nonnegative().default(0),
          limit: z.number().int().min(1).max(200).default(100),
        })
        .strict()
        .parse(request.params);
      if (!this.options.database.getThread(input.threadId)) {
        throw new LocalRpcError('task_not_found', 'Task not found.');
      }
      return {
        events: this.options.database
          .listEvents(input.threadId)
          .filter((event) => event.sequence > input.afterSequence)
          .slice(0, input.limit),
      };
    }
    if (request.method === 'tasks.steer') {
      const input = TurnMessageInputSchema.parse(request.params);
      this.options.supervisor.steer(input.threadId, input.input);
      return { ok: true };
    }
    if (request.method === 'tasks.queueFollowUp') {
      const input = TurnMessageInputSchema.parse(request.params);
      this.options.supervisor.queueFollowUp(input.threadId, input.input);
      return { ok: true };
    }
    if (request.method === 'tasks.compact') {
      const input = TurnStopInputSchema.parse(request.params);
      return { turn: await this.options.tasks.compact(input.threadId) };
    }
    if (request.method === 'tasks.fork') {
      const input = z
        .object({ checkpointId: IdSchema, title: z.string().trim().min(1).max(240).optional() })
        .strict()
        .parse(request.params);
      return { task: this.options.sessions.fork(input.checkpointId, input.title) };
    }
    if (request.method === 'tasks.export') {
      const input = z
        .object({ threadId: IdSchema, format: z.enum(['json', 'html']).default('json') })
        .strict()
        .parse(request.params);
      const content = Buffer.from(
        input.format === 'html'
          ? this.options.sessions.exportHtml(input.threadId).html
          : `${JSON.stringify(this.options.sessions.export(input.threadId, false), null, 2)}\n`,
        'utf8'
      );
      if (content.byteLength > 10 * 1024 * 1024) {
        throw new LocalRpcError('export_too_large', 'The bounded session export exceeds 10 MiB.');
      }
      const handleId = createId();
      const expiresAt = this.now() + EXPORT_HANDLE_LIFETIME_MS;
      this.exportHandles.set(handleId, {
        clientId: request.clientId,
        content,
        format: input.format,
        expiresAt,
        nextOffset: 0,
      });
      return {
        handleId,
        format: input.format,
        bytes: content.byteLength,
        expiresAt: new Date(expiresAt).toISOString(),
      };
    }
    if (request.method === 'exports.read') {
      const input = z
        .object({
          handleId: IdSchema,
          offset: z.number().int().nonnegative().default(0),
          maxBytes: z
            .number()
            .int()
            .min(1)
            .max(MAX_EXPORT_CHUNK_BYTES)
            .default(MAX_EXPORT_CHUNK_BYTES),
        })
        .strict()
        .parse(request.params);
      const handle = this.exportHandles.get(input.handleId);
      if (!handle || handle.clientId !== request.clientId) {
        throw new LocalRpcError(
          'export_unavailable',
          'The export handle is unavailable or expired.'
        );
      }
      if (handle.expiresAt <= this.now()) {
        this.exportHandles.delete(input.handleId);
        throw new LocalRpcError(
          'export_unavailable',
          'The export handle is unavailable or expired.'
        );
      }
      if (input.offset > handle.content.byteLength) {
        throw new LocalRpcError('invalid_offset', 'The export offset exceeds the content length.');
      }
      if (input.offset !== handle.nextOffset) {
        throw new LocalRpcError('invalid_offset', 'Export chunks must be read in order.');
      }
      const chunk = handle.content.subarray(input.offset, input.offset + input.maxBytes);
      const nextOffset = input.offset + chunk.byteLength;
      const done = nextOffset >= handle.content.byteLength;
      handle.nextOffset = nextOffset;
      if (done) this.exportHandles.delete(input.handleId);
      return { dataBase64: chunk.toString('base64'), nextOffset, done, format: handle.format };
    }
    if (request.method === 'tasks.stop') {
      const input = TurnStopInputSchema.parse(request.params);
      this.options.tasks.stop(input.threadId);
      return { ok: true };
    }
    if (request.method === 'approvals.list') {
      const input = z.object({ threadId: IdSchema }).strict().parse(request.params);
      return {
        approvals: this.options.database
          .listApprovals(input.threadId)
          .filter((approval) => approval.decision === null),
      };
    }
    const input = ApprovalResolveInputSchema.parse(request.params);
    return { approval: this.options.tasks.resolveApproval(input.approvalId, input.decision) };
  }

  private prunePairings(): void {
    const current = this.now();
    for (const [id, pairing] of this.pendingPairings) {
      const expiresAt = Date.parse(pairing.expiresAt);
      if (pairing.status === 'pending' && Date.parse(pairing.expiresAt) <= current) {
        pairing.status = 'expired';
      }
      if (expiresAt + PAIRING_RESULT_RETENTION_MS <= current) this.pendingPairings.delete(id);
    }
  }

  private pruneRate(values: number[]): number[] {
    const threshold = this.now() - 60_000;
    return values.filter((value) => value > threshold);
  }
}

export const canonicalLocalRpcRequest = (value: unknown): string =>
  JSON.stringify(canonicalizeLocalRpc(value));
