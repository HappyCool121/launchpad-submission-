import { realpath } from 'node:fs/promises';
import { snapshotGitState } from '../runtime/git-operations';
import type { PermissionMode } from '../shared/contracts';

export const MIN_RUNTIME_WORKERS = 1;
export const MAX_RUNTIME_WORKERS = 4;
export const DEFAULT_RUNTIME_WORKERS = 1;
export const MAX_QUEUED_RUNTIMES = 32;

export const configuredRuntimeWorkers = (raw = process.env.ADROUTER_AGENT_CONCURRENCY): number => {
  if (!raw) return DEFAULT_RUNTIME_WORKERS;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed)) return DEFAULT_RUNTIME_WORKERS;
  // The queue and lease implementation remains capacity-aware, but the supported
  // desktop runtime intentionally runs one normal task at a time.
  return MIN_RUNTIME_WORKERS;
};

export interface RuntimeLease {
  id: string;
  workspace: string;
  gitCommonDirectory: string | null;
  mode: 'read' | 'write';
}

export interface ScheduledRuntime extends RuntimeLease {
  start: () => Promise<void> | void;
  cancelled: () => void;
  failed: (error: unknown) => void;
}

const sharesResource = (left: RuntimeLease, right: RuntimeLease): boolean =>
  left.workspace === right.workspace ||
  (left.gitCommonDirectory !== null && left.gitCommonDirectory === right.gitCommonDirectory);

export const leasesConflict = (left: RuntimeLease, right: RuntimeLease): boolean =>
  sharesResource(left, right) && (left.mode === 'write' || right.mode === 'write');

export const resolveRuntimeLease = async (
  id: string,
  workspacePath: string,
  permissionMode: PermissionMode
): Promise<RuntimeLease> => {
  const workspace = await realpath(workspacePath);
  let gitCommonDirectory: string | null = null;
  try {
    gitCommonDirectory = (await snapshotGitState(workspace)).commonDirectory;
  } catch {
    // Non-Git workspaces lease only their canonical workspace path.
  }
  return {
    id,
    workspace,
    gitCommonDirectory,
    mode: permissionMode === 'workspace-write' ? 'write' : 'read',
  };
};

export class RuntimeScheduler {
  private readonly active = new Map<string, ScheduledRuntime>();
  private readonly queue: ScheduledRuntime[] = [];

  public constructor(public readonly capacity = configuredRuntimeWorkers()) {
    if (
      !Number.isInteger(capacity) ||
      capacity < MIN_RUNTIME_WORKERS ||
      capacity > MAX_RUNTIME_WORKERS
    ) {
      throw new Error(
        `Runtime worker capacity must be between ${MIN_RUNTIME_WORKERS} and ${MAX_RUNTIME_WORKERS}.`
      );
    }
  }

  public enqueue(task: ScheduledRuntime): 'started' | 'queued' {
    if (this.active.has(task.id) || this.queue.some((candidate) => candidate.id === task.id)) {
      throw new Error('This task is already scheduled.');
    }
    if (this.queue.length >= MAX_QUEUED_RUNTIMES) {
      throw new Error('The bounded agent task queue is full.');
    }
    this.queue.push(task);
    this.drain();
    return this.active.has(task.id) ? 'started' : 'queued';
  }

  public cancel(id: string): boolean {
    const index = this.queue.findIndex((candidate) => candidate.id === id);
    if (index < 0) return false;
    const [task] = this.queue.splice(index, 1);
    task?.cancelled();
    this.drain();
    return true;
  }

  public release(id: string): boolean {
    if (!this.active.delete(id)) return false;
    this.drain();
    return true;
  }

  public has(id: string): boolean {
    return this.active.has(id) || this.queue.some((candidate) => candidate.id === id);
  }

  public get activeIds(): string[] {
    return [...this.active.keys()];
  }

  public get queuedIds(): string[] {
    return this.queue.map((candidate) => candidate.id);
  }

  private canStart(task: ScheduledRuntime, queueIndex: number): boolean {
    if (this.active.size >= this.capacity) return false;
    if ([...this.active.values()].some((candidate) => leasesConflict(candidate, task))) {
      return false;
    }
    return !this.queue.slice(0, queueIndex).some((earlier) => leasesConflict(earlier, task));
  }

  private drain(): void {
    let started = true;
    while (started && this.active.size < this.capacity) {
      started = false;
      for (let index = 0; index < this.queue.length; index += 1) {
        const task = this.queue[index];
        if (!task || !this.canStart(task, index)) continue;
        this.queue.splice(index, 1);
        this.active.set(task.id, task);
        started = true;
        void Promise.resolve()
          .then(() => task.start())
          .catch((error) => {
            if (this.active.delete(task.id)) {
              task.failed(error);
              this.drain();
            }
          });
        break;
      }
    }
  }
}
