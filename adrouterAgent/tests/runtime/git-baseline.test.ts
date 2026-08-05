import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { captureGitTaskBaseline } from '@/runtime/git-operations';

const execFile = promisify(execFileCallback);
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

describe('task-start Git baseline', () => {
  it('captures exact HEAD, ref, index, dirty paths, and content hashes', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'adrouter-git-baseline-'));
    directories.push(workspace);
    await execFile('git', ['init', '-q', workspace]);
    await execFile('git', ['-C', workspace, 'config', 'user.name', 'Fixture']);
    await execFile('git', ['-C', workspace, 'config', 'user.email', 'fixture@example.test']);
    await writeFile(join(workspace, 'tracked.txt'), 'original\n');
    await execFile('git', ['-C', workspace, 'add', 'tracked.txt']);
    await execFile('git', ['-C', workspace, 'commit', '-qm', 'initial']);
    await writeFile(join(workspace, 'tracked.txt'), 'pre-existing change\n');
    await writeFile(join(workspace, 'untracked.txt'), 'untracked\n');

    const baseline = await captureGitTaskBaseline({
      workspaceRoot: workspace,
      threadId: '11111111-1111-4111-8111-111111111111',
      turnId: '22222222-2222-4222-8222-222222222222',
    });
    expect(baseline.headOid).toMatch(/^[0-9a-f]{40}$/);
    expect(baseline.ref).toMatch(/^refs\/heads\//);
    expect(baseline.indexTreeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(baseline.statusEntries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: ' M', path: 'tracked.txt', hash: expect.any(String) }),
        expect.objectContaining({ code: '??', path: 'untracked.txt', hash: expect.any(String) }),
      ])
    );
    expect(baseline.truncated).toBe(false);
  });
});
