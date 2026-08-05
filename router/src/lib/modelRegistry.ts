import { getProvider } from './providers/registry.js';
import type { ProviderId, RouterModelId, ThinkingLevel } from './types.js';

export type ModelClass = 'flash' | 'pro';
export type ModelAccess = 'owner_managed' | 'developer';

export interface StaticModelDescriptor {
  readonly id: RouterModelId;
  readonly provider: ProviderId;
  readonly model_class: ModelClass;
  readonly display_name: string;
  readonly provider_label: string;
  readonly description: string;
  readonly thinking_levels: readonly ThinkingLevel[];
  readonly default_thinking_level: ThinkingLevel;
  readonly context_window: number;
  readonly max_input_tokens: number;
  readonly max_output_tokens: number;
  readonly access: ModelAccess;
}

export type CatalogModelDescriptor = Omit<StaticModelDescriptor, 'access'>;

export interface ModelDescriptor extends CatalogModelDescriptor {
  thinking_levels: ThinkingLevel[];
  configured: boolean;
}

export interface TestModelRegistration {
  readonly id: RouterModelId;
  readonly provider: ProviderId;
  readonly thinking_levels: readonly ThinkingLevel[];
  readonly default_thinking_level: ThinkingLevel;
  readonly context_window: number;
  readonly max_input_tokens: number;
  readonly max_output_tokens: number;
}

export type ModelTokenLimits = Pick<StaticModelDescriptor, 'id' | 'context_window' | 'max_input_tokens' | 'max_output_tokens'>;

export const APPROVED_MODEL_LIMITS = {
  'deepseek-v4-flash': { context_window: 1_048_576, max_input_tokens: 917_504, max_output_tokens: 65_536 },
  'deepseek-v4-pro': { context_window: 1_048_576, max_input_tokens: 851_968, max_output_tokens: 131_072 },
  'mimo-v2.5': { context_window: 1_048_576, max_input_tokens: 917_504, max_output_tokens: 65_536 },
  'mimo-v2.5-pro': { context_window: 1_048_576, max_input_tokens: 851_968, max_output_tokens: 131_072 },
  'agnes-2.0-flash': { context_window: 524_288, max_input_tokens: 458_752, max_output_tokens: 65_536 },
  'agnes-2.5-flash': { context_window: 524_288, max_input_tokens: 458_752, max_output_tokens: 65_536 },
  'agnes-2.5-pro': { context_window: 1_048_576, max_input_tokens: 851_968, max_output_tokens: 131_072 },
  'agnes-2.5-pro-alpha': { context_window: 1_048_576, max_input_tokens: 786_432, max_output_tokens: 196_608 },
} as const satisfies Record<RouterModelId, Pick<StaticModelDescriptor, 'context_window' | 'max_input_tokens' | 'max_output_tokens'>>;

export const CANONICAL_MODEL_REGISTRY = [
  {
    id: 'deepseek-v4-flash',
    provider: 'deepseek',
    model_class: 'flash',
    display_name: 'DeepSeek V4 Flash',
    provider_label: 'DeepSeek',
    description: 'Fast DeepSeek coding model for interactive development.',
    thinking_levels: ['none', 'medium', 'high'],
    default_thinking_level: 'medium',
    ...APPROVED_MODEL_LIMITS['deepseek-v4-flash'],
    access: 'owner_managed',
  },
  {
    id: 'deepseek-v4-pro',
    provider: 'deepseek',
    model_class: 'pro',
    display_name: 'DeepSeek V4 Pro',
    provider_label: 'DeepSeek',
    description: 'DeepSeek coding model for complex development tasks.',
    thinking_levels: ['none', 'medium', 'high'],
    default_thinking_level: 'medium',
    ...APPROVED_MODEL_LIMITS['deepseek-v4-pro'],
    access: 'owner_managed',
  },
  {
    id: 'mimo-v2.5',
    provider: 'mimo',
    model_class: 'flash',
    display_name: 'MiMo V2.5 Flash',
    provider_label: 'MiMo',
    description: 'Fast MiMo coding model for interactive development.',
    thinking_levels: ['none', 'high'],
    default_thinking_level: 'high',
    ...APPROVED_MODEL_LIMITS['mimo-v2.5'],
    access: 'developer',
  },
  {
    id: 'mimo-v2.5-pro',
    provider: 'mimo',
    model_class: 'pro',
    display_name: 'MiMo V2.5 Pro',
    provider_label: 'MiMo',
    description: 'MiMo coding model for complex development tasks.',
    thinking_levels: ['none', 'high'],
    default_thinking_level: 'high',
    ...APPROVED_MODEL_LIMITS['mimo-v2.5-pro'],
    access: 'developer',
  },
  {
    id: 'agnes-2.0-flash',
    provider: 'agnes',
    model_class: 'flash',
    display_name: 'Agnes 2.0 Flash',
    provider_label: 'Agnes',
    description: 'Fast Agnes 2.0 coding model for interactive development.',
    thinking_levels: ['none', 'high'],
    default_thinking_level: 'none',
    ...APPROVED_MODEL_LIMITS['agnes-2.0-flash'],
    access: 'developer',
  },
  {
    id: 'agnes-2.5-flash',
    provider: 'agnes',
    model_class: 'flash',
    display_name: 'Agnes 2.5 Flash',
    provider_label: 'Agnes',
    description: 'Fast Agnes 2.5 coding model for interactive development.',
    thinking_levels: ['none', 'high'],
    default_thinking_level: 'none',
    ...APPROVED_MODEL_LIMITS['agnes-2.5-flash'],
    access: 'developer',
  },
  {
    id: 'agnes-2.5-pro',
    provider: 'agnes',
    model_class: 'pro',
    display_name: 'Agnes 2.5 Pro',
    provider_label: 'Agnes',
    description: 'Agnes 2.5 reasoning model for complex development tasks.',
    thinking_levels: ['high'],
    default_thinking_level: 'high',
    ...APPROVED_MODEL_LIMITS['agnes-2.5-pro'],
    access: 'developer',
  },
  {
    id: 'agnes-2.5-pro-alpha',
    provider: 'agnes',
    model_class: 'pro',
    display_name: 'Agnes 2.5 Pro Alpha',
    provider_label: 'Agnes',
    description: 'Alpha Agnes 2.5 reasoning model for complex development tasks.',
    thinking_levels: ['high'],
    default_thinking_level: 'high',
    ...APPROVED_MODEL_LIMITS['agnes-2.5-pro-alpha'],
    access: 'developer',
  },
] as const satisfies readonly StaticModelDescriptor[];

const ACTIVE_PROVIDERS = new Set<ProviderId>(['deepseek', 'mimo', 'agnes']);
const MODEL_CLASSES = new Set<ModelClass>(['flash', 'pro']);
const ACCESS_POLICIES = new Set<ModelAccess>(['owner_managed', 'developer']);
const THINKING_LEVELS = new Set<ThinkingLevel>(['none', 'medium', 'high']);

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function nonemptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function positiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

export function validateModelCatalog(value: unknown): asserts value is readonly StaticModelDescriptor[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error('invalid_model_catalog: expected a non-empty model array.');
  const ids = new Set<string>();
  for (const [index, candidate] of value.entries()) {
    const descriptor = record(candidate);
    if (!descriptor) throw new Error(`invalid_model_catalog: model at index ${index} must be an object.`);
    const id = descriptor.id;
    if (!nonemptyString(id)) throw new Error(`invalid_model_catalog: model at index ${index} has an invalid id.`);
    if (ids.has(id)) throw new Error(`invalid_model_catalog: duplicate model id ${id}.`);
    ids.add(id);
    if (!ACTIVE_PROVIDERS.has(descriptor.provider as ProviderId)) {
      throw new Error(`invalid_model_catalog: ${id} has an unsupported provider.`);
    }
    if (!MODEL_CLASSES.has(descriptor.model_class as ModelClass)) {
      throw new Error(`invalid_model_catalog: ${id} has an unsupported model_class.`);
    }
    if (!ACCESS_POLICIES.has(descriptor.access as ModelAccess)) {
      throw new Error(`invalid_model_catalog: ${id} has an unsupported access policy.`);
    }
    for (const field of ['display_name', 'provider_label', 'description'] as const) {
      if (!nonemptyString(descriptor[field])) throw new Error(`invalid_model_catalog: ${id} has an invalid ${field}.`);
    }
    if (!Array.isArray(descriptor.thinking_levels) || descriptor.thinking_levels.length === 0) {
      throw new Error(`invalid_model_catalog: ${id} must declare at least one thinking level.`);
    }
    const levels = new Set<ThinkingLevel>();
    for (const level of descriptor.thinking_levels) {
      if (!THINKING_LEVELS.has(level as ThinkingLevel)) {
        throw new Error(`invalid_model_catalog: ${id} has an unsupported thinking level.`);
      }
      if (levels.has(level as ThinkingLevel)) {
        throw new Error(`invalid_model_catalog: ${id} has a duplicate thinking level.`);
      }
      levels.add(level as ThinkingLevel);
    }
    if (!THINKING_LEVELS.has(descriptor.default_thinking_level as ThinkingLevel)
      || !levels.has(descriptor.default_thinking_level as ThinkingLevel)) {
      throw new Error(`invalid_model_catalog: ${id} has an invalid default thinking level.`);
    }
    if (!positiveInteger(descriptor.context_window)
      || !positiveInteger(descriptor.max_input_tokens)
      || !positiveInteger(descriptor.max_output_tokens)) {
      throw new Error(`invalid_model_catalog: ${id} token limits must be positive safe integers.`);
    }
    if (descriptor.max_input_tokens + descriptor.max_output_tokens > descriptor.context_window) {
      throw new Error(`invalid_model_catalog: ${id} input and output limits exceed its context window.`);
    }
    const expected = Object.prototype.hasOwnProperty.call(APPROVED_MODEL_LIMITS, id)
      ? APPROVED_MODEL_LIMITS[id as keyof typeof APPROVED_MODEL_LIMITS]
      : undefined;
    if (!expected) throw new Error(`invalid_model_catalog: ${id} is not an approved hosted model.`);
    for (const field of ['context_window', 'max_input_tokens', 'max_output_tokens'] as const) {
      if (descriptor[field] !== expected[field]) {
        throw new Error(`invalid_model_catalog: ${id} has an incorrect ${field}; expected ${expected[field]}.`);
      }
    }
  }
  for (const id of Object.keys(APPROVED_MODEL_LIMITS)) {
    if (!ids.has(id)) throw new Error(`invalid_model_catalog: missing approved model ${id}.`);
  }
}

validateModelCatalog(CANONICAL_MODEL_REGISTRY);

const canonicalById = new Map<RouterModelId, StaticModelDescriptor>(
  CANONICAL_MODEL_REGISTRY.map((descriptor) => [descriptor.id, descriptor]),
);
const testRegistrations = new Map<RouterModelId, TestModelRegistration>();

export const SUPPORTED_MODELS = CANONICAL_MODEL_REGISTRY.map((descriptor) => descriptor.id);
export const OWNER_MANAGED_MODELS = CANONICAL_MODEL_REGISTRY
  .filter((descriptor) => descriptor.access === 'owner_managed')
  .map((descriptor) => descriptor.id);
export const AUTOMATIC_DEVELOPER_MODELS = CANONICAL_MODEL_REGISTRY
  .filter((descriptor) => descriptor.access === 'developer')
  .map((descriptor) => descriptor.id);

function activeRegistry(): readonly StaticModelDescriptor[] {
  return process.env.LAUNCHPAD_SUBMISSION === 'true'
    ? CANONICAL_MODEL_REGISTRY.filter((descriptor) => descriptor.provider === 'agnes')
    : CANONICAL_MODEL_REGISTRY;
}

/** Test-only seam for provider-neutral coordinator coverage with synthetic models. */
export function registerModelForTests(registration: TestModelRegistration): void {
  if (!registration.id || !registration.thinking_levels.includes(registration.default_thinking_level)
    || !positiveInteger(registration.context_window) || !positiveInteger(registration.max_input_tokens)
    || !positiveInteger(registration.max_output_tokens)
    || registration.max_input_tokens + registration.max_output_tokens > registration.context_window) {
    throw new Error('invalid_test_model: registration must include thinking and valid explicit token limits.');
  }
  testRegistrations.set(registration.id, {
    ...registration,
    thinking_levels: [...registration.thinking_levels],
  });
}

function registrationForModel(model: RouterModelId): TestModelRegistration | undefined {
  return canonicalById.get(model) ?? testRegistrations.get(model);
}

export function listStaticModels(): CatalogModelDescriptor[] {
  return activeRegistry().map(({ access: _access, ...descriptor }) => ({
    ...descriptor,
    thinking_levels: [...descriptor.thinking_levels],
  }));
}

export function listModels(): ModelDescriptor[] {
  return listStaticModels().map((descriptor) => ({
    ...descriptor,
    thinking_levels: [...descriptor.thinking_levels],
    configured: getProvider(descriptor.provider)?.configured() ?? false,
  }));
}

export function authorizedModelsForAccount(input: { isDeveloper: boolean; flashEnabled: boolean; proEnabled: boolean }): RouterModelId[] {
  return activeRegistry().filter((descriptor) => descriptor.access === 'developer'
    ? input.isDeveloper
    : descriptor.model_class === 'flash' ? input.flashEnabled : input.proEnabled)
    .map((descriptor) => descriptor.id);
}

export function resolveModel(value: unknown): RouterModelId | undefined {
  if (typeof value !== 'string' || !registrationForModel(value)) return undefined;
  if (process.env.LAUNCHPAD_SUBMISSION === 'true' && providerForModel(value) !== 'agnes') return undefined;
  return value;
}

export function resolveThinkingLevel(value: unknown): ThinkingLevel {
  if (value === 'none' || value === 'high') return value;
  return 'medium';
}

export function descriptorForModel(model: RouterModelId): TestModelRegistration | undefined {
  return registrationForModel(model);
}

export function tokenLimitsForModel(model: RouterModelId): ModelTokenLimits | undefined {
  const descriptor = registrationForModel(model);
  return descriptor ? {
    id: descriptor.id,
    context_window: descriptor.context_window,
    max_input_tokens: descriptor.max_input_tokens,
    max_output_tokens: descriptor.max_output_tokens,
  } : undefined;
}

export function resolveThinkingForModel(
  model: RouterModelId,
  value: unknown,
  legacyEffort?: unknown,
): ThinkingLevel {
  const descriptor = descriptorForModel(model);
  if (!descriptor) throw new Error(`invalid_model: ${model} is not a registered runnable model.`);
  if (legacyEffort !== undefined) {
    if (descriptor.provider !== 'deepseek') {
      throw new Error(`unsupported_thinking_level: reasoning_effort is not supported by ${model}; use thinking_level.`);
    }
    if (legacyEffort !== 'low' && legacyEffort !== 'medium' && legacyEffort !== 'high') {
      throw new Error('unsupported_thinking_level: reasoning_effort must be low, medium, or high.');
    }
    const mapped = legacyEffort === 'high' ? 'high' : 'medium';
    if (descriptor.thinking_levels.includes(mapped)) return mapped;
  }
  const level = value === undefined ? descriptor.default_thinking_level : value;
  if ((level === 'none' || level === 'medium' || level === 'high') && descriptor.thinking_levels.includes(level)) return level;
  throw new Error(`unsupported_thinking_level: ${model} supports ${descriptor.thinking_levels.join(', ')}.`);
}

export function providerForModel(model: RouterModelId): ProviderId | undefined {
  return registrationForModel(model)?.provider;
}

export function defaultModel(): RouterModelId {
  return process.env.LAUNCHPAD_SUBMISSION === 'true' ? 'agnes-2.5-flash' : 'deepseek-v4-flash';
}
