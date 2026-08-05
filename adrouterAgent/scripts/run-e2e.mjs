import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const arch = process.arch;
const environment = { ...process.env, ADROUTER_E2E_BUILD: '1' };
const packageResult = spawnSync(
  join(process.cwd(), 'node_modules', '.bin', 'electron-forge'),
  ['package', '--platform=darwin', `--arch=${arch}`],
  { cwd: process.cwd(), env: environment, stdio: 'inherit' }
);
if (packageResult.status !== 0) process.exit(packageResult.status ?? 1);

const executable = join(
  process.cwd(),
  'out',
  `AdRouter Agent-darwin-${arch}`,
  'AdRouter Agent.app',
  'Contents',
  'MacOS',
  'AdRouter Agent'
);
if (!existsSync(executable)) throw new Error(`Packaged executable was not found at ${executable}.`);

const playwright = spawnSync(join(process.cwd(), 'node_modules', '.bin', 'playwright'), ['test'], {
  cwd: process.cwd(),
  env: { ...environment, ADROUTER_E2E_APP: executable },
  stdio: 'inherit',
});
process.exit(playwright.status ?? 1);
