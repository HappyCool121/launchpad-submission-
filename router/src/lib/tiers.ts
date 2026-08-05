// Tier assignment from the cache-hit (cosine similarity) score.
//
// Per router-logic/draft.md Stage 1:
//   sim > 0.85 -> Tier A (high intent, inline)
//   sim > 0.60 -> Tier B (medium intent, side panel)
//   sim < 0.60 -> Tier C (no intent, baseline banner)
// Plus NONE when the sensitive-category guardrail blocks monetization.

import type { AdTier } from './types.js';

export const TIER_THRESHOLDS = {
  A: 0.85,
  B: 0.6,
} as const;

export function tierFromScore(similarity: number): Exclude<AdTier, 'NONE'> {
  if (similarity > TIER_THRESHOLDS.A) return 'A';
  if (similarity > TIER_THRESHOLDS.B) return 'B';
  return 'C';
}
