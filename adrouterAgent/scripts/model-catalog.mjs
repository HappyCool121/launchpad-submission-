import { createHash } from 'node:crypto';

export const EXPECTED_MODEL_IDS = [
  'deepseek-v4-flash',
  'deepseek-v4-pro',
  'mimo-v2.5',
  'mimo-v2.5-pro',
  'agnes-2.0-flash',
  'agnes-2.5-flash',
  'agnes-2.5-pro',
  'agnes-2.5-pro-alpha',
];

const EXPECTED_MODES = {
  'deepseek-v4-flash': [['none', 'medium', 'high'], 'medium', 'deepseek', 'flash'],
  'deepseek-v4-pro': [['none', 'medium', 'high'], 'medium', 'deepseek', 'pro'],
  'mimo-v2.5': [['none', 'high'], 'high', 'mimo', 'flash'],
  'mimo-v2.5-pro': [['none', 'high'], 'high', 'mimo', 'pro'],
  'agnes-2.0-flash': [['none', 'high'], 'none', 'agnes', 'flash'],
  'agnes-2.5-flash': [['none', 'high'], 'none', 'agnes', 'flash'],
  'agnes-2.5-pro': [['high'], 'high', 'agnes', 'pro'],
  'agnes-2.5-pro-alpha': [['high'], 'high', 'agnes', 'pro'],
};

const EXPECTED_LIMITS = {
  'deepseek-v4-flash': [1_048_576, 917_504, 65_536],
  'deepseek-v4-pro': [1_048_576, 851_968, 131_072],
  'mimo-v2.5': [1_048_576, 917_504, 65_536],
  'mimo-v2.5-pro': [1_048_576, 851_968, 131_072],
  'agnes-2.0-flash': [524_288, 458_752, 65_536],
  'agnes-2.5-flash': [524_288, 458_752, 65_536],
  'agnes-2.5-pro': [1_048_576, 851_968, 131_072],
  'agnes-2.5-pro-alpha': [1_048_576, 786_432, 196_608],
};

const TOP_LEVEL_KEYS = ['catalog_digest', 'models', 'schema_version'];
const MODEL_KEYS = [
  'context_window',
  'default_thinking_level',
  'description',
  'display_name',
  'id',
  'max_input_tokens',
  'max_output_tokens',
  'model_class',
  'provider',
  'provider_label',
  'thinking_levels',
];

const fail = (message) => {
  throw new Error(`invalid_adrouter_catalog: ${message}`);
};

const record = (value, label) => {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    fail(`${label} must be an object`);
  return value;
};

const exactKeys = (value, keys, label) => {
  const actual = Object.keys(value).sort();
  if (actual.length !== keys.length || actual.some((key, index) => key !== keys[index])) {
    fail(`${label} keys must be exactly ${keys.join(', ')}`);
  }
};

const sorted = (value) => {
  if (Array.isArray(value)) return value.map(sorted);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, sorted(nested)])
  );
};

export const computeCatalogDigest = (payload) =>
  `sha256:${createHash('sha256')
    .update(JSON.stringify(sorted(payload)), 'utf8')
    .digest('hex')}`;

export const validateCatalog = (input) => {
  const catalog = record(input, 'catalog');
  exactKeys(catalog, TOP_LEVEL_KEYS, 'catalog');
  if (catalog.schema_version !== 1) fail('schema_version must equal 1');
  if (!Array.isArray(catalog.models) || catalog.models.length !== EXPECTED_MODEL_IDS.length) {
    fail(`models must contain exactly ${EXPECTED_MODEL_IDS.length} entries`);
  }
  for (let index = 0; index < EXPECTED_MODEL_IDS.length; index += 1) {
    const id = EXPECTED_MODEL_IDS[index];
    const model = record(catalog.models[index], `models[${index}]`);
    exactKeys(model, MODEL_KEYS, `models[${index}]`);
    const expected = EXPECTED_MODES[id];
    if (model.id !== id) fail(`models[${index}].id must equal ${id}`);
    if (model.provider !== expected[2]) fail(`${id}.provider must equal ${expected[2]}`);
    if (model.model_class !== expected[3]) fail(`${id}.model_class must equal ${expected[3]}`);
    for (const field of ['display_name', 'provider_label', 'description']) {
      if (
        typeof model[field] !== 'string' ||
        !model[field] ||
        model[field].trim() !== model[field]
      ) {
        fail(`${id}.${field} must be a non-empty trimmed string`);
      }
    }
    if (JSON.stringify(model.thinking_levels) !== JSON.stringify(expected[0])) {
      fail(`${id}.thinking_levels do not match the hosted contract`);
    }
    if (model.default_thinking_level !== expected[1]) {
      fail(`${id}.default_thinking_level does not match the hosted contract`);
    }
    const limits = EXPECTED_LIMITS[id];
    for (const [field, limit] of [
      ['context_window', limits[0]],
      ['max_input_tokens', limits[1]],
      ['max_output_tokens', limits[2]],
    ]) {
      if (model[field] !== limit) fail(`${id}.${field} must equal ${limit}`);
    }
  }
  const digest = computeCatalogDigest({ schema_version: 1, models: catalog.models });
  if (catalog.catalog_digest !== digest) fail(`catalog_digest mismatch; expected ${digest}`);
  return catalog;
};

const quote = (value) =>
  `'${value
    .replaceAll('\\', '\\\\')
    .replaceAll("'", "\\'")
    .replaceAll('\n', '\\n')
    .replaceAll('\r', '\\r')}'`;

const stringArray = (values) => `[${values.map(quote).join(', ')}]`;

export const renderGeneratedCatalog = (catalog) => {
  validateCatalog(catalog);
  const models = catalog.models
    .map(
      (model) => `  {
    id: ${quote(model.id)},
    provider: ${quote(model.provider)},
    modelClass: ${quote(model.model_class)},
    displayName: ${quote(model.display_name)},
    providerLabel: ${quote(model.provider_label)},
    description: ${quote(model.description)},
    thinkingLevels: ${stringArray(model.thinking_levels)},
    defaultThinkingLevel: ${quote(model.default_thinking_level)},
    contextWindow: ${model.context_window.toLocaleString('en-US').replace(/,/g, '_')},
    maxInputTokens: ${model.max_input_tokens.toLocaleString('en-US').replace(/,/g, '_')},
    maxOutputTokens: ${model.max_output_tokens.toLocaleString('en-US').replace(/,/g, '_')},
    configured: false,
  },`
    )
    .join('\n');
  return `// Generated from src/shared/catalog/adrouter-model-catalog.v1.json.
// Do not edit manually; update the canonical artifact and run the catalog check.

import type { RouterModelDescriptor } from '../contracts';

export const ADROUTER_CATALOG_SCHEMA_VERSION = ${catalog.schema_version} as const;
export const ADROUTER_CATALOG_DIGEST =
  ${quote(catalog.catalog_digest)} as const;

export const BUNDLED_ADROUTER_MODELS: readonly RouterModelDescriptor[] = [
${models}
] as const;
`;
};
