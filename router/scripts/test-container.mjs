import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const image = 'adrouter-backend:smoke';
const name = `adrouter-backend-smoke-${process.pid}`;
const envFile = '.env.service.local';
if (!existsSync(envFile)) {
  console.error('.env.service.local is missing. Run npm run local:init before the container integration test.');
  process.exit(1);
}
function run(args, options = {}) {
  const result = spawnSync('docker', args, { encoding: 'utf8', ...options });
  if (result.status !== 0) { process.stderr.write(result.stderr ?? ''); process.exit(result.status ?? 1); }
  return result.stdout.trim();
}
const build = spawnSync('docker', ['build', '--platform', 'linux/amd64', '-t', image, '.'], { stdio: 'inherit' });
if (build.status !== 0) process.exit(build.status ?? 1);
const env = Object.fromEntries(readFileSync(envFile, 'utf8').split(/\r?\n/).filter((line) => line && !line.startsWith('#')).map((line) => {
  const index = line.indexOf('='); return [line.slice(0, index), line.slice(index + 1)];
}));
for (const key of ['DATABASE_URL', 'SUPABASE_URL', 'SUPABASE_JWT_ISSUER']) env[key] = env[key].replaceAll('127.0.0.1', 'host.docker.internal').replaceAll('localhost', 'host.docker.internal');
const envArgs = Object.entries(env).flatMap(([key, value]) => ['-e', `${key}=${value}`]);
run(['run', '-d', '--name', name, '--read-only', '--tmpfs', '/tmp', '--add-host', 'host.docker.internal:host-gateway', '-p', '18788:8787', ...envArgs, image]);
try {
  for (let i = 0; i < 80; i += 1) {
    const probe = spawnSync('curl', ['-fsS', 'http://127.0.0.1:18788/health/ready']);
    if (probe.status === 0) break;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250);
  }
  const live = spawnSync('curl', ['-fsS', 'http://127.0.0.1:18788/health/live']);
  const ready = spawnSync('curl', ['-fsS', 'http://127.0.0.1:18788/health/ready']);
  if (live.status !== 0 || ready.status !== 0) throw new Error(`Container probes failed:\n${run(['logs', name])}`);
  const user = run(['inspect', '-f', '{{.Config.User}}', name]);
  const readOnly = run(['inspect', '-f', '{{.HostConfig.ReadonlyRootfs}}', name]);
  if (user !== 'node' || readOnly !== 'true') throw new Error(`Expected non-root read-only runtime; got user=${user}, readOnly=${readOnly}`);
  console.log('OK: compiled container is non-root, read-only, and passes live and ready probes against local Supabase.');
} finally {
  spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore' });
}
