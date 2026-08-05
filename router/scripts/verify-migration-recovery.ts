import { strict as assert } from 'node:assert';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const directory = mkdtempSync(join(tmpdir(), 'adrouter-migration-recovery-'));
const databasePath = join(directory, 'recovered.sqlite');

try {
  // Simulate an interrupted additive migration: schema changes happened, but
  // schema_migrations still records only the original migration.
  const database = new DatabaseSync(databasePath);
  database.exec(`
    CREATE TABLE schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
    INSERT INTO schema_migrations (version) VALUES ('001_campaigns_and_events');
    CREATE TABLE campaigns (
      id TEXT PRIMARY KEY, brand_name TEXT NOT NULL, ad_copy TEXT NOT NULL,
      target_keywords TEXT NOT NULL, click_url TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE ad_events (
      turn_id TEXT PRIMARY KEY, campaign_id TEXT REFERENCES campaigns(id), tier TEXT NOT NULL,
      reason_code TEXT NOT NULL, similarity REAL NOT NULL, client TEXT, provider TEXT, model TEXT,
      runtime_mode TEXT, status TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      settled_at TEXT, input_tokens INTEGER, cache_hit_tokens INTEGER, cache_miss_tokens INTEGER,
      output_tokens INTEGER, prompt_cost REAL, ad_subsidy REAL, paid REAL,
      seed_key TEXT, cache_write_tokens INTEGER, cost_input_cache_hit REAL,
      cost_input_cache_miss REAL, cost_cache_write REAL, cost_output REAL
    );
  `);
  database.close();

  const tsx = [
    resolve(process.cwd(), 'node_modules/.bin/tsx'),
    resolve(process.cwd(), '../../node_modules/.bin/tsx'),
  ].find(existsSync);
  assert.ok(tsx, 'the workspace tsx executable must be available for migration recovery');
  execFileSync(tsx, ['-e', "import { closeDatabase } from './src/lib/database.ts'; closeDatabase();"], {
    cwd: process.cwd(),
    env: { ...process.env, ADROUTER_DB_PATH: databasePath },
    stdio: 'pipe',
  });

  const recovered = new DatabaseSync(databasePath);
  const applied = (recovered.prepare('SELECT version FROM schema_migrations ORDER BY version').all() as { version: string }[]).map((row) => row.version);
  assert.deepEqual(applied, ['001_campaigns_and_events', '002_fixture_seed_key', '003_usage_and_cost_components']);
  const indexes = recovered.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='ad_events_seed_key'").all();
  assert.equal(indexes.length, 1, 'recovery must create the missing seed-key index after skipping duplicate columns');
  recovered.close();
} finally {
  rmSync(directory, { recursive: true, force: true });
}

console.log('OK: additive SQLite migrations recover cleanly after already-present columns.');
