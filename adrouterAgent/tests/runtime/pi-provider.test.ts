import { describe, expect, it, vi } from 'vitest';
import { createAdRouterPiProvider, sanitizeToolCallArguments } from '@/runtime/pi-provider';
import { AdRouterClient } from '@/runtime/router-client';
import { bundledCatalogModels } from '@/shared/model-catalog';
import { containsSponsorKey } from '@/shared/security';

const canonicalModel = bundledCatalogModels()[0];
if (!canonicalModel) throw new Error('Expected the bundled catalog to contain a model.');

const collect = async <T>(stream: AsyncIterable<T>): Promise<T[]> => {
  const events: T[] = [];
  for await (const event of stream) events.push(event);
  return events;
};

const createProvider = (
  fetchFn: typeof fetch,
  onContextOverflow = vi.fn(),
  retry: {
    compactForInputLimit?: Parameters<typeof createAdRouterPiProvider>[0]['compactForInputLimit'];
    onSafeRetry?: () => void;
  } = {}
) => {
  const onSettlement = vi.fn();
  const provider = createAdRouterPiProvider({
    client: new AdRouterClient({
      serverUrl: 'https://router.example',
      authentication: { mode: 'custom_bearer', token: 'fixture-token' },
      fetchFn,
    }),
    model: { ...canonicalModel, configured: true },
    thinkingLevel: 'medium',
    runtimeMode: 'mock',
    projectDisplayName: 'fixture',
    adsEnabled: true,
    onSponsor: vi.fn(),
    onSettlement,
    onContextOverflow,
    ...retry,
  });
  return { provider, onSettlement, onContextOverflow };
};

describe('AdRouter Pi provider', () => {
  it('removes economics fields before a router tool call can reach a desktop tool', () => {
    const argumentsValue = sanitizeToolCallArguments({
      path: 'src/user.ts',
      replacement: 'max = 32',
      sponsor: { headline: 'Do not expose this' },
      nested: { settlement: { paid: 0 } },
    });

    expect(argumentsValue).toEqual({
      path: 'src/user.ts',
      replacement: 'max = 32',
      nested: {},
    });
    expect(containsSponsorKey(argumentsValue)).toBe(false);
  });

  it('fails preflight without dispatching an over-budget router request', async () => {
    const fetchFn: typeof fetch = vi.fn(async () => new Response('{"type":"done"}\n'));
    const { provider, onContextOverflow } = createProvider(fetchFn);

    const events = await collect(
      provider.stream(provider.model, {
        systemPrompt: 'Bound the request.',
        messages: [{ role: 'user', content: 'x'.repeat(4_000_000), timestamp: Date.now() }],
        tools: [],
      })
    );

    expect(fetchFn).not.toHaveBeenCalled();
    expect(onContextOverflow).toHaveBeenCalledOnce();
    expect(events.at(-1)).toMatchObject({
      type: 'error',
      error: { errorMessage: expect.stringContaining('no router request was sent') },
    });
  });

  it('propagates Router token usage into the completed assistant message', async () => {
    const fetchFn: typeof fetch = vi.fn(
      async () =>
        new Response(
          [
            JSON.stringify({ type: 'text', content: 'done' }),
            JSON.stringify({
              type: 'settlement',
              turn_id: 'router-turn-1',
              settlement: {
                prompt_cost: 0.02,
                ad_subsidy: 0.01,
                paid: 0.01,
                input_tokens: 100,
                output_tokens: 20,
                cache_hit_tokens: 5,
                usage: { total_tokens: 127, cache_write_tokens: 2 },
              },
            }),
            JSON.stringify({ type: 'done' }),
            '',
          ].join('\n')
        )
    );
    const { provider, onSettlement } = createProvider(fetchFn);

    const events = await collect(
      provider.stream(provider.model, {
        messages: [{ role: 'user', content: 'finish', timestamp: Date.now() }],
        tools: [],
      })
    );

    expect(onSettlement).toHaveBeenCalledWith(
      expect.objectContaining({ inputTokens: 100, outputTokens: 20, totalTokens: 127 })
    );
    expect(events.findLast((event) => event.type === 'done')).toMatchObject({
      message: {
        usage: {
          input: 100,
          output: 20,
          cacheRead: 5,
          cacheWrite: 2,
          totalTokens: 127,
          cost: { total: 0.02 },
        },
      },
    });
  });

  it('compacts and retries exactly once only when a structured input rejection arrives before output', async () => {
    const fetchFn: typeof fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'too large', code: 'input_limit_exceeded' }), {
          status: 413,
        })
      )
      .mockResolvedValueOnce(
        new Response('{"type":"text","content":"recovered"}\n{"type":"done"}\n')
      );
    const compactForInputLimit = vi.fn(async (context) => ({
      ...context,
      messages: context.messages.slice(-1),
    }));
    const onSafeRetry = vi.fn();
    const { provider } = createProvider(fetchFn, vi.fn(), {
      compactForInputLimit,
      onSafeRetry,
    });

    const events = await collect(
      provider.stream(provider.model, {
        messages: [{ role: 'user', content: 'retry safely', timestamp: Date.now() }],
        tools: [],
      })
    );

    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(compactForInputLimit).toHaveBeenCalledOnce();
    expect(onSafeRetry).toHaveBeenCalledOnce();
    expect(events.findLast((event) => event.type === 'done')).toMatchObject({
      message: { content: [{ type: 'text', text: 'recovered' }] },
    });
  });

  it('never replays after the Router has emitted any stream event', async () => {
    const fetchFn: typeof fetch = vi.fn(
      async () =>
        new Response(
          '{"type":"text","content":"partial"}\n{"type":"error","message":"too large","code":"input_limit_exceeded"}\n'
        )
    );
    const compactForInputLimit = vi.fn(async (context) => context);
    const { provider } = createProvider(fetchFn, vi.fn(), { compactForInputLimit });

    await collect(
      provider.stream(provider.model, {
        messages: [{ role: 'user', content: 'do not replay', timestamp: Date.now() }],
      })
    );

    expect(fetchFn).toHaveBeenCalledOnce();
    expect(compactForInputLimit).not.toHaveBeenCalled();
  });
});
