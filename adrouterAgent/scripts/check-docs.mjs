import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const documents = [
  'README.md',
  'CHANGELOG.md',
  'CONTRIBUTING.md',
  'SUPPORT.md',
  'SECURITY.md',
  'PRIVACY.md',
  'RELEASE.md',
  'SOURCE_PROVENANCE.md',
];
for (const document of documents)
  assert.ok(existsSync(document), `missing public document ${document}`);

for (const document of documents) {
  const text = readFileSync(document, 'utf8');
  for (const match of text.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
    const target = match[1].split('#')[0];
    if (!target || /^(?:https?:|mailto:)/.test(target)) continue;
    assert.ok(
      existsSync(resolve(dirname(document), target)),
      `${document} has broken link ${target}`
    );
  }
}

console.log(`Documentation checks passed for ${documents.length} public documents.`);
