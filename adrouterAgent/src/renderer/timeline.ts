import { type JournalEvent, type Sponsor, SponsorSchema } from '../shared/contracts';

export interface SponsorRound {
  routerTurnId: string;
  sponsor: Sponsor;
  cost: number;
  subsidy: number;
  paid: number;
}

interface BaseTimelineItem {
  id: string;
  turnId: string | null;
}

export type TimelineItem =
  | (BaseTimelineItem & { kind: 'user'; text: string })
  | (BaseTimelineItem & { kind: 'assistant'; text: string; rounds?: SponsorRound[] })
  | (BaseTimelineItem & { kind: 'sponsor'; sponsor: Sponsor })
  | (BaseTimelineItem & {
      kind: 'thinking';
      text: string;
      active: boolean;
      sponsor?: Sponsor;
    })
  | (BaseTimelineItem & {
      kind: 'read';
      reads: Array<{ id: string; path: string; status: 'running' | 'completed' | 'failed' }>;
    })
  | (BaseTimelineItem & {
      kind: 'tool';
      title: string;
      text: string;
      status: 'running' | 'completed' | 'failed';
      toolCallId?: string;
      name?: string;
    })
  | (BaseTimelineItem & { kind: 'status' | 'error'; title: string; text: string });

const eventText = (event: JournalEvent): string => {
  for (const key of ['text', 'message', 'error', 'chunk']) {
    if (typeof event.payload[key] === 'string') return event.payload[key];
  }
  return '';
};

const numberValue = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : 0;

const sponsorValue = (value: unknown): Sponsor | undefined => {
  const parsed = SponsorSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
};

const toolTitle = (name: string): string => {
  const labels: Record<string, string> = {
    apply_patch: 'Edit file',
    git_diff: 'Inspect Git diff',
    git_status: 'Inspect Git status',
    list_files: 'List files',
    read_file: 'Read',
    run_command: 'Run command',
    search_text: 'Search',
  };
  return labels[name] ?? name.replaceAll('_', ' ');
};

const detailText = (value: unknown): string => {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return '';
  }
};

export const buildTimeline = (
  sourceEvents: readonly JournalEvent[],
  runningTurnId?: string
): TimelineItem[] => {
  const events = [...sourceEvents].sort((left, right) => left.sequence - right.sequence);
  const items: TimelineItem[] = [];
  const tools = new Map<string, Extract<TimelineItem, { kind: 'tool' }>>();
  const reads = new Map<string, Extract<TimelineItem, { kind: 'read' }>['reads'][number]>();
  const latestSponsorByTurn = new Map<string, Sponsor>();
  const sponsorByRouterTurn = new Map<string, Sponsor>();
  const roundsByTurn = new Map<string, SponsorRound[]>();

  for (const event of events) {
    const turnId = event.turnId;
    if (event.type === 'sponsor.update') {
      const sponsor = sponsorValue(event.payload);
      if (sponsor && turnId) {
        latestSponsorByTurn.set(turnId, sponsor);
        if (sponsor.routerTurnId) sponsorByRouterTurn.set(sponsor.routerTurnId, sponsor);
        if (turnId === runningTurnId) {
          const previousBanner = items.findIndex(
            (item) => item.kind === 'sponsor' && item.turnId === turnId
          );
          if (previousBanner >= 0) items.splice(previousBanner, 1);
          if (sponsor.tier === 'B' || sponsor.tier === 'C') {
            items.push({ id: event.id, kind: 'sponsor', turnId, sponsor });
          }
        }
      }
      continue;
    }
    if (event.type === 'settlement' && turnId) {
      const routerTurnId =
        typeof event.payload.routerTurnId === 'string' ? event.payload.routerTurnId : event.id;
      const sponsor =
        sponsorValue(event.payload.sponsor) ??
        sponsorByRouterTurn.get(routerTurnId) ??
        latestSponsorByTurn.get(turnId);
      if (sponsor) {
        const round: SponsorRound = {
          routerTurnId,
          sponsor,
          cost: numberValue(event.payload.cost),
          subsidy: numberValue(event.payload.subsidy),
          paid: numberValue(event.payload.paid),
        };
        const rounds = roundsByTurn.get(turnId) ?? [];
        if (!rounds.some((existing) => existing.routerTurnId === routerTurnId)) rounds.push(round);
        roundsByTurn.set(turnId, rounds);
      }
      continue;
    }
    if (event.type === 'message.user') {
      items.push({ id: event.id, kind: 'user', turnId, text: eventText(event) });
      continue;
    }
    if (event.type === 'thinking.delta') {
      const previous = items.at(-1);
      if (previous?.kind === 'thinking' && previous.turnId === turnId) {
        previous.text += eventText(event);
      } else {
        items.push({
          id: event.id,
          kind: 'thinking',
          turnId,
          text: eventText(event),
          active: turnId === runningTurnId,
        });
      }
      continue;
    }
    if (event.type === 'message.delta') {
      const previous = items.at(-1);
      if (previous?.kind === 'assistant' && previous.turnId === turnId) {
        previous.text += eventText(event);
      } else {
        items.push({ id: event.id, kind: 'assistant', turnId, text: eventText(event) });
      }
      continue;
    }
    if (event.type === 'message.complete') {
      const completedText = eventText(event);
      const previous = [...items]
        .reverse()
        .find((item) => item.kind === 'assistant' && item.turnId === turnId);
      if (previous?.kind === 'assistant') {
        if (!previous.text) previous.text = completedText;
      } else if (completedText) {
        items.push({ id: event.id, kind: 'assistant', turnId, text: completedText });
      }
      continue;
    }
    if (event.type === 'tool.activity') {
      const name = typeof event.payload.name === 'string' ? event.payload.name : 'tool';
      const state = event.payload.state;
      if (state !== 'started') continue;
      const toolCallId =
        typeof event.payload.toolCallId === 'string' ? event.payload.toolCallId : event.id;
      if (name === 'read_file') {
        const args =
          event.payload.args && typeof event.payload.args === 'object'
            ? (event.payload.args as Record<string, unknown>)
            : {};
        const path = typeof args.path === 'string' ? args.path : 'file';
        const previous = items.at(-1);
        const group: Extract<TimelineItem, { kind: 'read' }> =
          previous?.kind === 'read' && previous.turnId === turnId
            ? previous
            : { id: event.id, kind: 'read', turnId, reads: [] };
        if (group !== previous) items.push(group);
        const read = { id: toolCallId, path, status: 'running' as const };
        group.reads.push(read);
        reads.set(toolCallId, read);
        continue;
      }
      const item: Extract<TimelineItem, { kind: 'tool' }> = {
        id: event.id,
        kind: 'tool',
        turnId,
        title: toolTitle(name),
        text: detailText(event.payload.args ?? ''),
        status: 'running',
        toolCallId,
        name,
      };
      tools.set(toolCallId, item);
      items.push(item);
      continue;
    }
    if (event.type === 'command.output') {
      const toolCallId =
        typeof event.payload.toolCallId === 'string' ? event.payload.toolCallId : undefined;
      let item = toolCallId ? tools.get(toolCallId) : undefined;
      if (!item) {
        const previous = items.at(-1);
        if (previous?.kind === 'tool' && previous.name === 'run_command') item = previous;
      }
      if (item) item.text += eventText(event);
      continue;
    }
    if (event.type === 'tool.result') {
      const toolCallId =
        typeof event.payload.toolCallId === 'string' ? event.payload.toolCallId : undefined;
      const name = typeof event.payload.name === 'string' ? event.payload.name : 'tool';
      if (toolCallId && reads.has(toolCallId)) {
        const read = reads.get(toolCallId);
        if (read) read.status = event.payload.isError ? 'failed' : 'completed';
        continue;
      }
      let item = toolCallId ? tools.get(toolCallId) : undefined;
      if (!item) {
        const previous = items.at(-1);
        if (previous?.kind === 'tool' && previous.name === name) item = previous;
      }
      if (item) {
        item.status = event.payload.isError ? 'failed' : 'completed';
        const output = event.payload.output ?? event.payload.details;
        if (output) item.text = detailText(output);
      }
      continue;
    }
    if (event.type === 'runtime.crash' || event.type === 'diagnostic') {
      items.push({
        id: event.id,
        kind: 'error',
        turnId,
        title: event.type === 'runtime.crash' ? 'Runtime issue' : 'Notice',
        text: eventText(event),
      });
      continue;
    }
    if (event.type === 'final.evidence') {
      continue;
    }
    if (event.type === 'retry' || event.type === 'compaction') {
      items.push({
        id: event.id,
        kind: 'status',
        turnId,
        title: event.type === 'retry' ? 'Retrying' : event.type.replace('.', ' '),
        text: eventText(event) || detailText(event.payload),
      });
    }
  }

  for (const [turnId, rounds] of roundsByTurn) {
    const assistant = [...items]
      .reverse()
      .find((item) => item.kind === 'assistant' && item.turnId === turnId);
    if (assistant?.kind === 'assistant') assistant.rounds = rounds;
  }

  return items;
};
