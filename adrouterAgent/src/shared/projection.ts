import type { JournalEvent, ThreadStatus, TurnStatus } from './contracts';

export interface ThreadProjection {
  status: ThreadStatus;
  turns: Map<string, TurnStatus>;
  latestSponsorEvent?: JournalEvent;
  latestEvidenceEvent?: JournalEvent;
}

const isThreadStatus = (value: unknown): value is ThreadStatus =>
  value === 'idle' || value === 'running' || value === 'awaiting_approval' || value === 'failed';

const isTurnStatus = (value: unknown): value is TurnStatus =>
  value === 'queued' ||
  value === 'preparing' ||
  value === 'running' ||
  value === 'awaiting_approval' ||
  value === 'completed' ||
  value === 'failed' ||
  value === 'cancelled' ||
  value === 'interrupted';

export const rebuildThreadProjection = (events: readonly JournalEvent[]): ThreadProjection => {
  const projection: ThreadProjection = { status: 'idle', turns: new Map() };

  for (const event of [...events].sort((left, right) => left.sequence - right.sequence)) {
    if (event.type === 'thread.lifecycle' && isThreadStatus(event.payload.status)) {
      projection.status = event.payload.status;
    }
    if (event.type === 'turn.lifecycle' && event.turnId && isTurnStatus(event.payload.status)) {
      projection.turns.set(event.turnId, event.payload.status);
    }
    if (event.type === 'sponsor.update') {
      projection.latestSponsorEvent = event;
    }
    if (event.type === 'final.evidence') {
      projection.latestEvidenceEvent = event;
    }
  }

  return projection;
};
