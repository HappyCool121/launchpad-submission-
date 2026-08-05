import { execFile as execFileCallback } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { AppDatabase } from '@/main/database';
import { GitWorkflowService } from '@/main/git-workflow-service';
import type { JournalEvent } from '@/shared/contracts';

const execFile = promisify(execFileCallback);
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

const setup = async () => {
  const directory = await mkdtemp(join(tmpdir(), 'adrouter-git-gui-'));
  directories.push(directory);
  const workspace = join(directory, 'repository');
  await execFile('git', ['init', '-q', workspace]);
  await execFile('git', ['-C', workspace, 'config', 'user.name', 'Fixture']);
  await execFile('git', ['-C', workspace, 'config', 'user.email', 'fixture@example.test']);
  await writeFile(join(workspace, 'tracked.txt'), 'initial\n');
  await execFile('git', ['-C', workspace, 'add', 'tracked.txt']);
  await execFile('git', ['-C', workspace, 'commit', '-qm', 'initial']);
  const database = new AppDatabase(join(directory, 'agent.sqlite'));
  const project = database.createProject({
    path: workspace,
    displayName: 'repository',
    instructions: '',
    permissionMode: 'workspace-write',
    git: { branch: 'main', changeCount: 0, isDirty: false, remote: null },
  });
  const thread = database.createThread({
    projectId: project.id,
    title: 'Git workflow',
    model: 'deepseek-v4-flash',
    thinkingLevel: 'medium',
  });
  const turn = database.createTurn(thread.id, 'Prepare changes');
  database.updateTurnStatus(turn.id, 'completed');
  const events: JournalEvent[] = [];
  const service = new GitWorkflowService(
    database,
    (event) => events.push(event),
    () => false
  );
  return { database, workspace, thread, service, events };
};

describe('GUI Git workflow broker', () => {
  it('reviews and executes one exact branch operation with a one-use approval', async () => {
    const { database, workspace, thread, service, events } = await setup();
    const preview = await service.preview({
      threadId: thread.id,
      capability: 'git.branch.create',
      branch: 'feature/reviewed',
    });
    expect(preview.manifest).toMatchObject({
      capability: 'git.branch.create',
      argv: ['feature/reviewed', expect.stringMatching(/^[0-9a-f]{40}$/)],
    });
    const executed = await service.resolve(preview.manifest.operationId, 'allow-once');
    expect(executed).toMatchObject({
      approval: { decision: 'allow-once', version: 2 },
      result: { exitCode: 0 },
    });
    await expect(
      execFile('git', ['-C', workspace, 'show-ref', '--verify', 'refs/heads/feature/reviewed'])
    ).resolves.toBeDefined();
    await expect(service.resolve(preview.manifest.operationId, 'allow-once')).rejects.toThrow(
      /unavailable or expired/
    );
    expect(events.map((event) => event.type)).toEqual([
      'approval.request',
      'approval.resolved',
      'operation.completed',
    ]);
    database.close();
  });

  it('consumes approval but fails closed when a reviewed path changes before stage', async () => {
    const { database, workspace, thread, service, events } = await setup();
    await writeFile(join(workspace, 'tracked.txt'), 'reviewed\n');
    const preview = await service.preview({
      threadId: thread.id,
      capability: 'git.stage',
      paths: ['tracked.txt'],
    });
    await writeFile(join(workspace, 'tracked.txt'), 'changed after review\n');
    await expect(service.resolve(preview.manifest.operationId, 'allow-once')).rejects.toThrow(
      /changed/
    );
    expect(database.getApproval(preview.manifest.operationId)).toMatchObject({
      decision: 'allow-once',
      version: 2,
    });
    expect(events.at(-1)).toMatchObject({ type: 'diagnostic' });
    database.close();
  });

  it('shows and executes only the selected hunk patch', async () => {
    const { database, workspace, thread, service } = await setup();
    const original = Array.from({ length: 24 }, (_, index) => `line ${index + 1}`).join('\n');
    await writeFile(join(workspace, 'hunks.txt'), `${original}\n`);
    await execFile('git', ['-C', workspace, 'add', 'hunks.txt']);
    await execFile('git', ['-C', workspace, 'commit', '-qm', 'hunk fixture']);
    await writeFile(
      join(workspace, 'hunks.txt'),
      `${original.replace('line 2', 'line 2 selected').replace('line 22', 'line 22 later')}\n`
    );
    const preview = await service.preview({
      threadId: thread.id,
      capability: 'git.stage.hunk',
      path: 'hunks.txt',
      hunks: [1],
    });
    expect(preview.patchPreview).toContain('line 2 selected');
    expect(preview.patchPreview).not.toContain('line 22 later');
    await expect(
      service.resolve(preview.manifest.operationId, 'allow-once')
    ).resolves.toMatchObject({
      approval: { decision: 'allow-once' },
      result: { exitCode: 0 },
    });
    const staged = await execFile('git', ['-C', workspace, 'diff', '--cached', '--', 'hunks.txt']);
    expect(staged.stdout).toContain('line 2 selected');
    expect(staged.stdout).not.toContain('line 22 later');
    database.close();
  });
});
