import assert from 'node:assert/strict';
import { cpSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const piNestedRoot = resolve(
  root,
  'node_modules',
  '@earendil-works',
  'pi-coding-agent',
  'node_modules'
);
const replacements = [
  {
    name: 'brace-expansion',
    sourceName: 'adrouter-brace-expansion-patch',
    version: '5.0.8',
  },
  {
    name: 'protobufjs',
    sourceName: 'adrouter-protobufjs-patch',
    version: '7.6.5',
  },
];

for (const replacement of replacements) {
  const source = resolve(root, 'node_modules', replacement.sourceName);
  const destination = resolve(piNestedRoot, replacement.name);
  const installed = JSON.parse(readFileSync(resolve(source, 'package.json'), 'utf8'));
  assert.equal(
    installed.version,
    replacement.version,
    `${replacement.name} root resolution must be ${replacement.version}`
  );
  rmSync(destination, { recursive: true, force: true });
  cpSync(source, destination, { recursive: true });
  const physical = JSON.parse(readFileSync(resolve(destination, 'package.json'), 'utf8'));
  assert.equal(physical.version, replacement.version);
}

const crossZipRoot = resolve(root, 'node_modules', 'cross-zip');
const crossZipPackage = JSON.parse(readFileSync(resolve(crossZipRoot, 'package.json'), 'utf8'));
assert.equal(crossZipPackage.version, '4.0.1', 'cross-zip compatibility patch version changed');
const crossZipPath = resolve(crossZipRoot, 'index.js');
let crossZipSource = readFileSync(crossZipPath, 'utf8');
for (const [before, after] of [
  [
    'fs.rmdir(outPath, { recursive: true, maxRetries: 3 }, doZip2)',
    'fs.rm(outPath, { recursive: true, force: true, maxRetries: 3 }, doZip2)',
  ],
  [
    'fs.rmdirSync(outPath, { recursive: true, maxRetries: 3 })',
    'fs.rmSync(outPath, { recursive: true, force: true, maxRetries: 3 })',
  ],
]) {
  assert.ok(
    crossZipSource.includes(before) || crossZipSource.includes(after),
    `cross-zip source no longer contains the reviewed compatibility target: ${before}`
  );
  crossZipSource = crossZipSource.replace(before, after);
}
writeFileSync(crossZipPath, crossZipSource);

console.log(
  'Applied two audited dependency overrides and the reviewed cross-zip Node 25 compatibility patch.'
);
