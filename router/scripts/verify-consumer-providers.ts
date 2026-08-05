import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';

const requests: Record<string, unknown>[] = [];
const server = createServer((request, response) => {
  const chunks: Buffer[] = [];
  request.on('data', (chunk: Buffer) => chunks.push(chunk));
  request.on('end', () => {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
    requests.push(body);
    const systemMessageCount = Array.isArray(body.messages)
      ? body.messages.filter((message) => message && typeof message === 'object' && (message as { role?: unknown }).role === 'system').length
      : 0;
    if (typeof body.model === 'string' && body.model.startsWith('agnes-') && systemMessageCount > 1) {
      response.writeHead(400, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'Agnes accepts at most one system message.' }));
      return;
    }
    if (body.stream === true) {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.write('data: {"choices":[{"index":0,"delta":{"reasoning_content":"think "}}]}\n\n');
      response.write('data: {"choices":[{"index":0,"delta":{"content":"ok"}}]}\n\n');
      response.write('data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":2,"prompt_tokens_details":{"cached_tokens":3}}}\n\n');
      response.end('data: [DONE]\n\n');
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({
      id: 'chatcmpl_test', object: 'chat.completion', created: 1, model: body.model,
      choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content: 'ok', reasoning_content: 'think' } }],
      usage: { prompt_tokens: 10, completion_tokens: 2 },
    }));
  });
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const baseURL = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;

process.env.ROUTER_RUNTIME_PROFILE = 'demo';
process.env.ADROUTER_API_KEY = 'consumer-provider-route-test';
process.env.MIMO_ENABLED = 'true';
process.env.MIMO_API_KEY = 'test-mimo-key';
process.env.MIMO_BASE_URL = baseURL;
process.env.AGNES_ENABLED = 'true';
process.env.AGNES_API_KEY = 'test-agnes-key';
process.env.AGNES_BASE_URL = baseURL;

const [
  { mimoProvider },
  { agnesProvider },
  modelRegistry,
  { chatRouter },
  { agentTurnRouter },
  sponsorStore,
  database,
  { serializeOpenAICompatibleAgentMessages },
  pricing,
] = await Promise.all([
  import('../src/lib/providers/mimo.js'),
  import('../src/lib/providers/agnes.js'),
  import('../src/lib/modelRegistry.js'),
  import('../src/routes/chat.js'),
  import('../src/routes/agent-turn.js'),
  import('../src/lib/sponsorStore.js'),
  import('../src/lib/database.js'),
  import('../src/lib/providers/openai-compatible.js'),
  import('../src/lib/pricing.js'),
]);

const baseRequest = {
  messages: [{ role: 'user', content: 'hello' }],
  systemPrompt: 'Be helpful.',
  maxOutputTokens: 64,
};

try {
  assert.deepEqual(modelRegistry.listModels().map((model) => model.id), [
    'deepseek-v4-flash', 'deepseek-v4-pro',
    'mimo-v2.5', 'mimo-v2.5-pro',
    'agnes-2.0-flash', 'agnes-2.5-flash', 'agnes-2.5-pro', 'agnes-2.5-pro-alpha',
  ]);
  assert.deepEqual(modelRegistry.listStaticModels().filter((model) => model.provider === 'mimo').map((model) => [model.id, model.thinking_levels, model.default_thinking_level]), [
    ['mimo-v2.5', ['none', 'high'], 'high'],
    ['mimo-v2.5-pro', ['none', 'high'], 'high'],
  ]);
  assert.deepEqual(modelRegistry.listStaticModels().filter((model) => model.provider === 'agnes').map((model) => [model.id, model.thinking_levels, model.default_thinking_level]), [
    ['agnes-2.0-flash', ['none', 'high'], 'none'],
    ['agnes-2.5-flash', ['none', 'high'], 'none'],
    ['agnes-2.5-pro', ['high'], 'high'],
    ['agnes-2.5-pro-alpha', ['high'], 'high'],
  ]);
  assert.throws(() => modelRegistry.resolveThinkingForModel('mimo-v2.5', 'medium'), /supports none, high/);
  assert.throws(() => modelRegistry.resolveThinkingForModel('agnes-2.5-pro-alpha', 'none'), /supports high/);
  assert.throws(() => modelRegistry.resolveThinkingForModel('agnes-2.5-pro', 'none'), /supports high/);
  assert.throws(() => modelRegistry.resolveThinkingForModel('agnes-2.5-flash', undefined, 'high'), /reasoning_effort is not supported/);
  assert.equal(modelRegistry.resolveThinkingForModel('agnes-2.5-flash', undefined), 'none');
  assert.equal(modelRegistry.resolveThinkingForModel('agnes-2.5-pro-alpha', undefined), 'high');
  assert.equal(modelRegistry.resolveThinkingForModel('agnes-2.0-flash', undefined), 'none');
  assert.equal(modelRegistry.resolveThinkingForModel('agnes-2.5-pro', undefined), 'high');
  assert.deepEqual(modelRegistry.authorizedModelsForAccount({ isDeveloper: true, flashEnabled: true, proEnabled: false }), [
    'deepseek-v4-flash', 'mimo-v2.5', 'mimo-v2.5-pro', 'agnes-2.0-flash', 'agnes-2.5-flash', 'agnes-2.5-pro', 'agnes-2.5-pro-alpha',
  ]);
  assert.deepEqual(modelRegistry.authorizedModelsForAccount({ isDeveloper: false, flashEnabled: false, proEnabled: true }), [
    'deepseek-v4-pro',
  ]);
  for (const model of modelRegistry.listModels()) {
    assert(Object.hasOwn(pricing.MODEL_PRICING, model.id), `${model.id} is missing pricing`);
  }
  assert.deepEqual(pricing.computeCostBreakdown({
    model: 'agnes-2.0-flash', inputTokens: 1_000_000, outputTokens: 1_000_000,
  }), { input_cache_hit: 0, input_cache_miss: 0, cache_write: 0, output: 0, total: 0 });
  assert.deepEqual(pricing.computeCostBreakdown({
    model: 'agnes-2.5-pro', inputTokens: 1_000_000, outputTokens: 1_000_000,
  }), { input_cache_hit: 0, input_cache_miss: 0.45, cache_write: 0, output: 0.9, total: 1.35 });

  const mergeRequest = {
    ...baseRequest,
    model: 'agnes-2.5-pro-alpha',
    thinkingLevel: 'high' as const,
    systemPrompt: 'Router prompt',
    messages: [
      { role: 'system', content: 'Historical prompt one' },
      { role: 'system', content: '   ' },
      { role: 'user', content: 'look it up' },
      { role: 'assistant', content: [
        { type: 'thinking', thinking: 'prior reasoning' },
        { type: 'toolCall', id: 'call_1', name: 'lookup', arguments: { q: 'value' } },
        { type: 'toolCall', id: 'call_1', name: 'lookup', arguments: { q: 'value' } },
      ] },
      { role: 'toolResult', toolCallId: 'call_1', content: 'result' },
      { role: 'toolResult', toolCallId: 'call_1', content: 'result' },
      { role: 'system', content: 'Historical prompt two' },
      { role: 'user', content: 'summarize' },
    ],
  };
  const merged = serializeOpenAICompatibleAgentMessages(mergeRequest, 'merge') as unknown as Record<string, unknown>[];
  assert.deepEqual(merged.map((message) => message.role), ['system', 'user', 'assistant', 'tool', 'user']);
  assert.equal(merged[0]?.content, 'Router prompt\n\nHistorical prompt one\n\nHistorical prompt two');
  assert.equal(merged.filter((message) => message.role === 'system').length, 1);
  assert.equal(merged.filter((message) => message.role === 'tool').length, 1);
  assert.equal((merged.find((message) => message.role === 'assistant')?.tool_calls as unknown[]).length, 1);
  assert.equal(serializeOpenAICompatibleAgentMessages({ ...mergeRequest, systemPrompt: ' ', messages: [{ role: 'system', content: '\t' }] }, 'merge').length, 0);
  const preserved = serializeOpenAICompatibleAgentMessages(mergeRequest) as unknown as Record<string, unknown>[];
  assert.deepEqual(preserved.filter((message) => message.role === 'system').map((message) => message.content), [
    'Router prompt', 'Historical prompt one', '   ', 'Historical prompt two',
  ]);
  assert.throws(() => serializeOpenAICompatibleAgentMessages({
    ...mergeRequest,
    messages: [{ role: 'toolResult', toolCallId: 'call_conflict', content: 'first' }, { role: 'toolResult', toolCallId: 'call_conflict', content: 'second' }],
  }, 'merge'), /conflicting tool results reuse tool call ID call_conflict/);

  await mimoProvider.completeAgent({
    ...baseRequest,
    model: 'mimo-v2.5-pro',
    thinkingLevel: 'high',
    tools: [{ name: 'lookup', parameters: { type: 'object' } }],
    messages: [
      { role: 'user', content: 'look it up' },
      { role: 'assistant', content: [
        { type: 'thinking', thinking: 'prior reasoning', thinkingSignature: 'reasoning_content' },
        { type: 'toolCall', id: 'call_1', name: 'lookup', arguments: { q: 'value' } },
      ] },
      { role: 'toolResult', toolCallId: 'call_1', content: 'result' },
    ],
  });
  const mimoHigh = requests.at(-1)!;
  assert.equal(mimoHigh.max_completion_tokens, 64);
  assert.deepEqual(mimoHigh.thinking, { type: 'enabled' });
  assert.equal('max_tokens' in mimoHigh, false);
  const replay = (mimoHigh.messages as Record<string, unknown>[]).find((message) => message.role === 'assistant');
  assert.equal(replay?.reasoning_content, 'prior reasoning');

  const streamEvents: Record<string, unknown>[] = [];
  const mimoStream = await mimoProvider.streamAgent({ ...baseRequest, model: 'mimo-v2.5', thinkingLevel: 'none' }, (event) => streamEvents.push(event as Record<string, unknown>));
  assert.deepEqual(requests.at(-1)?.thinking, { type: 'disabled' });
  assert.deepEqual(mimoStream.usage, { input_tokens: 7, cache_read_tokens: 3, cache_write_tokens: 0, output_tokens: 2 });
  assert.deepEqual(streamEvents.map((event) => event.type), ['thinking', 'text']);

  await agnesProvider.completeAgent({ ...baseRequest, model: 'agnes-2.5-flash', thinkingLevel: 'high' });
  assert.deepEqual(requests.at(-1)?.chat_template_kwargs, { enable_thinking: true });
  assert.equal(requests.at(-1)?.max_tokens, 64);
  assert.equal('reasoning_effort' in requests.at(-1)!, false);

  await agnesProvider.completeAgent({ ...baseRequest, model: 'agnes-2.5-flash', thinkingLevel: 'none' });
  assert.equal('chat_template_kwargs' in requests.at(-1)!, false);

  await agnesProvider.completeAgent({ ...baseRequest, model: 'agnes-2.0-flash', thinkingLevel: 'high' });
  assert.deepEqual(requests.at(-1)?.chat_template_kwargs, { enable_thinking: true });

  await agnesProvider.completeAgent({ ...baseRequest, model: 'agnes-2.0-flash', thinkingLevel: 'none' });
  assert.equal('chat_template_kwargs' in requests.at(-1)!, false);

  const agnes20Stream = await agnesProvider.streamAgent(
    { ...baseRequest, model: 'agnes-2.0-flash', thinkingLevel: 'high' },
    () => undefined,
  );
  assert.deepEqual(requests.at(-1)?.chat_template_kwargs, { enable_thinking: true });
  assert.deepEqual(agnes20Stream.usage, { input_tokens: 7, cache_read_tokens: 3, cache_write_tokens: 0, output_tokens: 2 });

  await agnesProvider.completeAgent({ ...baseRequest, model: 'agnes-2.5-pro-alpha', thinkingLevel: 'high' });
  assert.equal('chat_template_kwargs' in requests.at(-1)!, false);
  assert.equal('thinking' in requests.at(-1)!, false);

  await agnesProvider.completeAgent({
    ...baseRequest,
    model: 'agnes-2.5-pro',
    thinkingLevel: 'high',
    tools: [{ name: 'lookup', parameters: { type: 'object' } }],
  });
  assert.equal('chat_template_kwargs' in requests.at(-1)!, false);
  assert.equal('thinking' in requests.at(-1)!, false);
  assert.equal(Array.isArray(requests.at(-1)?.tools), true);

  await agnesProvider.streamAgent(
    { ...baseRequest, model: 'agnes-2.5-pro', thinkingLevel: 'high' },
    () => undefined,
  );
  assert.equal('chat_template_kwargs' in requests.at(-1)!, false);
  assert.equal('thinking' in requests.at(-1)!, false);

  await sponsorStore.initSponsorStore();
  const app = express();
  app.use(express.json());
  app.use('/api', chatRouter);
  app.use(agentTurnRouter);
  const routeServer = app.listen(0, '127.0.0.1');
  await once(routeServer, 'listening');
  const routeBase = `http://127.0.0.1:${(routeServer.address() as AddressInfo).port}`;
  const headers = { authorization: `Bearer ${process.env.ADROUTER_API_KEY}`, 'content-type': 'application/json' };
  try {
    const badChat = await fetch(`${routeBase}/api/chat`, {
      method: 'POST', headers,
      body: JSON.stringify({ model: 'agnes-2.5-pro-alpha', thinking_level: 'none', runtime_mode: 'live', messages: [{ role: 'user', content: 'hello' }] }),
    });
    assert.equal(badChat.status, 400);
    assert.equal((await badChat.json() as { code?: string }).code, 'unsupported_thinking_level');

    const badAgent = await fetch(`${routeBase}/v1/agent/turn`, {
      method: 'POST', headers: { ...headers, accept: 'application/x-ndjson' },
      body: JSON.stringify({ model: 'mimo-v2.5', thinking_level: 'medium', runtime_mode: 'live', context: { messages: [{ role: 'user', content: 'hello' }] } }),
    });
    assert.equal(badAgent.status, 400);
    assert.equal((await badAgent.json() as { code?: string }).code, 'unsupported_thinking_level');

    const chat = await fetch(`${routeBase}/api/chat`, {
      method: 'POST', headers,
      body: JSON.stringify({ model: 'agnes-2.5-pro-alpha', runtime_mode: 'live', ads_enabled: false, messages: [{ role: 'user', content: 'hello' }] }),
    });
    assert.equal(chat.ok, true, await chat.text());

    const agentJson = await fetch(`${routeBase}/v1/agent/turn`, {
      method: 'POST', headers: { ...headers, accept: 'application/json' },
      body: JSON.stringify({
        model: 'agnes-2.5-pro-alpha', runtime_mode: 'live',
        context: { systemPrompt: 'You are a coding agent.', messages: [{ role: 'user', content: 'hello' }] },
        metadata: { ads_enabled: false },
      }),
    });
    const agentJsonBody = await agentJson.text();
    assert.equal(agentJson.ok, true, agentJsonBody);

    const agentNdjson = await fetch(`${routeBase}/v1/agent/turn`, {
      method: 'POST', headers: { ...headers, accept: 'application/x-ndjson' },
      body: JSON.stringify({
        model: 'agnes-2.5-pro-alpha', runtime_mode: 'live',
        context: { systemPrompt: 'You are a coding agent.', messages: [{ role: 'user', content: 'hello' }] },
        metadata: { ads_enabled: false },
      }),
    });
    const agentNdjsonBody = await agentNdjson.text();
    assert.equal(agentNdjson.ok, true, agentNdjsonBody);
    const agentEvents = agentNdjsonBody.split('\n').filter(Boolean).map((line) => JSON.parse(line) as { type?: string });
    assert.equal(agentEvents.at(-1)?.type, 'done');

    const zeroCostResponse = await fetch(`${routeBase}/v1/agent/turn`, {
      method: 'POST', headers: { ...headers, accept: 'application/json' },
      body: JSON.stringify({
        model: 'agnes-2.0-flash', runtime_mode: 'live',
        context: { messages: [{ role: 'user', content: 'hello' }] },
        metadata: { ads_enabled: false },
      }),
    });
    const zeroCostBody = await zeroCostResponse.json() as { settlement?: { prompt_cost?: number } };
    assert.equal(zeroCostResponse.ok, true, JSON.stringify(zeroCostBody));
    assert.equal(zeroCostBody.settlement?.prompt_cost, 0);

    const paidResponse = await fetch(`${routeBase}/v1/agent/turn`, {
      method: 'POST', headers: { ...headers, accept: 'application/json' },
      body: JSON.stringify({
        model: 'agnes-2.5-pro', runtime_mode: 'live',
        context: { messages: [{ role: 'user', content: 'hello' }] },
        metadata: { ads_enabled: false },
      }),
    });
    const paidBody = await paidResponse.json() as { settlement?: { prompt_cost?: number; paid?: number } };
    assert.equal(paidResponse.ok, true, JSON.stringify(paidBody));
    assert((paidBody.settlement?.prompt_cost ?? 0) > 0);
    assert.equal(paidBody.settlement?.paid, paidBody.settlement?.prompt_cost);
  } finally {
    routeServer.close();
    await once(routeServer, 'close');
  }

  console.log('OK: eight-model catalog, Agnes system merging, thinking contracts, pricing, routes, streaming, and usage normalization.');
} finally {
  server.close();
  await once(server, 'close');
  database.closeDatabase();
}
