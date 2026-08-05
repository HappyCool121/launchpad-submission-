import assert from 'node:assert/strict';
import { X509Certificate } from 'node:crypto';
import { strictPostgresConnection } from '../src/runtime/postgres-tls.js';
import { getRuntimeConfig, resetRuntimeConfigForTests } from '../src/runtime/config.js';
import { rejectHostedExecutionControls } from '../src/runtime/admission.js';

const keys = ['ROUTER_RUNTIME_PROFILE','ADROUTER_ENV','DATABASE_URL','SUPABASE_URL','SUPABASE_JWT_ISSUER','API_KEY_HMAC_PEPPER','ADROUTER_API_KEY','ROUTER_AUTH_KEY','ENABLE_DEMO_TIER_OVERRIDE','ENABLE_SPONSOR_WRITES','ROUTER_WEB_ORIGINS','ROUTER_API_ORIGIN','ROUTER_WEB_APP_ORIGIN','ROUTER_MAX_BODY_BYTES','ROUTER_MAX_INPUT_TOKENS','ROUTER_DEFAULT_OUTPUT_TOKENS','ROUTER_MAX_OUTPUT_TOKENS','ROUTER_PLATFORM_AUTH_ACCESS_TTL_SECONDS','ROUTER_PLATFORM_AUTH_TEST_HOOKS','MIMO_ENABLED','MIMO_API_KEY','MIMO_BASE_URL','AGNES_ENABLED','AGNES_API_KEY','AGNES_BASE_URL'] as const;
const original = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
function clear(): void { for (const key of keys) delete process.env[key]; resetRuntimeConfigForTests(); }
function validService(): void {
  process.env.ROUTER_RUNTIME_PROFILE = 'service'; process.env.ADROUTER_ENV = 'local';
  process.env.DATABASE_URL = 'postgresql://adrouter_runtime:unused@127.0.0.1:54322/postgres';
  process.env.SUPABASE_URL = 'http://127.0.0.1:54321'; process.env.SUPABASE_JWT_ISSUER = 'http://127.0.0.1:54321/auth/v1';
  process.env.API_KEY_HMAC_PEPPER = 'unit-test-pepper-at-least-thirty-two-characters';
}
function validHosted(): void {
  process.env.ROUTER_RUNTIME_PROFILE = 'service'; process.env.ADROUTER_ENV = 'staging';
  process.env.DATABASE_URL = 'postgresql://adrouter_runtime.project:unused@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres';
  process.env.SUPABASE_URL = 'https://project.supabase.co'; process.env.SUPABASE_JWT_ISSUER = 'https://project.supabase.co/auth/v1';
  process.env.API_KEY_HMAC_PEPPER = 'unit-test-pepper-at-least-thirty-two-characters';
  process.env.ROUTER_WEB_ORIGINS = 'https://app-staging.adrouter.co';
  process.env.ROUTER_API_ORIGIN = 'https://api-staging.adrouter.co';
  process.env.ROUTER_WEB_APP_ORIGIN = 'https://app-staging.adrouter.co';
}
function controls(body: unknown): { status?: number; next: boolean; code?: string } {
  const state: { status?: number; next: boolean; code?: string } = { next: false };
  const req = { body } as never;
  const res = {
    status(code: number) { state.status = code; return this; },
    json(payload: { code?: string }) { state.code = payload.code; return this; },
  } as never;
  rejectHostedExecutionControls(req, res, () => { state.next = true; });
  return state;
}
try {
  clear(); assert.throws(() => getRuntimeConfig(), /DATABASE_URL is required/);
  clear(); validService(); assert.equal(getRuntimeConfig().serviceMode, true);
  assert.equal(getRuntimeConfig().mimoEnabled, false);
  assert.equal(getRuntimeConfig().agnesEnabled, false);
  clear(); validService(); process.env.MIMO_ENABLED = 'true'; assert.throws(() => getRuntimeConfig(), /MIMO_API_KEY is required/);
  clear(); validService(); process.env.AGNES_ENABLED = 'true'; assert.throws(() => getRuntimeConfig(), /AGNES_API_KEY is required/);
  clear(); validService(); process.env.MIMO_ENABLED = 'true'; process.env.MIMO_API_KEY = 'test'; assert.equal(getRuntimeConfig().mimoEnabled, true);
  clear(); validService(); process.env.ADROUTER_API_KEY = 'shared'; assert.throws(() => getRuntimeConfig(), /Shared router keys are forbidden/);
  clear(); process.env.ROUTER_RUNTIME_PROFILE = 'demo'; process.env.ADROUTER_ENV = 'staging'; assert.throws(() => getRuntimeConfig(), /mandatory/);
  clear(); validService(); process.env.SUPABASE_JWT_ISSUER = 'http://127.0.0.1:54321/wrong'; assert.throws(() => getRuntimeConfig(), /SUPABASE_JWT_ISSUER/);
  clear(); validHosted(); assert.equal(getRuntimeConfig().hosted, true);
  assert.equal(getRuntimeConfig().maxBodyBytes, 8_388_608);
  assert.equal(getRuntimeConfig().maxInputTokens, 917_504);
  assert.equal(getRuntimeConfig().maxOutputTokens, 196_608);
  assert.equal(getRuntimeConfig().defaultOutputTokens, 4_096);
  assert.equal(getRuntimeConfig().platformAuthAccessTtlSeconds, 600);
  clear(); validHosted(); delete process.env.ROUTER_API_ORIGIN; assert.throws(() => getRuntimeConfig(), /ROUTER_API_ORIGIN.*HTTPS/);
  clear(); validHosted(); process.env.ROUTER_PLATFORM_AUTH_ACCESS_TTL_SECONDS = '10'; assert.throws(() => getRuntimeConfig(), /between 60 and 3600/);
  clear(); validHosted(); process.env.ROUTER_PLATFORM_AUTH_TEST_HOOKS = 'true'; assert.throws(() => getRuntimeConfig(), /cannot be enabled/);
  clear(); validHosted(); process.env.ROUTER_MAX_INPUT_TOKENS = '917503'; assert.throws(() => getRuntimeConfig(), /Hosted token limits are fixed/);
  clear(); validHosted(); process.env.ROUTER_MAX_OUTPUT_TOKENS = '196607'; assert.throws(() => getRuntimeConfig(), /Hosted token limits are fixed/);
  clear(); validHosted(); process.env.ROUTER_DEFAULT_OUTPUT_TOKENS = '4097'; assert.throws(() => getRuntimeConfig(), /Hosted token limits are fixed/);
  clear(); validService(); process.env.ROUTER_MAX_OUTPUT_TOKENS = '2048'; process.env.ROUTER_DEFAULT_OUTPUT_TOKENS = '4096'; assert.throws(() => getRuntimeConfig(), /cannot exceed/);
  clear(); validService(); process.env.ROUTER_MAX_BODY_BYTES = '0'; assert.throws(() => getRuntimeConfig(), /positive integer/);
  clear(); validHosted();
  assert.deepEqual(controls({ runtime_mode: 'mock' }), { status: 400, next: false, code: 'hosted_control_not_allowed' });
  assert.deepEqual(controls({ tier_override: 'A' }), { status: 400, next: false, code: 'hosted_control_not_allowed' });
  assert.equal(controls({ ads_enabled: false }).next, true);
  clear(); process.env.ROUTER_RUNTIME_PROFILE = 'demo'; assert.equal(controls({ runtime_mode: 'mock', tier_override: 'A' }).next, true);
  const strictConnection = strictPostgresConnection(
    'postgresql://adrouter_runtime.project:unused@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres?application_name=test&sslmode=require&sslrootcert=ignored',
    true,
  );
  const strictUrl = new URL(strictConnection.connectionString);
  assert.equal(strictUrl.searchParams.get('application_name'), 'test');
  assert.equal(strictUrl.searchParams.has('sslmode'), false);
  assert.equal(strictUrl.searchParams.has('sslrootcert'), false);
  assert.equal(strictConnection.ssl?.rejectUnauthorized, true);
  assert.match(new X509Certificate(strictConnection.ssl!.ca).subject, /CN=Supabase Root 2021 CA/);
  assert.deepEqual(strictPostgresConnection('postgresql://localhost/postgres?sslmode=disable', false), {
    connectionString: 'postgresql://localhost/postgres?sslmode=disable',
    ssl: undefined,
  });
  console.log('OK: configuration boundaries fail closed, including hosted controls and strict Supabase TLS.');
} finally {
  clear(); for (const key of keys) if (original[key] !== undefined) process.env[key] = original[key];
}
