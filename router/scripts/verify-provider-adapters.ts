import { strict as assert } from 'node:assert';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { closeDatabase } from '../src/lib/database.js';
import {
  adDisplayStatus,
  createMockResponse,
  planAgentRouting,
  runAgentTurn,
  streamAgentTurn,
} from '../src/lib/agent-routing.js';
import { registerModelPricingForTests } from '../src/lib/pricing.js';
import { registerModelForTests } from '../src/lib/modelRegistry.js';
import { registerProviderForTests } from '../src/lib/providers/registry.js';
import type { ProviderAdapter } from '../src/lib/providers/types.js';
import { routePrompt } from '../src/lib/router.js';
import { initSponsorStore } from '../src/lib/sponsorStore.js';
import { agentTurnRouter } from '../src/routes/agent-turn.js';
import { chatRouter } from '../src/routes/chat.js';

const providerRequests: { maxOutputTokens: number; abortSignal?: AbortSignal }[] = [];
function fakeProvider(id: 'qwen' | 'mimo'): ProviderAdapter {
  return {
    id,
    configured: () => true,
    thinkingParameters: () => ({}),
    runtimeMode: () => 'live',
    normalizeUsage: () => ({ input_tokens: 7, cache_read_tokens: 3, cache_write_tokens: 2, output_tokens: 11 }),
    streamChat: async (request, writeEvent) => {
      providerRequests.push(request);
      writeEvent({ type: 'text', content: `${id} stream` });
      return { input_tokens: 7, cache_read_tokens: 3, cache_write_tokens: 2, output_tokens: 11 };
    },
    completeAgent: async (request) => {
      providerRequests.push(request);
      return {
        assistant: { content: `${id} complete`, tool_calls: [], toolCalls: [] },
        usage: { input_tokens: 7, cache_read_tokens: 3, cache_write_tokens: 2, output_tokens: 11 },
      };
    },
    streamAgent: async (request, writeEvent) => {
      providerRequests.push(request);
      writeEvent({ type: 'text', content: `${id} stream` });
      return {
        assistant: { content: `${id} stream`, tool_calls: [], toolCalls: [] },
        usage: { input_tokens: 7, cache_read_tokens: 3, cache_write_tokens: 2, output_tokens: 11 },
      };
    },
  };
}

function assertOptOut(events: Record<string, unknown>[], label: string): void {
  const adEvent = events[0] as { type?: string; ad?: { tier?: string; reason_code?: string; sponsor?: unknown; campaign_id?: unknown } } | undefined;
  assert.equal(adEvent?.type, 'ad', `${label}: ad must be first`);
  assert.equal(adEvent?.ad?.tier, 'NONE', `${label}: opt-out must remain NONE`);
  assert.equal(adEvent?.ad?.reason_code, 'user_opt_out', `${label}: opt-out reason must survive`);
  assert.equal(adEvent?.ad?.sponsor, undefined, `${label}: opt-out must expose no sponsor`);
  assert.equal(adEvent?.ad?.campaign_id, undefined, `${label}: opt-out must expose no campaign`);
  const settlementEvent = events.find((event) => event.type === 'settlement') as { settlement?: { ad_subsidy?: number } } | undefined;
  assert.equal(settlementEvent?.settlement?.ad_subsidy, 0, `${label}: opt-out must receive no subsidy`);
}

function assertJsonOptOut(response: Record<string, unknown>, label: string): void {
  const ad = response.ad as { tier?: string; reason_code?: string; sponsor?: unknown; campaign_id?: unknown } | undefined;
  const settlement = response.settlement as { ad_subsidy?: number } | undefined;
  assert.equal(response.status, 'off', `${label}: opt-out must serialize explicit off status`);
  assert.equal(ad?.tier, 'NONE', `${label}: opt-out must remain NONE`);
  assert.equal(ad?.reason_code, 'user_opt_out', `${label}: opt-out reason must survive`);
  assert.equal(ad?.sponsor, undefined, `${label}: opt-out must expose no sponsor`);
  assert.equal(ad?.campaign_id, undefined, `${label}: opt-out must expose no campaign`);
  assert.equal(settlement?.ad_subsidy, 0, `${label}: opt-out must receive no subsidy`);
}

async function readNdjson(response: Response): Promise<Record<string, unknown>[]> {
  if (!response.ok) {
    throw new Error(`expected HTTP success, got ${response.status}: ${await response.text()}`);
  }
  return (await response.text()).split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
}

await initSponsorStore();
registerModelPricingForTests('qwen-test', { input_cache_hit: 0.01, input_cache_miss: 0.1, cache_write: 0.02, output: 0.2 });
registerModelPricingForTests('mimo-test', { input_cache_hit: 0.01, input_cache_miss: 0.1, cache_write: 0.02, output: 0.2 });
registerModelForTests({ id: 'qwen-test', provider: 'qwen', thinking_levels: ['none', 'medium', 'high'], default_thinking_level: 'medium', context_window: 1_048_576, max_input_tokens: 851_968, max_output_tokens: 196_608 });
registerModelForTests({ id: 'mimo-test', provider: 'mimo', thinking_levels: ['none', 'medium', 'high'], default_thinking_level: 'medium', context_window: 1_048_576, max_input_tokens: 851_968, max_output_tokens: 196_608 });
registerProviderForTests(fakeProvider('qwen'));
registerProviderForTests(fakeProvider('mimo'));

for (const [provider, model] of [['qwen', 'qwen-test'], ['mimo', 'mimo-test']] as const) {
  const plan = await planAgentRouting({ messages: [{ role: 'user', content: 'recommend a keyboard' }], model, runtimeMode: 'live' });
  assert.equal(plan.provider, provider);
  const result = await runAgentTurn(plan, []);
  assert.equal(result.assistant.content, `${provider} complete`);
  assert.equal(result.settlement.provider, provider);
  assert.equal(result.settlement.cache_hit_tokens, 3);
  assert.equal(result.settlement.cache_miss_tokens, 7);
  assert.equal(result.settlement.usage.cache_write_tokens, 2);
  const events: unknown[] = [];
  const streamed = await streamAgentTurn(plan, [], (event) => events.push(event));
  assert.equal(streamed.assistant.content, `${provider} stream`);
  assert.equal(events.length, 1);
}

const optedOutPlan = await planAgentRouting({
  messages: [{ role: 'user', content: 'recommend a new keyboard' }],
  model: 'qwen-test',
  runtimeMode: 'live',
  adsEnabled: false,
  tierOverride: 'A',
});
const abortController = new AbortController();
await runAgentTurn(optedOutPlan, [], { maxOutputTokens: 37, abortSignal: abortController.signal });
assert.equal(providerRequests.at(-1)?.maxOutputTokens, 37, 'admitted output limit must reach the provider');
assert.equal(providerRequests.at(-1)?.abortSignal, abortController.signal, 'request abort signal must reach the provider');
assert.equal(optedOutPlan.ad.tier, 'NONE', 'a tier override must not supersede opt-out');
assert.equal(optedOutPlan.ad.reason_code, 'user_opt_out', 'opt-out reason must survive override input');
assert.equal(createMockResponse(optedOutPlan).settlement.ad_subsidy, 0, 'opt-out must never receive subsidy');
assert.equal(adDisplayStatus(optedOutPlan.ad, 'live'), 'off', 'opt-out must clear CLI display state');

const guardedPlan = await planAgentRouting({
  messages: [{ role: 'user', content: 'I think I am having a heart attack and cannot breathe.' }],
  model: 'qwen-test',
  runtimeMode: 'live',
  tierOverride: 'A',
});
assert.equal(guardedPlan.ad.tier, 'NONE', 'a tier override must not supersede the guardrail');
assert.equal(guardedPlan.ad.reason_code, 'guardrail', 'guardrail reason must survive override input');
assert.equal(guardedPlan.ad.guardrail?.rule_id, 'health-emergency-cardiac', 'guardrail must expose a stable rule ID without prompt text');
assert.equal(adDisplayStatus(guardedPlan.ad, 'live'), 'privacy_protected', 'guardrail NONE must remain visible as privacy-protected');

const noInventory = await routePrompt({ prompt: 'recommend a keyboard', sponsors: [] });
assert.equal(noInventory.payload.tier, 'NONE', 'no inventory must not manufacture a sponsored tier');
assert.equal(noInventory.payload.reason_code, 'no_inventory', 'no inventory must remain distinguishable from guardrails');
assert.equal(adDisplayStatus(noInventory.payload, 'live'), 'degraded', 'inventory failures must clear stale sponsor display state');

// Exercise the supported demo routes in live mode against configured fake
// adapters without inventing a real Qwen or MiMo vendor endpoint.
process.env.ADROUTER_API_KEY ||= 'provider-adapter-test-key';
const app = express();
app.use(express.json());
app.use('/api', chatRouter);
app.use(agentTurnRouter);
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
const address = server.address() as AddressInfo;
const base = `http://127.0.0.1:${address.port}`;
const authorization = `Bearer ${process.env.ADROUTER_API_KEY}`;
const headers = { authorization, 'content-type': 'application/json' };

try {
  const webChat = await readNdjson(await fetch(`${base}/api/chat`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: 'qwen-test',
      runtime_mode: 'live',
      ads_enabled: false,
      messages: [{ role: 'user', content: 'recommend a keyboard' }],
    }),
  }));
  assertOptOut(webChat, 'web chat live turn');

  const agent = await readNdjson(await fetch(`${base}/v1/agent/turn`, {
    method: 'POST',
    headers: { ...headers, accept: 'application/x-ndjson' },
    body: JSON.stringify({
      model: 'qwen-test',
      runtime_mode: 'live',
      context: { messages: [{ role: 'user', content: 'recommend a keyboard' }], tools: [{ name: 'lookup' }] },
      metadata: { ads_enabled: false, client: 'provider-adapter-test' },
    }),
  }));
  assertOptOut(agent, 'agent live turn');
  assert.equal(agent[0]?.status, 'off', 'agent opt-out must serialize explicit off status');

  const agentJsonResponse = await fetch(`${base}/v1/agent/turn`, {
    method: 'POST',
    headers: { ...headers, accept: 'application/json' },
    body: JSON.stringify({
      model: 'qwen-test',
      runtime_mode: 'live',
      context: { messages: [{ role: 'user', content: 'recommend a keyboard' }] },
      metadata: { ads_enabled: false, client: 'provider-adapter-test' },
    }),
  });
  assert.equal(agentJsonResponse.ok, true, `agent JSON opt-out turn failed: ${agentJsonResponse.status}`);
  assertJsonOptOut(await agentJsonResponse.json() as Record<string, unknown>, 'agent JSON live turn');
} finally {
  server.close();
  await once(server, 'close');
}

closeDatabase();
console.log('OK: Qwen and MiMo test adapters, provider-neutral settlement, canonical live opt-out, and override precedence.');
