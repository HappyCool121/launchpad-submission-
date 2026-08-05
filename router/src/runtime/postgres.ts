import pg from 'pg';
import { getRuntimeConfig } from './config.js';
import { strictPostgresConnection } from './postgres-tls.js';

const { Pool } = pg;
let pool: pg.Pool | undefined;

export function getPostgresPool(): pg.Pool {
  const config = getRuntimeConfig();
  if (!config.serviceMode || !config.databaseUrl) throw new Error('PostgreSQL is available only in service mode.');
  const connection = strictPostgresConnection(config.databaseUrl, config.hosted);
  pool ??= new Pool({
    ...connection,
    max: config.postgresPoolSize,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
    statement_timeout: 10_000,
    allowExitOnIdle: false,
    application_name: `adrouter-${config.environment}`,
  });
  pool.on('error', (error) => console.error(JSON.stringify({ event: 'postgres_pool_error', error_type: error.name })));
  return pool;
}

export async function verifyPostgres(): Promise<void> {
  const result = await getPostgresPool().query<{ role: string; schema: string | null; elevated: boolean; auth_access: boolean }>(
    `select current_user as role, to_regnamespace('router')::text as schema,
      (r.rolsuper or r.rolcreatedb or r.rolcreaterole or r.rolreplication or r.rolbypassrls) as elevated,
      has_schema_privilege(current_user, 'auth', 'usage') as auth_access
      from pg_roles r where r.rolname = current_user`,
  );
  const row = result.rows[0];
  if (row?.role !== 'adrouter_runtime' || row.schema !== 'router' || row.elevated || row.auth_access) {
    throw new Error('DATABASE_URL must use the restricted adrouter_runtime login and migrated router schema.');
  }
}

export async function closePostgres(): Promise<void> {
  const current = pool;
  pool = undefined;
  if (current) await current.end();
}

export function poolStats(): { total: number; idle: number; waiting: number } {
  return pool ? { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount } : { total: 0, idle: 0, waiting: 0 };
}
