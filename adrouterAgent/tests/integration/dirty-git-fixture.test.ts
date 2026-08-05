import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ shell: { openPath: vi.fn() } }));

import { AppDatabase } from '@/main/database';
import { ReviewService } from '@/main/review-service';
import { classifyCommand } from '@/runtime/command-policy';
import { SandboxedCommandRunner } from '@/runtime/command-runner';
import { applyWorkspacePatch, readWorkspaceTextFile } from '@/runtime/workspace';
import { sha256 } from '@/shared/security';

const execFile = promisify(execFileCallback);
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

describe('dirty Git repository fixture', () => {
  it('preserves user work, tracks agent-only changes, and restores exact baselines', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'adrouter-fixture-'));
    directories.push(workspace);
    await writeFile(
      join(workspace, 'user.mjs'),
      'export const isValidUsername = (username) => username.length <= 16;\n'
    );
    await writeFile(join(workspace, 'README.md'), 'Usernames may be up to 16 characters.\n');
    await writeFile(join(workspace, 'notes.md'), 'Committed note\n');
    await execFile('git', ['init', workspace]);
    await execFile('git', ['-C', workspace, 'config', 'user.email', 'fixture@example.test']);
    await execFile('git', ['-C', workspace, 'config', 'user.name', 'Fixture']);
    await execFile('git', ['-C', workspace, 'add', '.']);
    await execFile('git', ['-C', workspace, 'commit', '-m', 'fixture']);
    await writeFile(join(workspace, 'notes.md'), 'User-owned dirty change\n');

    const database = new AppDatabase(join(workspace, '.agent.sqlite'));
    const project = database.createProject({
      path: workspace,
      displayName: 'fixture',
      instructions: '',
      permissionMode: 'workspace-write',
      git: { branch: 'main', changeCount: 1, isDirty: true, remote: null },
    });
    const thread = database.createThread({
      projectId: project.id,
      title: 'Extend username validation',
      model: 'opaque-model',
      thinkingLevel: 'medium',
    });
    const turn = database.createTurn(thread.id, 'Allow usernames through 32 characters.');
    database.updateTurnStatus(turn.id, 'running');
    const review = new ReviewService(database);

    const patch = async (path: string, original: string, replacement: string): Promise<void> => {
      const before = await readWorkspaceTextFile(workspace, path);
      const result = await applyWorkspacePatch(
        workspace,
        {
          path,
          expectedBeforeHash: before.hash,
          replacements: [{ original, replacement }],
        },
        { deletionApproved: false }
      );
      database.recordFileMutation({
        threadId: thread.id,
        path,
        status: 'modified',
        beforeBase64: Buffer.from(result.before ?? '').toString('base64'),
        afterBase64: Buffer.from(result.after ?? '').toString('base64'),
        beforeHash: result.beforeHash,
        afterHash: result.afterHash,
      });
    };

    await patch('user.mjs', '<= 16', '<= 32');
    await patch('README.md', '16 characters', '32 characters');

    expect(classifyCommand(['custom-runner', 'run']).disposition).toBe('approval');
    const runner = new SandboxedCommandRunner();
    try {
      const command = await runner.run({
        argv: ['grep', '-q', '32', 'user.mjs'],
        cwd: workspace,
        workspaceWriteAllowed: true,
      });
      expect(command.exitCode).toBe(0);
      database.appendEvent(thread.id, turn.id, 'tool.result', {
        name: 'run_command',
        exitCode: command.exitCode,
        timedOut: command.timedOut,
      });
    } finally {
      await runner.reset();
    }

    database.addRouterOutcome(thread.id, turn.id, {
      routerTurnId: 'fixture-router-turn',
      cost: 0.02,
      subsidy: 0.01,
      paid: 0.01,
      cacheRead: 4,
      cacheWrite: 2,
      inputTokens: 20,
      outputTokens: 10,
      totalTokens: 30,
      inferencePurpose: 'agent',
      sponsor: null,
      timestamp: new Date().toISOString(),
    });

    expect((await review.getDiff(thread.id)).map((diff) => diff.path)).toEqual([
      'README.md',
      'user.mjs',
    ]);
    expect(await readFile(join(workspace, 'notes.md'), 'utf8')).toBe('User-owned dirty change\n');
    expect(database.buildEvidence(thread.id)).toMatchObject({
      filesChanged: [
        { path: 'README.md', status: 'modified' },
        { path: 'user.mjs', status: 'modified' },
      ],
      economics: { paid: 0.01, tokens: 30 },
    });

    await expect(review.revertAll(thread.id)).resolves.toEqual({
      reverted: ['README.md', 'user.mjs'],
      conflicts: [],
    });
    expect(await readFile(join(workspace, 'user.mjs'), 'utf8')).toContain('<= 16');
    expect(await readFile(join(workspace, 'README.md'), 'utf8')).toContain('16 characters');
    expect(await readFile(join(workspace, 'notes.md'), 'utf8')).toBe('User-owned dirty change\n');
    expect(sha256(await readFile(join(workspace, 'user.mjs')))).toBe(
      sha256('export const isValidUsername = (username) => username.length <= 16;\n')
    );
    database.close();
  });
});
