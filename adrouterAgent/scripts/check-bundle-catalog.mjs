import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const catalog = JSON.parse(readFileSync('src/shared/bundles/catalog.v1.json', 'utf8'));
const digest = (value) => createHash('sha256').update(value).digest('hex');
const canonicalize = (value) =>
  Array.isArray(value)
    ? value.map(canonicalize)
    : value && typeof value === 'object'
      ? Object.fromEntries(
          Object.entries(value)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([key, nested]) => [key, canonicalize(nested)])
        )
      : value;

assert.equal(catalog.schemaVersion, 1, 'bundle catalog schema changed');
assert.ok(Array.isArray(catalog.bundles) && catalog.bundles.length > 0);
const ids = new Set();
for (const bundle of catalog.bundles) {
  const { manifest, entries } = bundle;
  assert.ok(!ids.has(manifest.id), `duplicate bundle ${manifest.id}`);
  ids.add(manifest.id);
  assert.equal(entries.length, manifest.entries.length, `${manifest.id} entry count changed`);
  entries.forEach((entry, index) => {
    assert.match(entry.path, /^[a-z0-9][a-z0-9._/-]*\.md$/);
    assert.ok(!entry.path.includes('..') && !entry.path.includes('\\'));
    assert.equal(digest(entry.content), entry.digest, `${entry.path} digest changed`);
    const { content: _content, ...metadata } = entry;
    assert.deepEqual(metadata, manifest.entries[index], `${entry.path} metadata changed`);
  });
  const { aggregateDigest, ...unsigned } = manifest;
  assert.equal(
    digest(JSON.stringify(canonicalize(unsigned))),
    aggregateDigest,
    `${manifest.id} aggregate digest changed`
  );
}

console.log(`Validated ${catalog.bundles.length} exact declarative bundle(s).`);
