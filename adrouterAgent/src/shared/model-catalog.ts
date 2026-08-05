import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { RouterCatalogStatus, RouterModelDescriptor } from './contracts';
import {
  ADROUTER_CATALOG_DIGEST,
  ADROUTER_CATALOG_SCHEMA_VERSION,
  BUNDLED_ADROUTER_MODELS,
} from './generated/adrouter-model-catalog';

const ThinkingLevelSchema = z.enum(['none', 'medium', 'high']);

const LiveModelSchema = z
  .object({
    id: z.string().trim().min(1).max(300),
    provider: z.string().trim().min(1).max(120),
    model_class: z.enum(['flash', 'pro']),
    display_name: z.string().trim().min(1).max(200),
    provider_label: z.string().trim().min(1).max(120),
    description: z.string().trim().min(1).max(1_000),
    thinking_levels: z.array(ThinkingLevelSchema).min(1).max(3),
    default_thinking_level: ThinkingLevelSchema,
    context_window: z.number().int().positive(),
    max_input_tokens: z.number().int().positive(),
    max_output_tokens: z.number().int().positive(),
    configured: z.boolean(),
  })
  .strict()
  .superRefine((model, context) => {
    if (new Set(model.thinking_levels).size !== model.thinking_levels.length) {
      context.addIssue({ code: 'custom', message: 'thinking_levels must be unique' });
    }
    if (!model.thinking_levels.includes(model.default_thinking_level)) {
      context.addIssue({ code: 'custom', message: 'default thinking level must be advertised' });
    }
    if (model.max_input_tokens + model.max_output_tokens > model.context_window) {
      context.addIssue({ code: 'custom', message: 'model token limits exceed the context window' });
    }
  });

const LiveModelsSchema = z
  .object({ models: z.array(LiveModelSchema).min(1).max(100) })
  .strict()
  .superRefine((catalog, context) => {
    const ids = catalog.models.map((model) => model.id);
    if (new Set(ids).size !== ids.length) {
      context.addIssue({ code: 'custom', message: 'model IDs must be unique' });
    }
  });

const sorted = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(sorted);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
      .map(([key, nested]) => [key, sorted(nested)])
  );
};

export const computeCatalogDigest = (payload: unknown): string =>
  `sha256:${createHash('sha256')
    .update(JSON.stringify(sorted(payload)), 'utf8')
    .digest('hex')}`;

const toDescriptor = (model: z.infer<typeof LiveModelSchema>): RouterModelDescriptor => ({
  id: model.id,
  provider: model.provider,
  modelClass: model.model_class,
  displayName: model.display_name,
  providerLabel: model.provider_label,
  description: model.description,
  thinkingLevels: [...model.thinking_levels],
  defaultThinkingLevel: model.default_thinking_level,
  contextWindow: model.context_window,
  maxInputTokens: model.max_input_tokens,
  maxOutputTokens: model.max_output_tokens,
  configured: model.configured,
});

const digestPayload = (models: z.infer<typeof LiveModelSchema>[]) => ({
  schema_version: ADROUTER_CATALOG_SCHEMA_VERSION,
  models: models.map(({ configured: _configured, ...model }) => model),
});

export class ModelCatalogError extends Error {
  public constructor(
    public readonly code: 'catalog_invalid' | 'catalog_incompatible',
    message: string
  ) {
    super(message);
    this.name = 'ModelCatalogError';
  }
}

export interface ValidatedLiveCatalog {
  schemaVersion: 1;
  digest: string;
  models: RouterModelDescriptor[];
}

export const validateLiveCatalog = (
  value: unknown,
  requireOfficialCatalog: boolean
): ValidatedLiveCatalog => {
  const parsed = LiveModelsSchema.safeParse(value);
  if (!parsed.success) {
    throw new ModelCatalogError('catalog_invalid', 'AdRouter returned an invalid model catalog.');
  }
  const digest = computeCatalogDigest(digestPayload(parsed.data.models));
  if (requireOfficialCatalog && digest !== ADROUTER_CATALOG_DIGEST) {
    throw new ModelCatalogError(
      'catalog_incompatible',
      'The hosted model catalog requires a newer compatible AdRouter Agent.'
    );
  }
  return {
    schemaVersion: ADROUTER_CATALOG_SCHEMA_VERSION,
    digest,
    models: parsed.data.models.map(toDescriptor),
  };
};

export const bundledCatalogModels = (): RouterModelDescriptor[] =>
  BUNDLED_ADROUTER_MODELS.map((model) => ({
    ...model,
    thinkingLevels: [...model.thinkingLevels],
  }));

export const bundledCatalogStatus = (): RouterCatalogStatus => ({
  schemaVersion: ADROUTER_CATALOG_SCHEMA_VERSION,
  digest: ADROUTER_CATALOG_DIGEST,
  source: 'bundled',
  freshness: 'bundled',
  compatibility: 'compatible',
  lastValidatedAt: null,
  lastAttemptAt: null,
  errorCode: null,
});

export const liveCatalogStatus = (
  catalog: Pick<ValidatedLiveCatalog, 'schemaVersion' | 'digest'>,
  checkedAt: string
): RouterCatalogStatus => ({
  schemaVersion: catalog.schemaVersion,
  digest: catalog.digest,
  source: 'live',
  freshness: 'fresh',
  compatibility: 'compatible',
  lastValidatedAt: checkedAt,
  lastAttemptAt: checkedAt,
  errorCode: null,
});

export const unavailableCatalogStatus = (
  checkedAt: string,
  errorCode: Exclude<RouterCatalogStatus['errorCode'], null>,
  incompatible = false
): RouterCatalogStatus => ({
  schemaVersion: null,
  digest: null,
  source: 'live',
  freshness: 'stale',
  compatibility: incompatible ? 'incompatible' : 'compatible',
  lastValidatedAt: null,
  lastAttemptAt: checkedAt,
  errorCode,
});

export { ADROUTER_CATALOG_DIGEST, ADROUTER_CATALOG_SCHEMA_VERSION };
