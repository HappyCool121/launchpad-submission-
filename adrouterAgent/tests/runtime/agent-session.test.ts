import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { describe, expect, it } from 'vitest';
import {
  compactMessages,
  DesktopAgentSession,
  historyToMessages,
  normalizeAssistantContent,
  toAgentThinkingLevel,
} from '@/runtime/agent-session';
import type { SessionEntry } from '@/shared/contracts';
import { bundledCatalogModels } from '@/shared/model-catalog';
import type { RuntimeEvent } from '@/shared/runtime-protocol';

const threadId = '11111111-1111-4111-8111-111111111111';
const turnId = '22222222-2222-4222-8222-222222222222';
const timestamp = '2026-07-11T12:00:00.000Z';
const canonicalModel = bundledCatalogModels()[0];
if (!canonicalModel) throw new Error('Expected the bundled catalog to contain a model.');

const sessionEntry = (
  ordinal: number,
  kind: SessionEntry['kind'],
  payload: Record<string, unknown>
): SessionEntry => ({
  id: `10000000-0000-4000-8000-${ordinal.toString().padStart(12, '0')}`,
  threadId,
  turnId,
  sourceEventId: `20000000-0000-4000-8000-${ordinal.toString().padStart(12, '0')}`,
  ordinal,
  kind,
  timestamp,
  payload,
  digest: ordinal.toString(16).padStart(64, '0'),
});

describe('durable agent context', () => {
  it('maps the router no-thinking value to the Pi agent boundary', () => {
    expect(toAgentThinkingLevel('none')).toBe('off');
    expect(toAgentThinkingLevel('high')).toBe('high');
  });

  it('runs the shared in-memory AgentSession to a terminal response', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response('{"type":"text","content":"finished"}\n{"type":"done"}\n', {
        status: 200,
        headers: { 'content-type': 'application/x-ndjson' },
      })) as typeof fetch;
    const events: RuntimeEvent[] = [];
    const session = new DesktopAgentSession(
      {
        type: 'start',
        threadId,
        turnId,
        project: {
          id: '33333333-3333-4333-8333-333333333333',
          path: process.cwd(),
          displayName: 'fixture',
          instructions: '',
          repositoryInstructions: '',
          repositoryInstructionFiles: [],
          bundleInstructions: '',
          promptSources: [],
          permissionMode: 'workspace-write',
          delegationEnabled: false,
        },
        model: { ...canonicalModel, configured: true },
        thinkingLevel: 'medium',
        runtimeMode: 'mock',
        sponsoredCompute: true,
        router: {
          authMode: 'custom_bearer',
          serverUrl: 'http://localhost:8787',
          token: 'fixture-token',
        },
        input: 'Finish the task.',
        history: [],
        allowedCommands: [],
      },
      (event) => events.push(event)
    );
    try {
      await session.run();
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'turn.lifecycle',
        payload: { status: 'completed', error: null },
      })
    );
    expect(events).toContainEqual(
      expect.objectContaining({
        type: 'message.complete',
        payload: expect.objectContaining({ text: 'finished' }),
      })
    );
  }, 10_000);

  it('restores structured assistant tool calls before matching tool results', () => {
    const messages = historyToMessages([
      sessionEntry(1, 'assistant_message', {
        role: 'assistant',
        text: '',
        model: 'deepseek-v4-flash',
        content: [
          { type: 'thinking', thinking: 'hidden' },
          {
            type: 'toolCall',
            id: 'call-1',
            name: 'read_file',
            arguments: { path: 'src/main.ts' },
          },
        ],
      }),
      sessionEntry(2, 'tool_result', {
        name: 'read_file',
        toolCallId: 'call-1',
        output: '{"content":"ok"}',
        isError: false,
      }),
    ]);

    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({
      role: 'assistant',
      stopReason: 'toolUse',
      content: [{ type: 'toolCall', id: 'call-1', name: 'read_file' }],
    });
    expect(messages[1]).toMatchObject({ role: 'toolResult', toolCallId: 'call-1' });
  });

  it('removes hidden thinking and sponsor fields from persisted tool calls', () => {
    expect(
      normalizeAssistantContent([
        { type: 'thinking', thinking: 'private' },
        {
          type: 'toolCall',
          id: 'call-2',
          name: 'apply_patch',
          arguments: { path: 'a.ts', sponsor: { headline: 'do not retain' } },
        },
      ])
    ).toEqual([
      { type: 'toolCall', id: 'call-2', name: 'apply_patch', arguments: { path: 'a.ts' } },
    ]);
  });

  it('retains old user constraints and durable anchors during token-aware compaction', async () => {
    const messages: AgentMessage[] = [
      {
        role: 'user',
        content: 'Acceptance criteria: preserve the public API.',
        timestamp: Date.now(),
      },
      ...Array.from(
        { length: 24 },
        (_, index): AgentMessage => ({
          role: 'assistant',
          content: [{ type: 'text', text: `${index}:${'x'.repeat(20_000)}` }],
          api: 'adrouter',
          provider: 'adrouter',
          model: 'test',
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: 'stop',
          timestamp: Date.now(),
        })
      ),
    ];
    const emitted: RuntimeEvent[] = [];
    const compacted = await compactMessages(
      messages,
      (event) => emitted.push(event),
      [
        'APPROVAL DECISION: custom-runner allowed once',
        `FILE STATE: src/main.ts modified in ${threadId}`,
      ],
      {
        model: {
          ...canonicalModel,
          contextWindow: 131_072,
          maxInputTokens: 65_536,
          maxOutputTokens: 32_768,
        },
        systemPrompt: 'Fixture system prompt.',
        tools: [],
      }
    );

    expect(compacted.length).toBeLessThan(messages.length);
    expect(compacted[0]).toMatchObject({ role: 'compactionSummary' });
    const summary = compacted[0]?.role === 'compactionSummary' ? compacted[0].summary : '';
    expect(summary).toContain('Acceptance criteria: preserve the public API.');
    expect(summary).toContain('APPROVAL DECISION: custom-runner allowed once');
    expect(summary).toContain('FILE STATE: src/main.ts modified');
    expect(emitted.map((event) => event.type)).toEqual([
      'context.budget',
      'compaction',
      'context.budget',
    ]);
    expect(emitted[1]?.payload).toMatchObject({ outcome: 'completed', reserveTokens: 16_384 });
  });
});
