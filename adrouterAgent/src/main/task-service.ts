import type { z } from 'zod';
import { delegationArguments } from '../runtime/delegation';
import { captureGitTaskBaseline } from '../runtime/git-operations';
import {
  type Approval,
  type ApprovalDecision,
  type JournalEvent,
  type OperationManifestV1,
  type Turn,
  TurnStartInputSchema,
} from '../shared/contracts';
import { containsSponsorKey, removeSponsorData, safeRecord } from '../shared/security';
import type { ConfigurationStore } from './configuration-store';
import type { AppDatabase } from './database';
import type { RuntimeSupervisor } from './runtime-supervisor';

export class TaskService {
  public constructor(
    private readonly database: AppDatabase,
    private readonly configuration: ConfigurationStore,
    private readonly supervisor: RuntimeSupervisor,
    private readonly publish: (event: JournalEvent) => void
  ) {}

  private publishLast(threadId: string): void {
    const event = this.database.listEvents(threadId).at(-1);
    if (event) this.publish(event);
  }

  public async start(rawInput: z.input<typeof TurnStartInputSchema>): Promise<Turn> {
    const input = TurnStartInputSchema.parse(rawInput);
    const thread = this.database.getThread(input.threadId);
    if (!thread) throw new Error('Thread not found.');
    if (thread.status === 'interrupted' || thread.status === 'blocked') {
      throw new Error('Explicitly continue this interrupted task before starting another turn.');
    }
    const project = this.database.getProject(thread.projectId);
    if (!project) throw new Error('Project not found.');
    const history = this.database.listSessionEntries(input.threadId);
    const storedConfiguration = await this.configuration.get();
    const selectedModel = storedConfiguration.models.find((model) => model.id === input.model);
    if (!selectedModel) throw new Error('The selected model is not available from AdRouter.');
    if (!selectedModel.thinkingLevels.includes(input.thinkingLevel)) {
      throw new Error('The selected thinking level is not supported by this model.');
    }
    const router = await this.configuration.getRuntimeConfiguration();
    this.database.updateThreadPreferences(input.threadId, input.model, input.thinkingLevel);
    const turn = this.database.createTurn(
      input.threadId,
      input.input,
      input.model,
      input.thinkingLevel
    );
    if (project.git && !this.database.getGitTaskBaseline(thread.id)) {
      try {
        this.database.saveGitTaskBaseline(
          await captureGitTaskBaseline({
            workspaceRoot: project.path,
            threadId: thread.id,
            turnId: turn.id,
          })
        );
      } catch {
        this.database.appendEvent(thread.id, turn.id, 'diagnostic', {
          message: 'Task-start Git baseline was unavailable; Git change attribution is limited.',
        });
      }
    }
    const queuedEvent = this.database.listEvents(input.threadId).at(-1);
    this.database.updateTurnStatus(turn.id, 'preparing');
    const preparingEvent = this.database.listEvents(input.threadId).at(-1);
    const userEvent = this.database.appendEvent(input.threadId, turn.id, 'message.user', {
      role: 'user',
      text: input.input,
    });
    this.database.updateThreadStatus(input.threadId, 'running');
    const threadRunningEvent = this.database.listEvents(input.threadId).at(-1);
    for (const event of [queuedEvent, preparingEvent, userEvent, threadRunningEvent]) {
      if (event) this.publish(event);
    }
    try {
      await this.supervisor.start(
        { ...input, model: selectedModel, turnId: turn.id, history },
        router
      );
    } catch (error) {
      this.database.updateTurnStatus(
        turn.id,
        'failed',
        error instanceof Error ? error.message : String(error)
      );
      this.database.updateThreadStatus(input.threadId, 'failed');
      throw error;
    }
    const savedTurn = this.database.getTurn(turn.id);
    if (!savedTurn) throw new Error('Turn could not be loaded after creation.');
    return savedTurn;
  }

  public stop(threadId: string): void {
    this.supervisor.stop(threadId);
  }

  public async compact(threadId: string): Promise<Turn> {
    const thread = this.database.getThread(threadId);
    if (!thread) throw new Error('Thread not found.');
    if (thread.status !== 'idle') {
      throw new Error('Manual compaction requires an idle task with no pending approval.');
    }
    const entries = this.database.listSessionEntries(threadId);
    if (entries.length < 4)
      throw new Error('This task does not yet have enough context to compact.');
    if (entries.some((entry) => containsSponsorKey(entry.payload))) {
      throw new Error('Sponsor-shaped data was rejected from manual compaction.');
    }
    const configuration = await this.configuration.get();
    const descriptor =
      configuration.models.find((model) => model.id === thread.model) ?? configuration.models[0];
    if (!descriptor) throw new Error('No validated model context limit is available.');

    let retainedStart = entries.length;
    let retainedTokens = 0;
    const keepRecentTokens = 32_768;
    while (retainedStart > 1 && retainedTokens < keepRecentTokens) {
      const candidate = entries[retainedStart - 1];
      if (!candidate) break;
      retainedTokens += Math.ceil(JSON.stringify(candidate.payload).length / 4);
      retainedStart -= 1;
    }
    if (retainedStart <= 0) retainedStart = Math.max(1, entries.length - 1);
    const summarized = entries.slice(0, retainedStart);
    if (summarized.length === 0) throw new Error('This task is already at its compacted boundary.');
    const important = summarized.flatMap((entry) => {
      const payload = safeRecord(removeSponsorData(entry.payload));
      const text =
        typeof payload.text === 'string'
          ? payload.text
          : typeof payload.output === 'string'
            ? payload.output
            : typeof payload.summary === 'string'
              ? payload.summary
              : '';
      if (!text) return [];
      const label =
        entry.kind === 'user_message'
          ? 'USER'
          : entry.kind === 'assistant_message'
            ? 'ASSISTANT'
            : entry.kind === 'tool_result'
              ? `TOOL ${typeof payload.name === 'string' ? payload.name : ''}`
              : 'CHECKPOINT';
      return [`${label}: ${text.slice(0, 1_500)}`];
    });
    const summary = [
      'Manual deterministic context checkpoint. Re-read files before relying on stale details.',
      ...important,
    ]
      .join('\n\n')
      .slice(0, 8_192);
    const retainedMessages = entries.slice(retainedStart).flatMap((entry) => {
      const payload = safeRecord(removeSponsorData(entry.payload));
      if (entry.kind === 'user_message' && typeof payload.text === 'string') {
        return [{ role: 'user', text: payload.text, timestamp: Date.parse(entry.timestamp) }];
      }
      if (entry.kind === 'assistant_message' && typeof payload.text === 'string') {
        return [
          {
            role: 'assistant',
            text: payload.text,
            content: Array.isArray(payload.content) ? payload.content : [],
            model: typeof payload.model === 'string' ? payload.model : thread.model,
            usage: safeRecord(payload.usage),
            timestamp: Date.parse(entry.timestamp),
          },
        ];
      }
      if (
        entry.kind === 'tool_result' &&
        typeof payload.toolCallId === 'string' &&
        typeof payload.name === 'string' &&
        typeof payload.output === 'string'
      ) {
        return [
          {
            role: 'toolResult',
            toolCallId: payload.toolCallId,
            toolName: payload.name,
            text: payload.output,
            isError: Boolean(payload.isError),
            timestamp: Date.parse(entry.timestamp),
          },
        ];
      }
      return [];
    });
    const tokensBefore = Math.ceil(
      entries.reduce((total, entry) => total + JSON.stringify(entry.payload).length, 0) / 4
    );
    const tokensAfter = Math.ceil((summary.length + JSON.stringify(retainedMessages).length) / 4);
    const turn = this.database.createTurn(
      threadId,
      'Manual context compaction',
      thread.model,
      thread.thinkingLevel,
      'compaction'
    );
    this.database.updateTurnStatus(turn.id, 'running');
    this.publishLast(threadId);
    this.database.updateThreadStatus(threadId, 'running');
    this.publishLast(threadId);
    const compaction = this.database.appendEvent(threadId, turn.id, 'compaction', {
      outcome: 'completed',
      maintenance: true,
      modelAssisted: false,
      summaryMaxTokens: 2_048,
      droppedMessages: summarized.length,
      tokensBefore,
      tokensAfter,
      maxInputTokens: descriptor.maxInputTokens,
      summary,
      retainedMessages,
    });
    this.publish(compaction);
    const budget = this.database.appendEvent(threadId, turn.id, 'context.budget', {
      estimatedTokens: tokensAfter,
      maxInputTokens: descriptor.maxInputTokens,
      compactionThreshold: Math.max(1, descriptor.maxInputTokens - 16_384),
      reserveTokens: 16_384,
      status: tokensAfter > descriptor.maxInputTokens ? 'overflow' : 'ok',
      source: 'compaction',
    });
    this.publish(budget);
    const checkpoint = this.database.appendEvent(threadId, turn.id, 'session.checkpoint', {
      safe: true,
      maintenance: true,
      model: thread.model,
    });
    this.publish(checkpoint);
    this.database.updateTurnStatus(turn.id, 'completed');
    this.publishLast(threadId);
    this.database.updateThreadStatus(threadId, 'idle');
    this.publishLast(threadId);
    return this.database.getTurn(turn.id) ?? turn;
  }

  public resolveApproval(approvalId: string, decision: ApprovalDecision): Approval {
    this.supervisor.assertApprovalActive(approvalId);
    const approval = this.database.resolveApproval(approvalId, decision);
    const event = this.database.appendEvent(
      approval.threadId,
      approval.turnId,
      'approval.resolved',
      {
        approvalId: approval.id,
        decision: approval.decision,
        ...(approval.operationManifest
          ? {
              capability: approval.operationManifest.capability,
              binding: approval.operationManifest.binding,
            }
          : {}),
      }
    );
    this.publish(event);
    this.database.updateTurnStatus(approval.turnId, 'running');
    this.publishLast(approval.threadId);
    this.database.updateThreadStatus(approval.threadId, 'running');
    this.publishLast(approval.threadId);
    this.supervisor.resolveApproval(approval.id, decision);
    return approval;
  }

  public async startDelegated(manifest: OperationManifestV1): Promise<Record<string, unknown>> {
    const { title, prompt } = delegationArguments(manifest);
    const parent = this.database.getThread(manifest.threadId);
    if (!parent) throw new Error('Delegating task not found.');
    const project = this.database.getProject(parent.projectId);
    if (!project || project.path !== manifest.workspace) {
      throw new Error('The delegated task workspace binding is invalid.');
    }
    if (!project.delegationEnabled) {
      throw new Error('Delegated tasks are disabled for this project.');
    }
    if (parent.parentThreadId && !parent.forkedFromCheckpointId) {
      throw new Error('Delegated child tasks cannot delegate again.');
    }
    const children = this.database
      .listThreads(project.id)
      .filter((thread) => thread.parentThreadId === parent.id && !thread.forkedFromCheckpointId);
    if (children.length >= 3) {
      throw new Error('This task already owns the maximum of three delegated children.');
    }
    const child = this.database.createThread({
      projectId: project.id,
      parentThreadId: parent.id,
      title,
      label: 'Delegated',
      model: parent.model,
      thinkingLevel: parent.thinkingLevel,
    });
    try {
      const turn = await this.start({
        threadId: child.id,
        input: prompt,
        model: parent.model,
        thinkingLevel: parent.thinkingLevel,
        runtimeMode: 'auto',
      });
      return {
        childThreadId: child.id,
        childTurnId: turn.id,
        status: 'queued',
        ownership: { parentThreadId: parent.id, depth: 1, maximumChildren: 3 },
      };
    } catch (error) {
      this.database.deleteThread(child.id);
      throw error;
    }
  }
}
