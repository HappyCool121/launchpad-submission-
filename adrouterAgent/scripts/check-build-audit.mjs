import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { evaluateBuildAudit } from './build-audit-policy.mjs';

const npmCli = process.env.npm_execpath;
if (!npmCli) throw new Error('Run this policy through npm run audit:build.');
const audit = spawnSync(process.execPath, [npmCli, 'audit', '--json'], {
  encoding: 'utf8',
  maxBuffer: 16 * 1024 * 1024,
});
if (audit.error) throw audit.error;
if (audit.status !== 0 && audit.status !== 1) {
  throw new Error(`npm audit exited unexpectedly with status ${audit.status}.`);
}
let report;
try {
  report = JSON.parse(audit.stdout);
} catch {
  throw new Error('npm audit did not return valid JSON.');
}
const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
const result = evaluateBuildAudit(report, lock);
console.log(
  `Build audit passed; ${result.checked.length} high-severity dependency nodes are bounded to ${result.allowedAdvisory}.`
);
