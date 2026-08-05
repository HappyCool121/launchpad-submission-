// Vector math + sponsor matching (Stage 1, "Cache-Hit Rate").

import type { Sponsor } from './types.js';

/** Cosine similarity in [-1, 1]. Returns 0 for degenerate inputs. */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}

export interface BestMatch {
  sponsor: Sponsor;
  similarity: number;
  /** The strongest signal used for this match. */
  signal: 'semantic' | 'keyword';
}

/**
 * Return the best-matching sponsor + its similarity score, or null if DB empty.
 *
 * Dense embeddings are the main signal when `OPENAI_API_KEY` is configured.
 * A deterministic keyword score is also used as a fallback/boost so explicit
 * prompts like "fix a leaky pipe" still match Home Depot in DeepSeek-only demo
 * mode where embeddings are hashed mock vectors.
 */
export function findBestMatch(
  promptEmbedding: number[],
  sponsors: Sponsor[],
  promptText = '',
): BestMatch | null {
  let best: BestMatch | null = null;
  for (const sponsor of sponsors) {
    const semanticSimilarity =
      sponsor.embedding.length === 0 ? 0 : cosineSimilarity(promptEmbedding, sponsor.embedding);
    const keywordSimilarityScore = keywordSimilarity(promptText, sponsor);
    const signal = keywordSimilarityScore > semanticSimilarity ? 'keyword' : 'semantic';
    const similarity = Math.max(semanticSimilarity, keywordSimilarityScore);
    if (!best || similarity > best.similarity) {
      best = { sponsor, similarity, signal };
    }
  }
  return best;
}

function keywordSimilarity(promptText: string, sponsor: Sponsor): number {
  if (!promptText.trim()) return 0;

  const prompt = normalizeText(promptText);
  const promptTokens = new Set(prompt.trim().split(/\s+/).filter(Boolean));
  let exactMatches = 0;
  let partialMatches = 0;

  for (const rawKeyword of sponsor.target_keywords) {
    const keyword = normalizeText(rawKeyword).trim();
    if (!keyword || keyword.length < 2) continue;

    const keywordTokens = keyword.split(/\s+/).filter(Boolean);
    if (containsPhrase(prompt, keyword)) {
      exactMatches++;
      continue;
    }

    const overlap = keywordTokens.filter((token) => promptTokens.has(token)).length;
    if (keywordTokens.length > 1 && overlap > 0) {
      partialMatches += overlap / keywordTokens.length;
    }
  }

  if (exactMatches === 0 && partialMatches === 0) return 0;

  // One exact commercial keyword is enough for Tier B; two or more direct
  // hits, e.g. "leaky pipe", should be Tier A for the demo.
  return Math.min(0.95, 0.58 + exactMatches * 0.16 + partialMatches * 0.08);
}

function containsPhrase(normalizedText: string, normalizedPhrase: string): boolean {
  return ` ${normalizedText} `.includes(` ${normalizedPhrase} `);
}

function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .replace(/\bleaky\b/g, 'leak')
    .replace(/\bleaks\b/g, 'leak')
    .replace(/\bleaking\b/g, 'leak')
    .replace(/[^a-z0-9]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map(stem)
    .join(' ');
}

function stem(token: string): string {
  if (token.length <= 3) return token;
  return token.replace(/(ing|ed|es|s)$/u, '');
}
