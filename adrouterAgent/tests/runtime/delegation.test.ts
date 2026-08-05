import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ConfigurationStore } from '@/main/configuration-store';
import { AppDatabase } from '@/main/database';
import type { RuntimeSupervisor } from '@/main/runtime-supervisor';
import { TaskService } from '@/main/task-service';
import { createDelegationManifest, delegationArguments } from '@/runtime/delegation';
import { bundledCatalogModels } from '@/shared/model-catalog';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

const setup = async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'adrouter-delegation-'));
  directories.push(workspace);
  const canonicalWorkspace = await realpath(workspace);
  const database = new AppDatabase(join(workspace, 'agent.sqlite'));
  const model = bundledCatalogModels()[0];
  if (!model) throw new Error('Expected a bundled model.');
  const project = database.createProject({
    path: canonicalWorkspace,
    displayName: 'delegation',
    instructions: '',
    permissionMode: 'workspace-write',
    delegationEnabled: true,
    git: null,
  });
  const parent = database.createThread({
    projectId: project.id,
    title: 'Parent',
    model: model.id,
    thinkingLevel: model.defaultThinkingLevel,
  });
  const parentTurn = database.createTurn(parent.id, 'Coordinate work');
  database.updateTurnStatus(parentTurn.id, 'running');
  const configuration = {
    get: vi.fn().mockResolvedValue({ models: [{ ...model, configured: true }] }),
    getRuntimeConfiguration: vi.fn().mockResolvedValue({
      serverUrl: 'http://localhost:8787',
      sponsoredCompute: false,
      authMode: 'custom_bearer',
      token: 'fixture',
    }),
  } as unknown as ConfigurationStore;
  const supervisor = {
    start: vi.fn().mockResolvedValue(undefined),
  } as unknown as RuntimeSupervisor;
  const tasks = new TaskService(database, configuration, supervisor, () => undefined);
  const manifest = await createDelegationManifest({
    threadId: parent.id,
    turnId: parentTurn.id,
    workspaceRoot: canonicalWorkspace,
    title: 'Inspect tests',
    prompt: 'Inspect the test suite and report only; do not mutate files.',
  });
  return {
    database,
    project,
    parent,
    parentTurn,
    model,
    supervisor,
    tasks,
    manifest,
    workspace: canonicalWorkspace,
  };
};

describe('bounded delegated child tasks', () => {
  it('creates an independent visible child and schedules it through the normal task service', async () => {
    const { database, parent, supervisor, tasks, manifest } = await setup();
    const result = await tasks.startDelegated(manifest);
    expect(result).toMatchObject({
      childThreadId: expect.any(String),
      childTurnId: expect.any(String),
      ownership: { parentThreadId: parent.id, depth: 1, maximumChildren: 3 },
    });
    const child = database.getThread(String(result.childThreadId));
    expect(child).toMatchObject({
      parentThreadId: parent.id,
      forkedFromCheckpointId: null,
      label: 'Delegated',
      status: 'running',
    });
    expect(supervisor.start).toHaveBeenCalledOnce();
    const startInput = vi.mocked(supervisor.start).mock.calls[0]?.[0];
    expect(startInput?.history).toEqual([]);
    expect(startInput?.input).toBe('Inspect the test suite and report only; do not mutate files.');
    database.close();
  });

  it('enforces depth one, three children, feature enablement, and immutable bindings', async () => {
    const { database, project, parent, model, tasks, manifest } = await setup();
    await tasks.startDelegated(manifest);
    for (const title of ['Second', 'Third']) {
      database.createThread({
        projectId: project.id,
        parentThreadId: parent.id,
        title,
        label: 'Delegated',
        model: model.id,
        thinkingLevel: model.defaultThinkingLevel,
      });
    }
    await expect(tasks.startDelegated(manifest)).rejects.toThrow(/maximum of three/);

    const child = database
      .listThreads(project.id)
      .find(
        (thread) => thread.parentThreadId === parent.id && database.listTurns(thread.id).length > 0
      );
    if (!child) throw new Error('Expected a delegated child.');
    const childTurn = database.listTurns(child.id)[0];
    if (!childTurn) throw new Error('Expected a delegated child turn.');
    const nested = await createDelegationManifest({
      threadId: child.id,
      turnId: childTurn.id,
      workspaceRoot: project.path,
      title: 'Nested',
      prompt: 'This must be rejected.',
    });
    await expect(tasks.startDelegated(nested)).rejects.toThrow(/cannot delegate again/);

    database.updateProject(project.id, { delegationEnabled: false });
    await expect(tasks.startDelegated(manifest)).rejects.toThrow(/disabled/);
    const boundPrompt = manifest.argv?.[1];
    if (!boundPrompt) throw new Error('Expected a bound delegation prompt.');
    expect(() =>
      delegationArguments({
        ...manifest,
        argv: ['Changed title', boundPrompt],
      })
    ).toThrow(/binding was modified/);
    database.close();
  });
});
