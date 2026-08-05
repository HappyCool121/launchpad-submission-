import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeCostBreakdown, applySubsidy } from './pricing.js';
import type { AdPayload, RuntimeMode, Settlement } from './types.js';

const packageDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const configuredPath = process.env.ADROUTER_DB_PATH;
/** The default is package-relative so starting the server from another directory is safe. */
export const databasePath = configuredPath === ':memory:'
  ? ':memory:'
  : configuredPath
    ? resolve(configuredPath)
    : resolve(packageDirectory, 'data/adrouter.sqlite');

if (databasePath !== ':memory:') mkdirSync(dirname(databasePath), { recursive: true });
const db = new DatabaseSync(databasePath);
let databaseClosed = false;

db.exec('PRAGMA foreign_keys = ON;');
if (databasePath !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);');

const migrationDirectory = resolve(packageDirectory, 'migrations');
const migrations = readdirSync(migrationDirectory)
  .filter((file) => /^\d+_.+\.sql$/.test(file))
  .sort()
  .map((file) => ({ version: file.replace(/\.sql$/, ''), sql: readFileSync(resolve(migrationDirectory, file), 'utf8') }));

function strippedStatement(statement: string): string {
  return statement.replace(/^\s*--.*$/gm, '').trim();
}

/**
 * SQLite has no `ADD COLUMN IF NOT EXISTS`. Running additive migrations one
 * statement at a time lets a recovered database record the migration even if
 * an earlier interrupted startup already added one of its columns or indexes.
 */
function executeAdditiveMigration(sql: string): void {
  for (const rawStatement of sql.split(';')) {
    const statement = strippedStatement(rawStatement);
    if (!statement) continue;

    try {
      db.exec(statement);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const upper = statement.toUpperCase();
      const duplicateColumn = upper.startsWith('ALTER TABLE') && /duplicate column name/i.test(message);
      const existingIndex = upper.startsWith('CREATE ') && upper.includes(' INDEX ') && /already exists/i.test(message);
      const existingTable = upper.startsWith('CREATE TABLE') && /already exists/i.test(message);
      if (duplicateColumn || existingIndex || existingTable) continue;
      throw error;
    }
  }
}

function withTransaction<T>(work: () => T): T {
  db.exec('BEGIN IMMEDIATE;');
  try {
    const result = work();
    db.exec('COMMIT;');
    return result;
  } catch (error) {
    db.exec('ROLLBACK;');
    throw error;
  }
}

function applyMigrations(): void {
  const applied = new Set((db.prepare('SELECT version FROM schema_migrations').all() as { version: string }[]).map((row) => row.version));
  for (const migration of migrations) {
    if (applied.has(migration.version)) continue;
    withTransaction(() => {
      executeAdditiveMigration(migration.sql);
      db.prepare('INSERT INTO schema_migrations (version) VALUES (?)').run(migration.version);
    });
  }
}

const DISALLOWED_ANALYTICS_COLUMNS = ['prompt', 'model_output', 'tool_data', 'api_key', 'user_id'];

export function analyticsSchemaColumns(): string[] {
  return (db.prepare('PRAGMA table_info(ad_events)').all() as { name: string }[]).map((column) => column.name);
}

/** Guard against accidental persistence of user content or credentials. */
export function assertAnalyticsPrivacySchema(): void {
  const columns = new Set(analyticsSchemaColumns());
  const forbidden = DISALLOWED_ANALYTICS_COLUMNS.filter((column) => columns.has(column));
  if (forbidden.length) {
    throw new Error(`analytics schema must not persist sensitive columns: ${forbidden.join(', ')}`);
  }
}

applyMigrations();
assertAnalyticsPrivacySchema();

export type CampaignRow = {
  id: string;
  brand_name: string;
  ad_copy: string;
  target_keywords: string;
  click_url: string | null;
  is_synthetic: boolean;
  disclosure: string | null;
};

export function listCampaigns(): CampaignRow[] {
  return (db.prepare('SELECT id, brand_name, ad_copy, target_keywords, click_url FROM campaigns WHERE active = 1 ORDER BY id').all() as
    Array<Omit<CampaignRow, 'is_synthetic' | 'disclosure'>>)
    .map((row) => ({ ...row, is_synthetic: false, disclosure: null }));
}

/** Advertiser writes update only the explicitly targeted campaign. */
export function upsertCampaign(row: CampaignRow): void {
  db.prepare(`INSERT INTO campaigns (id, brand_name, ad_copy, target_keywords, click_url) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET brand_name=excluded.brand_name, ad_copy=excluded.ad_copy, target_keywords=excluded.target_keywords, click_url=excluded.click_url, updated_at=CURRENT_TIMESTAMP`)
    .run(row.id, row.brand_name, row.ad_copy, row.target_keywords, row.click_url);
}

/** Import immutable fixture data without ever overwriting advertiser edits. */
export function insertSeedCampaign(row: CampaignRow): void {
  db.prepare('INSERT OR IGNORE INTO campaigns (id, brand_name, ad_copy, target_keywords, click_url) VALUES (?, ?, ?, ?, ?)')
    .run(row.id, row.brand_name, row.ad_copy, row.target_keywords, row.click_url);
}

function seedAnalyticsFixturesInTransaction(now: Date): void {
  const campaigns = listCampaigns();
  if (campaigns.length === 0) return;

  const insert = db.prepare(`INSERT OR IGNORE INTO ad_events
    (turn_id, campaign_id, tier, reason_code, similarity, client, provider, model, runtime_mode, status, created_at, settled_at,
     input_tokens, cache_hit_tokens, cache_miss_tokens, cache_write_tokens, output_tokens, prompt_cost, ad_subsidy, paid,
     cost_input_cache_hit, cost_input_cache_miss, cost_cache_write, cost_output, seed_key)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const anchor = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));

  for (let offset = 29; offset >= 0; offset--) {
    const day = new Date(anchor);
    day.setUTCDate(anchor.getUTCDate() - offset);
    const seedKey = `fixture-${day.toISOString().slice(0, 10)}`;
    const variant = offset % 4;
    const tier = variant === 3 ? 'NONE' : (['A', 'B', 'C'] as const)[variant];
    const campaign = tier === 'NONE' ? undefined : campaigns[offset % campaigns.length];
    const cacheHitTokens = 30;
    const cacheMissTokens = 90;
    const cacheWriteTokens = 0;
    const outputTokens = 60;
    const cost = computeCostBreakdown({
      model: 'deepseek-v4-flash',
      inputTokens: cacheHitTokens + cacheMissTokens,
      promptTokens: cacheHitTokens + cacheMissTokens,
      cacheHitTokens,
      cacheWriteTokens,
      outputTokens,
    });
    const subsidy = applySubsidy(cost.total, tier);
    const createdAt = `${day.toISOString().slice(0, 10)}T12:00:00.000Z`;

    insert.run(
      `fixture-turn-${day.toISOString().slice(0, 10)}`,
      campaign?.id ?? null,
      tier,
      tier === 'NONE' ? 'guardrail' : 'matched',
      tier === 'NONE' ? 0 : 0.84,
      'fixture',
      'deepseek',
      'deepseek-v4-flash',
      'mock',
      'settled',
      createdAt,
      createdAt,
      cacheMissTokens,
      cacheHitTokens,
      cacheMissTokens,
      cacheWriteTokens,
      outputTokens,
      cost.total,
      subsidy.ad_subsidy,
      subsidy.paid,
      cost.input_cache_hit,
      cost.input_cache_miss,
      cost.cache_write,
      cost.output,
      seedKey,
    );
  }
}

/**
 * Bootstrap campaigns and the first 30 analytics rows as one transaction.
 * Stable IDs and seed keys make subsequent startup calls no-ops.
 */
export function bootstrapCampaignsAndAnalytics(rows: CampaignRow[], now = new Date()): void {
  withTransaction(() => {
    for (const row of rows) insertSeedCampaign(row);
    seedAnalyticsFixturesInTransaction(now);
  });
}

/** Populate missing deterministic fixture rows without touching campaigns. */
export function seedAnalyticsFixtures(now = new Date()): void {
  withTransaction(() => seedAnalyticsFixturesInTransaction(now));
}

export function insertEvent(ad: AdPayload, meta: { client?: string; provider: string; model: string; runtimeMode: RuntimeMode }): void {
  db.prepare(`INSERT OR IGNORE INTO ad_events (turn_id, campaign_id, tier, reason_code, similarity, client, provider, model, runtime_mode, status)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`)
    .run(ad.turn_id, ad.campaign_id ?? null, ad.tier, ad.reason_code, ad.similarity, meta.client ?? null, meta.provider, meta.model, meta.runtimeMode);
}

/** Never overwrite an already failed or aborted turn with a late settlement. */
export function settleEvent(turnId: string, settlement: Settlement): void {
  db.prepare(`UPDATE ad_events SET status='settled', settled_at=CURRENT_TIMESTAMP, input_tokens=?, cache_hit_tokens=?, cache_miss_tokens=?, cache_write_tokens=?, output_tokens=?, prompt_cost=?, ad_subsidy=?, paid=?, cost_input_cache_hit=?, cost_input_cache_miss=?, cost_cache_write=?, cost_output=?
    WHERE turn_id=? AND status IN ('pending', 'off')`)
    .run(settlement.input_tokens, settlement.cache_hit_tokens, settlement.cache_miss_tokens, settlement.usage.cache_write_tokens, settlement.output_tokens, settlement.prompt_cost, settlement.ad_subsidy, settlement.paid, settlement.cost.input_cache_hit, settlement.cost.input_cache_miss, settlement.cost.cache_write, settlement.cost.output, turnId);
}

export function failEvent(turnId: string): void {
  db.prepare("UPDATE ad_events SET status='failed' WHERE turn_id=? AND status IN ('pending', 'off')").run(turnId);
}

export function abortEvent(turnId: string): void {
  db.prepare("UPDATE ad_events SET status='aborted' WHERE turn_id=? AND status IN ('pending', 'off')").run(turnId);
}

/** Mark a persisted turn aborted if a streaming client disconnects before settlement. */
export function abortOnResponseClose(response: { once: (event: 'close', listener: () => void) => unknown }, turnId: string): () => void {
  let finalized = false;
  response.once('close', () => { if (!finalized) abortEvent(turnId); });
  return () => { finalized = true; };
}

export function analyticsSummary(from?: string, to?: string) {
  const where = ['1=1']; const params: string[] = [];
  if (from) { where.push('created_at >= ?'); params.push(from); }
  if (to) { where.push('created_at <= ?'); params.push(to); }
  const clause = where.join(' AND ');
  return db.prepare(`SELECT COUNT(*) AS total, COALESCE(SUM(campaign_id IS NOT NULL), 0) AS campaign_hits, COALESCE(SUM(tier='NONE'), 0) AS none_count,
    COALESCE(SUM(status='settled'), 0) AS settled_count, COALESCE(SUM(ad_subsidy), 0) AS subsidy_total FROM ad_events WHERE ${clause}`).get(...params);
}

export function analyticsCampaigns(from?: string, to?: string) {
  const where = ['e.campaign_id IS NOT NULL']; const params: string[] = [];
  if (from) { where.push('e.created_at >= ?'); params.push(from); }
  if (to) { where.push('e.created_at <= ?'); params.push(to); }
  return db.prepare(`SELECT e.campaign_id, c.brand_name, COUNT(*) AS hits, COALESCE(SUM(e.tier='A'), 0) AS a_count, COALESCE(SUM(e.tier='B'), 0) AS b_count,
    COALESCE(SUM(e.tier='C'), 0) AS c_count, COALESCE(SUM(e.status='settled'), 0) AS settled_count, COALESCE(SUM(e.ad_subsidy), 0) AS funded_subsidy
    FROM ad_events e JOIN campaigns c ON c.id=e.campaign_id WHERE ${where.join(' AND ')} GROUP BY e.campaign_id, c.brand_name`).all(...params);
}

export function analyticsTierCounts(from?: string, to?: string) {
  const where = ['1=1']; const params: string[] = [];
  if (from) { where.push('created_at >= ?'); params.push(from); }
  if (to) { where.push('created_at <= ?'); params.push(to); }
  const rows = db.prepare(`SELECT tier, COUNT(*) AS count FROM ad_events WHERE ${where.join(' AND ')} GROUP BY tier`).all(...params) as { tier: string; count: number }[];
  return Object.fromEntries(rows.map((row) => [row.tier, row.count]));
}

export function analyticsStatusCounts(from?: string, to?: string) {
  const where = ['1=1']; const params: string[] = [];
  if (from) { where.push('created_at >= ?'); params.push(from); }
  if (to) { where.push('created_at <= ?'); params.push(to); }
  const rows = db.prepare(`SELECT status, COUNT(*) AS count FROM ad_events WHERE ${where.join(' AND ')} GROUP BY status`).all(...params) as { status: string; count: number }[];
  return Object.fromEntries(rows.map((row) => [row.status, row.count]));
}

/** Internal test/read-model helper; routes expose only aggregated analytics. */
export function eventByTurnId(turnId: string): Record<string, unknown> | undefined {
  return db.prepare('SELECT * FROM ad_events WHERE turn_id=?').get(turnId) as Record<string, unknown> | undefined;
}

/** Close once so signal and server-close hooks can both safely call this. */
export function closeDatabase(): void {
  if (databaseClosed) return;
  databaseClosed = true;
  db.close();
}
