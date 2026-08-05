import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { WebContents } from 'electron';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppDatabase } from '@/main/database';
import { EventSubscriptions } from '@/main/ipc';
import { RuntimeSupervisor } from '@/main/runtime-supervisor';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

describe('runtime supervision boundaries', () => {
  it('rejects a stale approval before mutating its persisted decision', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'adrouter-supervisor-'));
    directories.push(directory);
    const database = new AppDatabase(join(directory, 'agent.sqlite'));
    const project = database.createProject({
      path: '/tmp/project',
      displayName: 'project',
      instructions: '',
      permissionMode: 'workspace-write',
      git: { branch: 'main', changeCount: 0, isDirty: false, remote: null },
    });
    const thread = database.createThread({
      projectId: project.id,
      title: 'Task',
      model: 'auto',
      thinkingLevel: 'medium',
    });
    const turn = database.createTurn(thread.id, 'Task');
    const approvalId = randomUUID();
    database.createApproval({
      id: approvalId,
      threadId: thread.id,
      turnId: turn.id,
      kind: 'command',
      argv: ['custom-runner'],
      path: null,
      cwd: '/tmp/project',
      risk: 'medium',
      reason: 'Unknown command.',
      decision: null,
      createdAt: new Date().toISOString(),
      resolvedAt: null,
    });
    const supervisor = new RuntimeSupervisor(database, '/tmp/runtime.js', vi.fn());

    expect(() => supervisor.assertApprovalActive(approvalId)).toThrow(
      'This thread has no active agent runtime.'
    );
    expect(database.getApproval(approvalId)?.decision).toBeNull();
    database.close();
  });

  it('publishes events with the intended subscription identifier', () => {
    const send = vi.fn();
    const webContents = {
      once: vi.fn(),
      isDestroyed: () => false,
      send,
    } as unknown as WebContents;
    const subscriptions = new EventSubscriptions();
    const subscriptionId = subscriptions.subscribe(
      webContents,
      '11111111-1111-4111-8111-111111111111'
    );
    const event = {
      id: '22222222-2222-4222-8222-222222222222',
      threadId: '11111111-1111-4111-8111-111111111111',
      turnId: null,
      sequence: 1,
      type: 'diagnostic' as const,
      timestamp: '2026-07-11T12:00:00.000Z',
      payload: { message: 'ready' },
    };

    subscriptions.publish(event);

    expect(send).toHaveBeenCalledWith('adrouter:event', { subscriptionId, event });
  });
});
