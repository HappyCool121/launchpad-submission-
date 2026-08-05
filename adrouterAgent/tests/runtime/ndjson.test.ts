import { describe, expect, it } from 'vitest';
import { NdjsonParser } from '@/runtime/ndjson';

describe('NdjsonParser', () => {
  it('preserves ad-before-text ordering across split chunks', () => {
    const parser = new NdjsonParser();
    const first = parser.push(
      new TextEncoder().encode(
        '{"type":"ad","ad":{"turn_id":"turn-1","tier":"C","sponsor":{"brand_name":"Acme","ad_copy":"Safe compute","click_url":"https://acme.example"},"provisional_savings":0.05}}\n{"type":"te'
      )
    );
    const second = parser.push(new TextEncoder().encode('xt","delta":"hello"}\n'));
    const final = parser.finish();

    expect(first.errors).toEqual([]);
    expect(second.errors).toEqual([]);
    expect([...first.events, ...second.events, ...final.events].map((event) => event.type)).toEqual(
      ['ad', 'text']
    );
  });

  it('normalizes nested backend tool calls and settlement payloads', () => {
    const parser = new NdjsonParser();
    const result = parser.push(
      new TextEncoder().encode(
        [
          JSON.stringify({
            type: 'tool_call',
            tool_call: {
              id: 'call-1',
              function: { name: 'read_file', arguments: '{"path":"README.md"}' },
            },
          }),
          JSON.stringify({
            type: 'settlement',
            turn_id: 'turn-1',
            settlement: {
              prompt_cost: 0.02,
              ad_subsidy: 0.01,
              paid: 0.01,
              input_tokens: 10,
              cache_hit_tokens: 3,
              output_tokens: 4,
              usage: { total_tokens: 17, cache_write_tokens: 2 },
            },
          }),
          '',
        ].join('\n')
      )
    );

    expect(result.errors).toEqual([]);
    expect(result.events[0]).toEqual({
      type: 'tool_call',
      id: 'call-1',
      name: 'read_file',
      arguments: { path: 'README.md' },
    });
    expect(result.events[1]).toMatchObject({
      type: 'settlement',
      turn_id: 'turn-1',
      cost: 0.02,
      subsidy: 0.01,
      cache_read: 3,
      cache_write: 2,
      total_tokens: 17,
    });
  });

  it('keeps router ad identity and does not confuse savings dollars with a percentage', () => {
    const parser = new NdjsonParser();
    const result = parser.push(
      new TextEncoder().encode(
        `${JSON.stringify({
          type: 'ad',
          ad: {
            turn_id: 'router-b',
            tier: 'B',
            reason: 'Relevant developer tooling',
            sponsor: {
              brand_name: 'Fixture Cloud',
              ad_copy: 'Ship safely.',
              click_url: 'https://example.com/fixture',
            },
            provisional_savings: 0.0075,
          },
        })}\n`
      )
    );

    expect(result.events[0]).toMatchObject({
      type: 'ad',
      ad: {
        routerTurnId: 'router-b',
        tier: 'B',
        reason: 'Relevant developer tooling',
        provisionalSavings: 0.0075,
        subsidyPercent: 40,
      },
    });
  });

  it('reports malformed events and still returns later valid events', () => {
    const parser = new NdjsonParser();
    const result = parser.push(
      new TextEncoder().encode('{"type":"text","delta":"ok"}\nnot-json\n{"type":"done"}\n')
    );

    expect(result.events.map((event) => event.type)).toEqual(['text', 'done']);
    expect(result.errors).toHaveLength(1);
  });
});
