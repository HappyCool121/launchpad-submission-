import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { listStaticModels } from '../src/lib/modelRegistry.js';

const SCHEMA_VERSION = 1;
const catalogDirectory = new URL('../catalog/', import.meta.url);
const catalogUrl = new URL('model-catalog.v1.json', catalogDirectory);

function sortObjectKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortObjectKeys);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, nested]) => [key, sortObjectKeys(nested)]),
  );
}

function digest(payload: unknown): string {
  const canonicalJson = JSON.stringify(sortObjectKeys(payload));
  return `sha256:${createHash('sha256').update(canonicalJson, 'utf8').digest('hex')}`;
}

function generatedCatalog(): string {
  const models = listStaticModels();
  const payload = { schema_version: SCHEMA_VERSION, models };
  return `${JSON.stringify({
    schema_version: SCHEMA_VERSION,
    catalog_digest: digest(payload),
    models,
  }, null, 2)}\n`;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.some((argument) => argument !== '--check') || args.length > 1) {
    throw new Error('Usage: tsx scripts/export-model-catalog.ts [--check]');
  }
  const generated = generatedCatalog();
  if (args[0] === '--check') {
    let current: string;
    try {
      current = await readFile(catalogUrl, 'utf8');
    } catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : 'unknown';
      throw new Error(`model catalog is unavailable (${code}); run npm run catalog:generate.`);
    }
    if (current !== generated) throw new Error('model catalog is stale; run npm run catalog:generate.');
    console.log('OK: model-catalog.v1.json is current and byte-stable.');
    return;
  }
  await mkdir(catalogDirectory, { recursive: true });
  await writeFile(catalogUrl, generated, 'utf8');
  console.log('Generated catalog/model-catalog.v1.json.');
}

await main();
