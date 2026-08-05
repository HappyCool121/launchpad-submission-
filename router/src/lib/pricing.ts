// Provider-neutral per-model pricing configuration.
//
// Each configured model supplies cache-hit input, cache-miss input, optional
// cache-write, and output rates. Keep cost math in this one file so the wallet
// never silently applies one provider's rates to another provider's model.
// Sources checked 2026-08-02:
//   https://api-docs.deepseek.com/quick_start/pricing
//   https://mimo.mi.com/docs/en-US/price/pay-as-you-go
//   https://agnes-ai.com/en/docs/agnes-20-flash
//   https://agnes-ai.com/en/docs/agnes-25-flash
//   https://agnes-ai.com/en/docs/agnes-25-pro-alpha
//   https://agnes-ai.com/en/docs/agnes-25-pro

import type { RouterModelId } from './types.js';

/** Prices in USD per 1,000,000 tokens. */
export interface ModelPricing {
  input_cache_hit: number;
  input_cache_miss: number;
  output: number;
  cache_write?: number;
}

const pricingCatalog: Record<RouterModelId, ModelPricing> = {
  'deepseek-v4-flash': {
    input_cache_hit: 0.0028,
    input_cache_miss: 0.14,
    output: 0.28,
  },
  'deepseek-v4-pro': {
    input_cache_hit: 0.003625,
    input_cache_miss: 0.435,
    output: 0.87,
  },
  'mimo-v2.5': {
    input_cache_hit: 0.0028,
    input_cache_miss: 0.14,
    output: 0.28,
  },
  'mimo-v2.5-pro': {
    input_cache_hit: 0.0036,
    input_cache_miss: 0.435,
    output: 0.87,
  },
  // Agnes documents a limited-time $0 promotional rate for Flash models.
  // Revalidate these entries before enabling paid live traffic.
  'agnes-2.0-flash': {
    input_cache_hit: 0,
    input_cache_miss: 0,
    output: 0,
  },
  'agnes-2.5-flash': {
    input_cache_hit: 0,
    input_cache_miss: 0,
    output: 0,
  },
  'agnes-2.5-pro-alpha': {
    input_cache_hit: 0.0038,
    input_cache_miss: 0.45,
    output: 0.90,
  },
  'agnes-2.5-pro': {
    input_cache_hit: 0.0038,
    input_cache_miss: 0.45,
    output: 0.90,
  },
} as const;

/** Registered model prices. Dormant providers intentionally have no entries. */
export const MODEL_PRICING: Readonly<Record<RouterModelId, ModelPricing>> = pricingCatalog;

/** Test-only registration proves settlement does not assume a DeepSeek model. */
export function registerModelPricingForTests(model: RouterModelId, pricing: ModelPricing): void {
  pricingCatalog[model] = pricing;
}

function pricingForModel(model: RouterModelId): ModelPricing {
  const pricing = pricingCatalog[model];
  if (!pricing) throw new Error(`pricing_unavailable: ${model} has no configured token pricing.`);
  return pricing;
}

/** Tier subsidy fractions — the share of the prompt cost the ad offsets. */
export const TIER_SUBSIDY: Record<'A' | 'B' | 'C' | 'NONE', number> = {
  A: 1.0, // 100% offset — high-intent inline sponsorship.
  B: 0.4, // 40% offset — medium-intent side panel.
  C: 0.05, // 5% offset — baseline banner.
  NONE: 0, // guardrail blocked: no ad, no subsidy.
};

export interface CostInput {
  model?: RouterModelId;
  inputTokens: number;
  outputTokens: number;
  /** Total prompt tokens. */
  promptTokens?: number;
  /** Number of prompt tokens served from the provider context cache. Default 0. */
  cacheHitTokens?: number;
  /** Tokens written to a provider cache, if reported by the provider. */
  cacheWriteTokens?: number;
}

/** Raw model cost in USD using split cache-hit/miss pricing. */
export interface CostBreakdown { input_cache_hit: number; input_cache_miss: number; cache_write: number; output: number; total: number }

export function computeCostBreakdown({
  model = 'deepseek-v4-flash',
  inputTokens,
  outputTokens,
  promptTokens,
  cacheHitTokens = 0,
  cacheWriteTokens = 0,
}: CostInput): CostBreakdown {
  const pricing = pricingForModel(model);
  // Use promptTokens if provided (more accurate), fall back to cacheHitTokens + remainder.
  const totalPrompt = typeof promptTokens === 'number' ? promptTokens : inputTokens;
  const hitTokens = Math.min(cacheHitTokens, totalPrompt);
  const missTokens = totalPrompt - hitTokens;
  const input_cache_hit = round6((hitTokens / 1_000_000) * pricing.input_cache_hit);
  const input_cache_miss = round6((missTokens / 1_000_000) * pricing.input_cache_miss);
  const output = round6((outputTokens / 1_000_000) * pricing.output);
  const cache_write = round6((cacheWriteTokens / 1_000_000) * (pricing.cache_write ?? 0));
  return { input_cache_hit, input_cache_miss, cache_write, output, total: round6(input_cache_hit + input_cache_miss + cache_write + output) };
}

export function computeCost(input: CostInput): number {
  return computeCostBreakdown(input).total;
}

/** Apply the tier subsidy; returns cost, subsidy, and what the user pays. */
export function applySubsidy(
  cost: number,
  tier: 'A' | 'B' | 'C' | 'NONE',
): { prompt_cost: number; ad_subsidy: number; paid: number } {
  const fraction = TIER_SUBSIDY[tier];
  const ad_subsidy = round6(cost * fraction);
  const paid = round6(Math.max(0, cost - ad_subsidy));
  return { prompt_cost: round6(cost), ad_subsidy, paid };
}

/**
 * Round to 6 decimals. DeepSeek's rates are low ($0.14/1M input), so a single
 * query of a few thousand tokens costs ~$0.001–0.005 — 4-decimal rounding
 * would floor that to $0 and hide the savings the demo is built to show.
 */
function round6(n: number): number {
  return Math.round(n * 1_000_000) / 1_000_000;
}
