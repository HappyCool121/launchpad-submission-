import { describe, expect, it, vi } from 'vitest';
import {
  configuredRuntimeWorkers,
  leasesConflict,
  RuntimeScheduler,
  type ScheduledRuntime,
} from '@/main/runtime-scheduler';

const task = (
  id: string,
  workspace: string,
  mode: 'read' | 'write',
  gitCommonDirectory: string | null = null,
  start = vi.fn()
): ScheduledRuntime => ({
  id,
  workspace,
  mode,
  gitCommonDirectory,
  start,
  cancelled: vi.fn(),
  failed: vi.fn(),
});

const flush = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

describe('bounded runtime scheduling', () => {
  it('keeps the supported normal runtime at one worker', () => {
    expect(configuredRuntimeWorkers(undefined)).toBe(1);
    expect(configuredRuntimeWorkers('0')).toBe(1);
    expect(configuredRuntimeWorkers('4')).toBe(1);
    expect(configuredRuntimeWorkers('9')).toBe(1);
    expect(configuredRuntimeWorkers('invalid')).toBe(1);
  });

  it('runs different workspaces concurrently while serializing writers', async () => {
    const scheduler = new RuntimeScheduler(2);
    const first = task('first', '/workspace/a', 'write');
    const blocked = task('blocked', '/workspace/a', 'read');
    const independent = task('independent', '/workspace/b', 'write');

    expect(scheduler.enqueue(first)).toBe('started');
    expect(scheduler.enqueue(blocked)).toBe('queued');
    expect(scheduler.enqueue(independent)).toBe('started');
    await flush();
    expect(first.start).toHaveBeenCalledOnce();
    expect(independent.start).toHaveBeenCalledOnce();
    expect(blocked.start).not.toHaveBeenCalled();

    scheduler.release('first');
    await flush();
    expect(blocked.start).toHaveBeenCalledOnce();
  });

  it('serializes related worktrees by canonical Git common directory', async () => {
    const scheduler = new RuntimeScheduler(2);
    const first = task('first', '/worktree/a', 'write', '/repo/.git');
    const second = task('second', '/worktree/b', 'write', '/repo/.git');
    scheduler.enqueue(first);
    scheduler.enqueue(second);
    await flush();

    expect(first.start).toHaveBeenCalledOnce();
    expect(second.start).not.toHaveBeenCalled();
    scheduler.release('first');
    await flush();
    expect(second.start).toHaveBeenCalledOnce();
  });

  it('does not let a read bypass an earlier queued writer on the same resource', async () => {
    const scheduler = new RuntimeScheduler(2);
    const blocker = task('blocker', '/workspace/a', 'read');
    const capacity = task('capacity', '/workspace/b', 'write');
    const writer = task('writer', '/workspace/a', 'write');
    const laterRead = task('later-read', '/workspace/a', 'read');
    scheduler.enqueue(blocker);
    scheduler.enqueue(capacity);
    scheduler.enqueue(writer);
    scheduler.enqueue(laterRead);
    scheduler.release('capacity');
    await flush();

    expect(writer.start).not.toHaveBeenCalled();
    expect(laterRead.start).not.toHaveBeenCalled();
    scheduler.release('blocker');
    await flush();
    expect(writer.start).toHaveBeenCalledOnce();
    expect(laterRead.start).not.toHaveBeenCalled();
  });

  it('cancels queued tasks independently and releases failed starts', async () => {
    const scheduler = new RuntimeScheduler(1);
    const first = task('first', '/workspace/a', 'write');
    const queued = task('queued', '/workspace/b', 'write');
    scheduler.enqueue(first);
    scheduler.enqueue(queued);
    expect(scheduler.cancel('queued')).toBe(true);
    expect(queued.cancelled).toHaveBeenCalledOnce();

    scheduler.release('first');
    const failure = new Error('fork failed');
    const failed = task(
      'failed',
      '/workspace/c',
      'write',
      null,
      vi.fn(() => Promise.reject(failure))
    );
    scheduler.enqueue(failed);
    await flush();
    await flush();
    expect(failed.failed).toHaveBeenCalledWith(failure);
    expect(scheduler.activeIds).toEqual([]);
  });

  it('defines read/write conflicts only for shared canonical resources', () => {
    expect(leasesConflict(task('a', '/a', 'read'), task('b', '/a', 'read'))).toBe(false);
    expect(leasesConflict(task('a', '/a', 'read'), task('b', '/a', 'write'))).toBe(true);
    expect(leasesConflict(task('a', '/a', 'write', '/git'), task('b', '/b', 'read', '/git'))).toBe(
      true
    );
  });
});
