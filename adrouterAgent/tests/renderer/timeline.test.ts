import { describe, expect, it } from 'vitest';
import { buildTimeline } from '@/renderer/timeline';
import type { JournalEvent } from '@/shared/contracts';

const threadId = '11111111-1111-4111-8111-111111111111';
const turnId = '22222222-2222-4222-8222-222222222222';
const timestamp = '2026-07-12T00:00:00.000Z';

const event = (
  sequence: number,
  type: JournalEvent['type'],
  payload: Record<string, unknown>
): JournalEvent => ({
  id: `${sequence.toString().padStart(8, '0')}-0000-4000-8000-000000000000`,
  threadId,
  turnId,
  sequence,
  type,
  timestamp,
  payload,
});

const sponsor = (tier: 'A' | 'B' | 'C' | 'NONE', routerTurnId: string) => ({
  routerTurnId,
  tier,
  sponsorName: tier === 'NONE' ? null : `${tier} Sponsor`,
  headline: tier === 'NONE' ? 'Sensitive request' : `${tier} headline`,
  body: tier === 'NONE' ? null : 'Sponsored compute',
  url: tier === 'NONE' ? null : 'https://example.com',
  reason: tier === 'NONE' ? 'Sensitive request' : 'Relevant sponsor',
  provisionalSavings: 0.01,
  subsidyPercent: tier === 'A' ? 100 : tier === 'B' ? 40 : tier === 'C' ? 5 : 0,
});

describe('turn timeline projection', () => {
  it('keeps final evidence in the journal without projecting it into chat', () => {
    const timeline = buildTimeline([
      event(1, 'message.user', { text: 'Update the styles.' }),
      event(2, 'message.complete', { text: 'Done.' }),
      event(3, 'final.evidence', {
        outcome: 'completed',
        filesChanged: [{ path: 'styles/style.css', status: 'modified' }],
        pass: true,
      }),
    ]);

    expect(timeline).toHaveLength(2);
    expect(timeline.some((item) => item.kind === 'status')).toBe(false);
    expect(timeline.at(-1)).toMatchObject({ kind: 'assistant', text: 'Done.' });
  });

  it('streams one thinking block and groups only consecutive distinct reads', () => {
    const timeline = buildTimeline(
      [
        event(1, 'message.user', { text: 'Inspect the project.' }),
        event(2, 'thinking.delta', { text: 'I will ' }),
        event(3, 'thinking.delta', { text: 'inspect files.' }),
        event(4, 'tool.activity', {
          name: 'read_file',
          state: 'started',
          toolCallId: 'read-1',
          args: { path: 'a.ts' },
        }),
        event(5, 'tool.result', {
          name: 'read_file',
          toolCallId: 'read-1',
          output: '{}',
          isError: false,
        }),
        event(6, 'tool.activity', {
          name: 'read_file',
          state: 'started',
          toolCallId: 'read-2',
          args: { path: 'b.ts' },
        }),
        event(7, 'tool.result', {
          name: 'read_file',
          toolCallId: 'read-2',
          output: 'failed',
          isError: true,
        }),
        event(8, 'tool.activity', {
          name: 'search_text',
          state: 'started',
          toolCallId: 'search-1',
          args: { query: 'router' },
        }),
        event(9, 'tool.activity', {
          name: 'read_file',
          state: 'started',
          toolCallId: 'read-3',
          args: { path: 'c.ts' },
        }),
        event(10, 'message.delta', { text: 'Finished ' }),
        event(11, 'message.delta', { text: 'inspection.' }),
        event(12, 'message.complete', { text: 'Finished inspection.' }),
        event(13, 'turn.lifecycle', { status: 'completed' }),
      ],
      turnId
    );

    expect(timeline.map((item) => item.kind)).toEqual([
      'user',
      'thinking',
      'read',
      'tool',
      'read',
      'assistant',
    ]);
    expect(timeline[1]).toMatchObject({
      kind: 'thinking',
      text: 'I will inspect files.',
      active: true,
    });
    expect(timeline[2]).toMatchObject({
      kind: 'read',
      reads: [
        { id: 'read-1', path: 'a.ts', status: 'completed' },
        { id: 'read-2', path: 'b.ts', status: 'failed' },
      ],
    });
    expect(timeline[4]).toMatchObject({ kind: 'read', reads: [{ path: 'c.ts' }] });
    expect(timeline[5]).toMatchObject({ kind: 'assistant', text: 'Finished inspection.' });
  });

  it('replaces the active Tier C state and retains compact settled rounds on the answer', () => {
    const tierC = sponsor('C', 'router-c');
    const tierB = sponsor('B', 'router-b');
    const events = [
      event(1, 'message.user', { text: 'Build it.' }),
      event(2, 'sponsor.update', tierC),
      event(3, 'thinking.delta', { text: 'Working.' }),
      event(4, 'settlement', {
        routerTurnId: 'router-c',
        cost: 0.02,
        subsidy: 0.001,
        paid: 0.019,
        sponsor: tierC,
      }),
      event(5, 'sponsor.update', tierB),
      event(6, 'message.delta', { text: 'Done.' }),
      event(7, 'settlement', {
        routerTurnId: 'router-b',
        cost: 0.03,
        subsidy: 0.012,
        paid: 0.018,
        sponsor: tierB,
      }),
      event(8, 'message.complete', { text: 'Done.' }),
    ];

    const activeTierC = buildTimeline(events.slice(0, 4), turnId);
    expect(activeTierC.find((item) => item.kind === 'sponsor')).toMatchObject({
      sponsor: { tier: 'C', routerTurnId: 'router-c' },
    });

    const replaced = buildTimeline(events, turnId);
    expect(replaced.find((item) => item.kind === 'sponsor')).toMatchObject({
      sponsor: { tier: 'B', routerTurnId: 'router-b' },
    });

    const completed = buildTimeline(events);
    expect(completed.find((item) => item.kind === 'sponsor')).toBeUndefined();
    expect(completed.find((item) => item.kind === 'assistant')).toMatchObject({
      rounds: [
        { routerTurnId: 'router-c', sponsor: { tier: 'C' } },
        { routerTurnId: 'router-b', sponsor: { tier: 'B' } },
      ],
    });
  });
});
