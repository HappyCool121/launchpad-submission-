import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { access, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import { shell } from 'electron';
import { resolveWorkspacePath } from '../runtime/workspace';
import type { DiffFile } from '../shared/contracts';
import { sha256 } from '../shared/security';
import type { AppDatabase } from './database';

const pathExists = async (path: string): Promise<boolean> => {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
};

const writeAtomically = async (path: string, bytes: Uint8Array): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  const temporary = resolve(dirname(path), `.${basename(path)}.adrouter-revert-${randomUUID()}`);
  try {
    await writeFile(temporary, bytes, { mode: 0o600 });
    await rename(temporary, path);
  } finally {
    if (await pathExists(temporary)) {
      await unlink(temporary);
    }
  }
};

export class ReviewService {
  public constructor(private readonly database: AppDatabase) {}

  public async getDiff(threadId: string, requestedPath?: string): Promise<DiffFile[]> {
    const thread = this.database.getThread(threadId);
    if (!thread) {
      throw new Error('Thread not found.');
    }
    const project = this.database.getProject(thread.projectId);
    if (!project) {
      throw new Error('Project not found.');
    }

    const files: DiffFile[] = [];
    for (const baseline of this.database.listBaselines(threadId)) {
      if (requestedPath && baseline.path !== requestedPath) {
        continue;
      }
      const target = await resolveWorkspacePath(project.path, baseline.path, {
        allowMissing: true,
      });
      const exists = await pathExists(target.absolute);
      const currentBytes = exists ? await readFile(target.absolute) : null;
      const original = baseline.original_bytes
        ? Buffer.from(baseline.original_bytes, 'base64').toString('utf8')
        : '';
      const current = currentBytes ? currentBytes.toString('utf8') : '';
      files.push({
        path: baseline.path,
        status: baseline.latest_status as DiffFile['status'],
        original,
        current,
        baselineHash: baseline.original_hash,
        latestAgentHash: baseline.latest_agent_hash,
        currentHash: currentBytes ? sha256(currentBytes) : null,
      });
    }
    return files;
  }

  public async revertFile(
    threadId: string,
    path: string
  ): Promise<{ reverted: string[]; conflicts: string[] }> {
    const thread = this.database.getThread(threadId);
    if (!thread) {
      throw new Error('Thread not found.');
    }
    const project = this.database.getProject(thread.projectId);
    if (!project) {
      throw new Error('Project not found.');
    }
    const baseline = this.database
      .listBaselines(threadId)
      .find((candidate) => candidate.path === path);
    if (!baseline) {
      throw new Error('No agent baseline exists for this file.');
    }
    const target = await resolveWorkspacePath(project.path, path, { allowMissing: true });
    const exists = await pathExists(target.absolute);
    const current = exists ? await readFile(target.absolute) : null;
    const currentHash = current ? sha256(current) : null;
    if (currentHash !== baseline.latest_agent_hash) {
      this.database.updateBaselineStatus(threadId, path, 'conflict', baseline.latest_agent_hash);
      return { reverted: [], conflicts: [path] };
    }

    if (baseline.original_bytes === null) {
      if (exists) {
        await unlink(target.absolute);
      }
    } else {
      await writeAtomically(target.absolute, Buffer.from(baseline.original_bytes, 'base64'));
    }
    this.database.updateBaselineStatus(threadId, path, 'reverted', baseline.original_hash);
    this.database.appendEvent(threadId, null, 'diff.change', { path, status: 'reverted' });
    return { reverted: [path], conflicts: [] };
  }

  public async revertAll(threadId: string): Promise<{ reverted: string[]; conflicts: string[] }> {
    const reverted: string[] = [];
    const conflicts: string[] = [];
    for (const baseline of this.database.listBaselines(threadId)) {
      const result = await this.revertFile(threadId, baseline.path);
      reverted.push(...result.reverted);
      conflicts.push(...result.conflicts);
    }
    return { reverted, conflicts };
  }

  public accept(threadId: string): void {
    this.database.appendEvent(threadId, null, 'diagnostic', {
      message: 'Agent changes marked as reviewed.',
    });
  }

  public async openFile(threadId: string, path: string): Promise<void> {
    const thread = this.database.getThread(threadId);
    if (!thread) {
      throw new Error('Thread not found.');
    }
    const project = this.database.getProject(thread.projectId);
    if (!project) {
      throw new Error('Project not found.');
    }
    const target = await resolveWorkspacePath(project.path, path);
    const error = await shell.openPath(target.absolute);
    if (error) {
      throw new Error(error);
    }
  }
}
