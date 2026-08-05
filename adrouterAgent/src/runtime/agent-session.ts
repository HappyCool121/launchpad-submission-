import {
  Agent,
  type AgentEvent,
  type AgentMessage,
  createCompactionSummaryMessage,
  estimateTokens,
  generateSummary,
} from '@earendil-works/pi-agent-core';
import {
  type Api,
  type AssistantMessage,
  type Context,
  createModels,
  type Model,
  type Models,
  type Tool,
} from '@earendil-works/pi-ai';
import {
  AgentSession,
  AuthStorage,
  DefaultResourceLoader,
  ModelRegistry,
  SessionManager,
  SettingsManager,
} from '@earendil-works/pi-coding-agent';
import type { ApprovalDecision, OperationManifestV1, Sponsor } from '../shared/contracts';
import type { RuntimeEvent, RuntimeStartSchema } from '../shared/runtime-protocol';
import { containsSponsorKey, now, removeSponsorData, safeRecord } from '../shared/security';
import { SandboxedCommandRunner } from './command-runner';
import {
  COMPACTION_SETTINGS,
  CONTEXT_RESERVE_TOKENS,
  contextBudgetSnapshot,
  contextNeedsCompaction,
  estimateContextBudget,
  KEEP_RECENT_TOKENS,
} from './context-budget';
import { createAdRouterPiProvider } from './pi-provider';
import { sandboxReadiness } from './platform';
import {
  AdRouterClient,
  type ProtectedRouterHeaders,
  type ProtectedRouterRequest,
} from './router-client';
import { createDesktopTools, type ToolApproval } from './tools';

type RuntimeStart = typeof RuntimeStartSchema._output;

const toText = (content: unknown): string => {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }
  return content
    .filter((block): block is { type: 'text'; text: string } =>
      Boolean(block && typeof block === 'object' && (block as { type?: unknown }).type === 'text')
    )
    .map((block) => block.text)
    .join('');
};

const normalizeUsage = (value: unknown): AssistantMessage['usage'] => {
  const usage = safeRecord(value);
  const amount = (candidate: unknown): number =>
    typeof candidate === 'number' && Number.isFinite(candidate) && candidate >= 0 ? candidate : 0;
  return {
    input: amount(usage.input),
    output: amount(usage.output),
    cacheRead: amount(usage.cacheRead),
    cacheWrite: amount(usage.cacheWrite),
    totalTokens: amount(usage.totalTokens),
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    },
  };
};

export const toAgentThinkingLevel = (
  level: RuntimeStart['thinkingLevel']
): 'off' | 'medium' | 'high' => (level === 'none' ? 'off' : level);

export const normalizeAssistantContent = (value: unknown): AssistantMessage['content'] => {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.flatMap((rawBlock): AssistantMessage['content'] => {
    const block = safeRecord(rawBlock);
    if (block.type === 'text' && typeof block.text === 'string') {
      return [{ type: 'text', text: block.text }];
    }
    if (
      block.type === 'toolCall' &&
      typeof block.id === 'string' &&
      typeof block.name === 'string'
    ) {
      return [
        {
          type: 'toolCall',
          id: block.id,
          name: block.name,
          arguments: safeRecord(removeSponsorData(block.arguments)),
        },
      ];
    }
    // Hidden thinking is deliberately not persisted or reconstructed.
    return [];
  });
};

const serializeContextMessage = (message: AgentMessage): Record<string, unknown> | undefined => {
  if (containsSponsorKey(message)) return undefined;
  if (message.role === 'user') {
    return { role: 'user', text: toText(message.content), timestamp: message.timestamp };
  }
  if (message.role === 'assistant') {
    return {
      role: 'assistant',
      text: toText(message.content),
      content: normalizeAssistantContent(message.content),
      model: message.model,
      usage: normalizeUsage(message.usage),
      timestamp: message.timestamp,
    };
  }
  if (message.role === 'toolResult') {
    return {
      role: 'toolResult',
      toolCallId: message.toolCallId,
      toolName: message.toolName,
      text: toText(message.content),
      isError: message.isError,
      timestamp: message.timestamp,
    };
  }
  if (message.role === 'compactionSummary') {
    return {
      role: 'compactionSummary',
      summary: message.summary,
      tokensBefore: message.tokensBefore,
      timestamp: message.timestamp,
    };
  }
  return undefined;
};

const deserializeContextMessages = (value: unknown): AgentMessage[] => {
  if (!Array.isArray(value)) return [];
  return value.flatMap((candidate): AgentMessage[] => {
    if (containsSponsorKey(candidate)) return [];
    const message = safeRecord(candidate);
    const timestamp =
      typeof message.timestamp === 'number' && Number.isFinite(message.timestamp)
        ? message.timestamp
        : Date.now();
    if (message.role === 'user' && typeof message.text === 'string') {
      return [{ role: 'user', content: message.text, timestamp }];
    }
    if (message.role === 'assistant' && typeof message.text === 'string') {
      const content = normalizeAssistantContent(message.content);
      return [
        {
          role: 'assistant',
          content: content.length > 0 ? content : [{ type: 'text', text: message.text }],
          api: 'adrouter',
          provider: 'adrouter',
          model: typeof message.model === 'string' ? message.model : 'unknown',
          usage: normalizeUsage(message.usage),
          stopReason: content.some((block) => block.type === 'toolCall') ? 'toolUse' : 'stop',
          timestamp,
        },
      ];
    }
    if (
      message.role === 'toolResult' &&
      typeof message.toolCallId === 'string' &&
      typeof message.toolName === 'string' &&
      typeof message.text === 'string'
    ) {
      return [
        {
          role: 'toolResult',
          toolCallId: message.toolCallId,
          toolName: message.toolName,
          content: [{ type: 'text', text: message.text }],
          isError: Boolean(message.isError),
          timestamp,
        },
      ];
    }
    if (message.role === 'compactionSummary' && typeof message.summary === 'string') {
      return [
        {
          role: 'compactionSummary',
          summary: message.summary,
          tokensBefore: typeof message.tokensBefore === 'number' ? message.tokensBefore : 0,
          timestamp,
        },
      ];
    }
    return [];
  });
};

export const historyToMessages = (history: RuntimeStart['history']): AgentMessage[] => {
  let messages: AgentMessage[] = [];
  const latestCompaction = history.findLast(
    (entry) => entry.kind === 'compaction' && typeof entry.payload.summary === 'string'
  );
  if (latestCompaction) {
    messages = deserializeContextMessages(latestCompaction.payload.retainedMessages);
    if (messages.length === 0 && typeof latestCompaction.payload.summary === 'string') {
      messages.push(
        createCompactionSummaryMessage(
          latestCompaction.payload.summary,
          typeof latestCompaction.payload.tokensBefore === 'number'
            ? latestCompaction.payload.tokensBefore
            : 0,
          latestCompaction.timestamp
        )
      );
    }
  }

  for (const entry of history) {
    if (containsSponsorKey(entry.payload) || entry.kind === 'context_anchor') continue;
    if (entry.kind === 'compaction') continue;
    if (latestCompaction && entry.ordinal <= latestCompaction.ordinal) continue;
    if (entry.kind === 'user_message' && typeof entry.payload.text === 'string') {
      messages.push({
        role: 'user',
        content: entry.payload.text,
        timestamp: Date.parse(entry.timestamp),
      });
    }
    if (entry.kind === 'assistant_message' && typeof entry.payload.text === 'string') {
      const structuredContent = normalizeAssistantContent(entry.payload.content);
      messages.push({
        role: 'assistant',
        content:
          structuredContent.length > 0
            ? structuredContent
            : [{ type: 'text', text: entry.payload.text }],
        api: 'adrouter',
        provider: 'adrouter',
        model: typeof entry.payload.model === 'string' ? entry.payload.model : 'unknown',
        usage: normalizeUsage(entry.payload.usage),
        stopReason: structuredContent.some((block) => block.type === 'toolCall')
          ? 'toolUse'
          : 'stop',
        timestamp: Date.parse(entry.timestamp),
      });
    }
    if (entry.kind === 'tool_result') {
      const payload = safeRecord(entry.payload);
      const toolCallId = typeof payload.toolCallId === 'string' ? payload.toolCallId : undefined;
      const toolName = typeof payload.name === 'string' ? payload.name : undefined;
      const toolOutput = typeof payload.output === 'string' ? payload.output : undefined;
      if (toolCallId && toolName && toolOutput) {
        messages.push({
          role: 'toolResult',
          toolCallId,
          toolName,
          content: [{ type: 'text', text: toolOutput }],
          isError: Boolean(payload.isError),
          timestamp: Date.parse(entry.timestamp),
        });
      }
    }
  }
  return messages;
};

const systemPrompt = (input: RuntimeStart): string =>
  [
    'You are AdRouter Agent, a careful desktop coding agent.',
    'Work only through the supplied desktop tools. Do not ask for shell strings; use argv arrays.',
    'Respect repository instructions and project permissions. Explain plans and final evidence concisely.',
    'Never discuss, request, infer, or use sponsor data. Sponsorship is not part of your task context.',
    input.project.repositoryInstructions
      ? `Repository instructions:\n${input.project.repositoryInstructions}`
      : '',
    input.project.instructions ? `User project instructions:\n${input.project.instructions}` : '',
    input.project.bundleInstructions
      ? `Trusted bundled declarative guidance:\n${input.project.bundleInstructions}`
      : '',
  ]
    .filter(Boolean)
    .join('\n\n');

const describeImportantMessage = (message: AgentMessage): string | undefined => {
  if (!('content' in message)) {
    return undefined;
  }
  if (message.role === 'user') {
    return `USER GOAL OR CONSTRAINT:\n${toText(message.content)}`;
  }
  if (message.role === 'toolResult') {
    const text = toText(message.content);
    if (message.isError) {
      return `UNRESOLVED TOOL ERROR (${message.toolName}):\n${text}`;
    }
    if (message.toolName === 'apply_patch') {
      return `RECORDED FILE MODIFICATION:\n${text}`;
    }
    if (message.toolName === 'run_command' && /"exitCode":(?!0\b)/.test(text)) {
      return `UNRESOLVED COMMAND FAILURE:\n${text}`;
    }
    return undefined;
  }
  const text = toText(message.content);
  if (/\b(plan|acceptance criteria|in progress|pending|todo)\b/i.test(text)) {
    return `RECORDED PLAN CONTEXT:\n${text}`;
  }
  return undefined;
};

const historyAnchors = (history: RuntimeStart['history']): string[] =>
  history.flatMap((entry) => {
    if (entry.kind !== 'context_anchor' || containsSponsorKey(entry.payload)) return [];
    const eventType = entry.payload.eventType;
    const value = entry.payload.value;
    if (eventType === 'approval.resolved') {
      return [`APPROVAL DECISION: ${JSON.stringify(value)}`];
    }
    if (eventType === 'file.change' || eventType === 'diff.change') {
      return [`FILE STATE: ${JSON.stringify(value)}`];
    }
    if (eventType === 'operation.completed') {
      return [`STRUCTURED OPERATION: ${JSON.stringify(value)}`];
    }
    if (eventType === 'runtime.crash') {
      return [`UNRESOLVED RUNTIME ERROR: ${JSON.stringify(value)}`];
    }
    return [];
  });

interface MessageUnit {
  start: number;
  end: number;
  tokens: number;
}

export interface ContextCompactionState {
  summary: string | null;
  summarizedSourceCount: number;
  lastSummarizedSignature: string | null;
}

export const createContextCompactionState = (): ContextCompactionState => ({
  summary: null,
  summarizedSourceCount: 0,
  lastSummarizedSignature: null,
});

export interface CompactMessagesOptions {
  model: RuntimeStart['model'];
  systemPrompt: string;
  tools: readonly Tool[];
  models?: Models;
  providerModel?: Model<Api>;
  signal?: AbortSignal;
  state?: ContextCompactionState;
  force?: boolean;
}

const messageUnits = (messages: AgentMessage[]): MessageUnit[] => {
  const units: MessageUnit[] = [];
  let index = 0;
  while (index < messages.length) {
    const message = messages[index];
    let end = index + 1;
    if (message?.role === 'assistant') {
      const callIds = new Set(
        message.content.flatMap((block) => (block.type === 'toolCall' ? [block.id] : []))
      );
      while (end < messages.length) {
        const next = messages[end];
        if (next?.role !== 'toolResult' || !callIds.has(next.toolCallId)) break;
        end += 1;
      }
    }
    units.push({
      start: index,
      end,
      tokens: messages
        .slice(index, end)
        .reduce((total, candidate) => total + estimateTokens(candidate), 0),
    });
    index = end;
  }
  return units;
};

const recentBoundary = (messages: AgentMessage[], keepTokens: number): number => {
  const units = messageUnits(messages);
  if (units.length <= 1) return 0;
  let tokens = 0;
  let firstKeptUnit = units.length - 1;
  for (let index = units.length - 1; index >= 0; index -= 1) {
    const unit = units[index];
    if (!unit) continue;
    tokens += unit.tokens;
    firstKeptUnit = index;
    if (tokens >= keepTokens) break;
  }
  return units[firstKeptUnit]?.start ?? 0;
};

const boundedText = (value: string, maximumCharacters: number): string => {
  if (value.length <= maximumCharacters) return value;
  const prefixLength = Math.floor(maximumCharacters * 0.6);
  const suffixLength = Math.max(0, maximumCharacters - prefixLength - 100);
  return `${value.slice(0, prefixLength)}\n\n[bounded context omitted ${
    value.length - prefixLength - suffixLength
  } characters]\n\n${value.slice(-suffixLength)}`;
};

const messageSignature = (message: AgentMessage | undefined): string | null => {
  if (!message) return null;
  const content = 'content' in message ? toText(message.content) : '';
  return `${message.role}:${message.timestamp}:${content.slice(0, 256)}:${content.length}`;
};

const sanitizeSummaryMessage = (message: AgentMessage): AgentMessage => {
  const sanitized = removeSponsorData(message) as AgentMessage;
  if (sanitized.role !== 'assistant') return sanitized;
  return {
    ...sanitized,
    content: sanitized.content.filter((block) => block.type !== 'thinking'),
  };
};

const summarySurrogate = (message: AgentMessage, tokenLimit: number): AgentMessage => {
  const serialized = (() => {
    try {
      return JSON.stringify(removeSponsorData(message));
    } catch {
      return `[unserializable ${message.role} message]`;
    }
  })();
  return {
    role: 'user',
    content: `Oversized ${message.role} context, bounded for checkpoint generation:\n${boundedText(
      serialized,
      Math.max(1_024, tokenLimit * 3)
    )}`,
    timestamp: message.timestamp,
  };
};

const summaryChunks = (messages: AgentMessage[], tokenLimit: number): AgentMessage[][] => {
  const chunks: AgentMessage[][] = [];
  let current: AgentMessage[] = [];
  let currentTokens = 0;
  for (const original of messages) {
    if (containsSponsorKey(original)) continue;
    let message = sanitizeSummaryMessage(original);
    let tokens = estimateTokens(message);
    if (tokens > tokenLimit) {
      message = summarySurrogate(message, tokenLimit);
      tokens = estimateTokens(message);
    }
    if (current.length > 0 && currentTokens + tokens > tokenLimit) {
      chunks.push(current);
      current = [];
      currentTokens = 0;
    }
    current.push(message);
    currentTokens += tokens;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
};

const durableFallbackSummary = (
  messages: AgentMessage[],
  anchors: readonly string[],
  previousSummary: string | null
): string => {
  const retained = messages
    .map(describeImportantMessage)
    .filter((value): value is string => Boolean(value))
    .map((value) => boundedText(value, 4_096));
  return boundedText(
    [
      previousSummary ? `PREVIOUS CHECKPOINT:\n${previousSummary}` : '',
      'Earlier verbose context was compacted into a deterministic checkpoint.',
      ...anchors.map((anchor) => boundedText(anchor, 2_048)),
      ...retained,
      'Continue from the recent messages and re-read files before relying on stale details.',
    ]
      .filter(Boolean)
      .join('\n\n'),
    48_000
  );
};

const appendMissingAnchors = (summary: string, anchors: readonly string[]): string => {
  const missing = anchors.filter((anchor) => !summary.includes(anchor));
  if (missing.length === 0) return boundedText(summary, 48_000);
  return boundedText(
    `${summary}\n\n## Durable Agent Anchors\n${missing
      .map((anchor) => `- ${boundedText(anchor, 2_048)}`)
      .join('\n')}`,
    48_000
  );
};

const updateSummary = async (
  messages: AgentMessage[],
  anchors: readonly string[],
  previousSummary: string | null,
  options: CompactMessagesOptions
): Promise<{ summary: string; modelAssisted: boolean; error: string | null }> => {
  if (messages.length === 0 && previousSummary) {
    return {
      summary: appendMissingAnchors(previousSummary, anchors),
      modelAssisted: true,
      error: null,
    };
  }
  const chunkLimit = Math.min(
    64_000,
    Math.max(1_024, options.model.maxInputTokens - CONTEXT_RESERVE_TOKENS - 8_192)
  );
  if (
    !options.models ||
    !options.providerModel ||
    options.model.maxInputTokens <= CONTEXT_RESERVE_TOKENS + 8_192
  ) {
    return {
      summary: durableFallbackSummary(messages, anchors, previousSummary),
      modelAssisted: false,
      error: null,
    };
  }

  let summary = previousSummary ?? undefined;
  for (const chunk of summaryChunks(messages, chunkLimit)) {
    const result = await generateSummary(
      chunk,
      options.models,
      options.providerModel,
      CONTEXT_RESERVE_TOKENS,
      options.signal,
      'Preserve user constraints, exact paths, completed edits, unresolved failures, and approval outcomes. Omit hidden reasoning and any display-only accounting data.',
      summary,
      'off'
    );
    if (!result.ok || !result.value.trim()) {
      const error = result.ok ? 'Checkpoint summarization returned no text.' : result.error.message;
      return {
        summary: durableFallbackSummary(messages, anchors, previousSummary),
        modelAssisted: false,
        error,
      };
    }
    summary = result.value.trim();
  }

  return {
    summary: appendMissingAnchors(
      summary ?? durableFallbackSummary(messages, anchors, previousSummary),
      anchors
    ),
    modelAssisted: true,
    error: null,
  };
};

export const compactMessages = async (
  messages: AgentMessage[],
  emit: (event: RuntimeEvent) => void,
  anchors: readonly string[],
  options: CompactMessagesOptions
): Promise<AgentMessage[]> => {
  const before = estimateContextBudget(
    messages,
    options.systemPrompt,
    options.tools,
    options.model
  );
  emit({
    type: 'context.budget',
    turnId: null,
    timestamp: now(),
    payload: contextBudgetSnapshot(before),
  });
  if (!contextNeedsCompaction(before) && !options.force) return messages;

  const state = options.state ?? createContextCompactionState();
  const initialKeepTokens = Math.max(
    1_024,
    Math.min(
      KEEP_RECENT_TOKENS,
      before.compactionThreshold - before.fixedTokens - CONTEXT_RESERVE_TOKENS / 2
    )
  );
  let boundary = recentBoundary(messages, initialKeepTokens);
  if (boundary <= 0) return messages;

  const previousPrefixMessage = messages[state.summarizedSourceCount - 1];
  if (
    state.summarizedSourceCount > boundary ||
    (state.summarizedSourceCount > 0 &&
      messageSignature(previousPrefixMessage) !== state.lastSummarizedSignature)
  ) {
    state.summary = null;
    state.summarizedSourceCount = 0;
    state.lastSummarizedSignature = null;
  }

  let summaryResult = await updateSummary(
    messages.slice(state.summarizedSourceCount, boundary),
    anchors,
    state.summary,
    options
  );
  state.summary = summaryResult.summary;
  state.summarizedSourceCount = boundary;
  state.lastSummarizedSignature = messageSignature(messages[boundary - 1]);

  let summaryMessage = createCompactionSummaryMessage(state.summary, before.tokens, now());
  let compacted: AgentMessage[] = [summaryMessage, ...messages.slice(boundary)];
  let after = estimateContextBudget(compacted, options.systemPrompt, options.tools, options.model);

  if (after.tokens > after.compactionThreshold) {
    const summaryTokens = estimateTokens(summaryMessage);
    const tighterKeepTokens = Math.max(
      1_024,
      after.compactionThreshold - after.fixedTokens - summaryTokens - 1_024
    );
    const tighterBoundary = recentBoundary(messages, tighterKeepTokens);
    if (tighterBoundary > boundary) {
      const tighterSummary = await updateSummary(
        messages.slice(boundary, tighterBoundary),
        anchors,
        state.summary,
        options
      );
      summaryResult = {
        summary: tighterSummary.summary,
        modelAssisted: summaryResult.modelAssisted && tighterSummary.modelAssisted,
        error: summaryResult.error ?? tighterSummary.error,
      };
      state.summary = tighterSummary.summary;
      state.summarizedSourceCount = tighterBoundary;
      state.lastSummarizedSignature = messageSignature(messages[tighterBoundary - 1]);
      boundary = tighterBoundary;
      summaryMessage = createCompactionSummaryMessage(state.summary, before.tokens, now());
      compacted = [summaryMessage, ...messages.slice(boundary)];
      after = estimateContextBudget(compacted, options.systemPrompt, options.tools, options.model);
    }
  }

  emit({
    type: 'compaction',
    turnId: null,
    timestamp: now(),
    payload: {
      outcome: after.tokens <= after.maxInputTokens ? 'completed' : 'overflow',
      droppedMessages: boundary,
      tokensBefore: before.tokens,
      tokensAfter: after.tokens,
      maxInputTokens: after.maxInputTokens,
      reserveTokens: COMPACTION_SETTINGS.reserveTokens,
      keepRecentTokens: initialKeepTokens,
      modelAssisted: summaryResult.modelAssisted,
      summaryError: summaryResult.error,
      summary: state.summary,
      retainedMessages: compacted
        .map(serializeContextMessage)
        .filter((message): message is Record<string, unknown> => Boolean(message)),
    },
  });
  emit({
    type: 'context.budget',
    turnId: null,
    timestamp: now(),
    payload: contextBudgetSnapshot(after, 'compaction'),
  });
  return compacted;
};

export class DesktopAgentSession {
  private session?: AgentSession;
  private currentSponsor: Sponsor | null = null;
  private readonly pendingApprovals = new Map<
    string,
    { resolve: (decision: ApprovalDecision) => void; cleanup: () => void }
  >();
  private stopped = false;
  private queuedFollowUps = 0;
  private readonly compactionAnchors: string[];
  private readonly compactionState = createContextCompactionState();

  public constructor(
    private readonly start: RuntimeStart,
    private readonly emit: (event: RuntimeEvent) => void,
    private readonly authorize?: (
      request: ProtectedRouterRequest
    ) => Promise<ProtectedRouterHeaders>,
    private readonly executeOperation?: (
      manifest: OperationManifestV1,
      signal?: AbortSignal
    ) => Promise<Record<string, unknown>>
  ) {
    this.compactionAnchors = historyAnchors(start.history);
  }

  public async run(): Promise<void> {
    const router = new AdRouterClient({
      serverUrl: this.start.router.serverUrl,
      authentication:
        this.start.router.authMode === 'installation'
          ? {
              mode: 'installation',
              authorize:
                this.authorize ??
                (() =>
                  Promise.reject(new Error('The installation signing broker is unavailable.'))),
            }
          : { mode: 'custom_bearer', token: this.start.router.token },
    });
    let compactForInputLimit:
      | ((context: Context, signal?: AbortSignal) => Promise<Context | null>)
      | undefined;
    const provider = createAdRouterPiProvider({
      client: router,
      model: this.start.model,
      thinkingLevel: this.start.thinkingLevel,
      runtimeMode: this.start.runtimeMode,
      projectDisplayName: this.start.project.displayName,
      adsEnabled: this.start.sponsoredCompute,
      onSponsor: (sponsor) => {
        this.currentSponsor = sponsor as Sponsor;
        this.emit({
          type: 'sponsor.update',
          turnId: this.start.turnId,
          timestamp: now(),
          payload: safeRecord(sponsor),
        });
      },
      onSettlement: (settlement) => {
        this.emit({
          type: 'settlement',
          turnId: this.start.turnId,
          timestamp: now(),
          payload: { ...settlement, sponsor: this.currentSponsor },
        });
      },
      onContextOverflow: (estimate) => {
        this.emit({
          type: 'compaction',
          turnId: this.start.turnId,
          timestamp: now(),
          payload: {
            outcome: 'overflow',
            code: 'context_overflow',
            tokensBefore: estimate.tokens,
            maxInputTokens: estimate.maxInputTokens,
            fixedTokens: estimate.fixedTokens,
            dispatched: false,
          },
        });
      },
      compactForInputLimit: (context, signal) =>
        compactForInputLimit ? compactForInputLimit(context, signal) : Promise.resolve(null),
      onSafeRetry: () => {
        this.emit({
          type: 'retry',
          turnId: this.start.turnId,
          timestamp: now(),
          payload: {
            reason: 'input_limit_exceeded',
            attempt: 1,
            maxAttempts: 1,
            consumedEvents: 0,
          },
        });
      },
    });

    const commandRunner = new SandboxedCommandRunner();
    const sandbox = sandboxReadiness();
    const tools = createDesktopTools({
      workspaceRoot: this.start.project.path,
      permissionMode: this.start.project.permissionMode,
      threadId: this.start.threadId,
      turnId: this.start.turnId,
      commandRunner,
      allowedCommands: this.start.allowedCommands,
      commandsEnabled: sandbox.status === 'ready',
      delegationEnabled: this.start.project.delegationEnabled,
      executeOperation: this.executeOperation,
      requestApproval: (approval, signal) => this.requestApproval(approval, signal),
      emit: (type, payload) =>
        this.emit({ type, turnId: this.start.turnId, timestamp: now(), payload }),
    });
    const agentSystemPrompt = systemPrompt(this.start);
    this.emit({
      type: 'diagnostic',
      turnId: this.start.turnId,
      timestamp: now(),
      payload: {
        message: 'Active prompt sources were resolved before this task started.',
        promptSources: this.start.project.promptSources,
      },
    });
    const models = createModels();
    models.setProvider(provider.provider);
    compactForInputLimit = async (context, signal) => ({
      ...context,
      messages: (await compactMessages(
        context.messages as AgentMessage[],
        this.emit,
        this.compactionAnchors,
        {
          model: this.start.model,
          systemPrompt: agentSystemPrompt,
          tools,
          signal,
          state: this.compactionState,
          force: true,
        }
      )) as Context['messages'],
    });

    const agent = new Agent({
      initialState: {
        model: provider.model,
        thinkingLevel: toAgentThinkingLevel(this.start.thinkingLevel),
        systemPrompt: agentSystemPrompt,
        tools,
        messages: historyToMessages(this.start.history),
      },
      streamFn: provider.stream,
      steeringMode: 'one-at-a-time',
      followUpMode: 'one-at-a-time',
      toolExecution: 'sequential',
      transformContext: (messages, signal) =>
        compactMessages(messages, this.emit, this.compactionAnchors, {
          model: this.start.model,
          systemPrompt: agentSystemPrompt,
          tools,
          models,
          providerModel: provider.model,
          signal,
          state: this.compactionState,
        }),
    });
    const authStorage = AuthStorage.inMemory({ adrouter: { type: 'api_key', key: 'runtime' } });
    const modelRegistry = ModelRegistry.inMemory(authStorage);
    modelRegistry.registerProvider('adrouter', {
      name: 'AdRouter',
      baseUrl: provider.model.baseUrl,
      apiKey: 'runtime',
      api: provider.model.api,
      streamSimple: provider.stream,
      models: [provider.model],
    });
    const settingsManager = SettingsManager.inMemory({
      steeringMode: 'one-at-a-time',
      followUpMode: 'one-at-a-time',
    });
    const resourceLoader = new DefaultResourceLoader({
      cwd: this.start.project.path,
      agentDir: this.start.project.path,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPrompt: agentSystemPrompt,
    });
    this.session = new AgentSession({
      agent,
      sessionManager: SessionManager.inMemory(this.start.project.path),
      settingsManager,
      cwd: this.start.project.path,
      resourceLoader,
      modelRegistry,
      baseToolsOverride: Object.fromEntries(tools.map((tool) => [tool.name, tool])),
      allowedToolNames: tools.map((tool) => tool.name),
    });
    this.session.subscribe((event) => this.forwardAgentEvent(event as AgentEvent));

    this.emit({
      type: 'turn.lifecycle',
      turnId: this.start.turnId,
      timestamp: now(),
      payload: { status: 'running' },
    });
    try {
      await this.session.prompt(this.start.input, { expandPromptTemplates: false });
      const status =
        this.stopped || this.session.state.errorMessage
          ? this.stopped
            ? 'cancelled'
            : 'failed'
          : 'completed';
      this.emit({
        type: 'turn.lifecycle',
        turnId: this.start.turnId,
        timestamp: now(),
        payload: { status, error: this.session.state.errorMessage ?? null },
      });
    } catch (error) {
      this.emit({
        type: 'turn.lifecycle',
        turnId: this.start.turnId,
        timestamp: now(),
        payload: {
          status: this.stopped ? 'cancelled' : 'failed',
          error: error instanceof Error ? error.message : String(error),
        },
      });
    } finally {
      await commandRunner.reset().catch(() => undefined);
    }
  }

  public steer(input: string): void {
    this.emit({
      type: 'message.user',
      turnId: this.start.turnId,
      timestamp: now(),
      payload: { role: 'user', text: input, mode: 'steer' },
    });
    void this.session?.steer(input);
  }

  public queueFollowUp(input: string): void {
    this.emit({
      type: 'message.user',
      turnId: this.start.turnId,
      timestamp: now(),
      payload: { role: 'user', text: input, mode: 'follow-up' },
    });
    void this.session?.followUp(input);
    this.queuedFollowUps += 1;
    this.emit({
      type: 'queue.update',
      turnId: this.start.turnId,
      timestamp: now(),
      payload: { queued: this.queuedFollowUps, action: 'queued' },
    });
  }

  public clearQueue(): void {
    this.session?.clearQueue();
    this.queuedFollowUps = 0;
    this.emit({
      type: 'queue.update',
      turnId: this.start.turnId,
      timestamp: now(),
      payload: { queued: 0, action: 'cleared' },
    });
  }

  public stop(): void {
    this.stopped = true;
    this.session?.clearQueue();
    void this.session?.abort();
    for (const [, pending] of this.pendingApprovals) {
      pending.cleanup();
      pending.resolve('deny');
    }
    this.pendingApprovals.clear();
  }

  public resolveApproval(approvalId: string, decision: ApprovalDecision): boolean {
    const pending = this.pendingApprovals.get(approvalId);
    if (!pending) {
      return false;
    }
    this.pendingApprovals.delete(approvalId);
    pending.cleanup();
    pending.resolve(decision);
    this.compactionAnchors.push(`APPROVAL DECISION: ${approvalId} = ${decision}`);
    return true;
  }

  private async requestApproval(
    request: ToolApproval,
    signal?: AbortSignal
  ): Promise<ApprovalDecision> {
    if (this.stopped || signal?.aborted) {
      return 'deny';
    }
    if (this.pendingApprovals.size >= 8) {
      return 'deny';
    }
    this.emit({
      type: 'approval.request',
      turnId: this.start.turnId,
      timestamp: now(),
      payload: {
        ...request,
        threadId: this.start.threadId,
        turnId: this.start.turnId,
        createdAt: now(),
      },
    });
    this.emit({
      type: 'turn.lifecycle',
      turnId: this.start.turnId,
      timestamp: now(),
      payload: { status: 'awaiting_approval' },
    });

    return await new Promise<ApprovalDecision>((resolveDecision) => {
      const abort = (): void => {
        this.pendingApprovals.delete(request.id);
        resolveDecision('deny');
      };
      signal?.addEventListener('abort', abort, { once: true });
      this.pendingApprovals.set(request.id, {
        resolve: (decision) => {
          signal?.removeEventListener('abort', abort);
          resolveDecision(decision);
        },
        cleanup: () => signal?.removeEventListener('abort', abort),
      });
    });
  }

  private forwardAgentEvent(event: AgentEvent): void {
    if (
      event.type === 'message_start' &&
      event.message.role === 'user' &&
      this.queuedFollowUps > 0
    ) {
      this.queuedFollowUps -= 1;
      this.emit({
        type: 'queue.update',
        turnId: this.start.turnId,
        timestamp: now(),
        payload: { queued: this.queuedFollowUps, action: 'dequeued' },
      });
    }
    if (
      event.type === 'turn_end' &&
      event.message.role === 'assistant' &&
      event.message.stopReason !== 'error' &&
      event.message.stopReason !== 'aborted'
    ) {
      this.emit({
        type: 'session.checkpoint',
        turnId: this.start.turnId,
        timestamp: now(),
        payload: {
          safe: true,
          model: event.message.model,
          stopReason: event.message.stopReason,
          completedToolResults: event.toolResults.length,
        },
      });
      return;
    }
    if (event.type === 'message_update' && event.assistantMessageEvent.type === 'text_delta') {
      this.emit({
        type: 'message.delta',
        turnId: this.start.turnId,
        timestamp: now(),
        payload: { role: 'assistant', text: event.assistantMessageEvent.delta },
      });
      return;
    }
    if (event.type === 'message_update' && event.assistantMessageEvent.type === 'thinking_delta') {
      this.emit({
        type: 'thinking.delta',
        turnId: this.start.turnId,
        timestamp: now(),
        payload: { text: event.assistantMessageEvent.delta },
      });
      return;
    }
    if (event.type === 'message_end' && event.message.role === 'assistant') {
      const text = toText(event.message.content);
      const content = normalizeAssistantContent(event.message.content);
      if (text || content.some((block) => block.type === 'toolCall')) {
        this.emit({
          type: 'message.complete',
          turnId: this.start.turnId,
          timestamp: now(),
          payload: {
            role: 'assistant',
            text,
            content,
            model: event.message.model,
            usage: normalizeUsage(event.message.usage),
          },
        });
      }
      return;
    }
    if (event.type === 'tool_execution_start') {
      this.emit({
        type: 'tool.activity',
        turnId: this.start.turnId,
        timestamp: now(),
        payload: {
          recordKind: 'agent-tool-result',
          name: event.toolName,
          state: 'started',
          toolCallId: event.toolCallId,
          args: event.args,
        },
      });
      return;
    }
    if (event.type === 'tool_execution_end') {
      const result = safeRecord(event.result);
      const output = toText(result.content);
      this.emit({
        type: 'tool.result',
        turnId: this.start.turnId,
        timestamp: now(),
        payload: {
          name: event.toolName,
          toolCallId: event.toolCallId,
          output,
          isError: event.isError,
          details: result.details ?? {},
        },
      });
    }
  }
}
