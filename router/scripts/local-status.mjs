import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
const key = resolve(process.cwd(), '../supabase/.temp/signing_keys.json');
if (!existsSync(key)) {
  console.error('Local signing key is missing. Run npm run local:init first.');
  process.exit(1);
}
const result = spawnSync('npx', ['supabase', '--workdir', '..', 'status'], { cwd: process.cwd(), stdio: 'inherit' });
process.exit(result.status ?? 1);
