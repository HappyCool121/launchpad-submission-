import { strict as assert } from 'node:assert';
import { serializeDeepSeekAgentMessages } from '../src/lib/providers/deepseek.js';
import { sponsorEmbeddingText } from '../src/lib/embeddings.js';
import { adToCliAds } from '../src/lib/agent-routing.js';
import type { ProviderRequest } from '../src/lib/providers/types.js';

const baseRequest: ProviderRequest = {
  maxOutputTokens: 4096,
  model: 'deepseek-v4-flash',
  thinkingLevel: 'high',
  systemPrompt: 'You are a coding agent.',
  tools: [],
  messages: [
    { role: 'user', content: [{ type: 'text', text: 'Inspect both files.' }] },
    {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: '  inspect alpha\nthen beta  ', thinkingSignature: 'reasoning_content' },
        { type: 'toolCall', id: 'call_alpha', name: 'read', arguments: { path: 'alpha.txt' } },
        { type: 'toolCall', id: 'call_beta', name: 'read', arguments: { path: 'beta.txt' } },
        { type: 'toolCall', id: 'call_alpha', name: 'read', arguments: { path: 'alpha.txt' } },
      ],
    },
    { role: 'toolResult', toolCallId: 'call_alpha', content: [{ type: 'text', text: 'alpha' }] },
    { role: 'toolResult', toolCallId: 'call_alpha', content: [{ type: 'text', text: 'alpha' }] },
    { role: 'toolResult', toolCallId: 'call_beta', content: [{ type: 'text', text: 'beta' }] },
    { role: 'user', content: 'Summarize the results.' },
  ],
};

const serialized = serializeDeepSeekAgentMessages(baseRequest) as unknown as Array<Record<string, unknown>>;
const assistant = serialized[2] as {
  content?: unknown;
  reasoning_content?: unknown;
  tool_calls?: Array<{ id: string }>;
};
assert.equal(assistant.content, '', 'tool-only assistant content must be a non-null string');
assert.equal(
  assistant.reasoning_content,
  '  inspect alpha\nthen beta  ',
  'reasoning content must retain exact whitespace for DeepSeek replay',
);
assert.deepEqual(assistant.tool_calls?.map((tool) => tool.id), ['call_alpha', 'call_beta']);
assert.equal(
  serialized.filter((message) => message.role === 'tool').length,
  2,
  'exact legacy duplicate results must be collapsed',
);

const nonThinking = serializeDeepSeekAgentMessages({
  ...baseRequest,
  thinkingLevel: 'none',
}) as unknown as Array<Record<string, unknown>>;
assert.equal('reasoning_content' in nonThinking[2], false, 'non-thinking requests must omit reasoning_content');

assert.throws(
  () => serializeDeepSeekAgentMessages({
    ...baseRequest,
    messages: [{
      role: 'assistant',
      content: [
        { type: 'toolCall', id: 'call_conflict', name: 'read', arguments: { path: 'a.txt' } },
        { type: 'toolCall', id: 'call_conflict', name: 'read', arguments: { path: 'b.txt' } },
      ],
    }],
  }),
  /conflicting tool calls reuse tool call ID call_conflict/,
);

assert.throws(
  () => serializeDeepSeekAgentMessages({
    ...baseRequest,
    messages: [
      { role: 'toolResult', toolCallId: 'call_conflict', content: 'first' },
      { role: 'toolResult', toolCallId: 'call_conflict', content: 'second' },
    ],
  }),
  /conflicting tool results reuse tool call ID call_conflict/,
);

const disclosure = 'Closed beta test campaign — disclosure must not affect matching.';
assert.equal(
  sponsorEmbeddingText({
    id: 'synthetic',
    brand_name: 'Synthetic',
    ad_copy: 'Stable campaign copy.',
    target_keywords: ['workspace', 'planning'],
    click_url: null,
    is_synthetic: true,
    disclosure,
    embedding: [],
  }),
  'Stable campaign copy. workspace planning',
  'synthetic disclosure text must be excluded from embeddings',
);
const cliAds = adToCliAds({
  turn_id: 'turn',
  campaign_id: 'synthetic',
  reason_code: 'matched',
  tier: 'A',
  similarity: 0.9,
  provisional_savings: 0,
  reason: 'matched',
  sponsor: {
    brand_name: 'Synthetic',
    ad_copy: 'Stable campaign copy.',
    target_keywords: ['workspace'],
    click_url: null,
    is_synthetic: true,
    disclosure,
  },
});
assert.equal(cliAds[0]?.is_synthetic, true);
assert.equal(cliAds[0]?.disclosure, disclosure);
assert.equal(cliAds[0]?.url, undefined);

console.log('OK: agent messages preserve reasoning, disclosures stay out of embeddings, and CLI ads retain synthetic metadata.');
