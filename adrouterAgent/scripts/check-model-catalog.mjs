import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { renderGeneratedCatalog, validateCatalog } from './model-catalog.mjs';

const catalogPath = resolve('src/shared/catalog/adrouter-model-catalog.v1.json');
const generatedPath = resolve('src/shared/generated/adrouter-model-catalog.ts');

const catalog = validateCatalog(JSON.parse(await readFile(catalogPath, 'utf8')));
const expected = renderGeneratedCatalog(catalog);
const actual = await readFile(generatedPath, 'utf8');

if (actual !== expected) {
  throw new Error(
    'Generated model metadata is stale. Update src/shared/generated/adrouter-model-catalog.ts from the canonical catalog.'
  );
}

console.log(`Verified AdRouter model catalog ${catalog.catalog_digest}.`);
