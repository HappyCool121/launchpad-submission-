import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function ensureLocalSigningKey(backend = process.cwd()) {
  const root = resolve(backend, '..');
  const signingKey = resolve(root, 'supabase/.temp/signing_keys.json');
  if (existsSync(signingKey)) {
    const parsed = JSON.parse(readFileSync(signingKey, 'utf8'));
    // Repair files created by early CLI examples that showed a bare JWK even
    // though config.toml expects a JSON array of keys.
    const keys = Array.isArray(parsed) ? parsed : [parsed];
    if (!keys.length || keys.some((key) => key?.alg !== 'ES256' || !key?.d || !key?.kid)) throw new Error('The local signing-key file is invalid; remove it and rerun local:init.');
    if (!Array.isArray(parsed)) writeFileSync(signingKey, `${JSON.stringify(keys)}\n`, { mode: 0o600 });
    return signingKey;
  }
  mkdirSync(resolve(root, 'supabase/.temp'), { recursive: true });
  // Generate outside the project tree: once signing_keys_path is configured,
  // CLI 2.109.1 expects that file to exist before `gen signing-key` starts.
  const binary = resolve(backend, 'node_modules/.bin/supabase');
  const generated = spawnSync(binary, ['gen', 'signing-key', '--algorithm', 'ES256'], { cwd: '/tmp', encoding: 'utf8' });
  if (generated.status !== 0) throw new Error(generated.stderr || 'Supabase signing-key generation failed.');
  const jwk = JSON.parse(generated.stdout.split(/\r?\n/, 1)[0]);
  if (jwk.alg !== 'ES256' || !jwk.d || !jwk.kid) throw new Error('Supabase CLI returned an invalid ES256 signing key.');
  writeFileSync(signingKey, `${JSON.stringify([jwk])}\n`, { mode: 0o600 });
  return signingKey;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  ensureLocalSigningKey();
}
