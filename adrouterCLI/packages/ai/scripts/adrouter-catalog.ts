import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const ADROUTER_CATALOG_IDS = [
	"deepseek-v4-flash",
	"deepseek-v4-pro",
	"mimo-v2.5",
	"mimo-v2.5-pro",
	"agnes-2.0-flash",
	"agnes-2.5-flash",
	"agnes-2.5-pro",
	"agnes-2.5-pro-alpha",
] as const;

export type AdRouterCatalogModelId = (typeof ADROUTER_CATALOG_IDS)[number];
export type AdRouterThinkingLevel = "none" | "medium" | "high";

export interface AdRouterCatalogModel {
	id: AdRouterCatalogModelId;
	provider: "deepseek" | "mimo" | "agnes";
	model_class: "flash" | "pro";
	display_name: string;
	provider_label: string;
	description: string;
	thinking_levels: AdRouterThinkingLevel[];
	default_thinking_level: AdRouterThinkingLevel;
	context_window: number;
	max_input_tokens: number;
	max_output_tokens: number;
}

export interface AdRouterCatalog {
	schema_version: 1;
	catalog_digest: string;
	models: AdRouterCatalogModel[];
}

const EXPECTED_MODELS: ReadonlyArray<{
	id: AdRouterCatalogModelId;
	provider: AdRouterCatalogModel["provider"];
	modelClass: AdRouterCatalogModel["model_class"];
	thinkingLevels: readonly AdRouterThinkingLevel[];
	defaultThinkingLevel: AdRouterThinkingLevel;
}> = [
	{
		id: "deepseek-v4-flash",
		provider: "deepseek",
		modelClass: "flash",
		thinkingLevels: ["none", "medium", "high"],
		defaultThinkingLevel: "medium",
	},
	{
		id: "deepseek-v4-pro",
		provider: "deepseek",
		modelClass: "pro",
		thinkingLevels: ["none", "medium", "high"],
		defaultThinkingLevel: "medium",
	},
	{
		id: "mimo-v2.5",
		provider: "mimo",
		modelClass: "flash",
		thinkingLevels: ["none", "high"],
		defaultThinkingLevel: "high",
	},
	{
		id: "mimo-v2.5-pro",
		provider: "mimo",
		modelClass: "pro",
		thinkingLevels: ["none", "high"],
		defaultThinkingLevel: "high",
	},
	{
		id: "agnes-2.0-flash",
		provider: "agnes",
		modelClass: "flash",
		thinkingLevels: ["none", "high"],
		defaultThinkingLevel: "none",
	},
	{
		id: "agnes-2.5-flash",
		provider: "agnes",
		modelClass: "flash",
		thinkingLevels: ["none", "high"],
		defaultThinkingLevel: "none",
	},
	{
		id: "agnes-2.5-pro",
		provider: "agnes",
		modelClass: "pro",
		thinkingLevels: ["high"],
		defaultThinkingLevel: "high",
	},
	{
		id: "agnes-2.5-pro-alpha",
		provider: "agnes",
		modelClass: "pro",
		thinkingLevels: ["high"],
		defaultThinkingLevel: "high",
	},
];

const TOP_LEVEL_KEYS = ["catalog_digest", "models", "schema_version"];
const MODEL_KEYS = [
	"context_window",
	"default_thinking_level",
	"description",
	"display_name",
	"id",
	"max_input_tokens",
	"max_output_tokens",
	"model_class",
	"provider",
	"provider_label",
	"thinking_levels",
];
const THINKING_LEVELS = new Set<AdRouterThinkingLevel>(["none", "medium", "high"]);
const CATALOG_DIRECTORY = join(dirname(fileURLToPath(import.meta.url)), "..", "catalog");

export const ADROUTER_CATALOG_PATH = join(CATALOG_DIRECTORY, "adrouter-model-catalog.v1.json");

function fail(message: string): never {
	throw new Error(`invalid_adrouter_catalog: ${message}`);
}

function assertRecord(value: unknown, label: string): asserts value is Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) fail(`${label} must be an object`);
}

function assertExactKeys(record: Record<string, unknown>, expected: string[], label: string): void {
	const actual = Object.keys(record).sort();
	if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) {
		fail(`${label} keys must be exactly ${expected.join(", ")}`);
	}
}

function assertNonEmptyString(value: unknown, label: string): asserts value is string {
	if (typeof value !== "string" || value.trim() !== value || value.length === 0) {
		fail(`${label} must be a non-empty trimmed string`);
	}
}

function sortObjectKeys(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortObjectKeys);
	if (!value || typeof value !== "object") return value;
	return Object.fromEntries(
		Object.entries(value as Record<string, unknown>)
			.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
			.map(([key, nested]) => [key, sortObjectKeys(nested)]),
	);
}

export function computeAdRouterCatalogDigest(payload: unknown): string {
	const canonicalJson = JSON.stringify(sortObjectKeys(payload));
	return `sha256:${createHash("sha256").update(canonicalJson, "utf8").digest("hex")}`;
}

export function validateAdRouterCatalog(value: unknown): AdRouterCatalog {
	assertRecord(value, "catalog");
	assertExactKeys(value, TOP_LEVEL_KEYS, "catalog");
	if (value.schema_version !== 1) fail("schema_version must equal 1");
	if (typeof value.catalog_digest !== "string" || !/^sha256:[0-9a-f]{64}$/.test(value.catalog_digest)) {
		fail("catalog_digest must be a lowercase sha256 digest");
	}
	if (!Array.isArray(value.models) || value.models.length !== EXPECTED_MODELS.length) {
		fail(`models must contain exactly ${EXPECTED_MODELS.length} entries`);
	}

	for (let index = 0; index < value.models.length; index++) {
		const model = value.models[index];
		const expected = EXPECTED_MODELS[index];
		assertRecord(model, `models[${index}]`);
		assertExactKeys(model, MODEL_KEYS, `models[${index}]`);
		if (model.id !== expected.id) fail(`models[${index}].id must equal ${expected.id}`);
		if (model.provider !== expected.provider) fail(`${expected.id}.provider must equal ${expected.provider}`);
		if (model.model_class !== expected.modelClass) fail(`${expected.id}.model_class must equal ${expected.modelClass}`);
		assertNonEmptyString(model.display_name, `${expected.id}.display_name`);
		assertNonEmptyString(model.provider_label, `${expected.id}.provider_label`);
		assertNonEmptyString(model.description, `${expected.id}.description`);
		if (!Array.isArray(model.thinking_levels)) fail(`${expected.id}.thinking_levels must be an array`);
		if (
			model.thinking_levels.length !== expected.thinkingLevels.length ||
			model.thinking_levels.some(
				(level, levelIndex) => !THINKING_LEVELS.has(level as AdRouterThinkingLevel) || level !== expected.thinkingLevels[levelIndex],
			)
		) {
			fail(`${expected.id}.thinking_levels do not match the hosted contract`);
		}
		if (
			model.default_thinking_level !== expected.defaultThinkingLevel ||
			!model.thinking_levels.includes(model.default_thinking_level)
		) {
			fail(`${expected.id}.default_thinking_level does not match the hosted contract`);
		}
		for (const [key, expectedLimit] of [
			["context_window", 131_072],
			["max_input_tokens", 126_976],
			["max_output_tokens", 4_096],
		] as const) {
			if (!Number.isInteger(model[key]) || model[key] !== expectedLimit) {
				fail(`${expected.id}.${key} must equal ${expectedLimit}`);
			}
		}
	}

	const expectedDigest = computeAdRouterCatalogDigest({ schema_version: value.schema_version, models: value.models });
	if (value.catalog_digest !== expectedDigest) fail(`catalog_digest mismatch; expected ${expectedDigest}`);
	return value as unknown as AdRouterCatalog;
}

export function parseAdRouterCatalog(bytes: string | Buffer): AdRouterCatalog {
	let parsed: unknown;
	try {
		parsed = JSON.parse(typeof bytes === "string" ? bytes : bytes.toString("utf8"));
	} catch (error) {
		fail(`catalog is not valid JSON (${error instanceof Error ? error.message : String(error)})`);
	}
	return validateAdRouterCatalog(parsed);
}

export function readAdRouterCatalog(path = ADROUTER_CATALOG_PATH): AdRouterCatalog {
	return parseAdRouterCatalog(readFileSync(path));
}

function quote(value: string): string {
	return JSON.stringify(value);
}

function renderThinkingMap(levels: readonly AdRouterThinkingLevel[]): string {
	const supported = new Set(levels);
	return JSON.stringify({
		off: supported.has("none") ? "none" : null,
		minimal: null,
		low: null,
		medium: supported.has("medium") ? "medium" : null,
		high: supported.has("high") ? "high" : null,
		xhigh: null,
		max: null,
	});
}

export function renderAdRouterModelsModule(catalog: AdRouterCatalog): string {
	validateAdRouterCatalog(catalog);
	const limits = catalog.models[0];
	let output = `// This file is auto-generated by scripts/generate-models.ts
// Do not edit manually - run 'npm run generate-models' to update

import type { Model } from "../types.ts";

export const ADROUTER_CATALOG_SCHEMA_VERSION = ${catalog.schema_version} as const;
export const ADROUTER_CATALOG_DIGEST = ${quote(catalog.catalog_digest)} as const;
export const ADROUTER_HOSTED_LIMITS = {
	contextWindowTokens: ${limits.context_window},
	maxInputTokens: ${limits.max_input_tokens},
	maxOutputTokens: ${limits.max_output_tokens},
} as const;

export const ADROUTER_CATALOG_METADATA = {
`;
	for (const model of catalog.models) {
		output += `\t${quote(model.id)}: {
		provider: ${quote(model.provider)},
		modelClass: ${quote(model.model_class)},
		description: ${quote(model.description)},
		thinkingLevels: ${JSON.stringify(model.thinking_levels)},
		defaultThinkingLevel: ${quote(model.default_thinking_level)},
		maxInputTokens: ${model.max_input_tokens},
	},
`;
	}
	output += `} as const;

export const ADROUTER_MODELS = {
`;
	for (const model of catalog.models) {
		output += `\t${quote(model.id)}: {
		id: ${quote(model.id)},
		name: ${quote(`AdRouter ${model.display_name}`)},
		api: "adrouter-agent",
		provider: "adrouter",
		baseUrl: "",
		reasoning: true,
		thinkingLevelMap: ${renderThinkingMap(model.thinking_levels)},
		input: ["text"],
		cost: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
		},
		contextWindow: ${model.context_window},
		maxTokens: ${model.max_output_tokens},
	} satisfies Model<"adrouter-agent">,
`;
	}
	return `${output}} as const;\n`;
}
