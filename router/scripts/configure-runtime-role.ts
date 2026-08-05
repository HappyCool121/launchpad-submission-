import pg from 'pg';
import { strictPostgresConnection } from '../src/runtime/postgres-tls.js';
const migrationUrl = process.env.DATABASE_MIGRATION_URL;
const password = process.env.ADROUTER_RUNTIME_DB_PASSWORD;
if (!migrationUrl || !password || password.length < 32) throw new Error('DATABASE_MIGRATION_URL and a 32+ character ADROUTER_RUNTIME_DB_PASSWORD are required.');
const migrationHost = new URL(migrationUrl).hostname;
const localHosts = new Set(['localhost', '127.0.0.1', 'host.docker.internal']);
const pool = new pg.Pool({ ...strictPostgresConnection(migrationUrl, !localHosts.has(migrationHost)), max: 1 });
try {
  const formatted = await pool.query<{ statement: string }>(`select format('alter role adrouter_runtime password %L', $1::text) as statement`, [password]);
  await pool.query(formatted.rows[0]!.statement);
  console.log(JSON.stringify({ role: 'adrouter_runtime', configured: true }));
} finally { await pool.end(); }
