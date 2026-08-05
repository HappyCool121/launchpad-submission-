import {
  type EventType,
  type SessionEntry,
  type SessionExportV1,
  SessionExportV1Schema,
  type SessionHtmlExport,
  SessionHtmlExportSchema,
  type SessionImportPreview,
  SessionImportPreviewSchema,
  ThinkingLevelSchema,
  type Thread,
} from '../shared/contracts';
import {
  containsSponsorKey,
  createId,
  now,
  removeSponsorData,
  safeRecord,
  sha256,
} from '../shared/security';
import type { AppDatabase } from './database';

const MAX_SESSION_EXPORT_BYTES = 10 * 1024 * 1024;
const IMPORT_PREVIEW_TTL_MS = 10 * 60 * 1_000;
const CONTEXT_ANCHOR_EVENTS = new Set<EventType>([
  'approval.resolved',
  'file.change',
  'diff.change',
  'operation.completed',
  'runtime.crash',
]);

const scrubString = (value: string, projectPath: string): string => {
  let scrubbed = value.split(projectPath).join('[PROJECT]');
  scrubbed = scrubbed
    .replace(
      /\/(?:Applications|Library|Users|etc|home|mnt|opt|private|root|srv|tmp|usr|var|Volumes|workspace)\/[^\s"'`<>]+/g,
      '[REDACTED_PATH]'
    )
    .replace(/\b[A-Za-z]:\\[^\s"'`<>]+/g, '[REDACTED_PATH]')
    .replace(/\\\\[^\s\\"'`<>]+\\[^\s"'`<>]+/g, '[REDACTED_PATH]')
    .replace(
      /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
      '[REDACTED_SECRET]'
    )
    .replace(
      /\b(?:gh[opsu]_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9_-]{20,}|AKIA[A-Z0-9]{16})\b/g,
      '[REDACTED_SECRET]'
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi, 'Bearer [REDACTED_SECRET]')
    .replace(
      /\b(?:token|secret|password|api[_-]?key|credential)\s*[=:]\s*[^\s,;]{8,}/gi,
      '[REDACTED_SECRET]'
    );
  return scrubbed;
};

const scrubValue = (value: unknown, projectPath: string): unknown => {
  const sponsorFree = removeSponsorData(value);
  if (typeof sponsorFree === 'string') return scrubString(sponsorFree, projectPath);
  if (Array.isArray(sponsorFree)) return sponsorFree.map((child) => scrubValue(child, projectPath));
  if (!sponsorFree || typeof sponsorFree !== 'object') return sponsorFree;
  return Object.fromEntries(
    Object.entries(sponsorFree as Record<string, unknown>).map(([key, child]) => [
      key,
      scrubValue(child, projectPath),
    ])
  );
};

const exportEntryDigest = (entry: Pick<SessionEntry, 'kind' | 'timestamp' | 'payload'>): string =>
  sha256(
    JSON.stringify({
      schemaVersion: 1,
      kind: entry.kind,
      timestamp: entry.timestamp,
      payload: entry.payload,
    })
  );

const assertBounded = (value: unknown): void => {
  if (Buffer.byteLength(JSON.stringify(value)) > MAX_SESSION_EXPORT_BYTES) {
    throw new Error('The bounded session document exceeds 10 MiB.');
  }
};

const escapeHtml = (value: string): string =>
  value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');

const safeFilename = (value: string, extension: string): string =>
  `${
    value
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/gi, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 80) || 'adrouter-session'
  }.${extension}`;

const contentText = (value: unknown): string => {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value
    .flatMap((candidate) => {
      const block = safeRecord(candidate);
      return block.type === 'text' && typeof block.text === 'string' ? [block.text] : [];
    })
    .join('');
};

interface CliEntry {
  type: string;
  id: string;
  parentId: string | null;
  timestamp: string;
  [key: string]: unknown;
}

const parseCliV3 = (
  content: string,
  projectPath: string,
  sourceName: string
): { session: SessionExportV1; warnings: string[]; messages: number } => {
  const lines = content.split(/\r?\n/).filter((line) => line.trim());
  if (lines.length < 1 || lines.length > 20_001) {
    throw new Error('CLI session must contain 1 to 20,001 bounded JSONL records.');
  }
  const records = lines.map((line, index) => {
    if (Buffer.byteLength(line, 'utf8') > 1024 * 1024) {
      throw new Error(`CLI session record ${index + 1} exceeds 1 MiB.`);
    }
    try {
      return safeRecord(JSON.parse(line));
    } catch {
      throw new Error(`CLI session record ${index + 1} is not valid JSON.`);
    }
  });
  const header = records[0];
  if (header?.type !== 'session' || header.version !== 3 || typeof header.timestamp !== 'string') {
    throw new Error('Only AdRouterCLI session JSONL version 3 is supported.');
  }
  const entries = records.slice(1).map((record, index): CliEntry => {
    if (
      typeof record.type !== 'string' ||
      typeof record.id !== 'string' ||
      record.id.length < 1 ||
      record.id.length > 128 ||
      (record.parentId !== null && typeof record.parentId !== 'string') ||
      typeof record.timestamp !== 'string' ||
      !Number.isFinite(Date.parse(record.timestamp))
    ) {
      throw new Error(`CLI session record ${index + 2} has invalid tree metadata.`);
    }
    return record as CliEntry;
  });
  const byId = new Map<string, CliEntry>();
  for (const entry of entries) {
    if (byId.has(entry.id)) throw new Error('CLI session entry IDs must be unique.');
    byId.set(entry.id, entry);
  }
  for (const entry of entries) {
    if (entry.parentId && !byId.has(entry.parentId)) {
      throw new Error('CLI session contains an unresolved parent entry.');
    }
  }
  const leaf = entries.at(-1);
  const branch: CliEntry[] = [];
  const seen = new Set<string>();
  let current = leaf;
  while (current) {
    if (seen.has(current.id)) throw new Error('CLI session tree contains a cycle.');
    seen.add(current.id);
    branch.unshift(current);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }

  let model = 'agnes-2.5-flash';
  let thinkingLevel: 'none' | 'medium' | 'high' = 'none';
  let title = sourceName.replace(/\.jsonl$/i, '').slice(0, 240) || 'Imported CLI session';
  const converted: Array<
    Pick<SessionEntry, 'kind' | 'timestamp' | 'payload'> & { digest: string }
  > = [];
  let messages = 0;
  let skipped = 0;
  for (const entry of branch) {
    if (entry.type === 'model_change' && typeof entry.modelId === 'string') {
      model = entry.modelId.slice(0, 300);
      continue;
    }
    if (entry.type === 'thinking_level_change') {
      const parsed = ThinkingLevelSchema.safeParse(entry.thinkingLevel);
      if (parsed.success) thinkingLevel = parsed.data;
      continue;
    }
    if (entry.type === 'session_info' && typeof entry.name === 'string' && entry.name.trim()) {
      title = entry.name.trim().slice(0, 240);
      continue;
    }
    let kind: SessionEntry['kind'] | null = null;
    let payload: Record<string, unknown> = {};
    if (entry.type === 'message') {
      const message = safeRecord(entry.message);
      const text = contentText(message.content);
      if (message.role === 'user' && text) {
        kind = 'user_message';
        payload = { role: 'user', text };
        if (messages === 0) title = text.trim().slice(0, 80) || title;
      } else if (message.role === 'assistant' && text) {
        kind = 'assistant_message';
        payload = {
          role: 'assistant',
          text,
          content: [{ type: 'text', text }],
          model: typeof message.model === 'string' ? message.model.slice(0, 300) : model,
          usage: safeRecord(message.usage),
          importedDisplayOnly: true,
        };
        if (typeof message.model === 'string') model = message.model.slice(0, 300);
      } else if (
        message.role === 'toolResult' &&
        typeof message.toolCallId === 'string' &&
        typeof message.toolName === 'string'
      ) {
        kind = 'tool_result';
        payload = {
          toolCallId: message.toolCallId.slice(0, 300),
          name: message.toolName.slice(0, 300),
          output: text,
          isError: Boolean(message.isError),
          importedDisplayOnly: true,
        };
      }
    } else if (entry.type === 'compaction' && typeof entry.summary === 'string') {
      kind = 'compaction';
      payload = {
        summary: entry.summary,
        tokensBefore:
          typeof entry.tokensBefore === 'number' && Number.isFinite(entry.tokensBefore)
            ? Math.max(0, entry.tokensBefore)
            : 0,
        importedDisplayOnly: true,
      };
    }
    if (!kind) {
      skipped += 1;
      continue;
    }
    const scrubbed = safeRecord(scrubValue(payload, projectPath));
    const normalized = {
      kind,
      timestamp: new Date(entry.timestamp).toISOString(),
      payload: scrubbed,
    };
    converted.push({ ...normalized, digest: exportEntryDigest(normalized as SessionEntry) });
    if (kind === 'user_message' || kind === 'assistant_message') messages += 1;
  }
  if (converted.length === 0) throw new Error('CLI active branch contains no portable entries.');
  const session = SessionExportV1Schema.parse({
    schemaVersion: 1,
    exportedAt: now(),
    project: { displayName: 'AdRouterCLI import' },
    task: {
      title,
      label: 'Imported from CLI',
      model,
      thinkingLevel,
      sourceStatus: 'idle',
    },
    entries: converted,
    checkpoints: [],
  });
  assertBounded(session);
  return {
    session,
    warnings: [
      'Only the active CLI branch was imported; the task will remain idle.',
      ...(skipped > 0 ? [`Skipped ${skipped} unsupported or non-context CLI entries.`] : []),
    ],
    messages,
  };
};

export class SessionService {
  private readonly importPreviews = new Map<
    string,
    { projectId: string; session: SessionExportV1; expiresAt: number }
  >();

  public constructor(private readonly database: AppDatabase) {}

  public export(threadId: string, includeBilling = false): SessionExportV1 {
    const thread = this.database.getThread(threadId);
    if (!thread) throw new Error('Thread not found.');
    const project = this.database.getProject(thread.projectId);
    if (!project) throw new Error('Project not found.');
    const entries = this.database.listSessionEntries(threadId).map((entry) => {
      const payload = safeRecord(scrubValue(entry.payload, project.path));
      const exported = { kind: entry.kind, timestamp: entry.timestamp, payload };
      return { ...exported, digest: exportEntryDigest(exported) };
    });
    const settlements = includeBilling ? this.database.listRouterOutcomes(threadId) : [];
    const session = SessionExportV1Schema.parse({
      schemaVersion: 1,
      exportedAt: now(),
      project: { displayName: project.displayName },
      task: {
        title: thread.title,
        label: thread.label,
        model: thread.model,
        thinkingLevel: thread.thinkingLevel,
        sourceStatus: thread.status,
      },
      entries,
      checkpoints: this.database.listSessionCheckpoints(threadId).map((checkpoint) => ({
        entryOrdinal: checkpoint.entryOrdinal,
        contextDigest: checkpoint.contextDigest,
        createdAt: checkpoint.createdAt,
      })),
      ...(includeBilling
        ? {
            billing: {
              displayOnly: true,
              totals: settlements.reduce(
                (totals, settlement) => ({
                  cost: totals.cost + settlement.cost,
                  subsidy: totals.subsidy + settlement.subsidy,
                  paid: totals.paid + settlement.paid,
                  totalTokens: totals.totalTokens + settlement.totalTokens,
                }),
                { cost: 0, subsidy: 0, paid: 0, totalTokens: 0 }
              ),
            },
          }
        : {}),
    });
    assertBounded(session);
    return session;
  }

  public exportHtml(threadId: string): SessionHtmlExport {
    const session = this.export(threadId, false);
    const rows = session.entries
      .flatMap((entry) => {
        const payload = safeRecord(entry.payload);
        const text =
          entry.kind === 'compaction'
            ? typeof payload.summary === 'string'
              ? payload.summary
              : ''
            : typeof payload.text === 'string'
              ? payload.text
              : typeof payload.output === 'string'
                ? payload.output
                : '';
        if (!text) return [];
        const label =
          entry.kind === 'user_message'
            ? 'User'
            : entry.kind === 'assistant_message'
              ? 'Assistant'
              : entry.kind === 'tool_result'
                ? `Tool · ${typeof payload.name === 'string' ? payload.name : 'result'}`
                : 'Compaction checkpoint';
        return [
          `<article class="entry ${escapeHtml(entry.kind)}"><header><strong>${escapeHtml(label)}</strong><time>${escapeHtml(entry.timestamp)}</time></header><pre>${escapeHtml(text)}</pre></article>`,
        ];
      })
      .join('\n');
    const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; media-src 'none'; connect-src 'none'; frame-src 'none'">
<title>${escapeHtml(session.task.title)}</title><style>
:root{color-scheme:light dark;font:15px/1.5 system-ui,sans-serif}body{max-width:900px;margin:0 auto;padding:32px}h1{margin-bottom:4px}.meta{opacity:.7;margin-top:0}.entry{border:1px solid color-mix(in srgb,currentColor 20%,transparent);border-radius:10px;margin:16px 0;padding:16px}.entry header{display:flex;justify-content:space-between;gap:16px}.entry time{opacity:.65;font-size:12px}.entry pre{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit;margin:12px 0 0}.user_message{border-inline-start:4px solid #667eea}.assistant_message{border-inline-start:4px solid #3b82f6}.tool_result{border-inline-start:4px solid #8b5cf6}.compaction{border-inline-start:4px solid #64748b}
</style></head><body><h1>${escapeHtml(session.task.title)}</h1><p class="meta">Sanitized AdRouter Agent export · ${escapeHtml(session.exportedAt)} · ${session.entries.length} entries</p>${rows || '<p>No portable transcript entries.</p>'}</body></html>`;
    return SessionHtmlExportSchema.parse({
      filename: safeFilename(session.task.title, 'html'),
      html,
    });
  }

  public lastAssistantText(threadId: string): string {
    const thread = this.database.getThread(threadId);
    if (!thread) throw new Error('Thread not found.');
    const entry = this.database
      .listSessionEntries(threadId)
      .findLast((candidate) => candidate.kind === 'assistant_message');
    const text = entry && typeof entry.payload.text === 'string' ? entry.payload.text.trim() : '';
    if (!text) throw new Error('This task has no assistant response to copy.');
    return text;
  }

  public previewImport(
    projectId: string,
    sourceName: string,
    content: string
  ): SessionImportPreview {
    if (Buffer.byteLength(content, 'utf8') > MAX_SESSION_EXPORT_BYTES) {
      throw new Error('Session imports are limited to 10 MiB.');
    }
    const project = this.database.getProject(projectId);
    if (!project) throw new Error('Project not found.');
    let session: SessionExportV1;
    let format: SessionImportPreview['format'];
    let warnings: string[];
    let messages: number;
    try {
      const parsed = JSON.parse(content) as unknown;
      session = SessionExportV1Schema.parse(parsed);
      format = 'agent-json';
      warnings = ['Agent session import is sanitized and remains idle after confirmation.'];
      messages = session.entries.filter(
        (entry) => entry.kind === 'user_message' || entry.kind === 'assistant_message'
      ).length;
    } catch (jsonError) {
      if (!content.trimStart().startsWith('{')) throw jsonError;
      const cli = parseCliV3(content, project.path, sourceName);
      session = cli.session;
      format = 'adrouter-cli-v3-jsonl';
      warnings = cli.warnings;
      messages = cli.messages;
    }
    const previewId = createId();
    const expiresAt = Date.now() + IMPORT_PREVIEW_TTL_MS;
    this.importPreviews.set(previewId, { projectId, session, expiresAt });
    for (const [id, preview] of this.importPreviews) {
      if (preview.expiresAt <= Date.now()) this.importPreviews.delete(id);
    }
    return SessionImportPreviewSchema.parse({
      previewId,
      format,
      sourceName,
      title: session.task.title,
      model: session.task.model,
      thinkingLevel: session.task.thinkingLevel,
      entries: session.entries.length,
      messages,
      warnings,
      expiresAt: new Date(expiresAt).toISOString(),
    });
  }

  public confirmImport(previewId: string): Thread {
    const preview = this.importPreviews.get(previewId);
    this.importPreviews.delete(previewId);
    if (!preview || preview.expiresAt <= Date.now()) {
      throw new Error('The import preview expired; preview the source again.');
    }
    return this.import(preview.projectId, preview.session);
  }

  public import(projectId: string, raw: unknown): Thread {
    assertBounded(raw);
    const session = SessionExportV1Schema.parse(raw);
    const project = this.database.getProject(projectId);
    if (!project) throw new Error('Project not found.');
    for (const entry of session.entries) {
      if (containsSponsorKey(entry.payload)) {
        throw new Error('Imported model context contains sponsor-shaped data.');
      }
      if (exportEntryDigest(entry) !== entry.digest) {
        throw new Error('An imported session entry failed its integrity check.');
      }
      const scrubbed = scrubValue(entry.payload, project.path);
      if (JSON.stringify(scrubbed) !== JSON.stringify(entry.payload)) {
        throw new Error('Imported model context contains an absolute path or secret-like value.');
      }
    }
    const thread = this.database.createThread({
      projectId,
      title: session.task.title,
      label: session.task.label ? `${session.task.label} · imported`.slice(0, 120) : 'Imported',
      model: session.task.model,
      thinkingLevel: session.task.thinkingLevel,
    });
    try {
      for (const entry of session.entries) this.appendEntry(thread.id, entry, true);
      this.database.appendEvent(thread.id, null, 'diagnostic', {
        message: `Imported sponsor-free context from ${session.project.displayName}. No task was resumed or executed.`,
      });
      return this.database.getThread(thread.id) ?? thread;
    } catch (error) {
      this.database.deleteThread(thread.id);
      throw error;
    }
  }

  public fork(checkpointId: string, title?: string): Thread {
    const checkpoint = this.database.getSessionCheckpoint(checkpointId);
    if (!checkpoint?.safe) throw new Error('Safe session checkpoint not found.');
    const source = this.database.getThread(checkpoint.threadId);
    if (!source) throw new Error('Source task not found.');
    const entries = this.database
      .listSessionEntries(source.id)
      .filter((entry) => entry.ordinal <= checkpoint.entryOrdinal);
    const expectedDigest = sha256(
      JSON.stringify({ schemaVersion: 1, entries: entries.map((entry) => entry.digest) })
    );
    if (expectedDigest !== checkpoint.contextDigest) {
      throw new Error('The immutable checkpoint context failed its integrity check.');
    }
    const fork = this.database.createThread({
      projectId: source.projectId,
      parentThreadId: source.id,
      forkedFromCheckpointId: checkpoint.id,
      title: (title ?? `${source.title} (fork)`).slice(0, 240),
      label: source.label,
      model: source.model,
      thinkingLevel: source.thinkingLevel,
    });
    try {
      for (const entry of entries) this.appendEntry(fork.id, entry, false);
      this.database.appendEvent(fork.id, null, 'diagnostic', {
        message: `Forked from an immutable safe checkpoint in “${source.title}”.`,
      });
      return this.database.getThread(fork.id) ?? fork;
    } catch (error) {
      this.database.deleteThread(fork.id);
      throw error;
    }
  }

  private appendEntry(
    threadId: string,
    entry: Pick<SessionEntry, 'kind' | 'payload'>,
    imported: boolean
  ): void {
    const payload = safeRecord(entry.payload);
    if (entry.kind === 'user_message') {
      if (typeof payload.text !== 'string') throw new Error('Session user entry is invalid.');
      this.database.appendEvent(threadId, null, 'message.user', payload);
      return;
    }
    if (entry.kind === 'assistant_message') {
      if (typeof payload.text !== 'string') throw new Error('Session assistant entry is invalid.');
      this.database.appendEvent(threadId, null, 'message.complete', payload);
      return;
    }
    if (entry.kind === 'tool_result') {
      if (
        typeof payload.name !== 'string' ||
        typeof payload.toolCallId !== 'string' ||
        typeof payload.output !== 'string'
      ) {
        throw new Error('Session tool entry is invalid.');
      }
      this.database.appendEvent(threadId, null, 'tool.result', payload);
      return;
    }
    if (entry.kind === 'compaction') {
      if (typeof payload.summary !== 'string') throw new Error('Session compaction is invalid.');
      this.database.appendEvent(threadId, null, 'compaction', payload);
      return;
    }
    const eventType = payload.eventType;
    const value = safeRecord(payload.value);
    if (typeof eventType !== 'string' || !CONTEXT_ANCHOR_EVENTS.has(eventType as EventType)) {
      throw new Error('Session context anchor is invalid.');
    }
    this.database.appendEvent(threadId, null, eventType as EventType, {
      ...value,
      ...(imported ? { importedContext: true } : {}),
    });
  }
}
