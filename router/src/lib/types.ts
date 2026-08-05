// Shared types for the AdRouter backend.

/** A sponsor ad record. `embedding` is populated at startup / on ingestion. */
export interface Sponsor {
  id: string;
  brand_name: string;
  ad_copy: string;
  target_keywords: string[];
  click_url: string | null;
  is_synthetic: boolean;
  disclosure: string | null;
  /** Dense vector over `ad_copy + target_keywords`. Empty until embedded. */
  embedding: number[];
}

/** The four possible ad outcomes. `NONE` = guardrail blocked, no ad shown. */
export type AdTier = 'A' | 'B' | 'C' | 'NONE';
export type ProviderId = 'deepseek' | 'qwen' | 'mimo' | 'agnes';
/** Model IDs remain opaque to clients so new providers do not require a type release. */
export type RouterModelId = string;
export type ThinkingLevel = 'none' | 'medium' | 'high';
export type RuntimeMode = 'mock' | 'live';

/** The payload delivered to the frontend BEFORE the LLM stream finishes (Stage 3). */
export interface AdPayload {
  turn_id: string;
  campaign_id?: string;
  reason_code: 'matched' | 'guardrail' | 'user_opt_out' | 'no_inventory' | 'routing_failure' | 'demo_override';
  tier: AdTier;
  /** Privacy-safe guardrail metadata; never includes the original prompt. */
  guardrail?: { category: string; rule_id: string };
  /** Present when tier !== 'NONE'. */
  sponsor?: {
    brand_name: string;
    target_keywords: string[];
    click_url: string | null;
    ad_copy: string;
    is_synthetic: boolean;
    disclosure: string | null;
  };
  /** Cosine similarity score that produced this tier (0..1). 0 for NONE. */
  similarity: number;
  /** Provisional savings estimate shown while streaming; finalized on finish. */
  provisional_savings: number;
  /** Why this tier was chosen / why no ad — for the "Why am I seeing this?" line. */
  reason: string;
}

/** Final settlement computed once the stream completes (Stage 4). */
export interface Settlement {
  tier: AdTier;
  provider: ProviderId;
  model: RouterModelId;
  thinking_level: ThinkingLevel;
  runtime_mode: RuntimeMode;
  input_tokens: number;
  cache_hit_tokens: number;
  cache_miss_tokens: number;
  output_tokens: number;
  usage: { input_tokens: number; cache_read_tokens: number; cache_write_tokens: number; output_tokens: number; total_tokens: number };
  cost: { input_cache_hit: number; input_cache_miss: number; cache_write: number; output: number; total: number };
  /** Raw model cost (USD). */
  prompt_cost: number;
  /** Subsidy applied for this tier (USD). */
  ad_subsidy: number;
  /** What the user actually paid (USD). */
  paid: number;
  cache_hit: boolean;
}

export type ChatRole = 'system' | 'user' | 'assistant';

export interface ChatMessage {
  role: ChatRole;
  content: string;
}
