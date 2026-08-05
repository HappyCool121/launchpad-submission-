import type { RequestHandler } from 'express';
import { principalFrom, type Principal, type UserRole, type UserStatus } from './auth.js';
import { getRuntimeConfig } from './config.js';
import { authorizedModelsForAccount } from '../lib/modelRegistry.js';
import { getPostgresPool } from './postgres.js';
import {
  canonicalHtu,
  digestSecret,
  PlatformAuthError,
  sendPlatformAuthError,
  validatePublicEd25519Jwk,
  type ClientKind,
  type MachineScope,
  type StorageClass,
} from './platform-auth.js';
import { enforceClientVersion, verifyPlatformProof } from './platform-auth-proof.js';
import { nonceContext } from './platform-auth-store.js';
import { recordClientPolicyOutcome, recordMachineAuthentication, recordPlatformProofFailure } from './metrics.js';

type MachineRow = {
  access_token_id: string;
  family_id: string;
  access_expires_at: Date;
  installation_id: string;
  public_key_jwk: unknown;
  key_thumbprint: string;
  client_kind: ClientKind;
  scopes: MachineScope[];
  storage_class: StorageClass;
  user_id: string;
  role: UserRole;
  user_status: UserStatus;
  is_developer: boolean;
  is_advertiser: boolean;
  max_concurrency: number;
  max_output_tokens: number;
  daily_limit_microusd: string;
  monthly_limit_microusd: string;
  flash_enabled: boolean;
  pro_enabled: boolean;
  enabled: boolean;
  minimum_version: string;
  enforcement_mode: 'observe' | 'warn' | 'enforce';
  update_url: string | null;
};

function dpopToken(authorization: string | undefined): string | undefined {
  return authorization?.startsWith('DPoP ') ? authorization.slice(5) : undefined;
}

async function authenticateInstallation(
  scope: MachineScope | undefined,
  req: Parameters<RequestHandler>[0],
  res: Parameters<RequestHandler>[1],
  proofPurpose: 'access' | 'revoke' = 'access',
): Promise<void> {
  const accessToken = dpopToken(req.headers.authorization);
  if (!accessToken || !/^adr_at_[A-Za-z0-9_-]{43}$/.test(accessToken)) {
    throw new PlatformAuthError('invalid_access_token', 401, 'The machine access token is invalid.');
  }
  const result = await getPostgresPool().query<MachineRow>(
    `select t.id access_token_id,t.family_id,t.expires_at access_expires_at,
      i.id installation_id,i.public_key_jwk,i.key_thumbprint,i.client_kind,i.scopes,i.storage_class,
      u.user_id,u.role,u.status user_status,u.is_developer,u.is_advertiser,u.max_concurrency,u.max_output_tokens,
      u.daily_limit_microusd,u.monthly_limit_microusd,u.flash_enabled,u.pro_enabled,
      p.enabled,p.minimum_version,p.enforcement_mode,p.update_url
    from router.machine_access_tokens t
    join router.machine_token_families f on f.id=t.family_id and f.installation_id=t.installation_id
    join router.client_installations i on i.id=t.installation_id
    join router.beta_users u on u.user_id=i.user_id
    join router.client_policies p on p.client_kind=i.client_kind
    where t.secret_digest=$1 and t.revoked_at is null and t.expires_at > now()
      and f.status='active' and f.absolute_expires_at > now()
      and i.status='active' and u.status='active'`,
    [digestSecret('access-token', accessToken)],
  );
  const row = result.rows[0];
  if (!row) throw new PlatformAuthError('invalid_access_token', 401, 'The machine access token is invalid.');
  if (!row.is_developer) throw new PlatformAuthError('developer_required', 403, 'Developer access is not enabled for this account.');
  if (row.client_kind === 'opencode') throw new PlatformAuthError('client_not_allowed', 403, 'This client kind is not supported.');
  if (scope && !row.scopes.includes(scope)) throw new PlatformAuthError('installation_not_allowed', 403, 'The installation is not authorized for this route.');
  const publicKey = validatePublicEd25519Jwk(row.public_key_jwk);
  const proof = await verifyPlatformProof({
    request: req,
    publicKey,
    keyThumbprint: row.key_thumbprint,
    purpose: proofPurpose,
    nonceContext: nonceContext(proofPurpose, row.access_token_id, req.method, canonicalHtu(req)),
    expectedClientKind: row.client_kind,
    accessToken,
    bodyRequired: req.method !== 'GET',
  });
  const policy = enforceClientVersion({
    signedVersion: proof.clientVersion,
    minimumVersion: row.minimum_version,
    mode: row.enforcement_mode,
    enabled: row.enabled,
    updateUrl: row.update_url,
  });
  if (policy.warning) {
    res.setHeader('Warning', `299 AdRouter "Client version ${proof.clientVersion} is below ${row.minimum_version}"`);
    if (row.update_url) res.setHeader('Link', `<${row.update_url}>; rel="latest-version"`);
  }
  recordClientPolicyOutcome(row.client_kind, row.enforcement_mode, policy.belowMinimum ? 'below_minimum' : 'compatible');
  res.locals.principal = {
    userId: row.user_id,
    authSource: 'installation',
    role: row.role,
    status: row.user_status,
    isDeveloper: row.is_developer,
    isAdvertiser: row.is_advertiser,
    installationId: row.installation_id,
    tokenFamilyId: row.family_id,
    clientKind: row.client_kind,
    clientVersion: proof.clientVersion,
    scopes: row.scopes,
    keyThumbprint: row.key_thumbprint,
    storageClass: row.storage_class,
    accessTokenExpiresAt: row.access_expires_at.toISOString(),
    clientPolicyMode: row.enforcement_mode,
    minimumClientVersion: row.minimum_version,
    maxConcurrency: row.max_concurrency,
    maxOutputTokens: row.max_output_tokens,
    dailyLimitMicrousd: Number(row.daily_limit_microusd),
    monthlyLimitMicrousd: Number(row.monthly_limit_microusd),
    allowedModels: authorizedModelsForAccount({ isDeveloper: row.is_developer, flashEnabled: row.flash_enabled, proEnabled: row.pro_enabled }),
  } satisfies Principal;
  await getPostgresPool().query(
    `with token as (update router.machine_access_tokens set last_used_at=now() where id=$1)
      update router.client_installations set last_used_at=now(),claimed_version=$2,updated_at=now() where id=$3`,
    [row.access_token_id, proof.clientVersion, row.installation_id],
  );
  recordMachineAuthentication('installation', row.client_kind, 'accepted');
}

export function requireMachineRouteAuth(scope: MachineScope): RequestHandler {
  return (req, res, next) => {
    if (!getRuntimeConfig().serviceMode) {
      import('../lib/profile.js').then(({ requireRouterAuth }) => requireRouterAuth(req, res, next)).catch(next);
      return;
    }
    void authenticateInstallation(scope, req, res).then(() => next()).catch((error) => {
      const code = error instanceof PlatformAuthError ? error.code : 'other';
      recordMachineAuthentication('installation', 'unknown', 'rejected');
      recordPlatformProofFailure(code);
      sendPlatformAuthError(error, res);
    });
  };
}

export const requireInstallationRevokeAuth: RequestHandler = (req, res, next) => {
  if (!getRuntimeConfig().serviceMode) {
    import('../lib/profile.js').then(({ requireRouterAuth }) => requireRouterAuth(req, res, next)).catch(next);
    return;
  }
  void authenticateInstallation(undefined, req, res, 'revoke').then(() => next()).catch((error) => {
    const code = error instanceof PlatformAuthError ? error.code : 'other';
    recordMachineAuthentication('installation', 'unknown', 'rejected');
    recordPlatformProofFailure(code);
    sendPlatformAuthError(error, res);
  });
};

export function installationPrincipalFrom(response: Parameters<RequestHandler>[1]): Principal {
  const principal = principalFrom(response);
  if (principal.authSource !== 'installation' || !principal.installationId || !principal.tokenFamilyId) {
    throw new PlatformAuthError('installation_not_allowed', 403, 'An installation principal is required.');
  }
  return principal;
}
