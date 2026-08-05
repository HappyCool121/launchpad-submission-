import './env.js';
import { isSensitive } from './guardrail.js';
import { applySubsidy, computeCost, computeCostBreakdown, TIER_SUBSIDY } from './pricing.js';
import { routePrompt } from './router.js';
import { getSponsors } from './sponsorStore.js';
import { insertEvent } from './persistence.js';
import { defaultModel, providerForModel, resolveModel, resolveThinkingForModel } from './modelRegistry.js';
import { getProvider } from './providers/registry.js';
import type { NormalizedUsage, ProviderAssistant, ProviderMessage, ProviderToolCall } from './providers/types.js';
import type { AdPayload, AdTier, ChatMessage, ProviderId, RouterModelId, RuntimeMode, Settlement, ThinkingLevel } from './types.js';

export const DEFAULT_ROUTER_MODEL: RouterModelId = parseModel(
  process.env.ADROUTER_DEFAULT_MODEL ?? process.env.DEEPSEEK_MODEL,
);
export const DEFAULT_THINKING_LEVEL: ThinkingLevel = 'medium';

const ROUTER_TIMEOUT_MS = 4_000;

export const SYSTEM_PROMPT = [
  'You are a helpful, objective AI assistant running through AdRouter.',
  'Answer the user directly and honestly. Do NOT mention sponsors, ads, or AdRouter.',
  'Do not invent products or prices. Keep the answer focused and concise.',
].join(' ');

export interface AgentRoutingInput {
  messages: RouterMessage[];
  model?: unknown;
  thinkingLevel?: unknown;
  legacyReasoningEffort?: unknown;
  runtimeMode?: 'auto' | RuntimeMode;
  tierOverride?: AdTier;
  adsEnabled?: boolean;
  client?: string;
  reservationId?: string;
}

export interface AgentRoutingPlan {
  messages: RouterMessage[];
  lastUser: RouterMessage;
  model: RouterModelId;
  provider: ProviderId;
  thinkingLevel: ThinkingLevel;
  runtimeMode: RuntimeMode;
  ad: AdPayload;
}

export type RouterMessage = ProviderMessage;
type DeepSeekToolCall = ProviderToolCall;
type AgentTurnAssistant = ProviderAssistant;

export interface CliAd {
  id: string;
  turn_id: string;
  campaign_id?: string;
  reason_code: AdPayload['reason_code'];
  tier: 1 | 2 | 3;
  title: string;
  body: string;
  cta?: string;
  url?: string;
  label: string;
  is_synthetic?: boolean;
  disclosure?: string;
}

export type AdDisplayStatus = 'off' | 'privacy_protected' | 'degraded' | RuntimeMode;

export const DEFAULT_INJECTION = {
  mode: 'tui_panel',
  placement: 'bottom',
  refresh_after_turn: true,
};

export async function planAgentRouting(input: AgentRoutingInput): Promise<AgentRoutingPlan> {
  const messages = input.messages;
  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  if (!lastUser) {
    throw new Error('No user message found.');
  }

  const model = parseModel(input.model);
  const provider = providerForModel(model);
  const thinkingLevel = resolveThinkingForModel(model, input.thinkingLevel, input.legacyReasoningEffort);
  if (!provider) throw new Error(`invalid_model: ${model} is not a registered runnable model.`);
  const adapter = getProvider(provider);
  if (!adapter) throw new Error(`invalid_model: ${model} is not a registered runnable model.`);
  const runtimeMode = adapter.runtimeMode(input.runtimeMode);

  let ad = input.adsEnabled === false ? noAd('user_opt_out', 'Ads are disabled for this turn.') : await routeMessagesForAd(messages);
  // Demo controls can only alter an ordinary sponsor-eligible match. Privacy
  // decisions (guardrail/opt-out/failure) always win.
  if (input.tierOverride && ad.reason_code === 'matched' && ad.tier !== 'NONE') {
    ad = applyTierOverride(ad, input.tierOverride);
  }
  await insertEvent(ad, { client: input.client, provider, model, runtimeMode, reservationId: input.reservationId });

  return {
    messages,
    lastUser,
    model,
    provider,
    thinkingLevel,
    runtimeMode,
    ad,
  };
}

export async function routeMessagesForAd(messages: RouterMessage[]): Promise<AdPayload> {
  // Sponsorship is intentionally based on the current request only. The full
  // message list still reaches the model below, including assistant and tool
  // result context; it must not influence a newly selected placement.
  const latestUser = [...messages].reverse().find((message) => message.role === 'user');
  const userContext = stringifyContent(latestUser?.content);

  try {
    const guard = isSensitive(userContext);
    if (guard.sensitive) {
      return noAd('guardrail', `Sensitive category detected (${guard.category}). Routed without ads per privacy policy.`, guard);
    }

    return (await withTimeout(
      routePrompt({ prompt: userContext, sponsors: getSponsors() }),
      ROUTER_TIMEOUT_MS,
      `semantic routing exceeded ${ROUTER_TIMEOUT_MS}ms`,
    )).payload;
  } catch (err) {
    console.warn('[adrouter] semantic routing failed:', err instanceof Error ? err.message : err);
    return noAd('routing_failure', 'Semantic routing failed; routing without a sponsored placement.');
  }
}

export function createMockResponse(plan: AgentRoutingPlan, maxOutputTokens = 4096) {
  const ad = plan.ad;
  const text = mockAnswer(ad.tier);
  const settlement = finalizeSettlement(ad.tier, {
    model: plan.model,
    provider: plan.provider,
    thinkingLevel: plan.thinkingLevel,
    runtimeMode: plan.runtimeMode,
    inputTokens: 500 + estimateTokens(stringifyContent(plan.lastUser.content)),
    outputTokens: Math.min(1200, maxOutputTokens),
  });

  return { ad, text, settlement };
}

export async function streamChatCompletion(
  plan: AgentRoutingPlan,
  writeEvent: (event: unknown) => void,
  execution: { maxOutputTokens: number; abortSignal?: AbortSignal } = { maxOutputTokens: 4096 },
): Promise<Settlement> {
  const adapter = requireExecutionProvider(plan.provider, 'streamChat');
  const usage = await adapter.streamChat({ model: plan.model, thinkingLevel: plan.thinkingLevel, messages: plan.messages, systemPrompt: SYSTEM_PROMPT, ...execution }, writeEvent);
  return settlementFromNormalizedUsage(plan, usage);
}

export async function runAgentTurn(
  plan: AgentRoutingPlan,
  tools: unknown[] | undefined,
  execution: { maxOutputTokens: number; abortSignal?: AbortSignal } = { maxOutputTokens: 4096 },
): Promise<{ assistant: AgentTurnAssistant; settlement: Settlement; usage: Record<string, number> }> {
  if (plan.runtimeMode === 'mock') {
    const mock = createMockResponse(plan, execution.maxOutputTokens);
    return {
      assistant: { content: mock.text, tool_calls: [], toolCalls: [] },
      settlement: mock.settlement,
      usage: usageFromSettlement(mock.settlement),
    };
  }

  const adapter = requireExecutionProvider(plan.provider, 'completeAgent');
  const completion = await adapter.completeAgent({ model: plan.model, thinkingLevel: plan.thinkingLevel, messages: plan.messages, tools, systemPrompt: SYSTEM_PROMPT, ...execution });
  const settlement = settlementFromNormalizedUsage(plan, completion.usage);

  return {
    assistant: completion.assistant,
    settlement,
    usage: usageFromSettlement(settlement),
  };
}

/** Stream a CLI/provider turn through the selected provider adapter. */
export async function streamAgentTurn(
  plan: AgentRoutingPlan,
  tools: unknown[] | undefined,
  writeEvent: (event: unknown) => void,
  execution: { maxOutputTokens: number; abortSignal?: AbortSignal } = { maxOutputTokens: 4096 },
): Promise<{ assistant: AgentTurnAssistant; settlement: Settlement; usage: Record<string, number> }> {
  if (plan.runtimeMode === 'mock') {
    const mock = createMockResponse(plan, execution.maxOutputTokens);
    if (mock.text) writeEvent({ type: 'text', content: mock.text, delta: mock.text });
    return {
      assistant: { content: mock.text, tool_calls: [], toolCalls: [] },
      settlement: mock.settlement,
      usage: usageFromSettlement(mock.settlement),
    };
  }

  const adapter = requireExecutionProvider(plan.provider, 'streamAgent');
  const completion = await adapter.streamAgent({ model: plan.model, thinkingLevel: plan.thinkingLevel, messages: plan.messages, tools, systemPrompt: SYSTEM_PROMPT, ...execution }, writeEvent);
  const settlement = settlementFromNormalizedUsage(plan, completion.usage);
  return {
    assistant: completion.assistant,
    settlement,
    usage: usageFromSettlement(settlement),
  };
}

export function adToCliAds(payload: AdPayload): CliAd[] {
  if (payload.tier === 'NONE' || !payload.sponsor) return [];
  return [
    {
      id: `ad-${Date.now()}`,
      turn_id: payload.turn_id,
      campaign_id: payload.campaign_id,
      reason_code: payload.reason_code,
      tier: payload.tier === 'A' ? 1 : payload.tier === 'B' ? 2 : 3,
      title: payload.sponsor.brand_name,
      body: payload.sponsor.ad_copy,
      cta: payload.sponsor.click_url ? 'Learn more' : undefined,
      url: payload.sponsor.click_url ?? undefined,
      label: 'Sponsored',
      is_synthetic: payload.sponsor.is_synthetic,
      disclosure: payload.sponsor.disclosure ?? undefined,
    },
  ];
}

/** Map a privacy/routing outcome to explicit CLI display state. */
export function adDisplayStatus(payload: AdPayload, runtimeMode: RuntimeMode): AdDisplayStatus {
  if (payload.reason_code === 'user_opt_out') return 'off';
  if (payload.reason_code === 'guardrail') return 'privacy_protected';
  if (payload.reason_code === 'routing_failure' || payload.reason_code === 'no_inventory') return 'degraded';
  return runtimeMode;
}

export function safeWriteNdjson(res: { write: (chunk: string) => unknown; writableEnded?: boolean }, data: unknown): boolean {
  try {
    if (res.writableEnded) return false;
    res.write(`${JSON.stringify(data)}\n`);
    return true;
  } catch (err) {
    console.warn('[adrouter] stream event write skipped:', err instanceof Error ? err.message : err);
    return false;
  }
}

export function parseModel(value: unknown): RouterModelId {
  if (value === 'deepseek') throw new Error('invalid_model: use deepseek-v4-flash or deepseek-v4-pro.');
  const model = resolveModel(value);
  if (model) return model;
  if (typeof value === 'string') throw new Error(`invalid_model: ${value} is not a registered runnable model.`);
  return defaultModel();
}

/** Resolve runtime from the selected model's adapter, never from a provider-specific route branch. */
export function resolveRuntimeForModel(value: unknown, requested: 'auto' | RuntimeMode | undefined): { model: RouterModelId; provider: ProviderId; runtimeMode: RuntimeMode; configured: boolean } {
  const model = parseModel(value);
  const provider = providerForModel(model);
  const adapter = provider ? getProvider(provider) : undefined;
  if (!provider || !adapter) throw new Error(`invalid_model: ${model} is not a registered runnable model.`);
  return { model, provider, runtimeMode: adapter.runtimeMode(requested), configured: adapter.configured() };
}

export function parseThinkingLevel(value: unknown): ThinkingLevel {
  return value === 'none' || value === 'high' ? value : 'medium';
}

export function normalizeThinkingLevel(thinkingLevel: unknown, legacyEffort?: 'low' | 'medium' | 'high'): ThinkingLevel {
  if (legacyEffort) return legacyEffort === 'high' ? 'high' : 'medium';
  return parseThinkingLevel(thinkingLevel);
}

export function safeProviderError(error: unknown, provider: ProviderId): string {
  const status = error && typeof error === 'object' && 'status' in error
    ? Number((error as { status?: unknown }).status) : undefined;
  const statusClass = status && Number.isFinite(status) ? `${Math.floor(status / 100)}xx` : 'unknown';
  return `${provider} provider request failed (${statusClass}).`;
}

function requireExecutionProvider(provider: ProviderId, method: 'streamChat' | 'completeAgent' | 'streamAgent') {
  const adapter = getProvider(provider);
  if (!adapter) throw new Error(`provider_unavailable: ${provider} does not support ${method}.`);
  return adapter;
}

function settlementFromNormalizedUsage(plan: AgentRoutingPlan, usage: NormalizedUsage): Settlement {
  return finalizeSettlement(plan.ad.tier, {
    model: plan.model,
    provider: plan.provider,
    thinkingLevel: plan.thinkingLevel,
    runtimeMode: plan.runtimeMode,
    inputTokens: usage.input_tokens + usage.cache_read_tokens,
    outputTokens: usage.output_tokens,
    promptTokens: usage.input_tokens + usage.cache_read_tokens,
    cacheHitTokens: usage.cache_read_tokens,
    cacheWriteTokens: usage.cache_write_tokens,
  });
}

export function finalizeSettlement(
  tier: AdPayload['tier'],
  {
    model,
    provider,
    thinkingLevel,
    runtimeMode,
    inputTokens,
    outputTokens,
    cacheHitTokens = 0,
    promptTokens,
    cacheWriteTokens = 0,
  }: {
    model: RouterModelId;
    provider: ProviderId;
    thinkingLevel: ThinkingLevel;
    runtimeMode: RuntimeMode;
    inputTokens: number;
    outputTokens: number;
    cacheHitTokens?: number;
    promptTokens?: number;
    cacheWriteTokens?: number;
  },
): Settlement {
  const totalPromptTokens = promptTokens ?? inputTokens;
  const cacheReadTokens = Math.min(cacheHitTokens, totalPromptTokens);
  const cacheMissTokens = totalPromptTokens - cacheReadTokens;
  const cost = computeCostBreakdown({ model, inputTokens: totalPromptTokens, outputTokens, cacheHitTokens: cacheReadTokens, cacheWriteTokens, promptTokens: totalPromptTokens });
  const prompt_cost = cost.total;
  const { ad_subsidy, paid } = applySubsidy(prompt_cost, tier);
  return {
    tier,
    provider,
    model,
    thinking_level: thinkingLevel,
    runtime_mode: runtimeMode,
    input_tokens: cacheMissTokens,
    cache_hit_tokens: cacheReadTokens,
    cache_miss_tokens: cacheMissTokens,
    output_tokens: outputTokens,
    usage: { input_tokens: cacheMissTokens, cache_read_tokens: cacheReadTokens, cache_write_tokens: cacheWriteTokens, output_tokens: outputTokens, total_tokens: totalPromptTokens + cacheWriteTokens + outputTokens },
    cost,
    prompt_cost,
    ad_subsidy,
    paid,
    cache_hit: cacheHitTokens > 0,
  };
}

function usageFromSettlement(settlement: Settlement): Record<string, number> {
  return {
    input: settlement.cache_miss_tokens,
    output: settlement.output_tokens,
    totalTokens: settlement.usage.total_tokens,
    cacheRead: settlement.cache_hit_tokens,
    cacheWrite: settlement.usage.cache_write_tokens,
  };
}


function stringifyContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((block) => {
      if (!block || typeof block !== 'object') return '';
      const record = block as Record<string, unknown>;
      if (record.type === 'text' && typeof record.text === 'string') return record.text;
      if (record.type === 'image') return '(image omitted)';
      return '';
    })
    .filter(Boolean)
    .join('\n');
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_resolve, reject) => {
      setTimeout(() => reject(new Error(message)), ms);
    }),
  ]);
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.round(text.length / 4));
}

const STANDARD_RESPONSE = `The value of x for the equation 1 + 2x = 3 is 1.  if we subtract both sides of the equation by 1, we have 2x = 3 - 1,
which we can then simplify to 2x = 2,
and by dividing both sides by 2, we have x = 1`;

const DEMO_SIMILARITY: Record<AdTier, number> = { A: 0.91, B: 0.72, C: 0.42, NONE: 0 };

function applyTierOverride(payload: AdPayload, override: AdTier): AdPayload {
  const similarity = DEMO_SIMILARITY[override];
  const nominalCost = computeCost({ inputTokens: 4000, outputTokens: 1000 });
  const provisional_savings = Math.round(nominalCost * TIER_SUBSIDY[override] * 10000) / 10000;
  const noPlacement = override === 'NONE';
  const reason =
    override === 'NONE'
      ? 'Dev preview: guardrail override - routed without ads.'
      : override === 'A'
        ? `High commercial intent (similarity ${similarity}). Inline sponsored citation.`
        : override === 'B'
          ? `Medium commercial intent (similarity ${similarity}). Sponsored agent panel.`
          : `Low commercial intent (similarity ${similarity}). Baseline banner only.`;
  return {
    ...payload,
    reason_code: 'demo_override',
    tier: override,
    campaign_id: noPlacement ? undefined : payload.campaign_id,
    similarity,
    provisional_savings: noPlacement ? 0 : provisional_savings,
    reason,
    sponsor: noPlacement ? undefined : payload.sponsor,
  };
}

function noAd(
  reason_code: AdPayload['reason_code'],
  reason: string,
  guardrail?: { category?: string; rule_id?: string },
): AdPayload {
  return {
    turn_id: crypto.randomUUID(),
    tier: 'NONE',
    reason_code,
    guardrail: guardrail?.category && guardrail.rule_id ? { category: guardrail.category, rule_id: guardrail.rule_id } : undefined,
    similarity: 0,
    provisional_savings: 0,
    reason,
  };
}

function mockAnswer(tier: AdPayload['tier']): string {
  if (tier === 'NONE') {
    return 'This query was routed without ads per the AdRouter privacy guardrail. (Mock response — configure a router provider for live answers.)';
  }
  return STANDARD_RESPONSE;
}
