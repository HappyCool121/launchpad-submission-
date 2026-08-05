import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { principalFrom, requireBrowserAuth, requireDeveloper, requireRole } from '../runtime/auth.js';
import { getRuntimeConfig } from '../runtime/config.js';
import { requireInstallationRevokeAuth } from '../runtime/machine-auth.js';
import { getPostgresPool } from '../runtime/postgres.js';
import {
  CLIENT_KINDS,
  ACTIVE_CLIENT_KINDS,
  MACHINE_SCOPES,
  STORAGE_CLASSES,
  canonicalHtu,
  createUserCode,
  digestSecret,
  isBrowserHandoffId,
  jwkThumbprint,
  normalizeUserCode,
  opaqueSecret,
  parseSemVer,
  PlatformAuthError,
  requestIpPseudonym,
  sendPlatformAuthError,
  userCodeFromBrowserHandoffId,
  validatePublicEd25519Jwk,
  type ClientKind,
  type MachineScope,
  type PublicEd25519Jwk,
  type StorageClass,
} from '../runtime/platform-auth.js';
import { enforceClientVersion, verifyPlatformProof } from '../runtime/platform-auth-proof.js';
import { issueNonce, nonceContext, takeFixedWindowRateLimit } from '../runtime/platform-auth-store.js';
import { recordRefreshReuse } from '../runtime/metrics.js';

export const platformAuthRouter = Router();

const ClientKindSchema = z.enum(CLIENT_KINDS);
const ActiveClientKindSchema = z.enum(ACTIVE_CLIENT_KINDS);
const ScopeSchema = z.enum(MACHINE_SCOPES);
const StorageClassSchema = z.enum(STORAGE_CLASSES);
const VersionSchema = z.string().max(120).refine((value) => parseSemVer(value) !== undefined, 'Strict SemVer is required.');
const UuidSchema = z.string().uuid();
const BrowserHandoffIdSchema = z.string().refine(isBrowserHandoffId, 'A UUIDv4 browser handoff identifier is required.');
const InitiationSchema = z.object({
  client_kind: ClientKindSchema,
  client_version: VersionSchema,
  display_name: z.string().trim().min(1).max(120),
  public_key_jwk: z.unknown(),
  requested_scopes: z.array(ScopeSchema).min(1).max(2).transform((values) => [...new Set(values)]),
  storage_class: StorageClassSchema.default('unavailable'),
  browser_handoff_id: BrowserHandoffIdSchema.optional(),
}).strict();
const DeviceGrantSchema = z.object({
  grant_type: z.literal('urn:ietf:params:oauth:grant-type:device_code'),
  device_code: z.string().regex(/^adr_dc_[A-Za-z0-9_-]{43}$/),
  client_kind: ClientKindSchema,
}).strict();
const CancelAuthorizationSchema = z.object({
  device_code: z.string().regex(/^adr_dc_[A-Za-z0-9_-]{43}$/),
  client_kind: ClientKindSchema,
}).strict();
const RefreshGrantSchema = z.object({
  grant_type: z.literal('refresh_token'),
  refresh_token: z.string().regex(/^adr_rt_[A-Za-z0-9_-]{43}$/),
  installation_id: z.string().uuid(),
}).strict();
const TokenSchema = z.discriminatedUnion('grant_type', [DeviceGrantSchema, RefreshGrantSchema]);
const ResolveSchema = z.object({ user_code: z.string().min(8).max(16) }).strict();
const HandoffSchema = z.object({ browser_handoff_id: BrowserHandoffIdSchema }).strict();
const RenameSchema = z.object({ display_name: z.string().trim().min(1).max(120) }).strict();
const ClientPolicySchema = z.object({
  enabled: z.boolean(),
  minimum_version: VersionSchema,
  enforcement_mode: z.enum(['observe', 'warn', 'enforce']),
  update_url: z.string().url().refine((value) => new URL(value).protocol === 'https:').nullable().optional(),
}).strict();

function noStore(res: Parameters<Parameters<typeof platformAuthRouter.post>[1]>[1]): void {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
}

function oauthError(res: Parameters<Parameters<typeof platformAuthRouter.post>[1]>[1], code: string, message: string): void {
  noStore(res);
  res.status(400).json({ error: message, code });
}

function scopesForClient(_kind: ClientKind): readonly MachineScope[] { return MACHINE_SCOPES; }

function assertActiveClientKind(kind: ClientKind): asserts kind is 'cli' | 'desktop' {
  if (kind === 'opencode') throw new PlatformAuthError('client_not_allowed', 403, 'This client kind is not supported.');
}

type ClientPolicyRow = {
  enabled: boolean;
  minimum_version: string;
  enforcement_mode: 'observe' | 'warn' | 'enforce';
  update_url: string | null;
};

async function enforceCurrentClientPolicy(
  clientKind: ClientKind,
  signedVersion: string,
  res: Parameters<Parameters<typeof platformAuthRouter.post>[1]>[1],
): Promise<void> {
  assertActiveClientKind(clientKind);
  const result = await getPostgresPool().query<ClientPolicyRow>(
    'select enabled,minimum_version,enforcement_mode,update_url from router.client_policies where client_kind=$1',
    [clientKind],
  );
  const policy = result.rows[0];
  if (!policy) throw new PlatformAuthError('client_not_allowed', 403, 'This client kind is disabled.');
  const outcome = enforceClientVersion({
    signedVersion,
    minimumVersion: policy.minimum_version,
    mode: policy.enforcement_mode,
    enabled: policy.enabled,
    updateUrl: policy.update_url,
  });
  if (outcome.warning) {
    res.setHeader('Warning', `299 AdRouter "Client version ${signedVersion} is below ${policy.minimum_version}"`);
    if (policy.update_url) res.setHeader('Link', `<${policy.update_url}>; rel="latest-version"`);
  }
}

async function createDeviceAuthorization(input: {
  clientKind: ClientKind;
  clientVersion: string;
  displayName: string;
  publicKey: PublicEd25519Jwk;
  keyThumbprint: string;
  scopes: MachineScope[];
  storageClass: StorageClass;
  browserHandoffId?: string;
}): Promise<{ id: string; deviceCode: string; userCode: string }> {
  const attempts = input.browserHandoffId ? 1 : 3;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const id = input.browserHandoffId ?? randomUUID();
    const installationId = randomUUID();
    const deviceCode = opaqueSecret('adr_dc_');
    const userCode = input.browserHandoffId ? userCodeFromBrowserHandoffId(input.browserHandoffId) : createUserCode();
    const client = await getPostgresPool().connect();
    try {
      await client.query('begin');
      await client.query(
        `insert into router.client_installations(
          id,client_kind,display_name,public_key_jwk,key_thumbprint,scopes,storage_class,claimed_version,status
        ) values($1,$2,$3,$4,$5,$6,$7,$8,'pending')`,
        [installationId, input.clientKind, input.displayName, input.publicKey, input.keyThumbprint,
          input.scopes, input.storageClass, input.clientVersion],
      );
      await client.query(
        `insert into router.device_authorizations(
          id,installation_id,device_code_digest,user_code_digest,requested_scopes,expires_at
        ) values($1,$2,$3,$4,$5,now()+($6::text||' seconds')::interval)`,
        [id, installationId, digestSecret('device-code', deviceCode),
          digestSecret('user-code', normalizeUserCode(userCode)!), input.scopes,
          getRuntimeConfig().platformAuthDeviceTtlSeconds],
      );
      await client.query('commit');
      return { id, deviceCode, userCode };
    } catch (error) {
      await client.query('rollback');
      const code = error && typeof error === 'object' && 'code' in error ? String((error as { code?: unknown }).code) : '';
      if (code !== '23505' || attempt === attempts - 1) throw error;
    } finally { client.release(); }
  }
  throw new Error('Unable to allocate device authorization material.');
}

platformAuthRouter.post('/device/authorizations', async (req, res) => {
  const parsed = InitiationSchema.safeParse(req.body);
  if (!parsed.success) { sendPlatformAuthError(new PlatformAuthError('invalid_request', 400, 'The device authorization request is invalid.'), res); return; }
  try {
    assertActiveClientKind(parsed.data.client_kind);
    const publicKey = validatePublicEd25519Jwk(parsed.data.public_key_jwk);
    const keyThumbprint = jwkThumbprint(publicKey);
    const proof = await verifyPlatformProof({
      request: req,
      publicKey,
      keyThumbprint,
      purpose: 'initiation',
      nonceContext: nonceContext('initiation', keyThumbprint, canonicalHtu(req)),
      expectedClientKind: parsed.data.client_kind,
      bodyRequired: true,
      challengeWhenMissingProof: true,
    });
    if (proof.clientVersion !== parsed.data.client_version) {
      throw new PlatformAuthError('invalid_dpop_proof', 401, 'The signed client version does not match the request.');
    }
    await enforceCurrentClientPolicy(parsed.data.client_kind, proof.clientVersion, res);
    await takeFixedWindowRateLimit('initiate_ip', requestIpPseudonym(req), getRuntimeConfig().platformAuthInitiationLimit, getRuntimeConfig().platformAuthInitiationWindowSeconds);
    const pending = await getPostgresPool().query<{ count: string }>(
      `select count(*)::text count from router.client_installations i
        join router.device_authorizations d on d.installation_id=i.id
        where i.key_thumbprint=$1 and i.status='pending' and d.status='pending' and d.expires_at>now()`,
      [keyThumbprint],
    );
    if (Number(pending.rows[0]?.count ?? 0) >= getRuntimeConfig().platformAuthPendingPerThumbprint) {
      throw new PlatformAuthError('rate_limited', 429, 'Too many pending authorizations for this installation key.');
    }
    const allowed = scopesForClient(parsed.data.client_kind);
    if (parsed.data.requested_scopes.some((scope) => !allowed.includes(scope))) {
      throw new PlatformAuthError('invalid_request', 400, 'A requested scope is not allowed for this client kind.');
    }
    const created = await createDeviceAuthorization({
      clientKind: parsed.data.client_kind,
      clientVersion: parsed.data.client_version,
      displayName: parsed.data.display_name,
      publicKey,
      keyThumbprint,
      scopes: parsed.data.requested_scopes,
      storageClass: parsed.data.storage_class,
      browserHandoffId: parsed.data.browser_handoff_id,
    });
    const verificationUri = `${getRuntimeConfig().webAppOrigin}/connect`;
    noStore(res);
    res.status(201).json({
      device_code: created.deviceCode,
      user_code: created.userCode,
      verification_uri: verificationUri,
      verification_uri_complete: `${verificationUri}?code=${encodeURIComponent(created.userCode)}`,
      expires_in: getRuntimeConfig().platformAuthDeviceTtlSeconds,
      interval: 5,
    });
  } catch (error) { sendPlatformAuthError(error, res); }
});

type CancelAuthorizationRow = {
  authorization_id: string;
  installation_id: string;
  installation_status: string;
  public_key_jwk: unknown;
  key_thumbprint: string;
  client_kind: ClientKind;
  claimed_version: string;
  user_id: string | null;
};

platformAuthRouter.post('/device/authorizations/cancel', async (req, res) => {
  const parsed = CancelAuthorizationSchema.safeParse(req.body);
  if (!parsed.success) {
    sendPlatformAuthError(new PlatformAuthError('invalid_request', 400, 'The cancellation request is invalid.'), res);
    return;
  }
  try {
    const found = await getPostgresPool().query<CancelAuthorizationRow>(
      `select d.id authorization_id,i.id installation_id,i.status installation_status,
        i.public_key_jwk,i.key_thumbprint,i.client_kind,i.claimed_version,i.user_id
      from router.device_authorizations d join router.client_installations i on i.id=d.installation_id
      where d.device_code_digest=$1`,
      [digestSecret('device-code', parsed.data.device_code)],
    );
    const row = found.rows[0];
    // Cancellation is deliberately idempotent and does not reveal whether an
    // expired or already-cleaned device code ever existed.
    if (!row) { noStore(res); res.status(204).end(); return; }
    if (row.client_kind !== parsed.data.client_kind) {
      throw new PlatformAuthError('invalid_dpop_proof', 401, 'The cancellation proof does not match the authorization.');
    }
    assertActiveClientKind(row.client_kind);
    const proof = await verifyPlatformProof({
      request: req,
      publicKey: validatePublicEd25519Jwk(row.public_key_jwk),
      keyThumbprint: row.key_thumbprint,
      purpose: 'cancel',
      nonceContext: nonceContext('cancel', row.authorization_id, canonicalHtu(req)),
      expectedClientKind: row.client_kind,
      bodyRequired: true,
      challengeWhenMissingProof: true,
    });
    if (proof.clientVersion !== row.claimed_version) {
      throw new PlatformAuthError('invalid_dpop_proof', 401, 'The signed client version does not match enrollment.');
    }

    const client = await getPostgresPool().connect();
    try {
      await client.query('begin');
      const locked = await client.query<{ status: string; user_id: string | null }>(
        'select status,user_id from router.client_installations where id=$1 for update',
        [row.installation_id],
      );
      const installation = locked.rows[0];
      if (installation?.status === 'active') {
        await client.query('select router.revoke_client_installation($1,$2,$3)', [
          row.installation_id,
          installation.user_id,
          'client_enrollment_failed',
        ]);
      } else if (installation?.status === 'pending') {
        await client.query('delete from router.client_installations where id=$1', [row.installation_id]);
      }
      await client.query('commit');
    } catch (error) {
      await client.query('rollback').catch(() => undefined);
      throw error;
    } finally { client.release(); }
    noStore(res); res.status(204).end();
  } catch (error) { sendPlatformAuthError(error, res); }
});

type DeviceRow = {
  authorization_id: string;
  authorization_status: 'pending' | 'approved' | 'denied' | 'consumed' | 'expired';
  poll_interval_seconds: number;
  last_polled_at: Date | null;
  expires_at: Date;
  installation_id: string;
  installation_status: string;
  public_key_jwk: unknown;
  key_thumbprint: string;
  client_kind: ClientKind;
  claimed_version: string;
  scopes: MachineScope[];
  user_id: string | null;
};

type RefreshRow = {
  refresh_token_id: string;
  used_at: Date | null;
  revoked_at: Date | null;
  refresh_expires_at: Date;
  family_id: string;
  family_status: 'active' | 'revoked' | 'expired';
  absolute_expires_at: Date;
  installation_id: string;
  installation_status: string;
  public_key_jwk: unknown;
  key_thumbprint: string;
  client_kind: ClientKind;
  scopes: MachineScope[];
  user_status: string;
  is_developer: boolean;
  enabled: boolean;
  minimum_version: string;
  enforcement_mode: 'observe' | 'warn' | 'enforce';
  update_url: string | null;
};

function tokenResponse(accessToken: string, refreshToken: string, input: {
  installationId: string; clientKind: ClientKind; scopes: MachineScope[]; familyExpiresAt: Date;
}): Record<string, unknown> {
  return {
    access_token: accessToken,
    token_type: 'DPoP',
    expires_in: getRuntimeConfig().platformAuthAccessTtlSeconds,
    refresh_token: refreshToken,
    refresh_expires_in: Math.max(0, Math.floor((input.familyExpiresAt.getTime() - Date.now()) / 1000)),
    installation_id: input.installationId,
    client_kind: input.clientKind,
    scope: input.scopes.join(' '),
  };
}

async function handleDeviceGrant(req: Parameters<Parameters<typeof platformAuthRouter.post>[1]>[0], res: Parameters<Parameters<typeof platformAuthRouter.post>[1]>[1], grant: z.infer<typeof DeviceGrantSchema>): Promise<void> {
  const found = await getPostgresPool().query<DeviceRow>(
    `select d.id authorization_id,d.status authorization_status,d.poll_interval_seconds,d.last_polled_at,d.expires_at,
      i.id installation_id,i.status installation_status,i.public_key_jwk,i.key_thumbprint,i.client_kind,
      i.claimed_version,i.scopes,i.user_id
    from router.device_authorizations d join router.client_installations i on i.id=d.installation_id
    where d.device_code_digest=$1`,
    [digestSecret('device-code', grant.device_code)],
  );
  const row = found.rows[0];
  if (!row || row.client_kind !== grant.client_kind) { oauthError(res, 'expired_token', 'The device authorization is invalid or expired.'); return; }
  assertActiveClientKind(row.client_kind);
  const proof = await verifyPlatformProof({
    request: req,
    publicKey: validatePublicEd25519Jwk(row.public_key_jwk),
    keyThumbprint: row.key_thumbprint,
    purpose: 'device_token',
    nonceContext: nonceContext('device-token', row.authorization_id, canonicalHtu(req)),
    expectedClientKind: row.client_kind,
    bodyRequired: true,
    challengeWhenMissingProof: true,
  });
  if (proof.clientVersion !== row.claimed_version) throw new PlatformAuthError('invalid_dpop_proof', 401, 'The signed client version does not match enrollment.');
  await enforceCurrentClientPolicy(row.client_kind, proof.clientVersion, res);

  const client = await getPostgresPool().connect();
  try {
    await client.query('begin');
    const locked = await client.query<DeviceRow>(
      `select d.id authorization_id,d.status authorization_status,d.poll_interval_seconds,d.last_polled_at,d.expires_at,
        i.id installation_id,i.status installation_status,i.public_key_jwk,i.key_thumbprint,i.client_kind,
        i.claimed_version,i.scopes,i.user_id
      from router.device_authorizations d join router.client_installations i on i.id=d.installation_id
      where d.id=$1 for update of d,i`, [row.authorization_id],
    );
    const current = locked.rows[0]!;
    if (current.expires_at.getTime() <= Date.now() || current.authorization_status === 'expired') {
      await client.query(`update router.device_authorizations set status='expired' where id=$1 and status in ('pending','approved')`, [row.authorization_id]);
      await client.query('commit'); oauthError(res, 'expired_token', 'The device authorization expired.'); return;
    }
    if (current.authorization_status === 'denied') { await client.query('commit'); oauthError(res, 'access_denied', 'The device authorization was denied.'); return; }
    if (current.authorization_status === 'consumed') { await client.query('commit'); oauthError(res, 'expired_token', 'The device authorization was already consumed.'); return; }
    const minimumNextPoll = current.last_polled_at?.getTime() ?? 0;
    if (minimumNextPoll + current.poll_interval_seconds * 1000 > Date.now()) {
      const interval = Math.min(30, current.poll_interval_seconds + 5);
      await client.query('update router.device_authorizations set poll_interval_seconds=$2,last_polled_at=now() where id=$1', [row.authorization_id, interval]);
      await client.query('commit');
      const nextNonce = await issueNonce('device_token', row.key_thumbprint, nonceContext('device-token', row.authorization_id, canonicalHtu(req)));
      res.setHeader('DPoP-Nonce', nextNonce);
      oauthError(res, 'slow_down', 'Polling is too frequent.'); return;
    }
    if (current.authorization_status === 'pending') {
      await client.query('update router.device_authorizations set last_polled_at=now() where id=$1', [row.authorization_id]);
      await client.query('commit');
      const nextNonce = await issueNonce('device_token', row.key_thumbprint, nonceContext('device-token', row.authorization_id, canonicalHtu(req)));
      res.setHeader('DPoP-Nonce', nextNonce);
      oauthError(res, 'authorization_pending', 'The device authorization is awaiting user approval.'); return;
    }
    if (current.authorization_status !== 'approved' || current.installation_status !== 'active' || !current.user_id) {
      await client.query('rollback'); oauthError(res, 'access_denied', 'The installation is not active.'); return;
    }
    const account = await client.query<{ status: string; is_developer: boolean }>(
      'select status,is_developer from router.beta_users where user_id=$1 for update',
      [current.user_id],
    );
    if (account.rows[0]?.status !== 'active' || !account.rows[0].is_developer) {
      await client.query('rollback');
      throw new PlatformAuthError('developer_required', 403, 'Developer access is not enabled for this account.');
    }
    const familyId = randomUUID();
    const accessToken = opaqueSecret('adr_at_');
    const refreshToken = opaqueSecret('adr_rt_');
    const familyExpiresAt = new Date(Date.now() + getRuntimeConfig().platformAuthRefreshTtlSeconds * 1000);
    await client.query(`insert into router.machine_token_families(id,installation_id,absolute_expires_at)
      values($1,$2,$3)`, [familyId, current.installation_id, familyExpiresAt]);
    await client.query(`insert into router.machine_access_tokens(family_id,installation_id,secret_digest,key_thumbprint,scopes,expires_at)
      values($1,$2,$3,$4,$5,least($6,now()+($7::text||' seconds')::interval))`,
    [familyId, current.installation_id, digestSecret('access-token', accessToken), current.key_thumbprint, current.scopes, familyExpiresAt, getRuntimeConfig().platformAuthAccessTtlSeconds]);
    await client.query(`insert into router.machine_refresh_tokens(family_id,installation_id,secret_digest,expires_at)
      values($1,$2,$3,$4)`, [familyId, current.installation_id, digestSecret('refresh-token', refreshToken), familyExpiresAt]);
    await client.query(`update router.device_authorizations set status='consumed',consumed_at=now(),last_polled_at=now() where id=$1`, [row.authorization_id]);
    await client.query('commit');
    noStore(res);
    res.json(tokenResponse(accessToken, refreshToken, { installationId: current.installation_id, clientKind: current.client_kind, scopes: current.scopes, familyExpiresAt }));
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally { client.release(); }
}

async function revokeReusedFamily(familyId: string): Promise<void> {
  const client = await getPostgresPool().connect();
  try {
    await client.query('begin');
    await client.query('select id from router.machine_token_families where id=$1 for update', [familyId]);
    await client.query('select router.revoke_machine_token_family($1,$2)', [familyId, 'refresh_reuse']);
    await client.query('commit');
  } catch (error) { await client.query('rollback'); throw error; }
  finally { client.release(); }
}

async function handleRefreshGrant(req: Parameters<Parameters<typeof platformAuthRouter.post>[1]>[0], res: Parameters<Parameters<typeof platformAuthRouter.post>[1]>[1], grant: z.infer<typeof RefreshGrantSchema>): Promise<void> {
  const found = await getPostgresPool().query<RefreshRow>(
    `select r.id refresh_token_id,r.used_at,r.revoked_at,r.expires_at refresh_expires_at,
      f.id family_id,f.status family_status,f.absolute_expires_at,
      i.id installation_id,i.status installation_status,i.public_key_jwk,i.key_thumbprint,i.client_kind,i.scopes,
      u.status user_status,u.is_developer,p.enabled,p.minimum_version,p.enforcement_mode,p.update_url
    from router.machine_refresh_tokens r
    join router.machine_token_families f on f.id=r.family_id
    join router.client_installations i on i.id=r.installation_id
    join router.beta_users u on u.user_id=i.user_id
    join router.client_policies p on p.client_kind=i.client_kind
    where r.secret_digest=$1 and r.installation_id=$2`,
    [digestSecret('refresh-token', grant.refresh_token), grant.installation_id],
  );
  const row = found.rows[0];
  if (!row) throw new PlatformAuthError('invalid_access_token', 401, 'The refresh credential is invalid.');
  assertActiveClientKind(row.client_kind);
  const proof = await verifyPlatformProof({
    request: req,
    publicKey: validatePublicEd25519Jwk(row.public_key_jwk),
    keyThumbprint: row.key_thumbprint,
    purpose: 'refresh',
    nonceContext: nonceContext('refresh', row.refresh_token_id, canonicalHtu(req)),
    expectedClientKind: row.client_kind,
    bodyRequired: true,
    challengeWhenMissingProof: true,
  });
  await takeFixedWindowRateLimit('refresh_installation', digestSecret('refresh-installation', row.installation_id), getRuntimeConfig().platformAuthRefreshLimit, getRuntimeConfig().platformAuthRefreshWindowSeconds);
  if (row.used_at) {
    await revokeReusedFamily(row.family_id);
    recordRefreshReuse(row.client_kind);
    throw new PlatformAuthError('invalid_access_token', 401, 'Refresh reuse was detected. Re-enroll this installation.');
  }
  if (row.revoked_at || row.refresh_expires_at.getTime() <= Date.now() || row.family_status !== 'active'
    || row.absolute_expires_at.getTime() <= Date.now() || row.installation_status !== 'active' || row.user_status !== 'active') {
    throw new PlatformAuthError('invalid_access_token', 401, 'The refresh credential is no longer active.');
  }
  if (!row.is_developer) {
    throw new PlatformAuthError('developer_required', 403, 'Developer access is not enabled for this account.');
  }
  enforceClientVersion({ signedVersion: proof.clientVersion, minimumVersion: row.minimum_version, mode: row.enforcement_mode, enabled: row.enabled, updateUrl: row.update_url });
  const accessToken = opaqueSecret('adr_at_');
  const refreshToken = opaqueSecret('adr_rt_');
  const replacementId = randomUUID();
  const client = await getPostgresPool().connect();
  try {
    await client.query('begin');
    const locked = await client.query<{ used_at: Date | null; revoked_at: Date | null }>(
      'select used_at,revoked_at from router.machine_refresh_tokens where id=$1 for update', [row.refresh_token_id],
    );
    if (locked.rows[0]?.used_at) {
      await client.query('rollback');
      await revokeReusedFamily(row.family_id);
      recordRefreshReuse(row.client_kind);
      throw new PlatformAuthError('invalid_access_token', 401, 'Refresh reuse was detected. Re-enroll this installation.');
    }
    if (!locked.rows[0] || locked.rows[0].revoked_at) throw new PlatformAuthError('invalid_access_token', 401, 'The refresh credential is no longer active.');
    const account = await client.query<{ status: string; is_developer: boolean }>(
      `select u.status,u.is_developer from router.beta_users u
        join router.client_installations i on i.user_id=u.user_id
        where i.id=$1 for update of u`,
      [row.installation_id],
    );
    if (account.rows[0]?.status !== 'active') throw new PlatformAuthError('invalid_access_token', 401, 'The refresh credential is no longer active.');
    if (!account.rows[0].is_developer) throw new PlatformAuthError('developer_required', 403, 'Developer access is not enabled for this account.');
    await client.query('update router.machine_refresh_tokens set used_at=now() where id=$1', [row.refresh_token_id]);
    await client.query(`insert into router.machine_access_tokens(family_id,installation_id,secret_digest,key_thumbprint,scopes,expires_at)
      values($1,$2,$3,$4,$5,least($6,now()+($7::text||' seconds')::interval))`,
    [row.family_id, row.installation_id, digestSecret('access-token', accessToken), row.key_thumbprint, row.scopes, row.absolute_expires_at, getRuntimeConfig().platformAuthAccessTtlSeconds]);
    await client.query(`insert into router.machine_refresh_tokens(id,family_id,installation_id,secret_digest,rotated_from,expires_at)
      values($1,$2,$3,$4,$5,$6)`, [replacementId, row.family_id, row.installation_id, digestSecret('refresh-token', refreshToken), row.refresh_token_id, row.absolute_expires_at]);
    await client.query('update router.client_installations set claimed_version=$2,last_used_at=now(),updated_at=now() where id=$1', [row.installation_id, proof.clientVersion]);
    await client.query('commit');
    noStore(res);
    res.json(tokenResponse(accessToken, refreshToken, { installationId: row.installation_id, clientKind: row.client_kind, scopes: row.scopes, familyExpiresAt: row.absolute_expires_at }));
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally { client.release(); }
}

platformAuthRouter.post('/oauth/token', async (req, res) => {
  const parsed = TokenSchema.safeParse(req.body);
  if (!parsed.success) { sendPlatformAuthError(new PlatformAuthError('invalid_request', 400, 'The token request is invalid.'), res); return; }
  try {
    if (parsed.data.grant_type === 'refresh_token') await handleRefreshGrant(req, res, parsed.data);
    else await handleDeviceGrant(req, res, parsed.data);
  } catch (error) { sendPlatformAuthError(error, res); }
});

platformAuthRouter.post('/account/device-authorizations/resolve', requireBrowserAuth, requireDeveloper, async (req, res) => {
  const parsed = ResolveSchema.safeParse(req.body);
  const normalized = parsed.success ? normalizeUserCode(parsed.data.user_code) : undefined;
  if (!normalized) { res.status(400).json({ error: 'The user code is invalid.', code: 'invalid_request' }); return; }
  const principal = principalFrom(res);
  try {
    await takeFixedWindowRateLimit('resolve_user', digestSecret('resolve-user', principal.userId), getRuntimeConfig().platformAuthResolveLimit, getRuntimeConfig().platformAuthResolveWindowSeconds);
    const result = await getPostgresPool().query<{
      authorization_id: string; client_kind: ClientKind; claimed_version: string; display_name: string;
      key_thumbprint: string; requested_scopes: MachineScope[]; expires_at: Date;
    }>(`update router.device_authorizations d set resolved_by=$2,resolved_at=coalesce(resolved_at,now())
      from router.client_installations i
      where d.installation_id=i.id and d.user_code_digest=$1 and d.status='pending' and d.expires_at>now()
        and i.client_kind in ('cli','desktop')
        and (d.resolved_by is null or d.resolved_by=$2)
      returning d.id authorization_id,i.client_kind,i.claimed_version,i.display_name,i.key_thumbprint,d.requested_scopes,d.expires_at`,
    [digestSecret('user-code', normalized), principal.userId]);
    const row = result.rows[0];
    if (!row || row.client_kind === 'opencode') { res.status(404).json({ error: 'The authorization was not found or is no longer available.', code: 'authorization_not_found' }); return; }
    noStore(res);
    res.json({
      authorization_id: row.authorization_id,
      user_code: `${normalized.slice(0, 4)}-${normalized.slice(4)}`,
      client_kind: row.client_kind,
      client_version: row.claimed_version,
      display_name: row.display_name,
      public_key_thumbprint: `${row.key_thumbprint.slice(0, 8)}…${row.key_thumbprint.slice(-6)}`,
      requested_scopes: row.requested_scopes,
      expires_at: row.expires_at.toISOString(),
      attested: false,
    });
  } catch (error) { sendPlatformAuthError(error, res); }
});

platformAuthRouter.post('/account/device-authorizations/handoff', requireBrowserAuth, requireDeveloper, async (req, res) => {
  const parsed = HandoffSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: 'The browser handoff identifier is invalid.', code: 'invalid_request' }); return; }
  const principal = principalFrom(res);
  try {
    await takeFixedWindowRateLimit(
      'handoff_user',
      digestSecret('handoff-user', principal.userId),
      getRuntimeConfig().platformAuthHandoffLimit,
      getRuntimeConfig().platformAuthHandoffWindowSeconds,
    );
    const result = await getPostgresPool().query<{
      authorization_id: string; client_kind: ClientKind; claimed_version: string; display_name: string;
      key_thumbprint: string; requested_scopes: MachineScope[]; expires_at: Date;
    }>(`update router.device_authorizations d set resolved_by=$2,resolved_at=coalesce(resolved_at,now())
      from router.client_installations i
      where d.installation_id=i.id and d.id=$1 and d.status='pending' and d.expires_at>now()
        and i.client_kind in ('cli','desktop')
        and (d.resolved_by is null or d.resolved_by=$2)
      returning d.id authorization_id,i.client_kind,i.claimed_version,i.display_name,i.key_thumbprint,d.requested_scopes,d.expires_at`,
    [parsed.data.browser_handoff_id, principal.userId]);
    const row = result.rows[0];
    noStore(res);
    if (!row || row.client_kind === 'opencode') { res.status(204).end(); return; }
    res.json({
      authorization_id: row.authorization_id,
      user_code: userCodeFromBrowserHandoffId(parsed.data.browser_handoff_id),
      client_kind: row.client_kind,
      client_version: row.claimed_version,
      display_name: row.display_name,
      public_key_thumbprint: `${row.key_thumbprint.slice(0, 8)}…${row.key_thumbprint.slice(-6)}`,
      requested_scopes: row.requested_scopes,
      expires_at: row.expires_at.toISOString(),
      attested: false,
    });
  } catch (error) { sendPlatformAuthError(error, res); }
});

async function decideAuthorization(id: string, userId: string, decision: 'approve' | 'deny'): Promise<boolean> {
  const client = await getPostgresPool().connect();
  try {
    await client.query('begin');
    const result = await client.query<{ installation_id: string; client_kind: ClientKind; requested_scopes: MachineScope[] }>(
      `select d.installation_id,i.client_kind,d.requested_scopes
        from router.device_authorizations d join router.client_installations i on i.id=d.installation_id
        where d.id=$1 and d.resolved_by=$2 and d.status='pending' and d.expires_at>now()
        for update of d,i`, [id, userId],
    );
    const row = result.rows[0];
    if (!row || row.client_kind === 'opencode' || row.requested_scopes.some((scope) => !scopesForClient(row.client_kind).includes(scope))) {
      await client.query('rollback'); return false;
    }
    const account = await client.query<{ status: string; is_developer: boolean }>('select status,is_developer from router.beta_users where user_id=$1 for update', [userId]);
    if (account.rows[0]?.status !== 'active' || (decision === 'approve' && !account.rows[0].is_developer)) {
      await client.query('rollback'); return false;
    }
    if (decision === 'approve') {
      await client.query(`update router.client_installations set user_id=$2,status='active',approved_by=$2,approved_at=now(),updated_at=now() where id=$1`, [row.installation_id, userId]);
      await client.query(`update router.device_authorizations set status='approved',approved_by=$2,approved_at=now() where id=$1`, [id, userId]);
    } else {
      await client.query('delete from router.client_installations where id=$1', [row.installation_id]);
    }
    await client.query(`insert into router.audit_events(actor_user_id,action,target_type,target_id,outcome)
      values($1,$2,'device_authorization',$3,'success')`, [userId, `device_authorization_${decision}`, id]);
    await client.query('commit'); return true;
  } catch (error) { await client.query('rollback'); throw error; }
  finally { client.release(); }
}

for (const decision of ['approve', 'deny'] as const) {
  platformAuthRouter.post(`/account/device-authorizations/:id/${decision}`, requireBrowserAuth, async (req, res) => {
    if (decision === 'approve' && !principalFrom(res).isDeveloper) {
      res.status(403).json({ error: 'Developer access is not enabled for this account.', code: 'developer_required' });
      return;
    }
    if (!UuidSchema.safeParse(req.params.id).success) { res.status(400).json({ error: 'The authorization identifier is invalid.', code: 'invalid_request' }); return; }
    const changed = await decideAuthorization(req.params.id, principalFrom(res).userId, decision);
    if (!changed) { res.status(404).json({ error: 'The authorization was not found or is no longer available.', code: 'authorization_not_found' }); return; }
    noStore(res); res.json({ status: decision === 'approve' ? 'approved' : 'denied' });
  });
}

platformAuthRouter.get('/account/installations', requireBrowserAuth, async (_req, res) => {
  const result = await getPostgresPool().query(
    `select id,client_kind,display_name,key_thumbprint,scopes,storage_class,claimed_version,status,
      created_at,approved_at,last_used_at,revoked_at,revocation_reason,false attested
      from router.client_installations where user_id=$1 and status='active' and client_kind in ('cli','desktop') order by created_at desc`,
    [principalFrom(res).userId],
  );
  noStore(res); res.json({ installations: result.rows });
});

platformAuthRouter.patch('/account/installations/:id', requireBrowserAuth, async (req, res) => {
  const parsed = RenameSchema.safeParse(req.body);
  if (!parsed.success || !UuidSchema.safeParse(req.params.id).success) { res.status(400).json({ error: 'The installation update is invalid.', code: 'invalid_request' }); return; }
  const result = await getPostgresPool().query(
    `update router.client_installations set display_name=$3,updated_at=now()
      where id=$1 and user_id=$2 and status='active' and client_kind in ('cli','desktop')
      returning id,client_kind,display_name,key_thumbprint,scopes,storage_class,claimed_version,status,created_at,approved_at,last_used_at,revoked_at,false attested`,
    [req.params.id, principalFrom(res).userId, parsed.data.display_name],
  );
  if (!result.rows[0]) { res.status(404).json({ error: 'Installation not found.', code: 'installation_not_found' }); return; }
  noStore(res); res.json({ installation: result.rows[0] });
});

platformAuthRouter.post('/account/installations/:id/revoke', requireBrowserAuth, async (req, res) => {
  if (!UuidSchema.safeParse(req.params.id).success) { res.status(400).json({ error: 'The installation identifier is invalid.', code: 'invalid_request' }); return; }
  const principal = principalFrom(res);
  const owned = await getPostgresPool().query("select id from router.client_installations where id=$1 and user_id=$2 and status='active' and client_kind in ('cli','desktop')", [req.params.id, principal.userId]);
  if (!owned.rows[0]) { res.status(404).json({ error: 'Installation not found.', code: 'installation_not_found' }); return; }
  await getPostgresPool().query('select router.revoke_client_installation($1,$2,$3)', [req.params.id, principal.userId, 'user_revoked']);
  noStore(res); res.json({ status: 'revoked', installation_id: req.params.id });
});

platformAuthRouter.post('/installation/revoke', requireInstallationRevokeAuth, async (req, res) => {
  const parsed = z.object({ installation_id: z.string().uuid() }).strict().safeParse(req.body);
  const principal = principalFrom(res);
  if (!parsed.success || principal.authSource !== 'installation' || parsed.data.installation_id !== principal.installationId) {
    res.status(403).json({ error: 'The installation cannot revoke this record.', code: 'installation_not_allowed' }); return;
  }
  await getPostgresPool().query('select router.revoke_client_installation($1,$2,$3)', [principal.installationId, principal.userId, 'client_sign_out']);
  noStore(res); res.json({ status: 'revoked', installation_id: principal.installationId });
});

async function clientPolicies(): Promise<Record<string, unknown>> {
  const policies = await getPostgresPool().query("select client_kind,enabled,minimum_version,enforcement_mode,update_url,updated_at,updated_by from router.client_policies where client_kind in ('cli','desktop') order by client_kind");
  return { policies: policies.rows };
}

platformAuthRouter.get('/operator/client-policies', requireBrowserAuth, requireRole('owner', 'operator'), async (_req, res) => {
  noStore(res); res.json(await clientPolicies());
});
platformAuthRouter.get('/operator/client-policies/:clientKind', requireBrowserAuth, requireRole('owner', 'operator'), async (req, res) => {
  const kind = ActiveClientKindSchema.safeParse(req.params.clientKind);
  if (!kind.success) { res.status(404).json({ error: 'Client policy not found.', code: 'client_policy_not_found' }); return; }
  const result = await getPostgresPool().query('select client_kind,enabled,minimum_version,enforcement_mode,update_url,updated_at,updated_by from router.client_policies where client_kind=$1', [kind.data]);
  noStore(res); res.json({ policy: result.rows[0] });
});
platformAuthRouter.put('/operator/client-policies/:clientKind', requireBrowserAuth, requireRole('owner'), async (req, res) => {
  const kind = ActiveClientKindSchema.safeParse(req.params.clientKind); const parsed = ClientPolicySchema.safeParse(req.body);
  if (!kind.success || !parsed.success) { res.status(400).json({ error: 'The client policy update is invalid.', code: 'invalid_request' }); return; }
  const actor = principalFrom(res);
  const result = await getPostgresPool().query(`with updated as (
      update router.client_policies
      set enabled=$2,minimum_version=$3,enforcement_mode=$4,update_url=$5,updated_at=now(),updated_by=$6
      where client_kind=$1 returning *
    ), audited as (
      insert into router.audit_events(actor_user_id,action,target_type,target_id,outcome)
      select $6,'client_policy_update','client_policy',$1,'success' from updated
    ) select * from updated`,
    [kind.data, parsed.data.enabled, parsed.data.minimum_version, parsed.data.enforcement_mode, parsed.data.update_url ?? null, actor.userId]);
  noStore(res); res.json({ policy: result.rows[0] });
});

platformAuthRouter.all(['/operator/legacy-credential-policy', '/operator/legacy-credential-policy/*'], (_req, res) => {
  noStore(res); res.status(404).json({ error: 'Not found.', code: 'route_not_available' });
});
