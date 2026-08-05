import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';

const upstreamRequests: Array<{ authorization?: string; body: Record<string, unknown> }> = [];
const upstream = createServer((request, response) => {
  const chunks: Buffer[] = [];
  request.on('data', (chunk: Buffer) => chunks.push(chunk));
  request.on('end', () => {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
    upstreamRequests.push({ authorization: request.headers.authorization, body });
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write('data: {"choices":[{"index":0,"delta":{"content":"offline integration ok"}}]}\n\n');
    response.write('data: {"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":3}}\n\n');
    response.end('data: [DONE]\n\n');
  });
});
upstream.listen(0, '127.0.0.1');
await once(upstream, 'listening');

process.env.LAUNCHPAD_SUBMISSION = 'true';
process.env.ROUTER_RUNTIME_PROFILE = 'demo';
process.env.ADROUTER_ENV = 'local';
process.env.ADROUTER_API_KEY = 'offline-router-fixture';
process.env.AGNES_ENABLED = 'true';
process.env.AGNES_API_KEY = 'offline-agnes-fixture';
process.env.AGNES_BASE_URL = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/v1`;
process.env.ADROUTER_DEFAULT_MODEL = 'agnes-2.5-flash';

const [{ providerRouter }, { agentTurnRouter }, sponsorStore, database] = await Promise.all([
  import('../src/routes/provider.js'),
  import('../src/routes/agent-turn.js'),
  import('../src/lib/sponsorStore.js'),
  import('../src/lib/database.js'),
]);

await sponsorStore.initSponsorStore();
const app = express();
app.use(express.json());
app.use('/v1', providerRouter);
app.use(agentTurnRouter);
const router = app.listen(0, '127.0.0.1');
await once(router, 'listening');
const origin = `http://127.0.0.1:${(router.address() as AddressInfo).port}`;

try {
  const modelsResponse = await fetch(`${origin}/v1/models`);
  assert.equal(modelsResponse.ok, true);
  const modelsPayload = await modelsResponse.json() as { models: Array<{ id: string }> };
  assert.deepEqual(modelsPayload.models.map((model) => model.id), [
    'agnes-2.0-flash',
    'agnes-2.5-flash',
    'agnes-2.5-pro',
    'agnes-2.5-pro-alpha',
  ]);

  const headers = {
    authorization: 'Bearer offline-router-fixture',
    'content-type': 'application/json',
    accept: 'application/x-ndjson',
  };
  const response = await fetch(`${origin}/v1/agent/turn`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      context: { messages: [{ role: 'user', content: 'Recommend a keyboard for a small coding project.' }] },
      metadata: { client: 'launchpad-offline-integration' },
    }),
  });
  const body = await response.text();
  assert.equal(response.ok, true, body);
  const events = body.split('\n').filter(Boolean).map((line) => JSON.parse(line) as { type?: string });
  assert.equal(events[0]?.type, 'ad');
  assert(events.some((event) => event.type === 'text'));
  assert.equal(events.at(-2)?.type, 'settlement');
  assert.equal(events.at(-1)?.type, 'done');

  assert.equal(upstreamRequests.length, 1);
  assert.equal(upstreamRequests[0]?.authorization, 'Bearer offline-agnes-fixture');
  assert.equal(upstreamRequests[0]?.body.model, 'agnes-2.5-flash');
  for (const sponsor of sponsorStore.getSponsors()) {
    const providerPayload = JSON.stringify(upstreamRequests[0]?.body);
    assert(!providerPayload.includes(sponsor.brand_name));
    assert(!providerPayload.includes(sponsor.ad_copy));
  }

  const mockResponse = await fetch(`${origin}/v1/agent/turn`, {
    method: 'POST',
    headers: { ...headers, accept: 'application/json' },
    body: JSON.stringify({
      runtime_mode: 'mock',
      context: { messages: [{ role: 'user', content: 'hello' }] },
    }),
  });
  assert.equal(mockResponse.status, 400);
  assert.equal((await mockResponse.json() as { code?: string }).code, 'mock_mode_not_available');
  assert.equal(upstreamRequests.length, 1);

  console.log('OK: offline CLI/Agent route uses the four-model live Agnes contract without leaking sponsor data.');
} finally {
  router.close();
  upstream.close();
  await Promise.all([once(router, 'close'), once(upstream, 'close')]);
  await sponsorStore.stopSponsorStore();
  database.closeDatabase();
}
