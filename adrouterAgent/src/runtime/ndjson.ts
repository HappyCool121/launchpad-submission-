import { z } from 'zod';
import { type Sponsor, SponsorSchema } from '../shared/contracts';

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

const text = (value: unknown): string => (typeof value === 'string' ? value : '');
const number = (value: unknown): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
};

const normalizeTier = (value: unknown): Sponsor['tier'] | undefined => {
  if (value === 'A' || value === 1 || value === '1') return 'A';
  if (value === 'B' || value === 2 || value === '2') return 'B';
  if (value === 'C' || value === 3 || value === '3') return 'C';
  return value === 'NONE' ? 'NONE' : undefined;
};

const normalizeSponsor = (payload: Record<string, unknown>): Sponsor => {
  const rawAd = record(payload.ad);
  const cliAd = Array.isArray(payload.ads) ? record(payload.ads[0]) : {};
  const rawSponsor = record(rawAd.sponsor);
  const tier = normalizeTier(rawAd.tier ?? cliAd.tier) ?? 'NONE';
  const url = text(rawSponsor.click_url ?? rawAd.url ?? cliAd.url);
  const provisional = number(rawAd.provisional_savings);
  const reason = text(rawAd.reason ?? cliAd.body);
  const subsidyPercent = tier === 'A' ? 100 : tier === 'B' ? 40 : tier === 'C' ? 5 : 0;
  return SponsorSchema.parse({
    routerTurnId: text(rawAd.turn_id ?? cliAd.turn_id) || null,
    tier,
    sponsorName:
      tier === 'NONE'
        ? null
        : text(rawSponsor.brand_name ?? rawAd.sponsorName ?? cliAd.title) || null,
    headline:
      tier === 'NONE'
        ? reason || 'Routed without sponsored content.'
        : text(rawAd.headline ?? cliAd.title ?? rawSponsor.brand_name) || null,
    body: tier === 'NONE' ? null : text(rawSponsor.ad_copy ?? rawAd.body ?? cliAd.body) || null,
    url: /^https:\/\//i.test(url) ? url : null,
    reason,
    provisionalSavings: provisional,
    subsidyPercent,
  });
};

const normalizeToolCall = (value: unknown): Record<string, unknown> => {
  const call = record(value);
  const fn = record(call.function);
  const rawArguments = call.arguments ?? fn.arguments ?? {};
  let args: Record<string, unknown> = {};
  if (typeof rawArguments === 'string') {
    try {
      args = record(JSON.parse(rawArguments));
    } catch {
      args = {};
    }
  } else {
    args = record(rawArguments);
  }
  return { id: call.id, name: call.name ?? fn.name, arguments: args };
};

const RawRouterStreamEventSchema = z.discriminatedUnion('type', [
  z
    .object({ type: z.literal('ad'), ad: z.unknown().optional(), ads: z.unknown().optional() })
    .passthrough(),
  z
    .object({
      type: z.literal('text'),
      delta: z.string().optional(),
      content: z.string().optional(),
    })
    .passthrough(),
  z
    .object({
      type: z.literal('thinking'),
      delta: z.string().optional(),
      content: z.string().optional(),
    })
    .passthrough(),
  z
    .object({
      type: z.literal('tool_call'),
      tool_call: z.unknown().optional(),
      id: z.string().optional(),
      name: z.string().optional(),
      arguments: z.unknown().optional(),
    })
    .passthrough(),
  z
    .object({
      type: z.literal('settlement'),
      turn_id: z.string().min(1),
      settlement: z.unknown().optional(),
      usage: z.unknown().optional(),
    })
    .passthrough(),
  z.object({ type: z.literal('done') }).passthrough(),
  z.object({ type: z.literal('error'), message: z.string().min(1), code: z.string().optional() }),
]);

export const RouterStreamEventSchema = RawRouterStreamEventSchema.transform((event) => {
  if (event.type === 'ad') return { type: 'ad' as const, ad: normalizeSponsor(event) };
  if (event.type === 'text' || event.type === 'thinking') {
    return { type: event.type, delta: event.delta ?? event.content ?? '' };
  }
  if (event.type === 'tool_call') {
    return { type: 'tool_call' as const, ...normalizeToolCall(event.tool_call ?? event) } as {
      type: 'tool_call';
      id: string;
      name: string;
      arguments: Record<string, unknown>;
    };
  }
  if (event.type === 'settlement') {
    const settlement = record(event.settlement);
    const usage = record(settlement.usage ?? event.usage);
    const cost = record(settlement.cost);
    return {
      type: 'settlement' as const,
      turn_id: event.turn_id,
      cost: number(settlement.prompt_cost ?? cost.total),
      subsidy: number(settlement.ad_subsidy),
      paid: number(settlement.paid),
      cache_read: number(settlement.cache_hit_tokens ?? usage.cache_read_tokens ?? usage.cacheRead),
      cache_write: number(usage.cache_write_tokens ?? usage.cacheWrite),
      input_tokens: number(settlement.input_tokens ?? usage.input_tokens ?? usage.input),
      output_tokens: number(settlement.output_tokens ?? usage.output_tokens ?? usage.output),
      total_tokens: number(usage.total_tokens ?? usage.totalTokens),
      purpose: 'agent',
    };
  }
  return event.type === 'done' ? { type: 'done' as const, usage: record(event.usage) } : event;
});
export type RouterStreamEvent = z.infer<typeof RouterStreamEventSchema>;

export interface ParsedNdjson {
  events: RouterStreamEvent[];
  errors: string[];
}

export class NdjsonParser {
  private readonly decoder = new TextDecoder();
  private remainder = '';

  public push(chunk: Uint8Array): ParsedNdjson {
    this.remainder += this.decoder.decode(chunk, { stream: true });
    return this.drain(false);
  }

  public finish(): ParsedNdjson {
    this.remainder += this.decoder.decode();
    return this.drain(true);
  }

  private drain(flush: boolean): ParsedNdjson {
    const lines = this.remainder.split(/\r?\n/);
    this.remainder = flush ? '' : (lines.pop() ?? '');
    const events: RouterStreamEvent[] = [];
    const errors: string[] = [];

    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line) {
        continue;
      }
      const payload = line.startsWith('data:') ? line.slice(5).trim() : line;
      if (payload === '[DONE]') {
        events.push({ type: 'done', usage: {} });
        continue;
      }
      try {
        events.push(RouterStreamEventSchema.parse(JSON.parse(payload)));
      } catch (error) {
        errors.push(
          `Malformed router event: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }

    if (flush && this.remainder.trim()) {
      errors.push('Malformed trailing router event.');
    }

    return { events, errors };
  }
}
