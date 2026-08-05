import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppDatabase } from '@/main/database';
import { LocalRpcServer } from '@/main/local-rpc-server';
import type { RuntimeSupervisor } from '@/main/runtime-supervisor';
import { SessionService } from '@/main/session-service';
import type { TaskService } from '@/main/task-service';
import {
  type LocalRpcSignedRequest,
  localRpcParamsDigest,
  localRpcSigningPayload,
} from '@/shared/automation-protocol';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

const setup = async (now = Date.now(), temporaryRoot = tmpdir()) => {
  const directory = await mkdtemp(join(temporaryRoot, 'adrouter-rpc-'));
  directories.push(directory);
  const database = new AppDatabase(join(directory, 'agent.sqlite'));
  const project = database.createProject({
    path: directory,
    displayName: 'RPC project',
    instructions: '',
    permissionMode: 'workspace-write',
    git: null,
  });
  const thread = database.createThread({
    projectId: project.id,
    title: 'RPC task',
    model: 'deepseek-v4-flash',
    thinkingLevel: 'medium',
  });
  const tasks = {
    start: vi.fn(),
    stop: vi.fn(),
    resolveApproval: vi.fn(),
  } as unknown as TaskService;
  const supervisor = {
    runtimeStatus: { capacity: 2, active: 0, queued: 0, activeThreadIds: [] },
  } as unknown as RuntimeSupervisor;
  const server = new LocalRpcServer({
    database,
    tasks,
    supervisor,
    sessions: new SessionService(database),
    userDataPath: directory,
    appVersion: '0.1.0-beta.12',
    diagnostics: async () => ({ authenticated: true }),
    platform: 'darwin',
    now: () => now,
  });
  return { server, database, project, thread, tasks, now, directory };
};

const keyPair = () => {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicKey: publicKey.export({ format: 'der', type: 'spki' }).toString('base64'),
    privateKey,
  };
};

const pair = async (
  server: LocalRpcServer,
  scopes: Array<'diagnostics:read' | 'tasks:read' | 'tasks:write' | 'approvals:resolve'>
) => {
  const keys = keyPair();
  const response = await server.handleRequest({
    version: 1,
    requestId: '11111111-1111-4111-8111-111111111111',
    method: 'pair.request',
    params: { displayName: 'Test CLI', publicKey: keys.publicKey, scopes },
  });
  expect(response.ok).toBe(true);
  const pairing = (response.result as { pairing: { id: string; comparisonCode: string } }).pairing;
  const approved = server.approvePairing(pairing.id);
  if (!approved.clientId) throw new Error('Expected approved client ID.');
  return { ...keys, pairing, clientId: approved.clientId };
};

const signedRequest = (input: {
  clientId: string;
  privateKey: ReturnType<typeof keyPair>['privateKey'];
  method: LocalRpcSignedRequest['method'];
  params?: Record<string, unknown>;
  nonce?: string;
  timestamp?: string;
  requestId?: string;
}): LocalRpcSignedRequest => {
  const params = input.params ?? {};
  const fields = {
    version: 1 as const,
    requestId: input.requestId ?? '22222222-2222-4222-8222-222222222222',
    clientId: input.clientId,
    method: input.method,
    paramsDigest: localRpcParamsDigest(params),
    nonce: input.nonce ?? 'abcdefghijklmnopqrstuv',
    timestamp: input.timestamp ?? new Date().toISOString(),
  };
  return {
    ...fields,
    params,
    signature: sign(null, Buffer.from(localRpcSigningPayload(fields)), input.privateKey).toString(
      'base64'
    ),
  };
};

describe('authenticated local RPC', () => {
  it('pairs only after GUI approval and executes a correctly scoped signed request', async () => {
    const { server, database, now } = await setup(Date.parse('2026-08-02T00:00:00.000Z'));
    const client = await pair(server, ['diagnostics:read']);
    expect(client.pairing.comparisonCode).toMatch(/^\d{3}-\d{3}$/);
    expect(database.listAutomationClients()).toHaveLength(1);

    const request = signedRequest({
      clientId: client.clientId,
      privateKey: client.privateKey,
      method: 'diagnostics.get',
      timestamp: new Date(now).toISOString(),
    });
    const result = await server.handleRequest(request);
    expect(result).toMatchObject({
      ok: true,
      result: {
        protocolVersion: 1,
        appVersion: '0.1.0-beta.12',
        scheduler: { capacity: 2 },
      },
    });
    expect(database.getAutomationClient(client.clientId)?.lastUsedAt).toBe(
      new Date(now).toISOString()
    );
    database.close();
  });

  it('rejects tampering, nonce replay, skew, missing scopes, and revoked clients', async () => {
    const now = Date.parse('2026-08-02T00:00:00.000Z');
    const { server, database, project } = await setup(now);
    const client = await pair(server, ['diagnostics:read']);
    const valid = signedRequest({
      clientId: client.clientId,
      privateKey: client.privateKey,
      method: 'diagnostics.get',
      timestamp: new Date(now).toISOString(),
    });
    expect((await server.handleRequest(valid)).ok).toBe(true);
    expect(await server.handleRequest(valid)).toMatchObject({
      ok: false,
      error: { code: 'nonce_replay' },
    });

    const changed = signedRequest({
      clientId: client.clientId,
      privateKey: client.privateKey,
      method: 'diagnostics.get',
      nonce: 'differentnonceabcdefghij',
      timestamp: new Date(now).toISOString(),
    });
    changed.params = { changed: true };
    expect(await server.handleRequest(changed)).toMatchObject({
      ok: false,
      error: { code: 'params_changed' },
    });

    expect(
      await server.handleRequest(
        signedRequest({
          clientId: client.clientId,
          privateKey: client.privateKey,
          method: 'diagnostics.get',
          nonce: 'skewednonceabcdefghijkl',
          timestamp: new Date(now - 120_000).toISOString(),
        })
      )
    ).toMatchObject({ ok: false, error: { code: 'request_skew' } });

    expect(
      await server.handleRequest(
        signedRequest({
          clientId: client.clientId,
          privateKey: client.privateKey,
          method: 'tasks.list',
          params: { projectId: project.id },
          nonce: 'scopedeniedabcdefghijkl',
          timestamp: new Date(now).toISOString(),
        })
      )
    ).toMatchObject({ ok: false, error: { code: 'scope_denied' } });

    database.revokeAutomationClient(client.clientId, new Date(now).toISOString());
    expect(
      await server.handleRequest(
        signedRequest({
          clientId: client.clientId,
          privateKey: client.privateKey,
          method: 'diagnostics.get',
          nonce: 'revokednonceabcdefghijkl',
          timestamp: new Date(now).toISOString(),
        })
      )
    ).toMatchObject({ ok: false, error: { code: 'client_revoked' } });
    database.close();
  });

  it('exposes task events through the read scope and preserves bounded methods', async () => {
    const now = Date.parse('2026-08-02T00:00:00.000Z');
    const { server, database, thread } = await setup(now);
    database.appendEvent(thread.id, null, 'diagnostic', { message: 'one' });
    database.appendEvent(thread.id, null, 'diagnostic', { message: 'two' });
    const client = await pair(server, ['tasks:read']);
    const result = await server.handleRequest(
      signedRequest({
        clientId: client.clientId,
        privateKey: client.privateKey,
        method: 'tasks.events',
        params: { threadId: thread.id, afterSequence: 1, limit: 10 },
        timestamp: new Date(now).toISOString(),
      })
    );
    expect(result.ok).toBe(true);
    const events = (result.result as { events: Array<{ sequence: number }> }).events;
    expect(events.map((event) => event.sequence)).toEqual([2, 3]);
    database.close();
  });

  it('returns client-bound bounded export handles instead of filesystem paths', async () => {
    const now = Date.parse('2026-08-02T00:00:00.000Z');
    const { server, database, thread } = await setup(now);
    database.appendEvent(thread.id, null, 'message.user', { text: 'portable context' });
    const owner = await pair(server, ['tasks:read']);
    const other = await pair(server, ['tasks:read']);
    const exported = await server.handleRequest(
      signedRequest({
        clientId: owner.clientId,
        privateKey: owner.privateKey,
        method: 'tasks.export',
        params: { threadId: thread.id, format: 'json' },
        nonce: 'exportnonceabcdefghijkl',
        timestamp: new Date(now).toISOString(),
      })
    );
    const handleId = (exported.result as { handleId: string }).handleId;
    expect(exported.result).not.toHaveProperty('path');
    expect(
      await server.handleRequest(
        signedRequest({
          clientId: other.clientId,
          privateKey: other.privateKey,
          method: 'exports.read',
          params: { handleId, offset: 0, maxBytes: 64 },
          nonce: 'otherreadnonceabcdefghi',
          timestamp: new Date(now).toISOString(),
        })
      )
    ).toMatchObject({ ok: false, error: { code: 'export_unavailable' } });
    database.close();
  });

  it('creates a mode-0600 Unix socket inside a mode-0700 directory', async () => {
    const { server, database } = await setup(Date.now());
    await server.start();
    const endpointMode = (await stat(server.endpoint)).mode & 0o777;
    const directoryMode = (await stat(dirname(server.endpoint))).mode & 0o777;
    expect(endpointMode).toBe(0o600);
    expect(directoryMode).toBe(0o700);
    expect(Buffer.byteLength(server.endpoint)).toBeLessThan(104);

    const rawResponse = await new Promise<string>((resolveResponse, rejectResponse) => {
      const socket = connect(server.endpoint);
      socket.once('error', rejectResponse);
      socket.once('data', (chunk) => {
        resolveResponse(chunk.toString('utf8'));
        socket.end();
      });
      socket.once('connect', () => socket.write('{"bad":true}\n'));
    });
    expect(JSON.parse(rawResponse)).toMatchObject({
      ok: false,
      error: { code: 'invalid_request' },
    });
    await server.close();
    database.close();
  });
});
