import {
  type AgentMessage,
  estimateContextTokens,
  estimateTokens,
  shouldCompact,
} from '@earendil-works/pi-agent-core';
import type { Context, Tool } from '@earendil-works/pi-ai';
import type { ContextBudgetSnapshot, RouterModelDescriptor } from '../shared/contracts';

export const CONTEXT_RESERVE_TOKENS = 16_384;
export const KEEP_RECENT_TOKENS = 32_768;
const REQUEST_ENVELOPE_TOKENS = 512;

export const COMPACTION_SETTINGS = {
  enabled: true,
  reserveTokens: CONTEXT_RESERVE_TOKENS,
  keepRecentTokens: KEEP_RECENT_TOKENS,
} as const;

const serializedLength = (value: unknown): number => {
  try {
    return JSON.stringify(value).length;
  } catch {
    return 0;
  }
};

const textTokens = (value: string): number => Math.ceil(value.length / 4);

export const estimateFixedContextTokens = (
  systemPrompt: string | undefined,
  tools: readonly Tool[] | undefined
): number =>
  textTokens(systemPrompt ?? '') +
  Math.ceil(serializedLength(tools ?? []) / 4) +
  REQUEST_ENVELOPE_TOKENS;

export interface ContextBudgetEstimate {
  tokens: number;
  piTokens: number;
  messageTokens: number;
  fixedTokens: number;
  maxInputTokens: number;
  compactionThreshold: number;
}

export const estimateContextBudget = (
  messages: AgentMessage[],
  systemPrompt: string | undefined,
  tools: readonly Tool[] | undefined,
  model: Pick<RouterModelDescriptor, 'contextWindow' | 'maxInputTokens' | 'maxOutputTokens'>
): ContextBudgetEstimate => {
  const piEstimate = estimateContextTokens(messages);
  const messageTokens = messages.reduce((total, message) => total + estimateTokens(message), 0);
  const fixedTokens = estimateFixedContextTokens(systemPrompt, tools);
  const maxInputTokens = Math.min(
    model.maxInputTokens,
    model.contextWindow - model.maxOutputTokens
  );
  return {
    tokens: Math.max(piEstimate.tokens, messageTokens + fixedTokens),
    piTokens: piEstimate.tokens,
    messageTokens,
    fixedTokens,
    maxInputTokens,
    compactionThreshold: Math.min(maxInputTokens, model.contextWindow - CONTEXT_RESERVE_TOKENS),
  };
};

export const contextNeedsCompaction = (estimate: ContextBudgetEstimate): boolean =>
  shouldCompact(estimate.tokens, estimate.compactionThreshold + CONTEXT_RESERVE_TOKENS, {
    ...COMPACTION_SETTINGS,
    reserveTokens: CONTEXT_RESERVE_TOKENS,
  });

export const contextBudgetSnapshot = (
  estimate: ContextBudgetEstimate,
  source: ContextBudgetSnapshot['source'] = 'estimate'
): ContextBudgetSnapshot => ({
  estimatedTokens: Math.max(0, Math.ceil(estimate.tokens)),
  maxInputTokens: Math.max(1, Math.floor(estimate.maxInputTokens)),
  compactionThreshold: Math.max(1, Math.floor(estimate.compactionThreshold)),
  reserveTokens: CONTEXT_RESERVE_TOKENS,
  status:
    estimate.tokens > estimate.maxInputTokens
      ? 'overflow'
      : estimate.tokens >= estimate.compactionThreshold
        ? 'near_limit'
        : 'ok',
  source,
});

export const estimateProviderContextBudget = (
  context: Context,
  model: Pick<RouterModelDescriptor, 'contextWindow' | 'maxInputTokens' | 'maxOutputTokens'>
): ContextBudgetEstimate =>
  estimateContextBudget(
    context.messages as AgentMessage[],
    context.systemPrompt,
    context.tools,
    model
  );

export const contextOverflowMessage = (estimate: ContextBudgetEstimate): string =>
  `context_overflow: estimated ${estimate.tokens} input tokens exceeds the validated ${estimate.maxInputTokens}-token model limit; no router request was sent.`;
