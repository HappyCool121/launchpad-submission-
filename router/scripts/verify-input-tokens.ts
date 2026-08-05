import assert from 'node:assert/strict';
import { AdmissionError, assertInputLimit, reserve } from '../src/runtime/admission.js';
import { CANONICAL_MODEL_REGISTRY } from '../src/lib/modelRegistry.js';
import type { Principal } from '../src/runtime/auth.js';
import { estimateDeepSeekInputTokens, estimateOpenAICompatibleInputTokens, estimateProviderInputTokens } from '../src/runtime/input-tokens.js';

const ascii = { messages: [{ role: 'user', content: 'Hello world' }] };
const unicode = { messages: [{ role: 'user', content: '你好 👋🏽 世界' }] };
const withTools = {
  context: {
    tools: [{
      name: 'weather',
      description: 'Get weather',
      parameters: { type: 'object', properties: { city: { type: 'string' } } },
    }],
  },
  messages: [
    { role: 'user', content: 'Weather in Singapore?' },
    { role: 'assistant', content: '', tool_calls: [{ id: 'call_1', name: 'weather', arguments: { city: 'Singapore' } }] },
    { role: 'tool', tool_call_id: 'call_1', content: '29°C and rain' },
  ],
};

assert.equal(estimateDeepSeekInputTokens(ascii), 5);
assert.equal(estimateDeepSeekInputTokens(unicode), 10);
assert.equal(estimateDeepSeekInputTokens(withTools), 97);
assert.notEqual(estimateDeepSeekInputTokens(unicode), Buffer.byteLength(unicode.messages[0]!.content));
assert(estimateDeepSeekInputTokens(withTools) > estimateDeepSeekInputTokens(ascii));
assert(estimateOpenAICompatibleInputTokens(unicode) >= Buffer.byteLength(JSON.stringify({ systemPrompt: undefined, messages: unicode.messages, tools: [] }), 'utf8'));
assert.equal(estimateProviderInputTokens(ascii, 'deepseek'), estimateDeepSeekInputTokens(ascii));
assert.equal(estimateProviderInputTokens(ascii, 'mimo'), estimateOpenAICompatibleInputTokens(ascii));

const principal: Principal = {
  userId: '00000000-0000-4000-8000-000000000001',
  authSource: 'installation',
  installationId: '00000000-0000-4000-8000-000000000002',
  tokenFamilyId: '00000000-0000-4000-8000-000000000003',
  clientKind: 'cli',
  clientVersion: '0.82.0',
  role: 'owner',
  status: 'active',
  isDeveloper: true,
  isAdvertiser: false,
  maxConcurrency: 1,
  maxOutputTokens: 4_096,
  dailyLimitMicrousd: 1_000_000,
  monthlyLimitMicrousd: 1_000_000,
  allowedModels: ['deepseek-v4-flash'],
};

for (const descriptor of CANONICAL_MODEL_REGISTRY) {
  assert.doesNotThrow(() => assertInputLimit(descriptor.max_input_tokens, descriptor));
  assert.throws(
    () => assertInputLimit(descriptor.max_input_tokens + 1, descriptor),
    (error: unknown) => error instanceof AdmissionError
      && error.status === 413
      && error.code === 'input_limit_exceeded'
      && error.details?.estimated_input_tokens === descriptor.max_input_tokens + 1
      && error.details?.max_input_tokens === descriptor.max_input_tokens
      && error.details?.context_window === descriptor.context_window
      && error.details?.max_output_tokens === descriptor.max_output_tokens
      && error.details?.allowed_input_tokens === descriptor.max_input_tokens,
  );
}

await assert.rejects(reserve(principal, 'deepseek-v4-flash', 917_505, 4_096), (error: unknown) => error instanceof AdmissionError && error.code === 'input_limit_exceeded');

console.log('OK: provider token estimation is deterministic and all exact selected-model input boundaries fail before database access.');
