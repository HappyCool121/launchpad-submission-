import { createPublicKey, verify } from 'node:crypto';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  type AutomationKeyCipher,
  executeAutomationKeyHelperRequest,
} from '@/main/automation-key-helper';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

const fixtureCipher = (): AutomationKeyCipher => ({
  assertSecure: vi.fn().mockResolvedValue(undefined),
  encrypt: async (value) => Buffer.from(value, 'utf8').toString('hex'),
  decrypt: async (value) => Buffer.from(value, 'hex').toString('utf8'),
});

describe('safeStorage automation key helper', () => {
  it('generates, signs, binds, and lists an Ed25519 identity without returning private bytes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'adrouter-key-helper-'));
    directories.push(directory);
    const cipher = fixtureCipher();
    const generated = await executeAutomationKeyHelperRequest(
      directory,
      { method: 'key.generate' },
      cipher
    );
    expect(generated).toMatchObject({
      keyId: expect.stringMatching(/^[0-9a-f]{64}$/),
      publicKey: expect.any(String),
      clientId: null,
    });
    expect(generated).not.toHaveProperty('encryptedPrivateKey');
    const keyId = String(generated.keyId);
    const payload = '{"canonical":true}';
    const signed = await executeAutomationKeyHelperRequest(
      directory,
      { method: 'key.sign', keyId, payload },
      cipher
    );
    const publicKey = createPublicKey({
      key: Buffer.from(String(generated.publicKey), 'base64'),
      format: 'der',
      type: 'spki',
    });
    expect(
      verify(null, Buffer.from(payload), publicKey, Buffer.from(String(signed.signature), 'base64'))
    ).toBe(true);

    const clientId = '11111111-1111-4111-8111-111111111111';
    await executeAutomationKeyHelperRequest(
      directory,
      { method: 'key.bind', keyId, clientId },
      cipher
    );
    await expect(
      executeAutomationKeyHelperRequest(directory, { method: 'key.list' }, cipher)
    ).resolves.toMatchObject({ keys: [expect.objectContaining({ keyId, clientId })] });
    await expect(
      executeAutomationKeyHelperRequest(directory, { method: 'key.delete', keyId }, cipher)
    ).rejects.toThrow(/paired automation key cannot be deleted/);

    if (process.platform !== 'win32') {
      expect((await stat(join(directory, 'automation', 'client-keys'))).mode & 0o777).toBe(0o700);
      expect(
        (await stat(join(directory, 'automation', 'client-keys', `${keyId}.json`))).mode & 0o777
      ).toBe(0o600);
    }
  });

  it('deletes an abandoned key before it is bound', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'adrouter-key-helper-'));
    directories.push(directory);
    const cipher = fixtureCipher();
    const generated = await executeAutomationKeyHelperRequest(
      directory,
      { method: 'key.generate' },
      cipher
    );
    const keyId = String(generated.keyId);
    await expect(
      executeAutomationKeyHelperRequest(directory, { method: 'key.delete', keyId }, cipher)
    ).resolves.toEqual({ keyId, deleted: true });
    await expect(
      executeAutomationKeyHelperRequest(directory, { method: 'key.list' }, cipher)
    ).resolves.toEqual({ keys: [] });
  });

  it('returns the local endpoint without touching key storage', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'adrouter-key-helper-'));
    directories.push(directory);
    const cipher = fixtureCipher();
    const result = await executeAutomationKeyHelperRequest(
      directory,
      { method: 'endpoint' },
      cipher
    );
    expect(result).toMatchObject({ protocolVersion: 1, kind: expect.any(String) });
    expect(cipher.assertSecure).not.toHaveBeenCalled();
  });
});
