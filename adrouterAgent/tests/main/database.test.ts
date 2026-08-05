import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { AppDatabase } from '@/main/database';
import { createOperationManifest } from '@/runtime/operation-manifest';
import { rebuildThreadProjection } from '@/shared/projection';

const directories: string[] = [];
const createDatabase = async (): Promise<AppDatabase> => {
  const directory = await mkdtemp(join(tmpdir(), 'adrouter-db-'));
  directories.push(directory);
  return new AppDatabase(join(directory, 'agent.sqlite'));
};

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

describe('append-only event database', () => {
  it('migrates legacy project instructions into repository-owned fields', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'adrouter-db-v1-'));
    directories.push(directory);
    const path = join(directory, 'agent.sqlite');
    const legacy = new DatabaseSync(path);
    legacy.exec(`
      CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        path TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL,
        instructions TEXT NOT NULL,
        permission_mode TEXT NOT NULL,
        git_metadata TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      PRAGMA user_version = 1;
    `);
    legacy
      .prepare('INSERT INTO projects VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(
        '11111111-1111-4111-8111-111111111111',
        '/tmp/legacy-project',
        'legacy-project',
        'Legacy repository instructions.',
        'workspace-write',
        JSON.stringify({ branch: 'main', changeCount: 0, isDirty: false, remote: null }),
        '2026-07-11T12:00:00.000Z',
        '2026-07-11T12:00:00.000Z'
      );
    legacy.close();

    const database = new AppDatabase(path);
    expect(database.getProject('11111111-1111-4111-8111-111111111111')).toMatchObject({
      instructions: '',
      repositoryInstructions: 'Legacy repository instructions.',
      repositoryInstructionFiles: ['legacy imported instructions'],
    });
    database.close();
  });

  it('orders events, rebuilds projection, deduplicates router settlements, and recovers interrupted work', async () => {
    const database = await createDatabase();
    const project = database.createProject({
      path: '/tmp/project',
      displayName: 'project',
      instructions: '',
      permissionMode: 'workspace-write',
      git: { branch: 'main', changeCount: 1, isDirty: true, remote: null },
    });
    const thread = database.createThread({
      projectId: project.id,
      title: 'Task',
      model: 'auto',
      thinkingLevel: 'medium',
    });
    const turn = database.createTurn(thread.id, 'Fix the validation');
    database.updateTurnStatus(turn.id, 'running');
    database.updateThreadStatus(thread.id, 'running');
    database.appendEvent(thread.id, turn.id, 'message.user', { text: 'Fix the validation' });
    database.appendEvent(thread.id, turn.id, 'sponsor.update', { tier: 'B', subsidyPercent: 40 });

    const events = database.listEvents(thread.id);
    expect(events.map((event) => event.sequence)).toEqual(
      [...events.keys()].map((index) => index + 1)
    );
    expect(rebuildThreadProjection(events).latestSponsorEvent?.payload.tier).toBe('B');
    expect(
      database.addRouterOutcome(thread.id, turn.id, {
        routerTurnId: 'router-turn-1',
        cost: 1,
        subsidy: 0.4,
        paid: 0.6,
        cacheRead: 0,
        cacheWrite: 0,
        inputTokens: 10,
        outputTokens: 2,
        totalTokens: 12,
        inferencePurpose: 'agent',
        sponsor: null,
        timestamp: new Date().toISOString(),
      })
    ).toBe(true);
    const storedOutcome = database.listRouterOutcomes(thread.id)[0];
    if (!storedOutcome) {
      throw new Error('Expected a stored router outcome.');
    }
    expect(database.addRouterOutcome(thread.id, turn.id, storedOutcome)).toBe(false);
    database.createApproval({
      id: randomUUID(),
      threadId: thread.id,
      turnId: turn.id,
      kind: 'command',
      argv: ['custom-tool', 'run'],
      path: null,
      cwd: '/tmp/project',
      risk: 'medium',
      reason: 'Needs approval.',
      decision: null,
      createdAt: new Date().toISOString(),
      resolvedAt: null,
    });
    expect(
      database.denyPendingApprovalsForTurn(turn.id).map((approval) => approval.decision)
    ).toEqual(['deny']);
    expect(database.recoverInterruptedRuns().map((candidate) => candidate.id)).toContain(turn.id);
    expect(database.getTurn(turn.id)?.status).toBe('interrupted');
    expect(database.getThread(thread.id)?.status).toBe('interrupted');
    database.close();
  });

  it('builds evidence from canonical command completions without counting agent mirrors', async () => {
    const database = await createDatabase();
    const project = database.createProject({
      path: '/tmp/evidence-project',
      displayName: 'evidence-project',
      instructions: '',
      permissionMode: 'workspace-write',
      git: { branch: 'main', changeCount: 0, isDirty: false, remote: null },
    });
    const thread = database.createThread({
      projectId: project.id,
      title: 'Evidence',
      model: 'auto',
      thinkingLevel: 'medium',
    });
    const turn = database.createTurn(thread.id, 'Run tests');
    database.appendEvent(thread.id, turn.id, 'tool.result', {
      recordKind: 'command-completion',
      name: 'run_command',
      argv: ['npm', 'test'],
      cwd: '/tmp/evidence-project',
      startedAt: '2026-07-11T12:00:00.000Z',
      completedAt: '2026-07-11T12:00:01.000Z',
      exitCode: 0,
      timedOut: false,
      cancelled: false,
      status: 'completed',
    });
    database.appendEvent(thread.id, turn.id, 'tool.result', {
      recordKind: 'agent-tool-result',
      name: 'run_command',
      toolCallId: 'call-1',
      output: '{"exitCode":0}',
    });

    expect(database.buildEvidence(thread.id, turn.id)).toMatchObject({
      pass: true,
      commands: [{ recordKind: 'command-completion', exitCode: 0 }],
      testsExecuted: [{ argv: ['npm', 'test'], passed: true }],
    });

    const failedTurn = database.createTurn(thread.id, 'Run failing tests');
    database.appendEvent(thread.id, failedTurn.id, 'tool.result', {
      recordKind: 'command-completion',
      name: 'run_command',
      argv: ['npm', 'test'],
      cwd: '/tmp/evidence-project',
      startedAt: '2026-07-11T12:01:00.000Z',
      completedAt: '2026-07-11T12:01:01.000Z',
      exitCode: 1,
      timedOut: false,
      cancelled: false,
      status: 'failed',
    });
    expect(database.buildEvidence(thread.id, failedTurn.id)).toMatchObject({
      pass: false,
      testsExecuted: [{ argv: ['npm', 'test'], passed: false }],
    });
    database.close();
  });

  it('consumes a bound v2 approval exactly once and rejects thread-wide approval', async () => {
    const database = await createDatabase();
    const project = database.createProject({
      path: '/tmp/approval-project',
      displayName: 'approval-project',
      instructions: '',
      permissionMode: 'workspace-write',
      git: null,
    });
    const thread = database.createThread({
      projectId: project.id,
      title: 'Approval',
      model: 'auto',
      thinkingLevel: 'medium',
    });
    const turn = database.createTurn(thread.id, 'Approve one operation');
    const manifest = createOperationManifest({
      capability: 'file.delete',
      threadId: thread.id,
      turnId: turn.id,
      workspace: '/tmp/approval-project',
      targets: [{ path: 'old.txt', kind: 'file', beforeHash: 'a'.repeat(64) }],
    });
    database.createApproval({
      version: 2,
      id: manifest.operationId,
      threadId: thread.id,
      turnId: turn.id,
      kind: 'structured-operation',
      argv: null,
      path: 'old.txt',
      cwd: manifest.workspace,
      risk: 'high',
      reason: 'Delete the exact reviewed file.',
      operationManifest: manifest,
      expiresAt: manifest.expiresAt,
      decision: null,
      createdAt: manifest.createdAt,
      resolvedAt: null,
    });

    expect(() => database.resolveApproval(manifest.operationId, 'allow-thread')).toThrow(
      'allowed once'
    );
    database.resolveApproval(manifest.operationId, 'allow-once');
    expect(database.consumeOperationApproval(manifest.operationId, manifest.binding)).toMatchObject(
      { id: manifest.operationId, version: 2 }
    );
    expect(() => database.consumeOperationApproval(manifest.operationId, manifest.binding)).toThrow(
      'already consumed'
    );
    database.close();
  });

  it('projects only sponsor-free model context and records safe between-call checkpoints', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'adrouter-session-db-'));
    directories.push(directory);
    const path = join(directory, 'agent.sqlite');
    let database = new AppDatabase(path);
    const project = database.createProject({
      path: '/tmp/session-project',
      displayName: 'session-project',
      instructions: '',
      permissionMode: 'workspace-write',
      git: null,
    });
    const thread = database.createThread({
      projectId: project.id,
      title: 'Durable context',
      model: 'deepseek-v4-flash',
      thinkingLevel: 'medium',
    });
    const turn = database.createTurn(thread.id, 'Preserve the API');
    database.appendEvent(thread.id, turn.id, 'message.user', {
      role: 'user',
      text: 'Preserve the API',
    });
    database.appendEvent(thread.id, turn.id, 'sponsor.update', {
      sponsor: { brandName: 'Must remain display only' },
    });
    database.appendEvent(thread.id, turn.id, 'message.complete', {
      role: 'assistant',
      text: 'I will inspect it.',
      content: [{ type: 'text', text: 'I will inspect it.' }],
      model: 'deepseek-v4-flash',
      usage: {
        input: 100,
        output: 20,
        cacheRead: 2,
        cacheWrite: 0,
        totalTokens: 122,
        cost: { total: 99 },
      },
    });
    database.appendEvent(thread.id, turn.id, 'tool.result', {
      name: 'read_file',
      toolCallId: 'call-1',
      output: '{"content":"ok"}',
      isError: false,
    });
    database.appendEvent(thread.id, turn.id, 'compaction', {
      outcome: 'completed',
      summary: 'Preserve the API and continue from the inspected file.',
      droppedMessages: 1,
      tokensBefore: 120_000,
      tokensAfter: 32_000,
      modelAssisted: true,
      retainedMessages: [
        {
          role: 'compactionSummary',
          summary: 'Preserve the API and continue from the inspected file.',
          tokensBefore: 120_000,
          timestamp: Date.now(),
        },
      ],
    });
    database.appendEvent(thread.id, turn.id, 'session.checkpoint', {
      safe: true,
      completedToolResults: 1,
    });

    const entries = database.listSessionEntries(thread.id);
    expect(entries.map((entry) => entry.kind)).toEqual([
      'user_message',
      'assistant_message',
      'tool_result',
      'compaction',
    ]);
    expect(JSON.stringify(entries)).not.toMatch(/sponsor|settlement|"cost"/i);
    expect(entries[1]?.payload.usage).toEqual({
      input: 100,
      output: 20,
      cacheRead: 2,
      cacheWrite: 0,
      totalTokens: 122,
    });
    expect(database.listSessionCheckpoints(thread.id)).toEqual([
      expect.objectContaining({
        threadId: thread.id,
        turnId: turn.id,
        entryOrdinal: 4,
        safe: true,
      }),
    ]);

    database.close();
    database = new AppDatabase(path);
    expect(database.listSessionEntries(thread.id)).toHaveLength(4);
    expect(database.listSessionCheckpoints(thread.id)).toHaveLength(1);
    database.close();
  });

  it('records per-turn model choices and permanently cascades terminal thread data', async () => {
    const database = await createDatabase();
    const project = database.createProject({
      path: '/tmp/delete-project',
      displayName: 'delete-project',
      instructions: '',
      permissionMode: 'workspace-write',
      git: null,
    });
    const thread = database.createThread({
      projectId: project.id,
      title: 'Disposable chat',
      model: 'model-flash',
      thinkingLevel: 'medium',
    });
    const turn = database.createTurn(thread.id, 'Use the pro model', 'model-pro', 'high');
    expect(turn).toMatchObject({ model: 'model-pro', thinkingLevel: 'high' });
    database.appendEvent(thread.id, turn.id, 'message.user', { text: turn.input });

    database.deleteThread(thread.id);

    expect(database.getThread(thread.id)).toBeUndefined();
    expect(database.getTurn(turn.id)).toBeUndefined();
    expect(database.listEvents(thread.id)).toEqual([]);
    expect(database.getProject(project.id)).toBeDefined();
    database.close();
  });
});
