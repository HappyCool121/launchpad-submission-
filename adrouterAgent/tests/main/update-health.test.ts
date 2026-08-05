import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { writeLauncherHealthMarker } from '../../src/main/update-health';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

describe('launcher healthy-start marker', () => {
  it('writes only the exact owner-state marker after application initialization', async () => {
    const home = await mkdtemp(join(tmpdir(), 'adrouter-health-'));
    temporaryDirectories.push(home);
    const marker = join(home, '.local', 'share', 'adrouter-agent-launcher', 'health-marker.json');
    await expect(
      writeLauncherHealthMarker('0.1.0-beta.12', {
        argv: [
          'agent',
          `--adrouter-launcher-health-token=${'a'.repeat(43)}`,
          `--adrouter-launcher-health-marker=${marker}`,
        ],
        platform: 'linux',
        homeDirectory: home,
        environment: {},
        now: new Date('2026-08-02T01:02:03.000Z'),
      })
    ).resolves.toBe(true);
    expect(JSON.parse(await readFile(marker, 'utf8'))).toEqual({
      schema: 1,
      protocol: 1,
      releaseVersion: '0.1.0-beta.12',
      token: 'a'.repeat(43),
      healthyAt: '2026-08-02T01:02:03.000Z',
    });
  });

  it('rejects marker paths outside the launcher support directory', async () => {
    const home = await mkdtemp(join(tmpdir(), 'adrouter-health-'));
    temporaryDirectories.push(home);
    await expect(
      writeLauncherHealthMarker('0.1.0-beta.12', {
        argv: [
          'agent',
          `--adrouter-launcher-health-token=${'a'.repeat(43)}`,
          `--adrouter-launcher-health-marker=${join(home, 'outside.json')}`,
        ],
        platform: 'linux',
        homeDirectory: home,
        environment: {},
      })
    ).rejects.toThrow(/outside launcher state/);
  });
});
