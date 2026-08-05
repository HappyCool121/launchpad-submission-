import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { createGitOperationManifest, executeGitOperation } from '@/runtime/git-operations';

const execFile = promisify(execFileCallback);
const directories: string[] = [];
const threadId = '11111111-1111-4111-8111-111111111111';
const turnId = '22222222-2222-4222-8222-222222222222';

const repository = async (): Promise<string> => {
  const root = await mkdtemp(join(tmpdir(), 'adrouter-git-operation-'));
  directories.push(root);
  await execFile('git', ['init', '-q', root]);
  await execFile('git', ['-C', root, 'config', 'user.name', 'AdRouter Test']);
  await execFile('git', ['-C', root, 'config', 'user.email', 'test@adrouter.invalid']);
  await writeFile(join(root, 'tracked.txt'), 'initial\n');
  await execFile('git', ['-C', root, 'add', 'tracked.txt']);
  await execFile('git', ['-C', root, 'commit', '-q', '-m', 'initial']);
  return root;
};

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

describe('structured Git operations', () => {
  it('creates and switches branches without force or hooks', async () => {
    const root = await repository();
    const branch = await createGitOperationManifest({
      capability: 'git.branch.create',
      threadId,
      turnId,
      workspaceRoot: root,
      branch: 'feature/safe',
    });
    await expect(executeGitOperation(branch)).resolves.toMatchObject({ exitCode: 0 });

    const change = await createGitOperationManifest({
      capability: 'git.switch',
      threadId,
      turnId,
      workspaceRoot: root,
      branch: 'feature/safe',
    });
    await expect(executeGitOperation(change)).resolves.toMatchObject({ exitCode: 0 });
    await expect(
      execFile('git', ['-C', root, 'branch', '--show-current']).then(({ stdout }) => stdout.trim())
    ).resolves.toBe('feature/safe');
  });

  it('stages exact hashes and rejects a changed reviewed path', async () => {
    const root = await repository();
    await writeFile(join(root, 'tracked.txt'), 'reviewed\n');
    const manifest = await createGitOperationManifest({
      capability: 'git.stage',
      threadId,
      turnId,
      workspaceRoot: root,
      paths: ['tracked.txt'],
    });
    await writeFile(join(root, 'tracked.txt'), 'changed after review\n');

    await expect(executeGitOperation(manifest)).rejects.toThrow('changed');
  });

  it('stages only selected reviewed text hunks into the index', async () => {
    const root = await repository();
    const original = Array.from({ length: 24 }, (_, index) => `line ${index + 1}`).join('\n');
    await writeFile(join(root, 'hunks.txt'), `${original}\n`);
    await execFile('git', ['-C', root, 'add', 'hunks.txt']);
    await execFile('git', ['-C', root, 'commit', '-qm', 'hunk fixture']);
    const changed = original
      .replace('line 2', 'line 2 reviewed')
      .replace('line 22', 'line 22 remains unstaged');
    await writeFile(join(root, 'hunks.txt'), `${changed}\n`);

    const manifest = await createGitOperationManifest({
      capability: 'git.stage.hunk',
      threadId,
      turnId,
      workspaceRoot: root,
      path: 'hunks.txt',
      hunks: [1],
    });
    expect(manifest.argv?.[1]).toMatch(/^[a-f0-9]{64}$/);
    await expect(executeGitOperation(manifest)).resolves.toMatchObject({ exitCode: 0 });

    const staged = await execFile('git', ['-C', root, 'diff', '--cached', '--', 'hunks.txt']);
    expect(staged.stdout).toContain('line 2 reviewed');
    expect(staged.stdout).not.toContain('line 22 remains unstaged');
    const unstaged = await execFile('git', ['-C', root, 'diff', '--', 'hunks.txt']);
    expect(unstaged.stdout).toContain('line 22 remains unstaged');
    expect(unstaged.stdout).not.toContain('line 2 reviewed');
  });

  it('commits only the reviewed index and rejects dirty branch switching', async () => {
    const root = await repository();
    await writeFile(join(root, 'tracked.txt'), 'staged\n');
    await execFile('git', ['-C', root, 'add', 'tracked.txt']);
    const commit = await createGitOperationManifest({
      capability: 'git.commit',
      threadId,
      turnId,
      workspaceRoot: root,
      message: 'reviewed commit',
    });
    await expect(executeGitOperation(commit)).resolves.toMatchObject({ exitCode: 0 });

    await writeFile(join(root, 'tracked.txt'), 'dirty\n');
    await expect(
      createGitOperationManifest({
        capability: 'git.switch',
        threadId,
        turnId,
        workspaceRoot: root,
        branch: 'master',
      })
    ).rejects.toThrow('clean');
  });
});
