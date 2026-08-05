import { z } from 'zod';

export type AdRouterEnvironment = 'local' | 'staging' | 'production';
export type RuntimeProfile = 'service' | 'demo';
export type TrafficMode = 'disabled' | 'owner_only' | 'beta';

export const HOSTED_MAX_INPUT_TOKENS = 917_504;
export const HOSTED_MAX_OUTPUT_TOKENS = 196_608;
export const DEFAULT_OUTPUT_TOKENS = 4_096;
export const DEFAULT_MAX_BODY_BYTES = 8_388_608;

const EnvironmentSchema = z.enum(['local', 'staging', 'production']);
const TrafficModeSchema = z.enum(['disabled', 'owner_only', 'beta']);

export interface RuntimeConfig {
  launchpadMode: boolean;
  runtimeProfile: RuntimeProfile;
  serviceMode: boolean;
  hosted: boolean;
  environment: AdRouterEnvironment;
  port: number;
  metricsPort?: number;
  recoveryIntervalMs: number;
  databaseUrl?: string;
  supabaseUrl?: string;
  supabaseJwtIssuer?: string;
  apiKeyHmacPepper?: string;
  deepseekApiKey?: string;
  mimoApiKey?: string;
  mimoBaseUrl: string;
  mimoEnabled: boolean;
  agnesApiKey?: string;
  agnesBaseUrl: string;
  agnesEnabled: boolean;
  webOrigins: string[];
  apiOrigin: string;
  webAppOrigin: string;
  liveTrafficEnabled: boolean;
  trafficMode: TrafficMode;
  maxBodyBytes: number;
  maxInputTokens: number;
  defaultOutputTokens: number;
  maxOutputTokens: number;
  requestDeadlineMs: number;
  heartbeatMs: number;
  postgresPoolSize: number;
  platformAuthAccessTtlSeconds: number;
  platformAuthRefreshTtlSeconds: number;
  platformAuthDeviceTtlSeconds: number;
  platformAuthNonceTtlSeconds: number;
  platformAuthReplayTtlSeconds: number;
  platformAuthProofSkewSeconds: number;
  platformAuthInitiationLimit: number;
  platformAuthInitiationWindowSeconds: number;
  platformAuthPendingPerThumbprint: number;
  platformAuthResolveLimit: number;
  platformAuthResolveWindowSeconds: number;
  platformAuthHandoffLimit: number;
  platformAuthHandoffWindowSeconds: number;
  platformAuthRefreshLimit: number;
  platformAuthRefreshWindowSeconds: number;
  platformAuthNonceLimit: number;
  platformAuthNonceWindowSeconds: number;
  platformAuthCleanupIntervalMs: number;
  platformAuthTestHooks: boolean;
}

function positiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer.`);
  return parsed;
}

function nonnegativeInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative integer.`);
  return parsed;
}

function optionalPort(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return undefined;
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 65_535) throw new Error(`${name} must be a valid TCP port.`);
  return parsed;
}

function boundedInt(name: string, fallback: number, minimum: number, maximum: number): number {
  const value = positiveInt(name, fallback);
  if (value < minimum || value > maximum) throw new Error(`${name} must be between ${minimum} and ${maximum}.`);
  return value;
}

function exactOrigin(name: string, raw: string | undefined, fallback: string, hosted: boolean): string {
  const value = (raw ?? fallback).trim();
  if (!value) throw new Error(`${name} is required.`);
  const url = new URL(value);
  if (url.origin !== value || url.username || url.password || url.search || url.hash) {
    throw new Error(`${name} must be an exact credential-free origin.`);
  }
  if (hosted && url.protocol !== 'https:') throw new Error(`${name} must use HTTPS outside local mode.`);
  return value;
}

function exactOrigins(raw: string | undefined, local: boolean): string[] {
  const fallback = local ? 'http://localhost:5173,http://127.0.0.1:5173' : '';
  const origins = (raw ?? fallback).split(',').map((value) => value.trim()).filter(Boolean);
  for (const value of origins) {
    const url = new URL(value);
    if (url.origin !== value || url.username || url.password) {
      throw new Error('ROUTER_WEB_ORIGINS must contain exact origins without paths or credentials.');
    }
    if (!local && url.protocol !== 'https:') throw new Error('Non-local web origins must use HTTPS.');
  }
  return origins;
}

function providerBaseUrl(name: string, raw: string | undefined, fallback: string, hosted: boolean): string {
  const value = (raw ?? fallback).trim().replace(/\/+$/, '');
  const url = new URL(value);
  if (url.username || url.password || url.search || url.hash || !url.pathname.endsWith('/v1')) {
    throw new Error(`${name} must be a credential-free base URL ending in /v1.`);
  }
  if (hosted && url.protocol !== 'https:') throw new Error(`${name} must use HTTPS outside local mode.`);
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error(`${name} must use HTTP or HTTPS.`);
  return value;
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required in the service runtime profile.`);
  return value;
}

function buildConfig(): RuntimeConfig {
  const environment = EnvironmentSchema.parse(process.env.ADROUTER_ENV ?? 'local');
  const runtimeProfile = z.enum(['service', 'demo']).parse(process.env.ROUTER_RUNTIME_PROFILE ?? 'service');
  const launchpadMode = process.env.LAUNCHPAD_SUBMISSION === 'true';
  const serviceMode = runtimeProfile === 'service';
  const hosted = environment !== 'local';
  if (hosted && !serviceMode) throw new Error('ROUTER_RUNTIME_PROFILE=service is mandatory in staging and production.');
  const trafficMode = TrafficModeSchema.parse(process.env.ROUTER_TRAFFIC_MODE ?? (serviceMode ? 'disabled' : 'beta'));
  const liveTrafficEnabled = process.env.ROUTER_LIVE_TRAFFIC_ENABLED === 'true';
  const port = positiveInt('PORT', 8787);
  const webOrigins = exactOrigins(process.env.ROUTER_WEB_ORIGINS, !hosted);
  const apiOrigin = exactOrigin('ROUTER_API_ORIGIN', process.env.ROUTER_API_ORIGIN, `http://localhost:${port}`, hosted);
  const webAppOrigin = exactOrigin('ROUTER_WEB_APP_ORIGIN', process.env.ROUTER_WEB_APP_ORIGIN, webOrigins[0] ?? '', hosted);
  const platformAuthTestHooks = process.env.ROUTER_PLATFORM_AUTH_TEST_HOOKS === 'true';
  const mimoEnabled = process.env.MIMO_ENABLED === 'true';
  const agnesEnabled = process.env.AGNES_ENABLED === 'true';

  const config: RuntimeConfig = {
    launchpadMode,
    runtimeProfile,
    serviceMode,
    hosted,
    environment,
    port,
    metricsPort: optionalPort('METRICS_PORT'),
    recoveryIntervalMs: nonnegativeInt('ROUTER_RECOVERY_INTERVAL_MS', 0),
    databaseUrl: serviceMode ? required('DATABASE_URL') : undefined,
    supabaseUrl: serviceMode ? required('SUPABASE_URL') : undefined,
    supabaseJwtIssuer: serviceMode ? required('SUPABASE_JWT_ISSUER') : undefined,
    apiKeyHmacPepper: serviceMode ? required('API_KEY_HMAC_PEPPER') : undefined,
    deepseekApiKey: process.env.DEEPSEEK_API_KEY,
    mimoApiKey: process.env.MIMO_API_KEY,
    mimoBaseUrl: providerBaseUrl('MIMO_BASE_URL', process.env.MIMO_BASE_URL, 'https://api.xiaomimimo.com/v1', hosted),
    mimoEnabled,
    agnesApiKey: process.env.AGNES_API_KEY,
    agnesBaseUrl: providerBaseUrl('AGNES_BASE_URL', process.env.AGNES_BASE_URL, 'https://apihub.agnes-ai.com/v1', hosted),
    agnesEnabled,
    webOrigins,
    apiOrigin,
    webAppOrigin,
    liveTrafficEnabled,
    trafficMode,
    maxBodyBytes: positiveInt('ROUTER_MAX_BODY_BYTES', DEFAULT_MAX_BODY_BYTES),
    maxInputTokens: positiveInt('ROUTER_MAX_INPUT_TOKENS', HOSTED_MAX_INPUT_TOKENS),
    defaultOutputTokens: positiveInt('ROUTER_DEFAULT_OUTPUT_TOKENS', DEFAULT_OUTPUT_TOKENS),
    maxOutputTokens: positiveInt('ROUTER_MAX_OUTPUT_TOKENS', HOSTED_MAX_OUTPUT_TOKENS),
    requestDeadlineMs: positiveInt('ROUTER_REQUEST_DEADLINE_MS', 600_000),
    heartbeatMs: positiveInt('ROUTER_HEARTBEAT_MS', 15_000),
    postgresPoolSize: positiveInt('ROUTER_POSTGRES_POOL_SIZE', 5),
    platformAuthAccessTtlSeconds: boundedInt('ROUTER_PLATFORM_AUTH_ACCESS_TTL_SECONDS', 600, 60, 3_600),
    platformAuthRefreshTtlSeconds: boundedInt('ROUTER_PLATFORM_AUTH_REFRESH_TTL_SECONDS', 2_592_000, 86_400, 7_776_000),
    platformAuthDeviceTtlSeconds: boundedInt('ROUTER_PLATFORM_AUTH_DEVICE_TTL_SECONDS', 600, 300, 1_800),
    platformAuthNonceTtlSeconds: boundedInt('ROUTER_PLATFORM_AUTH_NONCE_TTL_SECONDS', 300, 60, 900),
    platformAuthReplayTtlSeconds: boundedInt('ROUTER_PLATFORM_AUTH_REPLAY_TTL_SECONDS', 300, 60, 900),
    platformAuthProofSkewSeconds: boundedInt('ROUTER_PLATFORM_AUTH_PROOF_SKEW_SECONDS', 60, 10, 300),
    platformAuthInitiationLimit: boundedInt('ROUTER_PLATFORM_AUTH_INITIATION_LIMIT', 5, 1, 100),
    platformAuthInitiationWindowSeconds: boundedInt('ROUTER_PLATFORM_AUTH_INITIATION_WINDOW_SECONDS', 600, 60, 3_600),
    platformAuthPendingPerThumbprint: boundedInt('ROUTER_PLATFORM_AUTH_PENDING_PER_THUMBPRINT', 3, 1, 20),
    platformAuthResolveLimit: boundedInt('ROUTER_PLATFORM_AUTH_RESOLVE_LIMIT', 10, 1, 100),
    platformAuthResolveWindowSeconds: boundedInt('ROUTER_PLATFORM_AUTH_RESOLVE_WINDOW_SECONDS', 600, 60, 3_600),
    platformAuthHandoffLimit: boundedInt('ROUTER_PLATFORM_AUTH_HANDOFF_LIMIT', 360, 1, 1_000),
    platformAuthHandoffWindowSeconds: boundedInt('ROUTER_PLATFORM_AUTH_HANDOFF_WINDOW_SECONDS', 900, 60, 3_600),
    platformAuthRefreshLimit: boundedInt('ROUTER_PLATFORM_AUTH_REFRESH_LIMIT', 10, 1, 120),
    platformAuthRefreshWindowSeconds: boundedInt('ROUTER_PLATFORM_AUTH_REFRESH_WINDOW_SECONDS', 60, 30, 600),
    platformAuthNonceLimit: boundedInt('ROUTER_PLATFORM_AUTH_NONCE_LIMIT', 60, 1, 600),
    platformAuthNonceWindowSeconds: boundedInt('ROUTER_PLATFORM_AUTH_NONCE_WINDOW_SECONDS', 60, 30, 600),
    platformAuthCleanupIntervalMs: boundedInt('ROUTER_PLATFORM_AUTH_CLEANUP_INTERVAL_MS', 60_000, 1_000, 3_600_000),
    platformAuthTestHooks,
  };

  if (config.defaultOutputTokens > config.maxOutputTokens) {
    throw new Error('ROUTER_DEFAULT_OUTPUT_TOKENS cannot exceed ROUTER_MAX_OUTPUT_TOKENS.');
  }
  if (config.mimoEnabled && !config.mimoApiKey?.trim()) throw new Error('MIMO_API_KEY is required when MIMO_ENABLED=true.');
  if (config.agnesEnabled && !config.agnesApiKey?.trim()) throw new Error('AGNES_API_KEY is required when AGNES_ENABLED=true.');
  if (launchpadMode) {
    if (serviceMode || hosted) throw new Error('LaunchPad mode requires the local demo runtime profile.');
    if (!process.env.ADROUTER_API_KEY?.trim()) {
      throw new Error('ADROUTER_API_KEY is required in LaunchPad mode.');
    }
    if (!config.agnesEnabled || !config.agnesApiKey?.trim()) {
      throw new Error('A live AGNES_API_KEY is required in LaunchPad mode.');
    }
  }
  if (hosted && (config.maxInputTokens !== HOSTED_MAX_INPUT_TOKENS
    || config.maxOutputTokens !== HOSTED_MAX_OUTPUT_TOKENS
    || config.defaultOutputTokens !== DEFAULT_OUTPUT_TOKENS)) {
    throw new Error(`Hosted token limits are fixed at ${HOSTED_MAX_INPUT_TOKENS} input, ${HOSTED_MAX_OUTPUT_TOKENS} output, and a ${DEFAULT_OUTPUT_TOKENS} default.`);
  }
  if (serviceMode) {
    if (hosted && !config.webOrigins.length) throw new Error('ROUTER_WEB_ORIGINS is required outside local mode.');
    if (hosted && !config.webOrigins.includes(config.webAppOrigin)) {
      throw new Error('ROUTER_WEB_APP_ORIGIN must also appear in ROUTER_WEB_ORIGINS.');
    }
    if (process.env.ADROUTER_API_KEY || process.env.ROUTER_AUTH_KEY) throw new Error('Shared router keys are forbidden in service mode.');
    if (process.env.ENABLE_DEMO_TIER_OVERRIDE === 'true' || process.env.ENABLE_SPONSOR_WRITES === 'true') {
      throw new Error('Demo capabilities are forbidden in service mode.');
    }
    const issuer = new URL(config.supabaseJwtIssuer!);
    const project = new URL(config.supabaseUrl!);
    if (project.pathname.replace(/\/$/, '') || project.username || project.password || project.search || project.hash) {
      throw new Error('SUPABASE_URL must be a credential-free project origin.');
    }
    if (issuer.username || issuer.password || issuer.search || issuer.hash) throw new Error('SUPABASE_JWT_ISSUER must not contain credentials, query, or fragment.');
    if (issuer.origin !== project.origin || issuer.pathname.replace(/\/$/, '') !== '/auth/v1') {
      throw new Error('SUPABASE_JWT_ISSUER must be the configured project /auth/v1 issuer.');
    }
    if (config.apiKeyHmacPepper!.length < 32) throw new Error('API_KEY_HMAC_PEPPER must contain at least 32 characters.');
    const database = new URL(config.databaseUrl!);
    if (database.protocol !== 'postgresql:' && database.protocol !== 'postgres:') throw new Error('DATABASE_URL must be a PostgreSQL URL.');
    if (decodeURIComponent(database.username).split('.')[0] !== 'adrouter_runtime') {
      throw new Error('DATABASE_URL must use the restricted adrouter_runtime role.');
    }
    const localHosts = new Set(['localhost', '127.0.0.1', 'host.docker.internal']);
    if (environment === 'local') {
      if (!localHosts.has(database.hostname) || !localHosts.has(project.hostname) || !localHosts.has(issuer.hostname)) {
        throw new Error('Local service URLs must use loopback or host.docker.internal.');
      }
    } else {
      if (project.protocol !== 'https:' || issuer.protocol !== 'https:') throw new Error('Hosted Supabase URLs must use HTTPS.');
      if (!database.hostname.endsWith('.pooler.supabase.com') || database.port !== '5432' || !decodeURIComponent(database.username).startsWith('adrouter_runtime.')) {
        throw new Error('Hosted DATABASE_URL must use adrouter_runtime through Supavisor session mode on port 5432.');
      }
    }
    if (hosted && !liveTrafficEnabled && trafficMode !== 'disabled') {
      throw new Error('ROUTER_TRAFFIC_MODE must be disabled while ROUTER_LIVE_TRAFFIC_ENABLED is false.');
    }
    if (hosted && platformAuthTestHooks) throw new Error('ROUTER_PLATFORM_AUTH_TEST_HOOKS cannot be enabled in staging or production.');
  }
  if (!serviceMode && (process.env.DATABASE_URL || process.env.SUPABASE_JWT_ISSUER || process.env.SUPABASE_URL)) {
    throw new Error('Service database and Supabase configuration is not accepted in demo mode.');
  }
  return Object.freeze(config);
}

let cached: RuntimeConfig | undefined;

export function getRuntimeConfig(): RuntimeConfig {
  cached ??= buildConfig();
  return cached;
}

/** Test helper; production code must treat configuration as immutable after boot. */
export function resetRuntimeConfigForTests(): void {
  cached = undefined;
}
