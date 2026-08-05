import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import express from 'express';
import {
  AUTOMATIC_DEVELOPER_MODELS,
  APPROVED_MODEL_LIMITS,
  CANONICAL_MODEL_REGISTRY,
  OWNER_MANAGED_MODELS,
  SUPPORTED_MODELS,
  authorizedModelsForAccount,
  listModels,
  listStaticModels,
  validateModelCatalog,
} from '../src/lib/modelRegistry.js';
import { MODEL_PRICING } from '../src/lib/pricing.js';
import { getProvider, providerRegistry } from '../src/lib/providers/registry.js';
import { providerRouter } from '../src/routes/provider.js';

const EXPECTED_IDS = [
  'deepseek-v4-flash',
  'deepseek-v4-pro',
  'mimo-v2.5',
  'mimo-v2.5-pro',
  'agnes-2.0-flash',
  'agnes-2.5-flash',
  'agnes-2.5-pro',
  'agnes-2.5-pro-alpha',
];
const EXPECTED_PRODUCT_METADATA = [
  ['deepseek-v4-flash', 'deepseek', 'flash', 'DeepSeek V4 Flash', 'DeepSeek', 'Fast DeepSeek coding model for interactive development.', ['none', 'medium', 'high'], 'medium'],
  ['deepseek-v4-pro', 'deepseek', 'pro', 'DeepSeek V4 Pro', 'DeepSeek', 'DeepSeek coding model for complex development tasks.', ['none', 'medium', 'high'], 'medium'],
  ['mimo-v2.5', 'mimo', 'flash', 'MiMo V2.5 Flash', 'MiMo', 'Fast MiMo coding model for interactive development.', ['none', 'high'], 'high'],
  ['mimo-v2.5-pro', 'mimo', 'pro', 'MiMo V2.5 Pro', 'MiMo', 'MiMo coding model for complex development tasks.', ['none', 'high'], 'high'],
  ['agnes-2.0-flash', 'agnes', 'flash', 'Agnes 2.0 Flash', 'Agnes', 'Fast Agnes 2.0 coding model for interactive development.', ['none', 'high'], 'none'],
  ['agnes-2.5-flash', 'agnes', 'flash', 'Agnes 2.5 Flash', 'Agnes', 'Fast Agnes 2.5 coding model for interactive development.', ['none', 'high'], 'none'],
  ['agnes-2.5-pro', 'agnes', 'pro', 'Agnes 2.5 Pro', 'Agnes', 'Agnes 2.5 reasoning model for complex development tasks.', ['high'], 'high'],
  ['agnes-2.5-pro-alpha', 'agnes', 'pro', 'Agnes 2.5 Pro Alpha', 'Agnes', 'Alpha Agnes 2.5 reasoning model for complex development tasks.', ['high'], 'high'],
];

function sortObjectKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortObjectKeys);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, nested]) => [key, sortObjectKeys(nested)]),
  );
}

function expectInvalidCatalog(mutate: (models: Record<string, unknown>[]) => void): void {
  const models = structuredClone(CANONICAL_MODEL_REGISTRY) as unknown as Record<string, unknown>[];
  mutate(models);
  assert.throws(() => validateModelCatalog(models), /invalid_model_catalog/);
}

assert.deepEqual(SUPPORTED_MODELS, EXPECTED_IDS);
assert.deepEqual(CANONICAL_MODEL_REGISTRY.map(({ id, context_window, max_input_tokens, max_output_tokens }) => [id, context_window, max_input_tokens, max_output_tokens]), [
  ['deepseek-v4-flash', 1_048_576, 917_504, 65_536],
  ['deepseek-v4-pro', 1_048_576, 851_968, 131_072],
  ['mimo-v2.5', 1_048_576, 917_504, 65_536],
  ['mimo-v2.5-pro', 1_048_576, 851_968, 131_072],
  ['agnes-2.0-flash', 524_288, 458_752, 65_536],
  ['agnes-2.5-flash', 524_288, 458_752, 65_536],
  ['agnes-2.5-pro', 1_048_576, 851_968, 131_072],
  ['agnes-2.5-pro-alpha', 1_048_576, 786_432, 196_608],
]);
assert.deepEqual(Object.keys(APPROVED_MODEL_LIMITS), EXPECTED_IDS);
assert.deepEqual(listStaticModels().map((descriptor) => [
  descriptor.id,
  descriptor.provider,
  descriptor.model_class,
  descriptor.display_name,
  descriptor.provider_label,
  descriptor.description,
  descriptor.thinking_levels,
  descriptor.default_thinking_level,
]), EXPECTED_PRODUCT_METADATA);
assert.deepEqual(OWNER_MANAGED_MODELS, EXPECTED_IDS.slice(0, 2));
assert.deepEqual(AUTOMATIC_DEVELOPER_MODELS, EXPECTED_IDS.slice(2));
assert.deepEqual(authorizedModelsForAccount({ isDeveloper: true, flashEnabled: true, proEnabled: false }), [
  'deepseek-v4-flash', ...EXPECTED_IDS.slice(2),
]);
assert.deepEqual(authorizedModelsForAccount({ isDeveloper: false, flashEnabled: false, proEnabled: true }), [
  'deepseek-v4-pro',
]);

expectInvalidCatalog((models) => models.push({ ...models[0] }));
expectInvalidCatalog((models) => { delete models[0]!.description; });
expectInvalidCatalog((models) => { models[0]!.provider = 'qwen'; });
expectInvalidCatalog((models) => { models[0]!.model_class = 'frontier'; });
expectInvalidCatalog((models) => { models[0]!.access = 'public'; });
expectInvalidCatalog((models) => { models[0]!.display_name = ' '; });
expectInvalidCatalog((models) => { models[0]!.thinking_levels = ['none', 'none']; });
expectInvalidCatalog((models) => { models[0]!.default_thinking_level = 'low'; });
expectInvalidCatalog((models) => { models[0]!.max_output_tokens = 8_192; });
expectInvalidCatalog((models) => { models[0]!.max_output_tokens = models[1]!.max_output_tokens; });
expectInvalidCatalog((models) => { models[0]!.max_input_tokens = 0; });
expectInvalidCatalog((models) => { models[0]!.context_window = 1.5; });
expectInvalidCatalog((models) => { models.pop(); });
expectInvalidCatalog((models) => { models[0]!.id = 'unapproved-model'; });

const catalog = JSON.parse(await readFile(new URL('../catalog/model-catalog.v1.json', import.meta.url), 'utf8')) as {
  schema_version: number;
  catalog_digest: string;
  models: Record<string, unknown>[];
};
assert.equal(catalog.schema_version, 1);
assert.deepEqual(catalog.models, listStaticModels());
assert(catalog.models.every((model) => !Object.hasOwn(model, 'configured') && !Object.hasOwn(model, 'access')));
const digestPayload = { schema_version: catalog.schema_version, models: catalog.models };
const expectedDigest = `sha256:${createHash('sha256')
  .update(JSON.stringify(sortObjectKeys(digestPayload)), 'utf8')
  .digest('hex')}`;
assert.equal(catalog.catalog_digest, expectedDigest);
assert.match(catalog.catalog_digest, /^sha256:[0-9a-f]{64}$/);

for (const providerId of ['deepseek', 'mimo', 'agnes'] as const) {
  assert.equal(providerRegistry.filter((provider) => provider.id === providerId).length, 1, `${providerId} must have one adapter`);
  assert(getProvider(providerId), `${providerId} adapter is unavailable`);
}
for (const descriptor of CANONICAL_MODEL_REGISTRY) {
  assert(Object.hasOwn(MODEL_PRICING, descriptor.id), `${descriptor.id} is missing pricing`);
}
for (const adapter of providerRegistry) {
  assert.equal('models' in adapter, false, `${adapter.id} must not own product catalog metadata`);
  assert.equal('supports' in adapter, false, `${adapter.id} must not own a model support set`);
}
for (const file of ['deepseek.ts', 'mimo.ts', 'agnes.ts', 'openai-compatible.ts']) {
  const source = await readFile(new URL(`../src/lib/providers/${file}`, import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\bmodels\s*:/, `${file} must not declare a model catalog`);
  assert.doesNotMatch(source, /\bsupports\s*:/, `${file} must not declare a model support set`);
}

const runtimeModels = listModels();
assert.deepEqual(runtimeModels.map(({ configured: _configured, ...model }) => model), listStaticModels());
for (const descriptor of runtimeModels) {
  assert.equal(descriptor.configured, getProvider(descriptor.provider)?.configured() ?? false);
}

const app = express();
app.use('/v1', providerRouter);
const server = app.listen(0, '127.0.0.1');
await once(server, 'listening');
try {
  const address = server.address() as AddressInfo;
  const response = await fetch(`http://127.0.0.1:${address.port}/v1/models`);
  assert.equal(response.ok, true);
  assert.deepEqual(await response.json(), { models: runtimeModels });
} finally {
  server.close();
  await once(server, 'close');
}

console.log(`OK: canonical eight-model registry, artifact digest ${catalog.catalog_digest}, access, pricing, and adapter coverage.`);
