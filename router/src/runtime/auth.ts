import { createHmac } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { getRuntimeConfig } from './config.js';
import { getPostgresPool } from './postgres.js';
import { authorizedModelsForAccount } from '../lib/modelRegistry.js';

export type UserRole = 'user' | 'owner' | 'operator';
export type UserStatus = 'pending' | 'active' | 'suspended' | 'disabled';
export type AuthSource = 'browser_jwt' | 'api_credential' | 'installation';
export type OAuthProvider = 'google';

export interface Principal {
  userId: string;
  authSource: AuthSource;
  role: UserRole;
  status: UserStatus;
  isDeveloper: boolean;
  isAdvertiser: boolean;
  email?: string;
  provider?: OAuthProvider;
  credentialId?: string;
  credentialEnvironment?: 'test' | 'live';
  installationId?: string;
  tokenFamilyId?: string;
  clientKind?: 'cli' | 'desktop' | 'opencode';
  clientVersion?: string;
  scopes?: ('agent:turn' | 'profile:read')[];
  keyThumbprint?: string;
  storageClass?: 'hardware_backed' | 'os_encrypted' | 'user_encrypted' | 'file_protected' | 'unavailable';
  accessTokenExpiresAt?: string;
  clientPolicyMode?: 'observe' | 'warn' | 'enforce';
  minimumClientVersion?: string;
  maxConcurrency: number;
  maxOutputTokens: number;
  dailyLimitMicrousd: number;
  monthlyLimitMicrousd: number;
  allowedModels: string[];
}

export function principalFrom(res: Response): Principal {
  const principal = res.locals.principal as Principal | undefined;
  if (!principal) throw new Error('Authenticated principal is unavailable.');
  return principal;
}

function bearer(req: Request): string | undefined {
  const value = req.headers.authorization;
  return value?.startsWith('Bearer ') ? value.slice(7) : undefined;
}

function pseudonym(userId: string): string {
  return createHmac('sha256', getRuntimeConfig().apiKeyHmacPepper!).update('deepseek-user-id\0').update(userId).digest('base64url');
}

export function providerUserId(principal: Principal): string { return pseudonym(principal.userId); }

let jwks: ReturnType<typeof createRemoteJWKSet> | undefined;

export function browserIdentityFromClaims(payload: JWTPayload): { userId: string; email: string; provider: OAuthProvider } {
  const email = typeof payload.email === 'string' ? payload.email.trim().toLowerCase() : '';
  const appMetadata = payload.app_metadata && typeof payload.app_metadata === 'object'
    ? payload.app_metadata as Record<string, unknown> : undefined;
  const provider = appMetadata?.provider;
  if (payload.role !== 'authenticated' || typeof payload.sub !== 'string' || payload.sub.length < 32 || payload.is_anonymous === true
    || !email || provider !== 'google') {
    throw new Error('The access token is not an authenticated non-anonymous user token.');
  }
  return { userId: payload.sub, email, provider };
}

async function verifyBrowserToken(token: string): Promise<{ userId: string; email: string; provider: OAuthProvider }> {
  const config = getRuntimeConfig();
  const issuer = config.supabaseJwtIssuer!;
  jwks ??= createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`), { cooldownDuration: 300_000 });
  const { payload } = await jwtVerify(token, jwks, { issuer, audience: 'authenticated' });
  return browserIdentityFromClaims(payload);
}

async function loadUser(userId: string): Promise<Omit<Principal, 'authSource'> | undefined> {
  const result = await getPostgresPool().query<{
    user_id: string; role: UserRole; status: UserStatus; max_concurrency: number;
    daily_limit_microusd: string; monthly_limit_microusd: string; max_output_tokens: number; flash_enabled: boolean; pro_enabled: boolean; is_developer: boolean; is_advertiser: boolean;
  }>(`select user_id, role, status, is_developer, is_advertiser, max_concurrency, max_output_tokens, daily_limit_microusd, monthly_limit_microusd, flash_enabled, pro_enabled
      from router.beta_users where user_id = $1`, [userId]);
  const row = result.rows[0];
  if (!row) return undefined;
  return {
    userId: row.user_id, role: row.role, status: row.status, isDeveloper: row.is_developer, isAdvertiser: row.is_advertiser,
    maxConcurrency: row.max_concurrency, maxOutputTokens: row.max_output_tokens,
    dailyLimitMicrousd: Number(row.daily_limit_microusd), monthlyLimitMicrousd: Number(row.monthly_limit_microusd),
    allowedModels: authorizedModelsForAccount({ isDeveloper: row.is_developer, flashEnabled: row.flash_enabled, proEnabled: row.pro_enabled }),
  };
}

export const requireBrowserAuth: RequestHandler = async (req, res, next) => {
  try {
    const token = bearer(req);
    if (!token || token.startsWith('adr_')) throw new Error('Missing browser access token.');
    const claims = await verifyBrowserToken(token);
    const stored = await loadUser(claims.userId);
    res.locals.principal = stored ? { ...stored, authSource: 'browser_jwt', email: claims.email, provider: claims.provider } : {
      userId: claims.userId, authSource: 'browser_jwt', email: claims.email, provider: claims.provider,
      role: 'user', status: 'pending', isDeveloper: false, isAdvertiser: false, maxConcurrency: 1, maxOutputTokens: 4096,
      dailyLimitMicrousd: 500_000, monthlyLimitMicrousd: 5_000_000, allowedModels: [],
    } satisfies Principal;
    next();
  } catch {
    res.status(401).json({ error: 'unauthorized', code: 'invalid_access_token' });
  }
};

export function requireRole(...roles: UserRole[]): RequestHandler {
  return (_req, res, next) => {
    const principal = res.locals.principal as Principal | undefined;
    if (!principal || principal.status !== 'active' || !roles.includes(principal.role)) {
      res.status(403).json({ error: 'forbidden', code: 'operator_required' });
      return;
    }
    next();
  };
}

export const requireAdvertiser: RequestHandler = (_req, res, next) => {
  const principal = res.locals.principal as Principal | undefined;
  if (!principal || principal.status !== 'active' || !principal.isAdvertiser) {
    res.status(403).json({ error: 'Advertiser access is not enabled for this account.', code: 'advertiser_required' });
    return;
  }
  next();
};

export const requireDeveloper: RequestHandler = (_req, res, next) => {
  const principal = res.locals.principal as Principal | undefined;
  if (!principal || principal.status !== 'active' || !principal.isDeveloper) {
    res.status(403).json({ error: 'Developer access is not enabled for this account.', code: 'developer_required' });
    return;
  }
  next();
};

export function requireNotDraining(req: Request, res: Response, next: NextFunction): void {
  import('./state.js').then(({ isDraining }) => isDraining()
    ? res.status(503).json({ error: 'draining', code: 'service_draining' })
    : next()).catch(next);
}
