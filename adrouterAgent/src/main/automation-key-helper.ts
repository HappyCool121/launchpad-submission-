import { createPrivateKey, generateKeyPairSync, sign } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { safeStorage } from 'electron';
import { z } from 'zod';
import { MAX_LOCAL_RPC_FRAME_BYTES } from '../shared/constants';
import { sha256 } from '../shared/security';
import { assertSecureCredentialStorage } from './credential-storage';
import { localRpcEndpoint } from './local-rpc-server';

const KeyIdSchema = z.string().regex(/^[0-9a-f]{64}$/);
const HelperRequestSchema = z.discriminatedUnion('method', [
  z.object({ method: z.literal('endpoint') }).strict(),
  z.object({ method: z.literal('key.generate') }).strict(),
  z
    .object({
      method: z.literal('key.sign'),
      keyId: KeyIdSchema,
      payload: z
        .string()
        .min(1)
        .max(64 * 1024),
    })
    .strict(),
  z.object({ method: z.literal('key.bind'), keyId: KeyIdSchema, clientId: z.uuid() }).strict(),
  z.object({ method: z.literal('key.delete'), keyId: KeyIdSchema }).strict(),
  z.object({ method: z.literal('key.list') }).strict(),
]);

const KeyRecordSchema = z
  .object({
    version: z.literal(1),
    keyId: KeyIdSchema,
    publicKey: z.string().min(40).max(500),
    encryptedPrivateKey: z.string().min(1).max(4_096),
    clientId: z.uuid().nullable(),
    createdAt: z.iso.datetime(),
  })
  .strict();
type KeyRecord = z.infer<typeof KeyRecordSchema>;

const keyDirectory = (userDataPath: string): string =>
  join(userDataPath, 'automation', 'client-keys');

const keyPath = (userDataPath: string, keyId: string): string =>
  resolve(keyDirectory(userDataPath), `${KeyIdSchema.parse(keyId)}.json`);

const safeRecord = (record: KeyRecord) => ({
  keyId: record.keyId,
  publicKey: record.publicKey,
  clientId: record.clientId,
  createdAt: record.createdAt,
});

const writeRecord = async (userDataPath: string, record: KeyRecord): Promise<void> => {
  const directory = keyDirectory(userDataPath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') await chmod(directory, 0o700);
  const destination = keyPath(userDataPath, record.keyId);
  const temporary = `${destination}.${process.pid}.tmp`;
  const backup = `${destination}.${process.pid}.backup`;
  let backedUp = false;
  let activated = false;
  try {
    await writeFile(temporary, `${JSON.stringify(record)}\n`, { flag: 'wx', mode: 0o600 });
    try {
      await lstat(destination);
      await rename(destination, backup);
      backedUp = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await rename(temporary, destination);
    activated = true;
    if (process.platform !== 'win32') await chmod(destination, 0o600);
    if (backedUp) await rm(backup, { force: true });
  } catch (error) {
    if (activated) await rm(destination, { force: true }).catch(() => undefined);
    if (backedUp) await rename(backup, destination).catch(() => undefined);
    throw error;
  } finally {
    await unlink(temporary).catch(() => undefined);
    await rm(backup, { force: true });
  }
};

const readRecord = async (userDataPath: string, keyId: string): Promise<KeyRecord> =>
  KeyRecordSchema.parse(JSON.parse(await readFile(keyPath(userDataPath, keyId), 'utf8')));

const listRecords = async (userDataPath: string): Promise<KeyRecord[]> => {
  try {
    const names = await readdir(keyDirectory(userDataPath));
    const records = await Promise.all(
      names
        .filter((name) => /^[0-9a-f]{64}\.json$/.test(name))
        .slice(0, 64)
        .map((name) => readRecord(userDataPath, name.slice(0, 64)))
    );
    return records.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
};

export interface AutomationKeyCipher {
  assertSecure(): Promise<void>;
  encrypt(value: string): Promise<string>;
  decrypt(value: string): Promise<string>;
}

const electronKeyCipher: AutomationKeyCipher = {
  assertSecure: () => assertSecureCredentialStorage(),
  encrypt: async (value) => (await safeStorage.encryptStringAsync(value)).toString('base64'),
  decrypt: async (value) =>
    (await safeStorage.decryptStringAsync(Buffer.from(value, 'base64'))).result,
};

export const executeAutomationKeyHelperRequest = async (
  userDataPath: string,
  raw: unknown,
  cipher: AutomationKeyCipher = electronKeyCipher
): Promise<Record<string, unknown>> => {
  const request = HelperRequestSchema.parse(raw);
  if (request.method === 'endpoint') {
    return {
      protocolVersion: 1,
      endpoint: localRpcEndpoint(userDataPath),
      kind: process.platform === 'win32' ? 'named-pipe' : 'unix-socket',
    };
  }
  await cipher.assertSecure();
  if (request.method === 'key.generate') {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    const publicBytes = publicKey.export({ format: 'der', type: 'spki' }) as Buffer;
    const privateBytes = privateKey.export({ format: 'der', type: 'pkcs8' }) as Buffer;
    const keyId = sha256(publicBytes);
    const privateKeyBase64 = privateBytes.toString('base64');
    const encryptedPrivateKey = await cipher.encrypt(privateKeyBase64);
    privateBytes.fill(0);
    const record = KeyRecordSchema.parse({
      version: 1,
      keyId,
      publicKey: Buffer.from(publicBytes).toString('base64'),
      encryptedPrivateKey,
      clientId: null,
      createdAt: new Date().toISOString(),
    });
    await writeRecord(userDataPath, record);
    return safeRecord(record);
  }
  if (request.method === 'key.list') {
    return { keys: (await listRecords(userDataPath)).map(safeRecord) };
  }
  const record = await readRecord(userDataPath, request.keyId);
  if (request.method === 'key.delete') {
    if (record.clientId)
      throw new Error('A paired automation key cannot be deleted by the helper.');
    await unlink(keyPath(userDataPath, record.keyId));
    return { keyId: record.keyId, deleted: true };
  }
  if (request.method === 'key.bind') {
    const updated = KeyRecordSchema.parse({ ...record, clientId: request.clientId });
    await writeRecord(userDataPath, updated);
    return safeRecord(updated);
  }
  const decrypted = await cipher.decrypt(record.encryptedPrivateKey);
  const privateKey = createPrivateKey({
    key: Buffer.from(decrypted, 'base64'),
    format: 'der',
    type: 'pkcs8',
  });
  if (privateKey.asymmetricKeyType !== 'ed25519') {
    throw new Error('The protected automation key has an invalid type.');
  }
  return {
    keyId: record.keyId,
    signature: sign(null, Buffer.from(request.payload), privateKey).toString('base64'),
  };
};

const readRequest = async (): Promise<unknown> => {
  let bytes = Buffer.alloc(0);
  for await (const chunk of process.stdin) {
    bytes = Buffer.concat([bytes, Buffer.from(chunk)]);
    if (bytes.byteLength > MAX_LOCAL_RPC_FRAME_BYTES) {
      throw new Error('The automation key-helper request is too large.');
    }
    const newline = bytes.indexOf(0x0a);
    if (newline >= 0) {
      return JSON.parse(bytes.subarray(0, newline).toString('utf8'));
    }
  }
  if (bytes.byteLength === 0) throw new Error('The automation key-helper request is empty.');
  return JSON.parse(bytes.toString('utf8'));
};

export const runAutomationKeyHelper = async (userDataPath: string): Promise<void> => {
  try {
    const result = await executeAutomationKeyHelperRequest(userDataPath, await readRequest());
    await new Promise<void>((resolveWrite, rejectWrite) => {
      process.stdout.write(`${JSON.stringify({ ok: true, result })}\n`, (error) =>
        error ? rejectWrite(error) : resolveWrite()
      );
    });
    process.exitCode = 0;
  } catch (error) {
    await new Promise<void>((resolveWrite) => {
      process.stdout.write(
        `${JSON.stringify({
          ok: false,
          error:
            error instanceof z.ZodError
              ? 'Invalid key-helper request.'
              : 'Key-helper operation failed.',
        })}\n`,
        () => resolveWrite()
      );
    });
    process.exitCode = 1;
  }
};
