import type { z } from 'zod';
import { createGitOperationManifest, reviewedHunkPatch } from '../runtime/git-operations';
import {
  ApprovalV2Schema,
  type GitWorkflowPreview,
  GitWorkflowPreviewInputSchema,
  GitWorkflowPreviewSchema,
  GitWorkflowResultSchema,
  type JournalEvent,
} from '../shared/contracts';
import type { AppDatabase } from './database';
import { OperationBroker } from './operation-broker';

const MAX_PENDING_PREVIEWS = 32;

export class GitWorkflowService {
  private readonly previews = new Map<string, GitWorkflowPreview>();

  public constructor(
    private readonly database: AppDatabase,
    private readonly publish: (event: JournalEvent) => void,
    private readonly hasActiveThread: (threadId: string) => boolean,
    private readonly operationBroker = new OperationBroker()
  ) {}

  public async preview(
    raw: z.input<typeof GitWorkflowPreviewInputSchema>
  ): Promise<GitWorkflowPreview> {
    this.prune();
    const input = GitWorkflowPreviewInputSchema.parse(raw);
    const thread = this.database.getThread(input.threadId);
    if (!thread) throw new Error('Thread not found.');
    if (
      this.hasActiveThread(thread.id) ||
      thread.status === 'running' ||
      thread.status === 'awaiting_approval'
    ) {
      throw new Error('Stop the active task before preparing a GUI Git operation.');
    }
    const project = this.database.getProject(thread.projectId);
    if (!project?.git) throw new Error('The selected project is not a Git worktree.');
    if (project.permissionMode !== 'workspace-write') {
      throw new Error('The selected project is read-only.');
    }
    const turn = this.database.listTurns(thread.id).at(-1);
    if (!turn) throw new Error('Start the task before using its Git workflow.');
    const manifest = await createGitOperationManifest({
      capability: input.capability,
      threadId: thread.id,
      turnId: turn.id,
      workspaceRoot: project.path,
      branch: input.branch,
      paths: input.paths,
      path: input.path,
      hunks: input.hunks,
      message: input.message,
      remote: input.remote,
      remoteRef: input.remoteRef,
    });
    const risk = manifest.capability === 'git.push' ? ('high' as const) : ('medium' as const);
    const patchPreview = reviewedHunkPatch(manifest);
    const preview = GitWorkflowPreviewSchema.parse({
      manifest,
      risk,
      patchPreview,
      reason:
        manifest.capability === 'git.stage.hunk'
          ? `Review the exact selected patch below. Patch SHA-256: ${manifest.argv?.[1]}. Before-state binding: ${manifest.binding}. Only the index is changed; filters, hooks, and interactive prompts remain disabled.`
          : `Review one exact ${manifest.capability} operation. Arguments: ${JSON.stringify(
              manifest.argv
            )}. Before-state binding: ${manifest.binding}. Force, reset, ref deletion, hooks, and interactive credential prompts remain disabled.`,
    });
    for (const [id, existing] of this.previews) {
      if (existing.manifest.threadId === thread.id) this.previews.delete(id);
    }
    if (this.previews.size >= MAX_PENDING_PREVIEWS) {
      throw new Error('Too many Git previews are awaiting a decision.');
    }
    this.previews.set(manifest.operationId, preview);
    return preview;
  }

  public async resolve(
    operationId: string,
    decision: 'allow-once' | 'deny'
  ): Promise<z.infer<typeof GitWorkflowResultSchema>> {
    this.prune();
    const preview = this.previews.get(operationId);
    if (!preview) throw new Error('The Git preview is unavailable or expired; review it again.');
    this.previews.delete(operationId);
    const { manifest } = preview;
    if (this.hasActiveThread(manifest.threadId)) {
      throw new Error('The task became active; review the Git operation again after it stops.');
    }
    const approval = ApprovalV2Schema.parse({
      version: 2,
      id: manifest.operationId,
      threadId: manifest.threadId,
      turnId: manifest.turnId,
      kind: 'git-operation',
      argv: manifest.argv,
      path: manifest.targets.map((target) => target.path).join(', ') || null,
      cwd: manifest.workspace,
      risk: preview.risk,
      reason: preview.reason,
      operationManifest: manifest,
      expiresAt: manifest.expiresAt,
      decision: null,
      createdAt: manifest.createdAt,
      resolvedAt: null,
    });
    this.database.createApproval(approval);
    this.publish(
      this.database.appendEvent(manifest.threadId, manifest.turnId, 'approval.request', {
        id: approval.id,
        version: approval.version,
        kind: approval.kind,
        capability: manifest.capability,
        binding: manifest.binding,
        source: 'gui-git',
      })
    );
    const resolved = this.database.resolveApproval(approval.id, decision);
    this.publish(
      this.database.appendEvent(manifest.threadId, manifest.turnId, 'approval.resolved', {
        approvalId: approval.id,
        decision,
        capability: manifest.capability,
        binding: manifest.binding,
        source: 'gui-git',
      })
    );
    if (decision === 'deny') {
      return GitWorkflowResultSchema.parse({ approval: resolved, result: null });
    }
    this.database.consumeOperationApproval(approval.id, manifest.binding);
    try {
      const result = await this.operationBroker.execute(manifest);
      this.publish(
        this.database.appendEvent(manifest.threadId, manifest.turnId, 'operation.completed', {
          operationId: manifest.operationId,
          capability: manifest.capability,
          binding: manifest.binding,
          source: 'gui-git',
          result,
        })
      );
      return GitWorkflowResultSchema.parse({ approval: resolved, result });
    } catch (error) {
      this.publish(
        this.database.appendEvent(manifest.threadId, manifest.turnId, 'diagnostic', {
          message: 'The approved GUI Git operation failed closed after its before-state changed.',
          capability: manifest.capability,
        })
      );
      throw error;
    }
  }

  private prune(): void {
    const current = Date.now();
    for (const [id, preview] of this.previews) {
      if (Date.parse(preview.manifest.expiresAt) <= current) this.previews.delete(id);
    }
  }
}
