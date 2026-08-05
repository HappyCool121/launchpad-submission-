// The router orchestrator — Stage 1 (Semantic Gateway) + provisional tier/subsidy.
//
// Pipeline: embed prompt -> guardrail -> find best sponsor match -> assign tier
// -> build the AdPayload delivered to the frontend before the stream finishes.
//
// The LLM call (Stage 2, Track X) happens separately in routes/chat.ts and is
// NEVER influenced by the ad selection (zero deep-prompt tampering).

import { generateEmbedding } from './embeddings.js';
import { findBestMatch } from './vector.js';
import { isSensitive } from './guardrail.js';
import { tierFromScore } from './tiers.js';
import { computeCost } from './pricing.js';
import type { AdPayload, Sponsor } from './types.js';

export interface RouteInput {
  prompt: string;
  sponsors: Sponsor[];
}

export interface RouteResult {
  payload: AdPayload;
}

/** Run the semantic gateway and return the AdPayload for this prompt. */
export async function routePrompt({ prompt, sponsors }: RouteInput): Promise<RouteResult> {
  // 1. Privacy guardrail — sensitive prompts get no ad.
  const guard = isSensitive(prompt);
  if (guard.sensitive) {
    return {
      payload: {
        turn_id: crypto.randomUUID(),
        reason_code: 'guardrail',
        tier: 'NONE',
        guardrail: guard.category && guard.rule_id ? { category: guard.category, rule_id: guard.rule_id } : undefined,
        similarity: 0,
        provisional_savings: 0,
        reason: `Sensitive category detected (${guard.category}). Routed without ads per privacy policy.`,
      },
    };
  }

  if (sponsors.length === 0) {
    return {
      payload: {
        turn_id: crypto.randomUUID(),
        reason_code: 'no_inventory',
        tier: 'NONE',
        similarity: 0,
        provisional_savings: 0,
        reason: 'No sponsors are available — routed without a sponsored placement.',
      },
    };
  }

  // 2. Embed the prompt + search the sponsor vector DB.
  const promptEmbedding = await generateEmbedding(prompt);
  const match = findBestMatch(promptEmbedding, sponsors, prompt);

  if (!match) {
    return {
      payload: {
        turn_id: crypto.randomUUID(),
        reason_code: 'no_inventory',
        tier: 'NONE',
        similarity: 0,
        provisional_savings: 0,
        reason: 'No sponsors are available — routed without a sponsored placement.',
      },
    };
  }

  // 3. Assign tier from the cache-hit rate (cosine similarity).
  const tier = tierFromScore(match.similarity);
  const similarity = Math.round(match.similarity * 1000) / 1000;

  // 4. Provisional savings: estimate against a nominal query cost (4k in / 1k out).
  // The final number is recomputed from real token counts on stream finish.
  const nominalCost = computeCost({ inputTokens: 4000, outputTokens: 1000 });
  const provisional_savings = nominalCost * (tier === 'A' ? 1 : tier === 'B' ? 0.4 : 0.05);

  const reason =
    tier === 'A'
      ? `High commercial intent (${match.signal} similarity ${similarity}). Inline sponsored citation.`
      : tier === 'B'
        ? `Medium commercial intent (${match.signal} similarity ${similarity}). Sponsored agent panel.`
        : `Low commercial intent (${match.signal} similarity ${similarity}). Baseline banner only.`;

  return {
    payload: {
      turn_id: crypto.randomUUID(),
      campaign_id: match.sponsor.id,
      reason_code: 'matched',
      tier,
      similarity,
      provisional_savings: Math.round(provisional_savings * 10000) / 10000,
      sponsor: {
        brand_name: match.sponsor.brand_name,
        target_keywords: match.sponsor.target_keywords,
        click_url: match.sponsor.click_url,
        ad_copy: match.sponsor.ad_copy,
        is_synthetic: match.sponsor.is_synthetic,
        disclosure: match.sponsor.disclosure,
      },
      reason,
    },
  };
}
