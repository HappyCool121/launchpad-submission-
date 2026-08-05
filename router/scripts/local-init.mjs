import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { ensureLocalSigningKey } from './ensure-local-signing-key.mjs';

const backend = process.cwd();
const envPath = resolve(backend, '.env.service.local');
const migrationUrl = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres';

function run(command, args, env = process.env) {
  const result = spawnSync(command, args, { cwd: backend, env, stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status ?? 1);
}

ensureLocalSigningKey(backend);
run('npx', ['supabase', '--workdir', '..', 'start']);
run('npx', ['supabase', '--workdir', '..', 'db', 'reset', '--local']);

if (existsSync(envPath)) {
  const databaseLine = readFileSync(envPath, 'utf8').split(/\r?\n/).find((line) => line.startsWith('DATABASE_URL='));
  if (!databaseLine) throw new Error('.env.service.local is missing DATABASE_URL.');
  const databaseUrl = new URL(databaseLine.slice('DATABASE_URL='.length));
  if (databaseUrl.username !== 'adrouter_runtime' || databaseUrl.hostname !== '127.0.0.1') {
    throw new Error('.env.service.local DATABASE_URL must use the local adrouter_runtime role.');
  }
  const password = decodeURIComponent(databaseUrl.password);
  run('npx', ['tsx', 'scripts/configure-runtime-role.ts'], { ...process.env, DATABASE_MIGRATION_URL: migrationUrl, ADROUTER_RUNTIME_DB_PASSWORD: password });
  console.log('.env.service.local already exists; reapplied its restricted runtime-role password after reset.');
  process.exit(0);
}

const password = randomBytes(32).toString('base64url');
const pepper = randomBytes(32).toString('base64url');
run('npx', ['tsx', 'scripts/configure-runtime-role.ts'], { ...process.env, DATABASE_MIGRATION_URL: migrationUrl, ADROUTER_RUNTIME_DB_PASSWORD: password });
const databaseUrl = `postgresql://adrouter_runtime:${encodeURIComponent(password)}@127.0.0.1:54322/postgres`;
writeFileSync(envPath, [
  'ROUTER_RUNTIME_PROFILE=service', 'ADROUTER_ENV=local', 'PORT=8787',
  `DATABASE_URL=${databaseUrl}`, 'SUPABASE_URL=http://127.0.0.1:54321',
  'SUPABASE_JWT_ISSUER=http://127.0.0.1:54321/auth/v1', `API_KEY_HMAC_PEPPER=${pepper}`,
  'ROUTER_WEB_ORIGINS=http://localhost:5173,http://127.0.0.1:5173',
  'ROUTER_LIVE_TRAFFIC_ENABLED=false', 'ROUTER_TRAFFIC_MODE=disabled', 'DEEPSEEK_API_KEY=',
  'MIMO_ENABLED=false', 'MIMO_API_KEY=', 'MIMO_BASE_URL=https://api.xiaomimimo.com/v1',
  'AGNES_ENABLED=false', 'AGNES_API_KEY=', 'AGNES_BASE_URL=https://apihub.agnes-ai.com/v1', '',
].join('\n'), { mode: 0o600 });
console.log('Created .env.service.local and configured the restricted adrouter_runtime password.');
