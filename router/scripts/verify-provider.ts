// Read-only smoke test for the canonical local provider API.

import '../src/lib/env.js';
import { listStaticModels } from '../src/lib/modelRegistry.js';

export {};

const BASE = process.env.ADROUTER_BASE ?? 'http://localhost:8787';
const API_KEY = process.env.ADROUTER_API_KEY ?? process.env.ROUTER_AUTH_KEY ?? '';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function main() {
  const models = await fetch(`${BASE}/v1/models`);
  assert(models.ok, 'GET /v1/models failed');
  const catalog = await models.json() as { models?: { id: string; thinking_levels: string[] }[] };
  assert(catalog.models?.map((model) => model.id).join(',') === listStaticModels().map((model) => model.id).join(','), 'expected the registered consumer model catalog');
  const levels = Object.fromEntries(catalog.models.map((model) => [model.id, model.thinking_levels.join(',')]));
  assert(levels['deepseek-v4-flash'] === 'none,medium,high' && levels['deepseek-v4-pro'] === 'none,medium,high', 'unexpected DeepSeek thinking catalog');
  assert(levels['mimo-v2.5'] === 'none,high' && levels['mimo-v2.5-pro'] === 'none,high', 'unexpected MiMo thinking catalog');
  assert(levels['agnes-2.0-flash'] === 'none,high' && levels['agnes-2.5-flash'] === 'none,high' && levels['agnes-2.5-pro-alpha'] === 'high' && levels['agnes-2.5-pro'] === 'high', 'unexpected Agnes thinking catalog');

  const health = await fetch(`${BASE}/health`);
  assert(health.ok, 'GET /health failed');
  const healthBody = await health.json() as { status?: string };
  assert(healthBody.status === 'ok', 'public health must remain shallow and provider-neutral');

  const denied = await fetch(`${BASE}/v1/profile`);
  assert(denied.status === 401, 'profile must require an API key');

  const profile = await fetch(`${BASE}/v1/profile`, { headers: { authorization: `Bearer ${API_KEY}` } });
  assert(profile.ok, 'authorized profile lookup failed');

  const retired = await fetch(`${BASE}/v1/turn`, {
    method: 'POST',
    headers: { authorization: `Bearer ${API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      client: 'verify-provider', model: 'deepseek', runtime_mode: 'mock',
      input: { messages: [{ role: 'user', content: 'retired route check' }] },
    }),
  });
  assert(retired.status === 404, 'retired shared-credential turn route must be unavailable');
  const retiredError = await retired.json() as { code?: string };
  assert(retiredError.code === 'route_not_available', 'retired turn route must return the stable error code');

  const response = await fetch(`${BASE}/v1/agent/turn`, {
    method: 'POST',
    headers: { authorization: `Bearer ${API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      runtime_mode: 'mock',
      context: { messages: [{ role: 'user', content: 'I have chest pain and a fever.' }] },
      metadata: { client: 'verify-provider' },
    }),
  });
  assert(response.ok, `canonical turn failed: ${response.status}`);
  const events = (await response.text()).split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
  assert(events[0]?.type === 'ad', 'ad must be the first canonical event');
  assert((events[0]?.ad as { tier?: string } | undefined)?.tier === 'NONE', 'sensitive prompt must be NONE');
  assert(events.some((event) => event.type === 'text'), 'canonical turn must return model text');
  assert(events.at(-1)?.type === 'done', 'canonical turn must finish with done');

  const optOut = await fetch(`${BASE}/v1/agent/turn`, {
    method: 'POST',
    headers: { authorization: `Bearer ${API_KEY}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      runtime_mode: 'mock',
      context: { messages: [{ role: 'user', content: 'recommend a new laptop for coding' }] },
      metadata: { client: 'verify-provider', ads_enabled: false },
    }),
  });
  assert(optOut.ok, `canonical opted-out turn failed: ${optOut.status}`);
  const optOutEvents = (await optOut.text()).split('\n').filter(Boolean).map((line) => JSON.parse(line) as Record<string, unknown>);
  const optOutAd = optOutEvents[0]?.ad as { tier?: string; reason_code?: string; sponsor?: unknown; campaign_id?: unknown } | undefined;
  assert(optOutAd?.tier === 'NONE' && optOutAd.reason_code === 'user_opt_out', 'ads_enabled=false must yield opt-out NONE');
  assert(!optOutAd.sponsor && !optOutAd.campaign_id, 'opt-out must not expose a sponsor or campaign');
  console.log('OK: canonical provider profile, catalog, auth, ad-first stream, and NONE guardrail.');
}

main().catch((error) => {
  console.error('verify-provider failed:', error);
  process.exit(1);
});
