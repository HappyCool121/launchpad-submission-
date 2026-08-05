import { execFile as execFileCallback } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { AppDatabase } from '@/main/database';
import { RepositoryService } from '@/main/repository-service';

const execFile = promisify(execFileCallback);
const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

describe('repository instruction registration', () => {
  it('opens a readable non-Git directory with nullable Git metadata', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'adrouter-folder-'));
    const state = await mkdtemp(join(tmpdir(), 'adrouter-folder-state-'));
    directories.push(workspace, state);
    const database = new AppDatabase(join(state, 'agent.sqlite'));
    const opened = await new RepositoryService(database).open(workspace);

    expect(opened.path).toBe(await realpath(workspace));
    expect(opened.git).toBeNull();
    database.close();
  });

  it('refreshes repository instructions without discarding user-authored instructions', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'adrouter-repository-'));
    const state = await mkdtemp(join(tmpdir(), 'adrouter-repository-state-'));
    directories.push(workspace, state);
    await execFile('git', ['-C', workspace, 'init']);
    await writeFile(join(workspace, 'AGENTS.md'), 'Repository rule one.');

    const database = new AppDatabase(join(state, 'agent.sqlite'));
    const repositories = new RepositoryService(database);
    const opened = await repositories.open(workspace);
    expect(opened.repositoryInstructionFiles).toEqual(['AGENTS.md']);
    expect(opened.repositoryInstructions).toContain('Repository rule one.');

    database.updateProject(opened.id, { instructions: 'Always preserve the public API.' });
    await writeFile(join(workspace, 'AGENTS.md'), 'Repository rule two.');
    const reopened = await repositories.open(workspace);

    expect(reopened.instructions).toBe('Always preserve the public API.');
    expect(reopened.repositoryInstructions).toContain('Repository rule two.');
    expect(reopened.repositoryInstructionFiles).toEqual(['AGENTS.md']);
    database.close();
  });

  it('loads scoped AGENTS/CLAUDE instructions in deterministic order and rejects symlinks', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'adrouter-instructions-'));
    const state = await mkdtemp(join(tmpdir(), 'adrouter-instructions-state-'));
    const outside = await mkdtemp(join(tmpdir(), 'adrouter-instructions-outside-'));
    directories.push(workspace, state, outside);
    await mkdir(join(workspace, '.agent'));
    await writeFile(join(workspace, 'AGENTS.md'), 'Agent root rule.');
    await writeFile(join(workspace, 'CLAUDE.md'), 'Claude root rule.');
    await writeFile(join(workspace, '.agent', 'instructions.md'), 'Project instruction rule.');
    await writeFile(join(outside, 'CLAUDE.md'), 'Outside rule.');
    await symlink(join(outside, 'CLAUDE.md'), join(workspace, '.agent', 'linked.md'));

    const database = new AppDatabase(join(state, 'agent.sqlite'));
    const opened = await new RepositoryService(database).open(workspace);
    expect(opened.repositoryInstructionFiles).toEqual([
      'AGENTS.md',
      'CLAUDE.md',
      '.agent/instructions.md',
    ]);
    expect(opened.repositoryInstructions.indexOf('Agent root rule.')).toBeLessThan(
      opened.repositoryInstructions.indexOf('Claude root rule.')
    );
    expect(opened.repositoryInstructions).not.toContain('Outside rule.');
    database.close();
  });
});
