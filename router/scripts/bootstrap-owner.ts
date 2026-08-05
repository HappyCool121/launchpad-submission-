import '../src/lib/env.js';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import pg from 'pg';
import { getRuntimeConfig } from '../src/runtime/config.js';
import { closePostgres, getPostgresPool } from '../src/runtime/postgres.js';

const email = process.argv[2]?.trim();
const password = readFileSync(0, 'utf8').trim();
if (!email || !email.includes('@') || password.length < 8) throw new Error('Usage: printf %s <password> | npm run local:bootstrap-owner -- <email>');
const config = getRuntimeConfig();
if (!config.serviceMode || config.environment !== 'local') throw new Error('local:bootstrap-owner is only valid in local service mode.');

const supabaseWorkdir = process.env.ADROUTER_SUPABASE_WORKDIR ?? '..';
const status = spawnSync('npx', ['supabase', '--workdir', supabaseWorkdir, 'status', '-o', 'json'], { cwd: process.cwd(), encoding: 'utf8' });
if (status.status !== 0) throw new Error('Local Supabase is not running. Run npm run local:init first.');
const values = JSON.parse(status.stdout) as Record<string, string>;
const anonKey = values.ANON_KEY ?? values.anon_key ?? values.anonKey;
const adminKey = values.SERVICE_ROLE_KEY ?? values.SECRET_KEY;
const adminDatabaseUrl = values.DB_URL;
if (!anonKey || !adminKey || !adminDatabaseUrl) throw new Error('Supabase status did not return the required local credentials.');

const normalizedEmail = email.toLowerCase();
const adminPool = new pg.Pool({ connectionString: adminDatabaseUrl, max: 1 });
try {
  await adminPool.query(`insert into router.auth_invites(email) values($1)
    on conflict(email) do update set status='invited',expires_at=null,claimed_by=null,claimed_at=null,revoked_at=null`, [normalizedEmail]);
} finally { await adminPool.end(); }

const response = await fetch(`${config.supabaseUrl}/auth/v1/admin/users`, {
  method: 'POST', headers: { apikey: adminKey, authorization: `Bearer ${adminKey}`, 'content-type': 'application/json' },
  body: JSON.stringify({ email: normalizedEmail, password, email_confirm: true, app_metadata: { provider: 'google', providers: ['google'] } }),
});
const signup = await response.json() as { id?: string; access_token?: string; user?: { id?: string }; msg?: string; error_description?: string };
const userId = signup.user?.id ?? signup.id;
if (!response.ok || !userId) throw new Error(signup.msg ?? signup.error_description ?? `Supabase signup failed (${response.status}).`);

const client = await getPostgresPool().connect();
try {
  await client.query('begin');
  await client.query(`insert into router.beta_users(user_id,status,role,is_developer,activated_at,daily_limit_microusd,monthly_limit_microusd,max_concurrency,flash_enabled,pro_enabled)
    values($1,'active','owner',true,now(),2000000,10000000,2,true,true)
    on conflict(user_id) do update set status='active',role='owner',is_developer=true,activated_at=coalesce(router.beta_users.activated_at,now()),flash_enabled=true,pro_enabled=true`, [userId]);
  await client.query(`update router.platform_settings set traffic_mode='owner_only',updated_by=$1,updated_at=now() where singleton=true`, [userId]);
  await client.query('commit');
} catch (error) { await client.query('rollback'); throw error; }
finally { client.release(); await closePostgres(); }

const showSecrets = process.argv.includes('--show-secrets');
console.log(JSON.stringify({ user_id: userId, role: 'owner', status: 'active', is_developer: true,
  ...(showSecrets ? { access_token: signup.access_token } : {}) }, null, 2));
if (showSecrets) console.error('The browser access token is shown for local verification only.');
else console.error('Bootstrap secrets were redacted. Pass --show-secrets only for an interactive local setup.');
