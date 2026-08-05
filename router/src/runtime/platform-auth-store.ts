import type { PoolClient } from 'pg';
import { getRuntimeConfig } from './config.js';
import { getPostgresPool } from './postgres.js';
import { digestSecret, opaqueSecret, PlatformAuthError } from './platform-auth.js';
import { recordAuthCleanup, recordNonceChallenge } from './metrics.js';

export type NoncePurpose = 'initiation' | 'device_token' | 'cancel' | 'refresh' | 'access' | 'revoke';
export type RateBucketKind = 'initiate_ip' | 'pending_thumbprint' | 'resolve_user' | 'handoff_user' | 'refresh_installation' | 'nonce_context';

export function fixedWindowRetryAfterSeconds(windowSeconds: number, nowMs = Date.now()): number {
  const elapsedSeconds = Math.floor(nowMs / 1000) % windowSeconds;
  return Math.max(1, windowSeconds - elapsedSeconds);
}

function postgresCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error ? String((error as { code?: unknown }).code) : undefined;
}

export async function takeFixedWindowRateLimit(
  kind: RateBucketKind,
  subject: Buffer,
  limit: number,
  windowSeconds: number,
): Promise<void> {
  const result = await getPostgresPool().query<{ request_count: number }>(
    `insert into router.auth_rate_buckets(bucket_kind,subject_digest,window_started_at,request_count,expires_at)
      values($1,$2,to_timestamp(floor(extract(epoch from now())/$3)*$3),1,
        to_timestamp(floor(extract(epoch from now())/$3)*$3)+($3::text||' seconds')::interval)
      on conflict(bucket_kind,subject_digest,window_started_at) do update
        set request_count=router.auth_rate_buckets.request_count+1
        where router.auth_rate_buckets.request_count < $4
      returning request_count`,
    [kind, subject, windowSeconds, limit],
  );
  if (!result.rows[0]) {
    throw new PlatformAuthError(
      'rate_limited',
      429,
      'Too many authentication requests. Try again later.',
      undefined,
      { 'Retry-After': String(fixedWindowRetryAfterSeconds(windowSeconds)) },
    );
  }
}

export function nonceContext(...parts: string[]): Buffer {
  return digestSecret('nonce-context', parts.join('\0'));
}

export async function issueNonce(purpose: NoncePurpose, keyThumbprint: string, contextDigest: Buffer): Promise<string> {
  const config = getRuntimeConfig();
  await takeFixedWindowRateLimit(
    'nonce_context',
    digestSecret('nonce-rate-context', Buffer.concat([contextDigest, Buffer.from(keyThumbprint)])),
    config.platformAuthNonceLimit,
    config.platformAuthNonceWindowSeconds,
  );
  const plaintext = opaqueSecret('adr_nonce_');
  await getPostgresPool().query(
    `insert into router.proof_nonces(nonce_digest,context_digest,key_thumbprint,purpose,expires_at)
      values($1,$2,$3,$4,now()+($5::text||' seconds')::interval)`,
    [digestSecret('nonce', plaintext), contextDigest, keyThumbprint, purpose, config.platformAuthNonceTtlSeconds],
  );
  return plaintext;
}

export async function nonceChallenge(purpose: NoncePurpose, keyThumbprint: string, contextDigest: Buffer): Promise<never> {
  const nonce = await issueNonce(purpose, keyThumbprint, contextDigest);
  recordNonceChallenge(purpose);
  throw new PlatformAuthError('use_dpop_nonce', 401, 'A fresh DPoP nonce is required.', nonce);
}

async function claimReplay(client: PoolClient, keyThumbprint: string, jti: string): Promise<void> {
  try {
    await client.query(
      `insert into router.proof_replays(key_thumbprint,proof_id_digest,expires_at)
        values($1,$2,now()+($3::text||' seconds')::interval)`,
      [keyThumbprint, digestSecret('proof-jti', jti), getRuntimeConfig().platformAuthReplayTtlSeconds],
    );
  } catch (error) {
    if (postgresCode(error) === '23505') throw new PlatformAuthError('invalid_dpop_proof', 401, 'The DPoP proof was already used.');
    throw error;
  }
}

export async function consumeNonceAndClaimReplay(input: {
  nonce: string | undefined;
  purpose: NoncePurpose;
  keyThumbprint: string;
  contextDigest: Buffer;
  jti: string;
}): Promise<void> {
  if (!input.nonce) return nonceChallenge(input.purpose, input.keyThumbprint, input.contextDigest);
  const client = await getPostgresPool().connect();
  try {
    await client.query('begin');
    const nonce = await client.query<{ id: string }>(
      `select id from router.proof_nonces
        where nonce_digest=$1 and context_digest=$2 and key_thumbprint=$3 and purpose=$4
          and consumed_at is null and expires_at > now()
        for update`,
      [digestSecret('nonce', input.nonce), input.contextDigest, input.keyThumbprint, input.purpose],
    );
    if (!nonce.rows[0]) {
      await client.query('rollback');
      return nonceChallenge(input.purpose, input.keyThumbprint, input.contextDigest);
    }
    await claimReplay(client, input.keyThumbprint, input.jti);
    await client.query('update router.proof_nonces set consumed_at=now() where id=$1 and consumed_at is null', [nonce.rows[0].id]);
    await client.query('commit');
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function cleanupPlatformAuth(): Promise<Record<string, number>> {
  const result = await getPostgresPool().query<{ record_type: string; removed: string }>('select * from router.cleanup_platform_auth($1)', [500]);
  const removed = Object.fromEntries(result.rows.map((row) => [row.record_type, Number(row.removed)]));
  recordAuthCleanup(removed);
  return removed;
}

let cleanupTimer: NodeJS.Timeout | undefined;
export function startPlatformAuthCleanup(): void {
  if (cleanupTimer || !getRuntimeConfig().serviceMode) return;
  cleanupTimer = setInterval(() => {
    void cleanupPlatformAuth().catch((error) => {
      console.warn(JSON.stringify({ event: 'platform_auth_cleanup_failed', error_type: error instanceof Error ? error.name : 'UnknownError' }));
    });
  }, getRuntimeConfig().platformAuthCleanupIntervalMs);
  cleanupTimer.unref();
}

export function stopPlatformAuthCleanup(): void {
  if (cleanupTimer) clearInterval(cleanupTimer);
  cleanupTimer = undefined;
}
