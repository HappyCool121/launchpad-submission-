import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const rootPath = fileURLToPath(root);
const required = [
  'README.md',
  'SUBMISSION.md',
  'PLAN.md',
  'NOTICE.md',
  'docs/ARCHITECTURE.md',
  'docs/DECISIONS.md',
  'docs/DEMO.md',
  'docs/RESULTS.md',
  'docs/SECURITY.md',
  'docs/SOURCE_SNAPSHOT.md',
  'router/README.md',
  'router/.env.example',
  'adrouterCLI/README.md',
  'adrouterCLI/.env.example',
  'adrouterAgent/README.md',
  'adrouterAgent/.env.example',
];

for (const path of required) {
  assert(existsSync(new URL(path, root)), `missing required submission file: ${path}`);
}

const ignoredDirectories = new Set([
  '.git',
  'node_modules',
  'dist',
  'out',
  '.vite',
  'coverage',
  'test-results',
  'playwright-report',
]);
const files = [];
const symlinks = [];
async function walk(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) symlinks.push(path);
    else if (entry.isDirectory()) await walk(path);
    else files.push(path);
  }
}
await walk(rootPath);
assert.deepEqual(symlinks, [], `symbolic links are forbidden: ${symlinks.join(', ')}`);

const relativeFiles = files.map((path) => relative(rootPath, path));
for (const path of relativeFiles) {
  assert(!path.includes('/.git/'), `nested Git metadata is forbidden: ${path}`);
  assert(!/(^|\/)\.env(\.|$)/.test(path) || path.endsWith('.env.example'), `private env file is forbidden: ${path}`);
  assert(!/(^|\/)\.protected(\/|$)/.test(path), `private release material is forbidden: ${path}`);
  assert(!/(^|\/)provenance(\/|$)/i.test(path), `release provenance is outside submission scope: ${path}`);
  assert(!/(^|\/)(AGENTS|RELEASE)\.md$/.test(path), `workspace/release instructions are outside submission scope: ${path}`);
  assert(!/release-manifest\.json$/i.test(path), `release manifest is outside submission scope: ${path}`);
}

const read = (path) => readFile(new URL(path, root), 'utf8');
const readme = await read('README.md');
const submission = await read('SUBMISSION.md');
const routerEnv = await read('router/.env.example');
const cliEnv = await read('adrouterCLI/.env.example');
const agentEnv = await read('adrouterAgent/.env.example');

assert.match(readme, /https:\/\/github\.com\/HappyCool121\/launchpad-submission-/);
for (const model of [
  'agnes-2.0-flash',
  'agnes-2.5-flash',
  'agnes-2.5-pro',
  'agnes-2.5-pro-alpha',
]) {
  assert.match(readme, new RegExp(`\\b${model.replaceAll('.', '\\.')}\\b`));
}
assert.match(routerEnv, /^AGNES_API_KEY=replace_/m);
assert.match(routerEnv, /^ADROUTER_API_KEY=replace_/m);
assert.doesNotMatch(cliEnv, /^AGNES_API_KEY=/m);
assert.doesNotMatch(agentEnv, /^AGNES_API_KEY=/m);

const writeup = submission.split('## Full write-up')[1]?.split('## Repository review guide')[0] ?? '';
const wordCount = (writeup.match(/[A-Za-z0-9][A-Za-z0-9'’-]*/g) ?? []).length;
assert(wordCount >= 700 && wordCount <= 1100, `submission write-up must be 700-1100 words; found ${wordCount}`);
assert.doesNotMatch(submission, /TO SUPPLY|VIDEO_ID|PLACEHOLDER/i);

for (const path of relativeFiles.filter((value) => /\.(?:md|json|mjs|ts|tsx|yaml|yml|example)$/.test(value))) {
  const content = (await read(path)).replaceAll(
    'ghp_abcdefghijklmnopqrstuvwxyz012345',
    '[known-redaction-test-fixture]'
  );
  assert.doesNotMatch(content, /\b(?:ghp_|github_pat_)[A-Za-z0-9_]{20,}/, `GitHub token-like value in ${path}`);
  assert.doesNotMatch(content, /\bAKIA[0-9A-Z]{16}\b/, `AWS key-like value in ${path}`);
  assert.doesNotMatch(content, /\bsk-[A-Za-z0-9_-]{24,}\b/, `provider key-like value in ${path}`);
}

console.log(`OK: ${required.length} required files, ${relativeFiles.length} source files, ${wordCount}-word write-up, and public boundary checks.`);
