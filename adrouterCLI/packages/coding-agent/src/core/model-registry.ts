/**
 * Model registry for the locked AdRouter runtime and explicit mutable SDK/test registries.
 */

import { ADROUTER_MODELS } from "@adrouter/ai";
import {
	type Api,
	type AssistantMessageEventStream,
	type Context,
	getModels,
	getProviders,
	type KnownProvider,
	type Model,
	type OAuthProviderInterface,
	registerApiProvider,
	resetApiProviders,
	type SimpleStreamOptions,
} from "@adrouter/ai/compat";
import { registerOAuthProvider, resetOAuthProviders } from "@adrouter/ai/oauth";
import type { AuthStatus, AuthStorage } from "./auth-storage.ts";
import { BUILT_IN_PROVIDER_DISPLAY_NAMES } from "./provider-display-names.ts";
import {
	clearConfigValueCache,
	isConfigValueConfigured,
	resolveConfigValueOrThrow,
	resolveConfigValueUncached,
	resolveHeadersOrThrow,
} from "./resolve-config-value.ts";

interface ProviderRequestConfig {
	apiKey?: string;
	headers?: Record<string, string>;
	authHeader?: boolean;
}

export type ResolvedRequestAuth =
	| {
			ok: true;
			apiKey?: string;
			headers?: Record<string, string>;
			env?: Record<string, string>;
	  }
	| {
			ok: false;
			error: string;
	  };

export interface ProviderModelConfig {
	id: string;
	name: string;
	api?: Api;
	baseUrl?: string;
	reasoning: boolean;
	thinkingLevelMap?: Model<Api>["thinkingLevelMap"];
	input: ("text" | "image")[];
	cost: Model<Api>["cost"];
	contextWindow: number;
	maxTokens: number;
	headers?: Record<string, string>;
	compat?: Model<Api>["compat"];
}

/** Configuration accepted by an explicitly mutable in-memory registry. */
export interface ProviderConfig {
	name?: string;
	baseUrl?: string;
	apiKey?: string;
	api?: Api;
	streamSimple?: (model: Model<Api>, context: Context, options?: SimpleStreamOptions) => AssistantMessageEventStream;
	headers?: Record<string, string>;
	authHeader?: boolean;
	compat?: Model<Api>["compat"];
	oauth?: Omit<OAuthProviderInterface, "id">;
	models?: ProviderModelConfig[];
}

/** @deprecated Use ProviderConfig. */
export type ProviderConfigInput = ProviderConfig;

export class ModelRegistryLockedError extends Error {
	readonly code = "model_registry_locked" as const;

	constructor() {
		super("The official AdRouter model registry is locked. Use ModelRegistry.inMemory() for SDK/test providers.");
		this.name = "ModelRegistryLockedError";
	}
}

function cloneModel(model: Model<Api>): Model<Api> {
	return {
		...model,
		input: [...model.input],
		cost: {
			...model.cost,
			tiers: model.cost.tiers?.map((tier) => ({ ...tier })),
		},
		thinkingLevelMap: model.thinkingLevelMap ? { ...model.thinkingLevelMap } : undefined,
		headers: model.headers ? { ...model.headers } : undefined,
		compat: model.compat ? structuredClone(model.compat) : undefined,
	};
}

function deepFreeze<T>(value: T): T {
	if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
	for (const nested of Object.values(value)) deepFreeze(nested);
	return Object.freeze(value);
}

const OFFICIAL_MODELS = Object.freeze(
	Object.values(ADROUTER_MODELS).map((model) => deepFreeze(cloneModel(model as Model<Api>))),
);

/** Clear the config value command cache. Exported for testing. */
export const clearApiKeyCache = clearConfigValueCache;

export class ModelRegistry {
	private models: Model<Api>[];
	private readonly locked: boolean;
	private providerRequestConfigs = new Map<string, ProviderRequestConfig>();
	private modelRequestHeaders = new Map<string, Record<string, string>>();
	private registeredProviders = new Map<string, ProviderConfig>();
	readonly authStorage: AuthStorage;

	private constructor(authStorage: AuthStorage, locked: boolean) {
		this.authStorage = authStorage;
		this.locked = locked;
		this.models = locked ? [...OFFICIAL_MODELS] : this.loadBuiltInModels();
	}

	/** Create the immutable official registry containing exactly the generated AdRouter catalog. */
	static create(authStorage: AuthStorage): ModelRegistry {
		return new ModelRegistry(authStorage, true);
	}

	/** Create the explicit mutable registry used by SDK callers and test harnesses. */
	static inMemory(authStorage: AuthStorage): ModelRegistry {
		return new ModelRegistry(authStorage, false);
	}

	isLocked(): boolean {
		return this.locked;
	}

	refresh(): void {
		if (this.locked) return;
		this.providerRequestConfigs.clear();
		this.modelRequestHeaders.clear();
		resetApiProviders();
		resetOAuthProviders();
		this.models = this.loadBuiltInModels();
		for (const [providerName, config] of this.registeredProviders) {
			this.applyProviderConfig(providerName, config);
		}
	}

	private loadBuiltInModels(): Model<Api>[] {
		let models = getProviders().flatMap((provider) =>
			(getModels(provider as KnownProvider) as Model<Api>[]).map(cloneModel),
		);
		for (const oauthProvider of this.authStorage.getOAuthProviders()) {
			const credential = this.authStorage.get(oauthProvider.id);
			if (credential?.type === "oauth" && oauthProvider.modifyModels) {
				models = oauthProvider.modifyModels(models, credential);
			}
		}
		return models;
	}

	getAll(): Model<Api>[] {
		return [...this.models];
	}

	getAvailable(): Model<Api>[] {
		return this.models.filter((model) => this.hasConfiguredAuth(model));
	}

	find(provider: string, modelId: string): Model<Api> | undefined {
		return this.models.find((model) => model.provider === provider && model.id === modelId);
	}

	hasConfiguredAuth(model: Model<Api>): boolean {
		const providerApiKey = this.providerRequestConfigs.get(model.provider)?.apiKey;
		return (
			this.authStorage.hasAuth(model.provider) ||
			(providerApiKey !== undefined && isConfigValueConfigured(providerApiKey))
		);
	}

	private getModelRequestKey(provider: string, modelId: string): string {
		return `${provider}:${modelId}`;
	}

	private storeProviderRequestConfig(providerName: string, config: ProviderRequestConfig): void {
		if (!config.apiKey && !config.headers && !config.authHeader) return;
		this.providerRequestConfigs.set(providerName, {
			apiKey: config.apiKey,
			headers: config.headers,
			authHeader: config.authHeader,
		});
	}

	private storeModelHeaders(providerName: string, modelId: string, headers?: Record<string, string>): void {
		const key = this.getModelRequestKey(providerName, modelId);
		if (!headers || Object.keys(headers).length === 0) {
			this.modelRequestHeaders.delete(key);
			return;
		}
		this.modelRequestHeaders.set(key, headers);
	}

	async getApiKeyAndHeaders(model: Model<Api>): Promise<ResolvedRequestAuth> {
		try {
			const providerConfig = this.providerRequestConfigs.get(model.provider);
			const providerEnv = this.authStorage.getProviderEnv(model.provider);
			const storedApiKey = await this.authStorage.getApiKey(model.provider, { includeFallback: false });
			const apiKey =
				storedApiKey ??
				(providerConfig?.apiKey
					? resolveConfigValueOrThrow(
							providerConfig.apiKey,
							`API key for provider "${model.provider}"`,
							providerEnv,
						)
					: undefined);
			const providerHeaders = resolveHeadersOrThrow(
				providerConfig?.headers,
				`provider "${model.provider}"`,
				providerEnv,
			);
			const modelHeaders = resolveHeadersOrThrow(
				this.modelRequestHeaders.get(this.getModelRequestKey(model.provider, model.id)),
				`model "${model.provider}/${model.id}"`,
				providerEnv,
			);
			let headers =
				model.headers || providerHeaders || modelHeaders
					? { ...model.headers, ...providerHeaders, ...modelHeaders }
					: undefined;
			if (providerConfig?.authHeader) {
				if (!apiKey) return { ok: false, error: `No API key found for "${model.provider}"` };
				headers = { ...headers, Authorization: `Bearer ${apiKey}` };
			}
			return {
				ok: true,
				apiKey,
				headers: headers && Object.keys(headers).length > 0 ? headers : undefined,
				env: providerEnv && Object.keys(providerEnv).length > 0 ? providerEnv : undefined,
			};
		} catch (error) {
			return { ok: false, error: error instanceof Error ? error.message : String(error) };
		}
	}

	getProviderAuthStatus(provider: string): AuthStatus {
		const stored = this.authStorage.getAuthStatus(provider);
		if (stored.source) return stored;
		const providerApiKey = this.providerRequestConfigs.get(provider)?.apiKey;
		return providerApiKey && isConfigValueConfigured(providerApiKey)
			? { configured: true, source: "runtime", label: "in-memory registry" }
			: stored;
	}

	getProviderDisplayName(provider: string): string {
		const registeredProvider = this.registeredProviders.get(provider);
		const oauthProvider = this.authStorage.getOAuthProviders().find((candidate) => candidate.id === provider);
		return (
			registeredProvider?.name ??
			registeredProvider?.oauth?.name ??
			oauthProvider?.name ??
			BUILT_IN_PROVIDER_DISPLAY_NAMES[provider] ??
			provider
		);
	}

	async getApiKeyForProvider(provider: string): Promise<string | undefined> {
		const stored = await this.authStorage.getApiKey(provider);
		if (stored !== undefined) return stored;
		const providerApiKey = this.providerRequestConfigs.get(provider)?.apiKey;
		return providerApiKey
			? resolveConfigValueUncached(providerApiKey, this.authStorage.getProviderEnv(provider))
			: undefined;
	}

	isUsingOAuth(model: Model<Api>): boolean {
		return this.authStorage.get(model.provider)?.type === "oauth";
	}

	registerProvider(providerName: string, config: ProviderConfig): void {
		if (this.locked) throw new ModelRegistryLockedError();
		this.validateProviderConfig(providerName, config);
		this.applyProviderConfig(providerName, config);
		this.upsertRegisteredProvider(providerName, config);
	}

	unregisterProvider(providerName: string): void {
		if (this.locked) throw new ModelRegistryLockedError();
		if (!this.registeredProviders.has(providerName)) return;
		this.registeredProviders.delete(providerName);
		this.refresh();
	}

	private upsertRegisteredProvider(providerName: string, config: ProviderConfig): void {
		const existing = this.registeredProviders.get(providerName);
		if (!existing) {
			this.registeredProviders.set(providerName, { ...config });
			return;
		}
		for (const key of Object.keys(config) as (keyof ProviderConfig)[]) {
			if (config[key] !== undefined) (existing as Record<string, unknown>)[key] = config[key];
		}
	}

	private validateProviderConfig(providerName: string, config: ProviderConfig): void {
		if (config.streamSimple && !config.api) {
			throw new Error(`Provider ${providerName}: "api" is required when registering streamSimple.`);
		}
		if (!config.models || config.models.length === 0) return;
		if (!config.baseUrl) throw new Error(`Provider ${providerName}: "baseUrl" is required when defining models.`);
		if (!config.apiKey && !config.oauth) {
			throw new Error(`Provider ${providerName}: "apiKey" or "oauth" is required when defining models.`);
		}
		for (const model of config.models) {
			if (!model.api && !config.api) {
				throw new Error(`Provider ${providerName}, model ${model.id}: no "api" specified.`);
			}
			if (model.contextWindow <= 0 || model.maxTokens <= 0) {
				throw new Error(`Provider ${providerName}, model ${model.id}: token limits must be positive.`);
			}
		}
	}

	private applyProviderConfig(providerName: string, config: ProviderConfig): void {
		if (config.oauth) registerOAuthProvider({ ...config.oauth, id: providerName });
		if (config.streamSimple) {
			const streamSimple = config.streamSimple;
			registerApiProvider(
				{
					api: config.api!,
					stream: (model, context, options) => streamSimple(model, context, options as SimpleStreamOptions),
					streamSimple,
				},
				`provider:${providerName}`,
			);
		}
		this.storeProviderRequestConfig(providerName, config);

		if (config.models && config.models.length > 0) {
			this.models = this.models.filter((model) => model.provider !== providerName);
			for (const definition of config.models) {
				this.storeModelHeaders(providerName, definition.id, definition.headers);
				this.models.push({
					id: definition.id,
					name: definition.name,
					api: (definition.api ?? config.api) as Api,
					provider: providerName,
					baseUrl: definition.baseUrl ?? config.baseUrl!,
					reasoning: definition.reasoning,
					thinkingLevelMap: definition.thinkingLevelMap,
					input: [...definition.input],
					cost: { ...definition.cost },
					contextWindow: definition.contextWindow,
					maxTokens: definition.maxTokens,
					compat: definition.compat,
				} as Model<Api>);
			}
			if (config.oauth?.modifyModels) {
				const credential = this.authStorage.get(providerName);
				if (credential?.type === "oauth") this.models = config.oauth.modifyModels(this.models, credential);
			}
			return;
		}

		if (config.baseUrl || config.compat) {
			this.models = this.models.map((model) =>
				model.provider === providerName
					? {
							...model,
							baseUrl: config.baseUrl ?? model.baseUrl,
							compat: config.compat ? { ...model.compat, ...config.compat } : model.compat,
						}
					: model,
			);
		}
	}
}
