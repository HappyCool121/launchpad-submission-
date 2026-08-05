import { cpSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  type Approval,
  type ApprovalDecision,
  type ApprovalInput,
  ApprovalSchema,
  type AutomationClient,
  AutomationClientSchema,
  type BundleTrust,
  BundleTrustSchema,
  type ContextBudgetSnapshot,
  ContextBudgetSnapshotSchema,
  type DiffFile,
  EventSchema,
  type EventType,
  type GitTaskBaseline,
  GitTaskBaselineSchema,
  type JournalEvent,
  type Project,
  ProjectSchema,
  type SessionCheckpoint,
  SessionCheckpointSchema,
  type SessionEntry,
  SessionEntrySchema,
  type Settlement,
  SettlementSchema,
  type Thread,
  ThreadSchema,
  type ThreadStatus,
  type Turn,
  TurnSchema,
  type TurnStatus,
} from '../shared/contracts';
import {
  containsSponsorKey,
  createId,
  now,
  removeSponsorData,
  safeRecord,
  sha256,
} from '../shared/security';

interface ProjectRow {
  id: string;
  path: string;
  display_name: string;
  instructions: string;
  repository_instructions: string;
  repository_instruction_files: string;
  permission_mode: string;
  delegation_enabled: number;
  git_metadata: string;
  created_at: string;
  updated_at: string;
}

interface ThreadRow {
  id: string;
  project_id: string;
  parent_thread_id: string | null;
  forked_from_checkpoint_id: string | null;
  title: string;
  label: string | null;
  model: string;
  thinking_level: string;
  status: string;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

interface TurnRow {
  id: string;
  thread_id: string;
  input: string;
  model: string;
  thinking_level: string;
  kind: string;
  status: string;
  error: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

interface EventRow {
  id: string;
  thread_id: string;
  turn_id: string | null;
  sequence: number;
  type: string;
  timestamp: string;
  payload: string;
}

interface ApprovalRow {
  version: number;
  id: string;
  thread_id: string;
  turn_id: string;
  kind: string;
  argv: string | null;
  path: string | null;
  cwd: string;
  risk: string;
  reason: string;
  operation_manifest: string | null;
  expires_at: string | null;
  decision: string | null;
  created_at: string;
  resolved_at: string | null;
  consumed_at: string | null;
}

interface BundleTrustRow {
  project_id: string;
  bundle_id: string;
  bundle_version: string;
  bundle_digest: string;
  trusted_at: string;
}

interface AutomationClientRow {
  id: string;
  display_name: string;
  public_key: string;
  public_key_fingerprint: string;
  scopes: string;
  created_at: string;
  last_used_at: string | null;
  revoked_at: string | null;
}

interface BaselineRow {
  thread_id: string;
  path: string;
  original_bytes: string | null;
  original_hash: string | null;
  latest_agent_hash: string | null;
  latest_status: string;
}

interface SessionEntryRow {
  id: string;
  thread_id: string;
  turn_id: string | null;
  source_event_id: string;
  ordinal: number;
  kind: string;
  timestamp: string;
  payload: string;
  digest: string;
}

interface SessionCheckpointRow {
  id: string;
  thread_id: string;
  turn_id: string;
  source_event_id: string;
  entry_ordinal: number;
  context_digest: string;
  safe: number;
  created_at: string;
}

interface GitTaskBaselineRow {
  thread_id: string;
  turn_id: string;
  head_oid: string | null;
  ref: string | null;
  index_tree_hash: string;
  status_entries: string;
  truncated: number;
  captured_at: string;
}

const migrations = [
  `
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      path TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      instructions TEXT NOT NULL,
      permission_mode TEXT NOT NULL,
      git_metadata TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS threads (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      model TEXT NOT NULL,
      thinking_level TEXT NOT NULL,
      status TEXT NOT NULL,
      archived_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS threads_by_project ON threads(project_id, updated_at DESC);
    CREATE TABLE IF NOT EXISTS turns (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      input TEXT NOT NULL,
      status TEXT NOT NULL,
      error TEXT,
      created_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT
    );
    CREATE INDEX IF NOT EXISTS turns_by_thread ON turns(thread_id, created_at ASC);
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      turn_id TEXT REFERENCES turns(id) ON DELETE SET NULL,
      sequence INTEGER NOT NULL,
      type TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      payload TEXT NOT NULL,
      UNIQUE(thread_id, sequence)
    );
    CREATE INDEX IF NOT EXISTS events_by_thread ON events(thread_id, sequence ASC);
    CREATE TABLE IF NOT EXISTS approvals (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      argv TEXT,
      path TEXT,
      cwd TEXT NOT NULL,
      risk TEXT NOT NULL,
      reason TEXT NOT NULL,
      decision TEXT,
      created_at TEXT NOT NULL,
      resolved_at TEXT
    );
    CREATE INDEX IF NOT EXISTS approvals_by_thread ON approvals(thread_id, created_at ASC);
    CREATE TABLE IF NOT EXISTS file_baselines (
      thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      path TEXT NOT NULL,
      original_bytes TEXT,
      original_hash TEXT,
      latest_agent_hash TEXT,
      latest_status TEXT NOT NULL,
      PRIMARY KEY(thread_id, path)
    );
    CREATE TABLE IF NOT EXISTS file_mutations (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      path TEXT NOT NULL,
      ordinal INTEGER NOT NULL,
      forward_patch TEXT NOT NULL,
      reverse_patch TEXT NOT NULL,
      before_hash TEXT,
      after_hash TEXT,
      created_at TEXT NOT NULL,
      UNIQUE(thread_id, ordinal)
    );
    CREATE INDEX IF NOT EXISTS mutations_by_thread_path ON file_mutations(thread_id, path, ordinal ASC);
    CREATE TABLE IF NOT EXISTS router_outcomes (
      router_turn_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      turn_id TEXT REFERENCES turns(id) ON DELETE SET NULL,
      settlement TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS outcomes_by_thread ON router_outcomes(thread_id, created_at ASC);
  `,
  `
    ALTER TABLE projects ADD COLUMN repository_instructions TEXT NOT NULL DEFAULT '';
    ALTER TABLE projects ADD COLUMN repository_instruction_files TEXT NOT NULL DEFAULT '[]';
    UPDATE projects
    SET repository_instructions = instructions,
        repository_instruction_files = CASE WHEN instructions = '' THEN '[]' ELSE '["legacy imported instructions"]' END,
        instructions = '';
  `,
  `
    ALTER TABLE turns ADD COLUMN model TEXT NOT NULL DEFAULT '';
    ALTER TABLE turns ADD COLUMN thinking_level TEXT NOT NULL DEFAULT 'medium';
    UPDATE threads
    SET thinking_level = 'none'
    WHERE thinking_level IN ('off', 'minimal', 'low');
    UPDATE turns
    SET model = (SELECT threads.model FROM threads WHERE threads.id = turns.thread_id),
        thinking_level = (SELECT threads.thinking_level FROM threads WHERE threads.id = turns.thread_id);
  `,
  `
    CREATE TABLE IF NOT EXISTS session_entries (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      turn_id TEXT REFERENCES turns(id) ON DELETE SET NULL,
      source_event_id TEXT NOT NULL UNIQUE REFERENCES events(id) ON DELETE CASCADE,
      ordinal INTEGER NOT NULL,
      kind TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      payload TEXT NOT NULL,
      digest TEXT NOT NULL,
      UNIQUE(thread_id, ordinal)
    );
    CREATE INDEX IF NOT EXISTS session_entries_by_thread
      ON session_entries(thread_id, ordinal ASC);
    CREATE TABLE IF NOT EXISTS session_checkpoints (
      id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
      turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
      source_event_id TEXT NOT NULL UNIQUE REFERENCES events(id) ON DELETE CASCADE,
      entry_ordinal INTEGER NOT NULL,
      context_digest TEXT NOT NULL,
      safe INTEGER NOT NULL CHECK(safe = 1),
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS session_checkpoints_by_thread
      ON session_checkpoints(thread_id, created_at ASC);
  `,
  `
    ALTER TABLE approvals ADD COLUMN version INTEGER NOT NULL DEFAULT 1;
    ALTER TABLE approvals ADD COLUMN operation_manifest TEXT;
    ALTER TABLE approvals ADD COLUMN expires_at TEXT;
    ALTER TABLE approvals ADD COLUMN consumed_at TEXT;
  `,
  `
    CREATE TABLE IF NOT EXISTS project_bundle_trust (
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      bundle_id TEXT NOT NULL,
      bundle_version TEXT NOT NULL,
      bundle_digest TEXT NOT NULL,
      trusted_at TEXT NOT NULL,
      PRIMARY KEY(project_id, bundle_id)
    );
    CREATE INDEX IF NOT EXISTS bundle_trust_by_project
      ON project_bundle_trust(project_id, trusted_at ASC);
  `,
  `
    CREATE TABLE IF NOT EXISTS automation_clients (
      id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      public_key TEXT NOT NULL UNIQUE,
      public_key_fingerprint TEXT NOT NULL UNIQUE,
      scopes TEXT NOT NULL,
      created_at TEXT NOT NULL,
      last_used_at TEXT,
      revoked_at TEXT
    );
    CREATE INDEX IF NOT EXISTS automation_clients_active
      ON automation_clients(revoked_at, created_at ASC);
  `,
  `
    ALTER TABLE threads ADD COLUMN parent_thread_id TEXT REFERENCES threads(id) ON DELETE SET NULL;
    ALTER TABLE threads ADD COLUMN forked_from_checkpoint_id TEXT REFERENCES session_checkpoints(id) ON DELETE SET NULL;
    ALTER TABLE threads ADD COLUMN label TEXT;
    CREATE INDEX IF NOT EXISTS threads_by_parent
      ON threads(parent_thread_id, created_at ASC);
    CREATE TABLE IF NOT EXISTS git_task_baselines (
      thread_id TEXT PRIMARY KEY REFERENCES threads(id) ON DELETE CASCADE,
      turn_id TEXT NOT NULL REFERENCES turns(id) ON DELETE CASCADE,
      head_oid TEXT,
      ref TEXT,
      index_tree_hash TEXT NOT NULL,
      status_entries TEXT NOT NULL,
      truncated INTEGER NOT NULL,
      captured_at TEXT NOT NULL
    );
  `,
  `
    ALTER TABLE projects ADD COLUMN delegation_enabled INTEGER NOT NULL DEFAULT 0;
  `,
  `
    ALTER TABLE turns ADD COLUMN kind TEXT NOT NULL DEFAULT 'agent';
  `,
];

const fromProjectRow = (row: ProjectRow): Project =>
  ProjectSchema.parse({
    id: row.id,
    path: row.path,
    displayName: row.display_name,
    instructions: row.instructions,
    repositoryInstructions: row.repository_instructions,
    repositoryInstructionFiles: JSON.parse(row.repository_instruction_files),
    permissionMode: row.permission_mode,
    delegationEnabled: row.delegation_enabled === 1,
    git: JSON.parse(row.git_metadata),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });

const fromThreadRow = (row: ThreadRow): Thread =>
  ThreadSchema.parse({
    id: row.id,
    projectId: row.project_id,
    parentThreadId: row.parent_thread_id,
    forkedFromCheckpointId: row.forked_from_checkpoint_id,
    title: row.title,
    label: row.label,
    model: row.model,
    thinkingLevel: row.thinking_level,
    status: row.status,
    archivedAt: row.archived_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });

const fromTurnRow = (row: TurnRow): Turn =>
  TurnSchema.parse({
    id: row.id,
    threadId: row.thread_id,
    input: row.input,
    model: row.model,
    thinkingLevel: row.thinking_level,
    kind: row.kind,
    status: row.status,
    error: row.error,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  });

const fromEventRow = (row: EventRow): JournalEvent =>
  EventSchema.parse({
    id: row.id,
    threadId: row.thread_id,
    turnId: row.turn_id,
    sequence: row.sequence,
    type: row.type,
    timestamp: row.timestamp,
    payload: JSON.parse(row.payload),
  });

const fromApprovalRow = (row: ApprovalRow): Approval =>
  ApprovalSchema.parse({
    version: row.version,
    id: row.id,
    threadId: row.thread_id,
    turnId: row.turn_id,
    kind: row.kind,
    argv: row.argv ? JSON.parse(row.argv) : null,
    path: row.path,
    cwd: row.cwd,
    risk: row.risk,
    reason: row.reason,
    operationManifest: row.operation_manifest ? JSON.parse(row.operation_manifest) : null,
    expiresAt: row.expires_at,
    decision: row.decision,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
  });

const fromSessionEntryRow = (row: SessionEntryRow): SessionEntry =>
  SessionEntrySchema.parse({
    id: row.id,
    threadId: row.thread_id,
    turnId: row.turn_id,
    sourceEventId: row.source_event_id,
    ordinal: row.ordinal,
    kind: row.kind,
    timestamp: row.timestamp,
    payload: JSON.parse(row.payload),
    digest: row.digest,
  });

const fromSessionCheckpointRow = (row: SessionCheckpointRow): SessionCheckpoint =>
  SessionCheckpointSchema.parse({
    id: row.id,
    threadId: row.thread_id,
    turnId: row.turn_id,
    sourceEventId: row.source_event_id,
    entryOrdinal: row.entry_ordinal,
    contextDigest: row.context_digest,
    safe: row.safe === 1,
    createdAt: row.created_at,
  });

const fromBundleTrustRow = (row: BundleTrustRow): BundleTrust =>
  BundleTrustSchema.parse({
    projectId: row.project_id,
    bundleId: row.bundle_id,
    bundleVersion: row.bundle_version,
    bundleDigest: row.bundle_digest,
    trustedAt: row.trusted_at,
  });

const fromAutomationClientRow = (row: AutomationClientRow): AutomationClient =>
  AutomationClientSchema.parse({
    id: row.id,
    displayName: row.display_name,
    publicKey: row.public_key,
    publicKeyFingerprint: row.public_key_fingerprint,
    scopes: JSON.parse(row.scopes),
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
  });

const fromGitTaskBaselineRow = (row: GitTaskBaselineRow): GitTaskBaseline =>
  GitTaskBaselineSchema.parse({
    threadId: row.thread_id,
    turnId: row.turn_id,
    headOid: row.head_oid,
    ref: row.ref,
    indexTreeHash: row.index_tree_hash,
    statusEntries: JSON.parse(row.status_entries),
    truncated: row.truncated === 1,
    capturedAt: row.captured_at,
  });

export class AppDatabase {
  private readonly database: DatabaseSync;

  public constructor(private readonly databasePath: string) {
    mkdirSync(dirname(databasePath), { recursive: true });
    const isExisting = existsSync(databasePath);
    this.database = new DatabaseSync(databasePath, {
      enableForeignKeyConstraints: true,
      timeout: 5_000,
    });
    this.migrate(isExisting);
    this.backfillSessionProjection();
  }

  public close(): void {
    this.database.close();
  }

  public createProject(
    input: Omit<
      Project,
      | 'id'
      | 'createdAt'
      | 'updatedAt'
      | 'repositoryInstructions'
      | 'repositoryInstructionFiles'
      | 'delegationEnabled'
    > &
      Partial<
        Pick<Project, 'repositoryInstructions' | 'repositoryInstructionFiles' | 'delegationEnabled'>
      >
  ): Project {
    const createdAt = now();
    const project: Project = {
      ...input,
      repositoryInstructions: input.repositoryInstructions ?? '',
      repositoryInstructionFiles: input.repositoryInstructionFiles ?? [],
      delegationEnabled: input.delegationEnabled ?? false,
      id: createId(),
      createdAt,
      updatedAt: createdAt,
    };
    this.database
      .prepare(
        `INSERT INTO projects
           (id, path, display_name, instructions, repository_instructions,
            repository_instruction_files, permission_mode, delegation_enabled, git_metadata,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        project.id,
        project.path,
        project.displayName,
        project.instructions,
        project.repositoryInstructions,
        JSON.stringify(project.repositoryInstructionFiles),
        project.permissionMode,
        project.delegationEnabled ? 1 : 0,
        JSON.stringify(project.git),
        project.createdAt,
        project.updatedAt
      );
    return project;
  }

  public listProjects(): Project[] {
    return (
      this.database
        .prepare('SELECT * FROM projects ORDER BY updated_at DESC')
        .all() as unknown as ProjectRow[]
    ).map(fromProjectRow);
  }

  public getProject(id: string): Project | undefined {
    const row = this.database.prepare('SELECT * FROM projects WHERE id = ?').get(id) as unknown as
      | ProjectRow
      | undefined;
    return row ? fromProjectRow(row) : undefined;
  }

  public getProjectByPath(path: string): Project | undefined {
    const row = this.database
      .prepare('SELECT * FROM projects WHERE path = ?')
      .get(path) as unknown as ProjectRow | undefined;
    return row ? fromProjectRow(row) : undefined;
  }

  public updateProject(
    id: string,
    patch: Partial<
      Pick<
        Project,
        | 'displayName'
        | 'instructions'
        | 'repositoryInstructions'
        | 'repositoryInstructionFiles'
        | 'permissionMode'
        | 'delegationEnabled'
        | 'git'
      >
    >
  ): Project {
    const project = this.getProject(id);
    if (!project) {
      throw new Error('Project not found.');
    }
    const updated: Project = {
      ...project,
      ...(patch.displayName === undefined ? {} : { displayName: patch.displayName }),
      ...(patch.instructions === undefined ? {} : { instructions: patch.instructions }),
      ...(patch.repositoryInstructions === undefined
        ? {}
        : { repositoryInstructions: patch.repositoryInstructions }),
      ...(patch.repositoryInstructionFiles === undefined
        ? {}
        : { repositoryInstructionFiles: patch.repositoryInstructionFiles }),
      ...(patch.permissionMode === undefined ? {} : { permissionMode: patch.permissionMode }),
      ...(patch.delegationEnabled === undefined
        ? {}
        : { delegationEnabled: patch.delegationEnabled }),
      ...(patch.git === undefined ? {} : { git: patch.git }),
      updatedAt: now(),
    };
    this.database
      .prepare(
        `UPDATE projects SET display_name = ?, instructions = ?, repository_instructions = ?,
         repository_instruction_files = ?, permission_mode = ?, delegation_enabled = ?,
         git_metadata = ?, updated_at = ? WHERE id = ?`
      )
      .run(
        updated.displayName,
        updated.instructions,
        updated.repositoryInstructions,
        JSON.stringify(updated.repositoryInstructionFiles),
        updated.permissionMode,
        updated.delegationEnabled ? 1 : 0,
        JSON.stringify(updated.git),
        updated.updatedAt,
        updated.id
      );
    return updated;
  }

  public removeProject(id: string): void {
    this.database.prepare('DELETE FROM projects WHERE id = ?').run(id);
  }

  public listBundleTrust(projectId: string): BundleTrust[] {
    return (
      this.database
        .prepare('SELECT * FROM project_bundle_trust WHERE project_id = ? ORDER BY trusted_at ASC')
        .all(projectId) as unknown as BundleTrustRow[]
    ).map(fromBundleTrustRow);
  }

  public trustBundle(input: Omit<BundleTrust, 'trustedAt'>): BundleTrust {
    if (!this.getProject(input.projectId)) throw new Error('Project not found.');
    const trust = BundleTrustSchema.parse({ ...input, trustedAt: now() });
    this.database
      .prepare(
        `INSERT INTO project_bundle_trust
           (project_id, bundle_id, bundle_version, bundle_digest, trusted_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(project_id, bundle_id) DO UPDATE SET
           bundle_version = excluded.bundle_version,
           bundle_digest = excluded.bundle_digest,
           trusted_at = excluded.trusted_at`
      )
      .run(
        trust.projectId,
        trust.bundleId,
        trust.bundleVersion,
        trust.bundleDigest,
        trust.trustedAt
      );
    return trust;
  }

  public revokeBundleTrust(projectId: string, bundleId: string): boolean {
    const result = this.database
      .prepare('DELETE FROM project_bundle_trust WHERE project_id = ? AND bundle_id = ?')
      .run(projectId, bundleId);
    return Number(result.changes) === 1;
  }

  public createAutomationClient(
    input: Pick<AutomationClient, 'displayName' | 'publicKey' | 'publicKeyFingerprint' | 'scopes'>
  ): AutomationClient {
    const createdAt = now();
    const client = AutomationClientSchema.parse({
      ...input,
      id: createId(),
      createdAt,
      lastUsedAt: null,
      revokedAt: null,
    });
    this.database
      .prepare(
        `INSERT INTO automation_clients
           (id, display_name, public_key, public_key_fingerprint, scopes, created_at,
            last_used_at, revoked_at)
         VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)`
      )
      .run(
        client.id,
        client.displayName,
        client.publicKey,
        client.publicKeyFingerprint,
        JSON.stringify(client.scopes),
        client.createdAt
      );
    return client;
  }

  public getAutomationClient(id: string): AutomationClient | undefined {
    const row = this.database
      .prepare('SELECT * FROM automation_clients WHERE id = ?')
      .get(id) as unknown as AutomationClientRow | undefined;
    return row ? fromAutomationClientRow(row) : undefined;
  }

  public getAutomationClientByFingerprint(fingerprint: string): AutomationClient | undefined {
    const row = this.database
      .prepare('SELECT * FROM automation_clients WHERE public_key_fingerprint = ?')
      .get(fingerprint) as unknown as AutomationClientRow | undefined;
    return row ? fromAutomationClientRow(row) : undefined;
  }

  public listAutomationClients(): AutomationClient[] {
    return (
      this.database
        .prepare('SELECT * FROM automation_clients ORDER BY created_at ASC')
        .all() as unknown as AutomationClientRow[]
    ).map(fromAutomationClientRow);
  }

  public touchAutomationClient(id: string, usedAt = now()): void {
    this.database
      .prepare('UPDATE automation_clients SET last_used_at = ? WHERE id = ? AND revoked_at IS NULL')
      .run(usedAt, id);
  }

  public revokeAutomationClient(id: string, revokedAt = now()): AutomationClient {
    const client = this.getAutomationClient(id);
    if (!client) throw new Error('Automation client not found.');
    if (!client.revokedAt) {
      this.database
        .prepare('UPDATE automation_clients SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL')
        .run(revokedAt, id);
    }
    const updated = this.getAutomationClient(id);
    if (!updated) throw new Error('Automation client could not be reloaded.');
    return updated;
  }

  public createThread(
    input: Omit<
      Thread,
      | 'id'
      | 'status'
      | 'archivedAt'
      | 'createdAt'
      | 'updatedAt'
      | 'parentThreadId'
      | 'forkedFromCheckpointId'
      | 'label'
    > &
      Partial<Pick<Thread, 'parentThreadId' | 'forkedFromCheckpointId' | 'label'>>
  ): Thread {
    const createdAt = now();
    const thread: Thread = ThreadSchema.parse({
      ...input,
      id: createId(),
      parentThreadId: input.parentThreadId ?? null,
      forkedFromCheckpointId: input.forkedFromCheckpointId ?? null,
      label: input.label ?? null,
      status: 'idle',
      archivedAt: null,
      createdAt,
      updatedAt: createdAt,
    });
    this.database
      .prepare(
        `INSERT INTO threads
           (id, project_id, parent_thread_id, forked_from_checkpoint_id, title, label, model,
            thinking_level, status, archived_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        thread.id,
        thread.projectId,
        thread.parentThreadId,
        thread.forkedFromCheckpointId,
        thread.title,
        thread.label,
        thread.model,
        thread.thinkingLevel,
        thread.status,
        thread.archivedAt,
        thread.createdAt,
        thread.updatedAt
      );
    this.appendEvent(thread.id, null, 'thread.lifecycle', { status: 'idle' });
    return thread;
  }

  public listThreads(projectId: string): Thread[] {
    return (
      this.database
        .prepare(
          'SELECT * FROM threads WHERE project_id = ? AND archived_at IS NULL ORDER BY updated_at DESC'
        )
        .all(projectId) as unknown as ThreadRow[]
    ).map(fromThreadRow);
  }

  public searchThreads(projectId: string, query: string): Thread[] {
    const escaped = `%${query.replace(/[\\%_]/g, (value) => `\\${value}`)}%`;
    return (
      this.database
        .prepare(
          `SELECT DISTINCT threads.*
           FROM threads
           WHERE threads.project_id = ?
             AND threads.archived_at IS NULL
             AND (
               threads.title LIKE ? ESCAPE '\\' COLLATE NOCASE
               OR COALESCE(threads.label, '') LIKE ? ESCAPE '\\' COLLATE NOCASE
               OR EXISTS (
                 SELECT 1 FROM session_entries
                 WHERE session_entries.thread_id = threads.id
                   AND session_entries.payload LIKE ? ESCAPE '\\' COLLATE NOCASE
               )
             )
           ORDER BY threads.updated_at DESC
           LIMIT 50`
        )
        .all(projectId, escaped, escaped, escaped) as unknown as ThreadRow[]
    ).map(fromThreadRow);
  }

  public getThread(id: string): Thread | undefined {
    const row = this.database.prepare('SELECT * FROM threads WHERE id = ?').get(id) as unknown as
      | ThreadRow
      | undefined;
    return row ? fromThreadRow(row) : undefined;
  }

  public updateThreadStatus(id: string, status: ThreadStatus): Thread {
    const thread = this.getThread(id);
    if (!thread) {
      throw new Error('Thread not found.');
    }
    const updatedAt = now();
    this.database
      .prepare('UPDATE threads SET status = ?, updated_at = ? WHERE id = ?')
      .run(status, updatedAt, id);
    this.appendEvent(id, null, 'thread.lifecycle', { status });
    return { ...thread, status, updatedAt };
  }

  public updateThreadPreferences(
    id: string,
    model: string,
    thinkingLevel: Thread['thinkingLevel']
  ): Thread {
    const thread = this.getThread(id);
    if (!thread) throw new Error('Thread not found.');
    const updatedAt = now();
    this.database
      .prepare('UPDATE threads SET model = ?, thinking_level = ?, updated_at = ? WHERE id = ?')
      .run(model, thinkingLevel, updatedAt, id);
    return { ...thread, model, thinkingLevel, updatedAt };
  }

  public labelThread(id: string, label: string | null): Thread {
    const thread = this.getThread(id);
    if (!thread) throw new Error('Thread not found.');
    const updatedAt = now();
    this.database
      .prepare('UPDATE threads SET label = ?, updated_at = ? WHERE id = ?')
      .run(label, updatedAt, id);
    return { ...thread, label, updatedAt };
  }

  public continueInterruptedThread(id: string): Thread {
    const thread = this.getThread(id);
    if (!thread) throw new Error('Thread not found.');
    if (thread.status !== 'interrupted' && thread.status !== 'blocked') {
      throw new Error('Only an interrupted or blocked task needs explicit continuation.');
    }
    return this.updateThreadStatus(id, 'idle');
  }

  public archiveThread(id: string): Thread {
    const thread = this.getThread(id);
    if (!thread) {
      throw new Error('Thread not found.');
    }
    const archivedAt = now();
    this.database
      .prepare('UPDATE threads SET archived_at = ?, updated_at = ? WHERE id = ?')
      .run(archivedAt, archivedAt, id);
    return { ...thread, archivedAt, updatedAt: archivedAt };
  }

  public deleteThread(id: string): void {
    const thread = this.getThread(id);
    if (!thread) throw new Error('Thread not found.');
    if (thread.status === 'running' || thread.status === 'awaiting_approval') {
      throw new Error('A running chat cannot be deleted.');
    }
    this.database.prepare('DELETE FROM threads WHERE id = ?').run(id);
  }

  public createTurn(
    threadId: string,
    input: string,
    model?: string,
    thinkingLevel?: Turn['thinkingLevel'],
    kind: Turn['kind'] = 'agent'
  ): Turn {
    const thread = this.getThread(threadId);
    if (!thread) throw new Error('Thread not found.');
    const createdAt = now();
    const turn: Turn = {
      id: createId(),
      threadId,
      input,
      model: model ?? thread.model,
      thinkingLevel: thinkingLevel ?? thread.thinkingLevel,
      kind,
      status: 'queued',
      error: null,
      createdAt,
      startedAt: null,
      finishedAt: null,
    };
    this.database
      .prepare(
        `INSERT INTO turns (id, thread_id, input, model, thinking_level, kind, status, error, created_at, started_at, finished_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        turn.id,
        turn.threadId,
        turn.input,
        turn.model,
        turn.thinkingLevel,
        turn.kind,
        turn.status,
        turn.error,
        turn.createdAt,
        turn.startedAt,
        turn.finishedAt
      );
    this.appendEvent(threadId, turn.id, 'turn.lifecycle', { status: 'queued' });
    return turn;
  }

  public listTurns(threadId: string): Turn[] {
    return (
      this.database
        .prepare('SELECT * FROM turns WHERE thread_id = ? ORDER BY created_at ASC')
        .all(threadId) as unknown as TurnRow[]
    ).map(fromTurnRow);
  }

  public getTurn(id: string): Turn | undefined {
    const row = this.database.prepare('SELECT * FROM turns WHERE id = ?').get(id) as unknown as
      | TurnRow
      | undefined;
    return row ? fromTurnRow(row) : undefined;
  }

  public updateTurnStatus(id: string, status: TurnStatus, error: string | null = null): Turn {
    const turn = this.getTurn(id);
    if (!turn) {
      throw new Error('Turn not found.');
    }
    const startedAt =
      turn.startedAt ?? (status === 'preparing' || status === 'running' ? now() : null);
    const finishedAt = ['completed', 'failed', 'cancelled', 'interrupted'].includes(status)
      ? now()
      : null;
    this.database
      .prepare(
        'UPDATE turns SET status = ?, error = ?, started_at = ?, finished_at = ? WHERE id = ?'
      )
      .run(status, error, startedAt, finishedAt, id);
    this.appendEvent(turn.threadId, id, 'turn.lifecycle', { status, error });
    return { ...turn, status, error, startedAt, finishedAt };
  }

  public appendEvent(
    threadId: string,
    turnId: string | null,
    type: EventType,
    payload: Record<string, unknown>
  ): JournalEvent {
    const timestamp = now();
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const current = this.database
        .prepare('SELECT COALESCE(MAX(sequence), 0) AS sequence FROM events WHERE thread_id = ?')
        .get(threadId) as { sequence: number };
      const event: JournalEvent = {
        id: createId(),
        threadId,
        turnId,
        sequence: current.sequence + 1,
        type,
        timestamp,
        payload: safeRecord(payload),
      };
      this.database
        .prepare(
          'INSERT INTO events (id, thread_id, turn_id, sequence, type, timestamp, payload) VALUES (?, ?, ?, ?, ?, ?, ?)'
        )
        .run(
          event.id,
          event.threadId,
          event.turnId,
          event.sequence,
          event.type,
          event.timestamp,
          JSON.stringify(event.payload)
        );
      this.database
        .prepare('UPDATE threads SET updated_at = ? WHERE id = ?')
        .run(timestamp, threadId);
      this.projectSessionEvent(event);
      this.database.exec('COMMIT');
      return event;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  public listEvents(threadId: string): JournalEvent[] {
    return (
      this.database
        .prepare('SELECT * FROM events WHERE thread_id = ? ORDER BY sequence ASC')
        .all(threadId) as unknown as EventRow[]
    ).map(fromEventRow);
  }

  public listSessionEntries(threadId: string): SessionEntry[] {
    return (
      this.database
        .prepare('SELECT * FROM session_entries WHERE thread_id = ? ORDER BY ordinal ASC')
        .all(threadId) as unknown as SessionEntryRow[]
    ).map(fromSessionEntryRow);
  }

  public listSessionCheckpoints(threadId: string): SessionCheckpoint[] {
    return (
      this.database
        .prepare(
          'SELECT * FROM session_checkpoints WHERE thread_id = ? ORDER BY created_at ASC, id ASC'
        )
        .all(threadId) as unknown as SessionCheckpointRow[]
    ).map(fromSessionCheckpointRow);
  }

  public getSessionCheckpoint(id: string): SessionCheckpoint | undefined {
    const row = this.database
      .prepare('SELECT * FROM session_checkpoints WHERE id = ?')
      .get(id) as unknown as SessionCheckpointRow | undefined;
    return row ? fromSessionCheckpointRow(row) : undefined;
  }

  public saveGitTaskBaseline(input: GitTaskBaseline): GitTaskBaseline {
    const baseline = GitTaskBaselineSchema.parse(input);
    this.database
      .prepare(
        `INSERT INTO git_task_baselines
           (thread_id, turn_id, head_oid, ref, index_tree_hash, status_entries, truncated,
            captured_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(thread_id) DO NOTHING`
      )
      .run(
        baseline.threadId,
        baseline.turnId,
        baseline.headOid,
        baseline.ref,
        baseline.indexTreeHash,
        JSON.stringify(baseline.statusEntries),
        baseline.truncated ? 1 : 0,
        baseline.capturedAt
      );
    return this.getGitTaskBaseline(baseline.threadId) ?? baseline;
  }

  public getGitTaskBaseline(threadId: string): GitTaskBaseline | undefined {
    const row = this.database
      .prepare('SELECT * FROM git_task_baselines WHERE thread_id = ?')
      .get(threadId) as unknown as GitTaskBaselineRow | undefined;
    return row ? fromGitTaskBaselineRow(row) : undefined;
  }

  public createApproval(input: ApprovalInput): Approval {
    const approval = ApprovalSchema.parse(input);
    this.database
      .prepare(
        `INSERT INTO approvals
           (version, id, thread_id, turn_id, kind, argv, path, cwd, risk, reason,
            operation_manifest, expires_at, decision, created_at, resolved_at, consumed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`
      )
      .run(
        approval.version,
        approval.id,
        approval.threadId,
        approval.turnId,
        approval.kind,
        approval.argv ? JSON.stringify(approval.argv) : null,
        approval.path,
        approval.cwd,
        approval.risk,
        approval.reason,
        approval.operationManifest ? JSON.stringify(approval.operationManifest) : null,
        approval.expiresAt,
        approval.decision,
        approval.createdAt,
        approval.resolvedAt
      );
    return approval;
  }

  public getApproval(id: string): Approval | undefined {
    const row = this.database.prepare('SELECT * FROM approvals WHERE id = ?').get(id) as unknown as
      | ApprovalRow
      | undefined;
    return row ? fromApprovalRow(row) : undefined;
  }

  public listApprovals(threadId: string): Approval[] {
    return (
      this.database
        .prepare('SELECT * FROM approvals WHERE thread_id = ? ORDER BY created_at ASC')
        .all(threadId) as unknown as ApprovalRow[]
    ).map(fromApprovalRow);
  }

  public resolveApproval(id: string, decision: ApprovalDecision): Approval {
    const approval = this.getApproval(id);
    if (!approval || approval.decision) {
      throw new Error('Approval is not pending.');
    }
    if (approval.version === 2 && decision === 'allow-thread') {
      throw new Error('Structured operations can only be allowed once.');
    }
    if (
      approval.version === 2 &&
      decision === 'allow-once' &&
      (!approval.expiresAt || Date.parse(approval.expiresAt) <= Date.now())
    ) {
      throw new Error('The structured operation approval expired.');
    }
    const resolvedAt = now();
    this.database
      .prepare('UPDATE approvals SET decision = ?, resolved_at = ? WHERE id = ?')
      .run(decision, resolvedAt, id);
    return { ...approval, decision, resolvedAt };
  }

  public consumeOperationApproval(
    id: string,
    manifestBinding: string,
    consumedAt = now()
  ): Approval {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const row = this.database
        .prepare('SELECT * FROM approvals WHERE id = ?')
        .get(id) as unknown as ApprovalRow | undefined;
      const approval = row ? fromApprovalRow(row) : undefined;
      if (
        approval?.version !== 2 ||
        approval.decision !== 'allow-once' ||
        !approval.operationManifest ||
        approval.operationManifest.binding !== manifestBinding
      ) {
        throw new Error('The structured operation is not bound to an allow-once approval.');
      }
      if (!approval.expiresAt || Date.parse(approval.expiresAt) <= Date.parse(consumedAt)) {
        throw new Error('The structured operation approval expired.');
      }
      if (row?.consumed_at) {
        throw new Error('The structured operation approval was already consumed.');
      }
      const result = this.database
        .prepare('UPDATE approvals SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL')
        .run(consumedAt, id);
      if (Number(result.changes) !== 1) {
        throw new Error('The structured operation approval was already consumed.');
      }
      this.database.exec('COMMIT');
      return approval;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  public denyPendingApprovalsForTurn(turnId: string): Approval[] {
    const pending = (
      this.database
        .prepare(
          'SELECT * FROM approvals WHERE turn_id = ? AND decision IS NULL ORDER BY created_at ASC'
        )
        .all(turnId) as unknown as ApprovalRow[]
    ).map(fromApprovalRow);
    if (pending.length === 0) {
      return [];
    }

    const resolvedAt = now();
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const update = this.database.prepare(
        'UPDATE approvals SET decision = ?, resolved_at = ? WHERE id = ? AND decision IS NULL'
      );
      for (const approval of pending) {
        update.run('deny', resolvedAt, approval.id);
      }
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
    return pending.map((approval) => ({ ...approval, decision: 'deny', resolvedAt }));
  }

  public recordFileMutation(input: {
    threadId: string;
    path: string;
    status: string;
    beforeBase64: string | null;
    afterBase64: string | null;
    beforeHash: string | null;
    afterHash: string | null;
  }): void {
    const existing = this.database
      .prepare('SELECT * FROM file_baselines WHERE thread_id = ? AND path = ?')
      .get(input.threadId, input.path) as unknown as BaselineRow | undefined;
    if (!existing) {
      this.database
        .prepare(
          `INSERT INTO file_baselines (thread_id, path, original_bytes, original_hash, latest_agent_hash, latest_status)
           VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(
          input.threadId,
          input.path,
          input.beforeBase64,
          input.beforeHash,
          input.afterHash,
          input.status
        );
    } else {
      this.database
        .prepare(
          'UPDATE file_baselines SET latest_agent_hash = ?, latest_status = ? WHERE thread_id = ? AND path = ?'
        )
        .run(input.afterHash, input.status, input.threadId, input.path);
    }
    const ordinal =
      (
        this.database
          .prepare(
            'SELECT COALESCE(MAX(ordinal), 0) AS ordinal FROM file_mutations WHERE thread_id = ?'
          )
          .get(input.threadId) as { ordinal: number }
      ).ordinal + 1;
    const forward = JSON.stringify({
      before: input.beforeBase64,
      after: input.afterBase64,
      status: input.status,
    });
    const reverse = JSON.stringify({
      before: input.afterBase64,
      after: input.beforeBase64,
      status: 'reverted',
    });
    this.database
      .prepare(
        `INSERT INTO file_mutations (id, thread_id, path, ordinal, forward_patch, reverse_patch, before_hash, after_hash, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        createId(),
        input.threadId,
        input.path,
        ordinal,
        forward,
        reverse,
        input.beforeHash,
        input.afterHash,
        now()
      );
  }

  public listBaselines(threadId: string): BaselineRow[] {
    return this.database
      .prepare('SELECT * FROM file_baselines WHERE thread_id = ? ORDER BY path ASC')
      .all(threadId) as unknown as BaselineRow[];
  }

  public updateBaselineStatus(
    threadId: string,
    path: string,
    status: string,
    latestAgentHash: string | null
  ): void {
    this.database
      .prepare(
        'UPDATE file_baselines SET latest_status = ?, latest_agent_hash = ? WHERE thread_id = ? AND path = ?'
      )
      .run(status, latestAgentHash, threadId, path);
  }

  public addRouterOutcome(
    threadId: string,
    turnId: string | null,
    settlement: Settlement
  ): boolean {
    const result = this.database
      .prepare(
        `INSERT OR IGNORE INTO router_outcomes (router_turn_id, thread_id, turn_id, settlement, created_at)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(
        settlement.routerTurnId,
        threadId,
        turnId,
        JSON.stringify(settlement),
        settlement.timestamp
      );
    return Number(result.changes) > 0;
  }

  public listRouterOutcomes(threadId: string): Settlement[] {
    const rows = this.database
      .prepare('SELECT settlement FROM router_outcomes WHERE thread_id = ? ORDER BY created_at ASC')
      .all(threadId) as unknown as { settlement: string }[];
    return rows.map((row) => SettlementSchema.parse(JSON.parse(row.settlement)));
  }

  public recoverInterruptedRuns(): Turn[] {
    const nonTerminal = ['queued', 'preparing', 'running', 'awaiting_approval'];
    const rows = this.database
      .prepare(`SELECT * FROM turns WHERE status IN (${nonTerminal.map(() => '?').join(', ')})`)
      .all(...nonTerminal) as unknown as TurnRow[];
    const interrupted = rows.map((row) =>
      this.updateTurnStatus(row.id, 'interrupted', 'The desktop runtime was interrupted.')
    );
    for (const turn of interrupted) this.denyPendingApprovalsForTurn(turn.id);
    for (const threadId of new Set(interrupted.map((turn) => turn.threadId))) {
      const thread = this.getThread(threadId);
      if (thread && (thread.status === 'running' || thread.status === 'awaiting_approval')) {
        this.updateThreadStatus(threadId, 'interrupted');
      }
    }
    return interrupted;
  }

  public getThreadDetail(threadId: string): {
    thread: Thread;
    turns: Turn[];
    events: JournalEvent[];
    approvals: Approval[];
    checkpoints: SessionCheckpoint[];
    gitBaseline: GitTaskBaseline | null;
    contextBudget: ContextBudgetSnapshot | null;
  } {
    const thread = this.getThread(threadId);
    if (!thread) {
      throw new Error('Thread not found.');
    }
    const events = this.listEvents(threadId);
    const contextBudgetEvent = events.findLast((event) => event.type === 'context.budget');
    return {
      thread,
      turns: this.listTurns(threadId),
      events,
      approvals: this.listApprovals(threadId),
      checkpoints: this.listSessionCheckpoints(threadId),
      gitBaseline: this.getGitTaskBaseline(threadId) ?? null,
      contextBudget: contextBudgetEvent
        ? ContextBudgetSnapshotSchema.parse(contextBudgetEvent.payload)
        : null,
    };
  }

  public buildEvidence(threadId: string, turnId?: string): Record<string, unknown> {
    const allEvents = this.listEvents(threadId);
    const events = turnId ? allEvents.filter((event) => event.turnId === turnId) : allEvents;
    const baselines = this.listBaselines(threadId);
    const outcomes = this.listRouterOutcomes(threadId);
    const commands = events
      .filter(
        (event) =>
          event.type === 'tool.result' &&
          event.payload.name === 'run_command' &&
          event.payload.recordKind === 'command-completion'
      )
      .map((event) => event.payload);
    const failures = commands.filter(
      (command) => command.exitCode !== 0 || command.timedOut === true || command.cancelled === true
    );
    const testsExecuted = commands
      .filter((command) => {
        const argv = Array.isArray(command.argv) ? command.argv.map(String) : [];
        const executable = argv[0]?.split('/').at(-1)?.toLowerCase();
        return (
          ['pytest', 'cargo', 'go'].includes(executable ?? '') ||
          (['npm', 'pnpm', 'yarn', 'bun'].includes(executable ?? '') &&
            (argv[1] === 'test' ||
              (argv[1] === 'run' && /^(test|lint|typecheck|check)$/i.test(argv[2] ?? ''))))
        );
      })
      .map((command) => ({
        argv: command.argv,
        passed: command.exitCode === 0 && command.timedOut !== true && command.cancelled !== true,
      }));
    return {
      outcome:
        events.findLast((event) => event.type === 'turn.lifecycle')?.payload.status ?? 'unknown',
      filesChanged: baselines.map((baseline) => ({
        path: baseline.path,
        status: baseline.latest_status,
      })),
      commands,
      testsExecuted,
      pass: failures.length === 0,
      knownLimitations: events
        .filter((event) => event.type === 'diagnostic')
        .map((event) => event.payload.message),
      manualReviewSuggestions: baselines.map(
        (baseline) => `Review ${baseline.path} before committing.`
      ),
      economics: outcomes.reduce(
        (total, outcome) => ({
          cost: total.cost + outcome.cost,
          subsidy: total.subsidy + outcome.subsidy,
          paid: total.paid + outcome.paid,
          cacheRead: total.cacheRead + outcome.cacheRead,
          cacheWrite: total.cacheWrite + outcome.cacheWrite,
          tokens: total.tokens + outcome.totalTokens,
        }),
        { cost: 0, subsidy: 0, paid: 0, cacheRead: 0, cacheWrite: 0, tokens: 0 }
      ),
    };
  }

  public asDiffFiles(threadId: string): DiffFile[] {
    return this.listBaselines(threadId).map((baseline) => ({
      path: baseline.path,
      status: baseline.latest_status as DiffFile['status'],
      original: baseline.original_bytes
        ? Buffer.from(baseline.original_bytes, 'base64').toString('utf8')
        : '',
      current: '',
      baselineHash: baseline.original_hash,
      latestAgentHash: baseline.latest_agent_hash,
      currentHash: null,
    }));
  }

  private sessionProjection(
    event: JournalEvent
  ): { kind: SessionEntry['kind']; payload: Record<string, unknown> } | undefined {
    if (containsSponsorKey(event.payload)) return undefined;
    const payload = safeRecord(event.payload);
    if (event.type === 'message.user' && typeof payload.text === 'string') {
      return {
        kind: 'user_message',
        payload: {
          role: 'user',
          text: payload.text,
          ...(typeof payload.mode === 'string' ? { mode: payload.mode } : {}),
        },
      };
    }
    if (event.type === 'message.complete' && typeof payload.text === 'string') {
      const usage = safeRecord(payload.usage);
      const tokenCount = (value: unknown): number =>
        typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
      return {
        kind: 'assistant_message',
        payload: {
          role: 'assistant',
          text: payload.text,
          content: removeSponsorData(payload.content ?? []),
          model: typeof payload.model === 'string' ? payload.model : 'unknown',
          usage: {
            input: tokenCount(usage.input),
            output: tokenCount(usage.output),
            cacheRead: tokenCount(usage.cacheRead),
            cacheWrite: tokenCount(usage.cacheWrite),
            totalTokens: tokenCount(usage.totalTokens),
          },
        },
      };
    }
    if (
      event.type === 'tool.result' &&
      typeof payload.name === 'string' &&
      typeof payload.toolCallId === 'string' &&
      typeof payload.output === 'string'
    ) {
      return {
        kind: 'tool_result',
        payload: {
          name: payload.name,
          toolCallId: payload.toolCallId,
          output: payload.output,
          isError: Boolean(payload.isError),
        },
      };
    }
    if (event.type === 'compaction' && typeof payload.summary === 'string') {
      return {
        kind: 'compaction',
        payload: {
          summary: payload.summary,
          outcome: payload.outcome,
          droppedMessages: payload.droppedMessages,
          tokensBefore: payload.tokensBefore,
          tokensAfter: payload.tokensAfter,
          modelAssisted: payload.modelAssisted,
          retainedMessages: removeSponsorData(payload.retainedMessages ?? []),
        },
      };
    }
    if (
      event.type === 'approval.resolved' ||
      event.type === 'file.change' ||
      event.type === 'diff.change' ||
      event.type === 'operation.completed' ||
      event.type === 'runtime.crash'
    ) {
      return {
        kind: 'context_anchor',
        payload: {
          eventType: event.type,
          value: removeSponsorData(payload),
        },
      };
    }
    return undefined;
  }

  private projectSessionEvent(event: JournalEvent): void {
    if (event.type === 'session.checkpoint') {
      if (!event.turnId || event.payload.safe !== true) return;
      const exists = this.database
        .prepare('SELECT 1 AS present FROM session_checkpoints WHERE source_event_id = ?')
        .get(event.id) as { present: number } | undefined;
      if (exists) return;
      const entries = this.database
        .prepare(
          'SELECT ordinal, digest FROM session_entries WHERE thread_id = ? ORDER BY ordinal ASC'
        )
        .all(event.threadId) as unknown as Array<{ ordinal: number; digest: string }>;
      const entryOrdinal = entries.at(-1)?.ordinal ?? 0;
      const checkpoint: SessionCheckpoint = SessionCheckpointSchema.parse({
        id: createId(),
        threadId: event.threadId,
        turnId: event.turnId,
        sourceEventId: event.id,
        entryOrdinal,
        contextDigest: sha256(
          JSON.stringify({ schemaVersion: 1, entries: entries.map((entry) => entry.digest) })
        ),
        safe: true,
        createdAt: event.timestamp,
      });
      this.database
        .prepare(
          `INSERT INTO session_checkpoints
             (id, thread_id, turn_id, source_event_id, entry_ordinal, context_digest, safe, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          checkpoint.id,
          checkpoint.threadId,
          checkpoint.turnId,
          checkpoint.sourceEventId,
          checkpoint.entryOrdinal,
          checkpoint.contextDigest,
          1,
          checkpoint.createdAt
        );
      return;
    }

    const projection = this.sessionProjection(event);
    if (!projection) return;
    const exists = this.database
      .prepare('SELECT 1 AS present FROM session_entries WHERE source_event_id = ?')
      .get(event.id) as { present: number } | undefined;
    if (exists) return;
    const ordinal =
      (
        this.database
          .prepare(
            'SELECT COALESCE(MAX(ordinal), 0) AS ordinal FROM session_entries WHERE thread_id = ?'
          )
          .get(event.threadId) as { ordinal: number }
      ).ordinal + 1;
    const digest = sha256(
      JSON.stringify({
        schemaVersion: 1,
        threadId: event.threadId,
        turnId: event.turnId,
        ordinal,
        kind: projection.kind,
        timestamp: event.timestamp,
        payload: projection.payload,
      })
    );
    const entry: SessionEntry = SessionEntrySchema.parse({
      id: createId(),
      threadId: event.threadId,
      turnId: event.turnId,
      sourceEventId: event.id,
      ordinal,
      kind: projection.kind,
      timestamp: event.timestamp,
      payload: projection.payload,
      digest,
    });
    this.database
      .prepare(
        `INSERT INTO session_entries
           (id, thread_id, turn_id, source_event_id, ordinal, kind, timestamp, payload, digest)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        entry.id,
        entry.threadId,
        entry.turnId,
        entry.sourceEventId,
        entry.ordinal,
        entry.kind,
        entry.timestamp,
        JSON.stringify(entry.payload),
        entry.digest
      );
  }

  private backfillSessionProjection(): void {
    const events = (
      this.database
        .prepare('SELECT * FROM events ORDER BY thread_id ASC, sequence ASC')
        .all() as unknown as EventRow[]
    ).map(fromEventRow);
    if (events.length === 0) return;
    this.database.exec('BEGIN IMMEDIATE');
    try {
      for (const event of events) this.projectSessionEvent(event);
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  private migrate(backupExistingDatabase: boolean): void {
    const version = this.database.prepare('PRAGMA user_version').get() as { user_version: number };
    const hasTurns = this.database
      .prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'turns'")
      .get() as { present: number } | undefined;
    if (version.user_version > 0 && !hasTurns) {
      const baseSchema = migrations[0];
      if (!baseSchema) throw new Error('Missing base database schema.');
      this.database.exec(baseSchema);
    }
    if (backupExistingDatabase && version.user_version < migrations.length) {
      cpSync(this.databasePath, `${this.databasePath}.backup-${Date.now()}`);
    }
    for (let index = version.user_version; index < migrations.length; index += 1) {
      this.database.exec('BEGIN IMMEDIATE');
      try {
        const migration = migrations[index];
        if (!migration) {
          throw new Error(`Missing database migration ${index + 1}.`);
        }
        this.database.exec(migration);
        this.database.exec(`PRAGMA user_version = ${index + 1}`);
        this.database.exec('COMMIT');
      } catch (error) {
        this.database.exec('ROLLBACK');
        throw error;
      }
    }
  }

  public get path(): string {
    return join(this.databasePath);
  }
}
