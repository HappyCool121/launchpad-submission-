// Smoke test for POST /v1/agent/turn. Start the server first:
// npm run dev
// npm run test:agent-turn

import '../src/lib/env.js';

export {};

const BASE = process.env.ADROUTER_BASE ?? 'http://localhost:8787';
const ROUTER_TEST_KEY = process.env.ADROUTER_API_KEY ?? process.env.ROUTER_AUTH_KEY;

async function readNdjson(res: Response): Promise<Record<string, unknown>[]> {
  const text = await res.text();
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function postTurn(prompt: string, extra: Record<string, unknown> = {}) {
  const res = await fetch(`${BASE}/v1/agent/turn`, {
    method: 'POST',
    headers: {
      accept: 'application/x-ndjson',
      'content-type': 'application/json',
      ...(ROUTER_TEST_KEY ? { authorization: `Bearer ${ROUTER_TEST_KEY}` } : {}),
    },
    body: JSON.stringify({
      model: 'deepseek-v4-flash',
      thinking_level: 'high',
      runtime_mode: 'mock',
      context: { messages: [{ role: 'user', content: prompt }] },
      metadata: { client: 'verify-agent-turn', ad_mode: 'mock' },
      ...extra,
    }),
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  }
  return readNdjson(res);
}

function tierFromEvents(events: Record<string, unknown>[]): string | undefined {
  const event = events[0] as { ad?: { tier?: unknown } } | undefined;
  return typeof event?.ad?.tier === 'string' ? event.ad.tier : undefined;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function main() {
  console.log(`Testing AdRouter agent turn at ${BASE} ...`);

  const health = await fetch(`${BASE}/health`);
  assert(health.ok, '/health alias failed');

  const events = await postTurn('debug this python loop');
  assert(events[0]?.type === 'ad', 'first event must be ad');
  assert(events.some((event) => event.type === 'text'), 'expected text event');
  assert(events.some((event) => event.type === 'settlement'), 'expected settlement event');
  assert(events.at(-1)?.type === 'done', 'last event must be done');

  const piEvents = await postTurn('continue after reading package json', {
    context: {
      systemPrompt: 'You are a coding agent.',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'read package.json' }], timestamp: Date.now() },
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'Need the file first.', thinkingSignature: 'reasoning_content' },
            { type: 'toolCall', id: 'call_1', name: 'read_file', arguments: { path: 'package.json' } },
          ],
          timestamp: Date.now(),
        },
        {
          role: 'toolResult',
          toolCallId: 'call_1',
          toolName: 'read_file',
          content: [{ type: 'text', text: '{"name":"tiny"}' }],
          isError: false,
          timestamp: Date.now(),
        },
        { role: 'user', content: 'summarize it', timestamp: Date.now() },
      ],
      tools: [{ name: 'read_file', description: 'Read a file', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }],
    },
  });
  assert(piEvents[0]?.type === 'ad', 'Pi-style context first event must be ad');
  assert(piEvents.some((event) => event.type === 'text'), 'Pi-style context expected text event');

  const noneEvents = await postTurn('I have chest pain and a fever, what should I do?');
  assert(tierFromEvents(noneEvents) === 'NONE', 'guardrail prompt must route to NONE');

  const multiTurnContext = {
    context: {
      messages: [
        { role: 'user', content: 'How do I fix a leaking pipe under my kitchen sink?' },
        { role: 'assistant', content: 'Start by turning off the water supply.' },
        { role: 'toolResult', toolCallId: 'call_1', content: 'The kitchen shutoff valve is under the sink.' },
        { role: 'user', content: 'Where should I go for a cheap vacation in December?' },
      ],
    },
  };
  const pipeEvents = await postTurn('unused latest prompt', {
    context: {
      messages: multiTurnContext.context.messages.slice(0, 1),
    },
  });
  const pipeAd = pipeEvents[0] as { ad?: { sponsor?: { brand_name?: string } } };
  assert(pipeAd.ad?.sponsor?.brand_name === 'Home Depot', 'initial pipe prompt must route to Home Depot');

  const vacationEvents = await postTurn('unused latest prompt', multiTurnContext);
  const vacationAd = vacationEvents[0] as { ad?: { sponsor?: { brand_name?: string } } };
  assert(vacationAd.ad?.sponsor?.brand_name === 'Expedia', 'latest vacation prompt must replace Home Depot with Expedia');

  const sensitiveFollowUp = await postTurn('unused latest prompt', {
    context: {
      messages: [...multiTurnContext.context.messages, { role: 'user', content: 'I have chest pain and a fever.' }],
    },
  });
  assert(tierFromEvents(sensitiveFollowUp) === 'NONE', 'sensitive follow-up must replace the placement with NONE');

  console.log('OK: /v1/agent/turn streams ad first, refreshes from the latest user prompt, and preserves guardrail NONE.');
}

main().catch((err) => {
  console.error('verify-agent-turn failed:', err);
  process.exit(1);
});
