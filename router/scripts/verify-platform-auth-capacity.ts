import '../src/lib/env.js';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { randomBytes } from 'node:crypto';
import { closePostgres, getPostgresPool, verifyPostgres } from '../src/runtime/postgres.js';

await verifyPostgres();
const pool = getPostgresPool();
const samples = Number(process.env.ROUTER_PLATFORM_AUTH_CAPACITY_SAMPLES ?? 300);
const concurrency = Number(process.env.ROUTER_PLATFORM_AUTH_CAPACITY_CONCURRENCY ?? 20);
const p95LimitMs = Number(process.env.ROUTER_PLATFORM_AUTH_CAPACITY_P95_MS ?? 75);
const cleanupLimitMs = Number(process.env.ROUTER_PLATFORM_AUTH_CLEANUP_LIMIT_MS ?? 2_000);
if (!Number.isSafeInteger(samples) || samples < 100 || samples > 10_000 || !Number.isSafeInteger(concurrency) || concurrency < 2 || concurrency > 100) {
  throw new Error('Capacity samples must be 100-10000 and concurrency 2-100.');
}

const durations: number[] = [];
try {
  let cursor = 0;
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (cursor < samples) {
      cursor += 1;
      const started = performance.now();
      await pool.query('select id from router.machine_access_tokens where secret_digest=$1 and revoked_at is null and expires_at>now()', [randomBytes(32)]);
      durations.push(performance.now() - started);
    }
  }));
  durations.sort((a, b) => a - b);
  const p95 = durations[Math.min(durations.length - 1, Math.floor(durations.length * 0.95))];
  assert(p95 <= p95LimitMs, `platform-auth token lookup p95 ${p95.toFixed(2)}ms exceeds ${p95LimitMs}ms`);

  const thumbprint = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  await pool.query(
    `insert into router.proof_replays(key_thumbprint,proof_id_digest,claimed_at,expires_at)
      select $1,decode(md5(value::text)||md5('platform-auth-'||value::text),'hex'),now()-interval '10 minutes',now()-interval '5 minutes'
      from generate_series(1,1000) value on conflict do nothing`, [thumbprint],
  );
  const cleanupStarted = performance.now();
  await pool.query('select * from router.cleanup_platform_auth(500)');
  await pool.query('select * from router.cleanup_platform_auth(500)');
  const cleanupMs = performance.now() - cleanupStarted;
  assert(cleanupMs <= cleanupLimitMs, `platform-auth cleanup ${cleanupMs.toFixed(2)}ms exceeds ${cleanupLimitMs}ms`);
  const remaining = await pool.query<{ count: string }>('select count(*)::text count from router.proof_replays where key_thumbprint=$1 and expires_at<=now()', [thumbprint]);
  assert.equal(remaining.rows[0]?.count, '0');
  assert.equal(pool.waitingCount, 0, 'PostgreSQL pool retains waiting platform-auth work');
  console.log(JSON.stringify({ event: 'platform_auth_capacity_passed', samples, concurrency, p95_ms: Number(p95.toFixed(2)), cleanup_ms: Number(cleanupMs.toFixed(2)) }));
} finally {
  await pool.query(`delete from router.proof_replays where key_thumbprint='AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'`).catch(() => undefined);
  await closePostgres();
}
