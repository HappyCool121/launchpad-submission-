import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createNetworkFetchManifest, isPublicNetworkAddress } from '@/runtime/network-policy';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

describe('structured network policy', () => {
  it('rejects private, local, reserved, and documentation addresses', () => {
    for (const address of [
      '127.0.0.1',
      '10.0.0.1',
      '169.254.169.254',
      '172.20.0.1',
      '192.168.0.1',
      '198.51.100.1',
      '203.0.113.1',
      '::1',
      'fd00::1',
      'fe80::1',
      '2001:db8::1',
    ]) {
      expect(isPublicNetworkAddress(address), address).toBe(false);
    }
    expect(isPublicNetworkAddress('8.8.8.8')).toBe(true);
    expect(isPublicNetworkAddress('2606:4700:4700::1111')).toBe(true);
  });

  it('creates an exact, capped HTTPS binding and rejects unsafe URLs', async () => {
    const root = await mkdtemp(join(tmpdir(), 'adrouter-network-policy-'));
    directories.push(root);
    const manifest = await createNetworkFetchManifest({
      threadId: '11111111-1111-4111-8111-111111111111',
      turnId: '22222222-2222-4222-8222-222222222222',
      workspaceRoot: root,
      method: 'HEAD',
      url: 'https://8.8.8.8/resource',
      maxResponseBytes: Number.MAX_SAFE_INTEGER,
    });

    expect(manifest.network).toMatchObject({
      method: 'HEAD',
      host: '8.8.8.8',
      resolvedAddresses: ['8.8.8.8'],
      maxResponseBytes: 10 * 1024 * 1024,
    });
    await expect(
      createNetworkFetchManifest({
        threadId: manifest.threadId,
        turnId: manifest.turnId,
        workspaceRoot: root,
        method: 'GET',
        url: 'http://8.8.8.8/',
      })
    ).rejects.toThrow('HTTPS');
    await expect(
      createNetworkFetchManifest({
        threadId: manifest.threadId,
        turnId: manifest.turnId,
        workspaceRoot: root,
        method: 'GET',
        url: 'https://user:secret@8.8.8.8/',
      })
    ).rejects.toThrow('credentials');
    await expect(
      createNetworkFetchManifest({
        threadId: manifest.threadId,
        turnId: manifest.turnId,
        workspaceRoot: root,
        method: 'GET',
        url: 'https://127.0.0.1/',
      })
    ).rejects.toThrow('denied');
  });
});
