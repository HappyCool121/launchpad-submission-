import { describe, expect, it } from 'vitest';
import catalog from '@/shared/catalog/adrouter-model-catalog.v1.json';
import {
  ADROUTER_CATALOG_DIGEST,
  bundledCatalogModels,
  type ModelCatalogError,
  validateLiveCatalog,
} from '@/shared/model-catalog';

const livePayload = (): unknown => ({
  models: catalog.models.map((model) => ({ ...model, configured: true })),
});

const expectCatalogError = (operation: () => unknown, code: ModelCatalogError['code']): void => {
  try {
    operation();
  } catch (error) {
    expect(error).toMatchObject({ code });
    return;
  }

  throw new Error(`Expected ${code}`);
};

describe('canonical AdRouter model catalog', () => {
  it('matches the exact ordered eight-model hosted contract', () => {
    const validated = validateLiveCatalog(livePayload(), true);

    expect(validated.digest).toBe(ADROUTER_CATALOG_DIGEST);
    expect(validated.models.map((model) => model.id)).toEqual([
      'deepseek-v4-flash',
      'deepseek-v4-pro',
      'mimo-v2.5',
      'mimo-v2.5-pro',
      'agnes-2.0-flash',
      'agnes-2.5-flash',
      'agnes-2.5-pro',
      'agnes-2.5-pro-alpha',
    ]);
    expect(bundledCatalogModels()).toEqual(
      validated.models.map((model) => ({ ...model, configured: false }))
    );
  });

  it('rejects hosted catalog drift instead of inferring compatibility', () => {
    const payload = livePayload() as { models: Array<Record<string, unknown>> };
    payload.models[0] = { ...payload.models[0], description: 'Changed after packaging.' };

    expectCatalogError(() => validateLiveCatalog(payload, true), 'catalog_incompatible');
  });

  it('requires every descriptor field and rejects unknown keys', () => {
    const missing = livePayload() as { models: Array<Record<string, unknown>> };
    delete missing.models[0]?.max_output_tokens;
    expectCatalogError(() => validateLiveCatalog(missing, false), 'catalog_invalid');

    const extra = livePayload() as { models: Array<Record<string, unknown>> };
    extra.models[0] = { ...extra.models[0], inferred_reasoning: true };
    expectCatalogError(() => validateLiveCatalog(extra, false), 'catalog_invalid');
  });

  it('allows a strict server-scoped custom catalog without hosted ID inference', () => {
    const payload = livePayload() as { models: Array<Record<string, unknown>> };
    payload.models = [{ ...payload.models[0], id: 'custom-flash' }];

    const validated = validateLiveCatalog(payload, false);
    expect(validated.models).toHaveLength(1);
    expect(validated.models[0]).toMatchObject({
      id: 'custom-flash',
      contextWindow: 1_048_576,
      maxInputTokens: 917_504,
      maxOutputTokens: 65_536,
    });
    expect(validated.digest).not.toBe(ADROUTER_CATALOG_DIGEST);
  });
});
