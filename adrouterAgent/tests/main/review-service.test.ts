import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ shell: { openPath: vi.fn() } }));

import { AppDatabase } from '@/main/database';
import { ReviewService } from '@/main/review-service';
import { sha256 } from '@/shared/security';

const directories: string[] = [];

const createThread = (database: AppDatabase, workspace: string) => {
  const project = database.createProject({
    path: workspace,
    displayName: 'fixture',
    instructions: '',
    permissionMode: 'workspace-write',
    git: { branch: 'main', changeCount: 1, isDirty: true, remote: null },
  });
  return database.createThread({
    projectId: project.id,
    title: 'Task',
    model: 'opaque-model',
    thinkingLevel: 'medium',
  });
};

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

describe('agent-only review reverts', () => {
  it('restores a baseline without touching unrelated dirty files and blocks overlapping user edits', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'adrouter-review-'));
    directories.push(workspace);
    const database = new AppDatabase(join(workspace, 'agent.sqlite'));
    const review = new ReviewService(database);
    const target = join(workspace, 'user.ts');
    const unrelated = join(workspace, 'README.md');
    const original = 'export const max = 16;\n';
    const agentVersion = 'export const max = 32;\n';
    await writeFile(target, original);
    await writeFile(unrelated, 'Existing user change\n');

    const firstThread = createThread(database, workspace);
    database.recordFileMutation({
      threadId: firstThread.id,
      path: 'user.ts',
      status: 'modified',
      beforeBase64: Buffer.from(original).toString('base64'),
      afterBase64: Buffer.from(agentVersion).toString('base64'),
      beforeHash: sha256(original),
      afterHash: sha256(agentVersion),
    });
    await writeFile(target, agentVersion);

    await expect(review.revertFile(firstThread.id, 'user.ts')).resolves.toEqual({
      reverted: ['user.ts'],
      conflicts: [],
    });
    expect(await readFile(target, 'utf8')).toBe(original);
    expect(await readFile(unrelated, 'utf8')).toBe('Existing user change\n');

    const secondThread = database.createThread({
      projectId: firstThread.projectId,
      title: 'Second task',
      model: 'opaque-model',
      thinkingLevel: 'medium',
    });
    database.recordFileMutation({
      threadId: secondThread.id,
      path: 'user.ts',
      status: 'modified',
      beforeBase64: Buffer.from(original).toString('base64'),
      afterBase64: Buffer.from(agentVersion).toString('base64'),
      beforeHash: sha256(original),
      afterHash: sha256(agentVersion),
    });
    await writeFile(target, 'export const max = 48;\n');

    await expect(review.revertFile(secondThread.id, 'user.ts')).resolves.toEqual({
      reverted: [],
      conflicts: ['user.ts'],
    });
    expect(await readFile(target, 'utf8')).toBe('export const max = 48;\n');
    database.close();
  });
});
