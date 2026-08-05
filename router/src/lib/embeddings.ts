// Pluggable embeddings seam.
//
// DeepSeek has NO embeddings endpoint, but the semantic router requires one.
// This module isolates the embedding provider so it can be swapped with a
// one-line change (see PROVIDER below).
//
//   Default:   OpenAI `text-embedding-3-small` (fast, cheap; needs OPENAI_API_KEY)
//   Fallback:  local MiniLM via @xenova/transformers (offline, no key)
//
// To switch to the local provider: install @xenova/transformers and replace
// the `embedOpenAI` call with a local pipeline — the rest of the router is
// provider-agnostic (it only calls `generateEmbedding(text)`).

import './env.js';
import OpenAI from 'openai';
import type { Sponsor } from './types.js';

const PROVIDER: 'openai' | 'local' = 'openai';

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY ?? '',
});

const EMBED_DIM = 1536; // text-embedding-3-small

/** Embed a single piece of text. */
export async function generateEmbedding(text: string): Promise<number[]> {
  if (PROVIDER === 'openai') {
    return embedOpenAI(text);
  }
  return embedLocal(text);
}

async function embedOpenAI(text: string): Promise<number[]> {
  if (!process.env.OPENAI_API_KEY) {
    // Deterministic mock vector so the router is testable without a key.
    // NOT semantically meaningful — only for MOCK MODE smoke tests.
    return mockVector(text);
  }
  const res = await openai.embeddings.create({
    model: 'text-embedding-3-small',
    input: text,
  });
  return res.data[0].embedding as unknown as number[];
}

// Local provider placeholder. Wire up @xenova/transformers here if you want
// DeepSeek-only operation (no OPENAI_API_KEY). Left unimplemented to avoid
// pulling the heavy dependency by default.
async function embedLocal(_text: string): Promise<number[]> {
  throw new Error(
    'Local embeddings not configured. Install @xenova/transformers and implement embedLocal(), or set OPENAI_API_KEY.',
  );
}

/**
 * Deterministic mock vector for offline testing (no API key).
 *
 * Uses the hashing trick over whitespace tokens: each word hashes to a
 * dimension and accumulates. Cosine similarity then reflects shared
 * vocabulary — a crude but REAL semantic signal, so tier behavior (A/B/C)
 * is demoable without a live embeddings key. It is NOT production-grade
 * semantic matching; set OPENAI_API_KEY for that.
 */
function mockVector(text: string): number[] {
  const vec = new Array(EMBED_DIM).fill(0);
  const tokens = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  for (const token of tokens) {
    // Stem a little: drop common suffixes so "pipes"/"pipe" collide.
    const stem = token.replace(/(ing|s|es|ed)$/, '');
    const dim = hashStr(stem) % EMBED_DIM;
    vec[dim] += 1;
  }
  const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
  return vec.map((v) => v / norm);
}

function hashStr(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** The text we embed for a sponsor — ad copy + keywords — drives matching. */
export function sponsorEmbeddingText(s: Sponsor): string {
  return `${s.ad_copy} ${s.target_keywords.join(' ')}`.trim();
}

export function isEmbeddingsConfigured(): boolean {
  return PROVIDER === 'openai' ? Boolean(process.env.OPENAI_API_KEY) : true;
}
