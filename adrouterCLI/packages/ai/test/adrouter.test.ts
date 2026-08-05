import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readAdRouterCatalog } from "../scripts/adrouter-catalog.ts";
import {
	ADROUTER_HOSTED_CONTEXT_WINDOW_TOKENS,
	ADROUTER_HOSTED_MAX_INPUT_TOKENS,
	ADROUTER_HOSTED_MAX_OUTPUT_TOKENS,
	ADROUTER_HOSTED_PROACTIVE_INPUT_TOKENS,
} from "../src/adrouter-config.ts";
import { getAdRouterMessageUpdate, getLatestAdRouterAds } from "../src/adrouter-events.ts";
import { assertAdRouterHostedInputWithinLimit, stream } from "../src/api/adrouter.ts";
import { clampThinkingLevel, getSupportedThinkingLevels } from "../src/models.ts";
import {
	ADROUTER_CATALOG_DIGEST,
	ADROUTER_CATALOG_METADATA,
	ADROUTER_CATALOG_SCHEMA_VERSION,
	ADROUTER_HOSTED_LIMITS,
	ADROUTER_MODELS,
} from "../src/providers/adrouter.models.ts";
import type { Model } from "../src/types.ts";
import { isContextOverflow } from "../src/utils/overflow.ts";

function parseRequestBody(init: RequestInit | undefined): any {
	return JSON.parse(new TextDecoder().decode(init?.body as Uint8Array));
}

const model: Model<"adrouter-agent"> = {
	id: "deepseek-v4-flash",
	name: "AdRouter DeepSeek V4 Flash",
	api: "adrouter-agent",
	provider: "adrouter",
	baseUrl: "https://router.example.test",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: ADROUTER_HOSTED_CONTEXT_WINDOW_TOKENS,
	maxTokens: ADROUTER_HOSTED_MAX_OUTPUT_TOKENS,
};

function mockFetch(body: unknown): void {
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => ({
			ok: true,
			status: 200,
			headers: new Headers({ "content-type": "application/json" }),
			json: async () => body,
		})),
	);
}

function mockNdjsonFetch(lines: unknown[]): void {
	const body = new ReadableStream({
		start(controller) {
			const encoder = new TextEncoder();
			for (const line of lines) {
				controller.enqueue(encoder.encode(`${JSON.stringify(line)}\n`));
			}
			controller.close();
		},
	});
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => new Response(body, { status: 200, headers: { "content-type": "application/x-ndjson" } })),
	);
}

describe("AdRouter provider", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		delete process.env.ADROUTER_AD_MODE;
		delete process.env.ADROUTER_MODEL_ROUTE;
		delete process.env.ADROUTER_RUNTIME_MODE;
		delete process.env.ADROUTER_MIN_AD_TIER;
	});

	it("keeps all hosted models on the shared 128K contract", () => {
		for (const hostedModel of Object.values(ADROUTER_MODELS)) {
			expect(hostedModel.contextWindow).toBe(ADROUTER_HOSTED_CONTEXT_WINDOW_TOKENS);
			expect(hostedModel.maxTokens).toBe(ADROUTER_HOSTED_MAX_OUTPUT_TOKENS);
		}
		expect(ADROUTER_HOSTED_MAX_INPUT_TOKENS).toBe(
			ADROUTER_HOSTED_CONTEXT_WINDOW_TOKENS - ADROUTER_HOSTED_MAX_OUTPUT_TOKENS,
		);
		expect(ADROUTER_HOSTED_PROACTIVE_INPUT_TOKENS).toBe(114_688);
	});

	it("allows the exact proactive threshold and rejects one estimated token above it locally", () => {
		const atThreshold = {
			messages: [
				{
					role: "user" as const,
					content: "a".repeat(ADROUTER_HOSTED_PROACTIVE_INPUT_TOKENS * 4),
					timestamp: Date.now(),
				},
			],
		};
		expect(assertAdRouterHostedInputWithinLimit(atThreshold)).toBe(ADROUTER_HOSTED_PROACTIVE_INPUT_TOKENS);

		let error: unknown;
		try {
			assertAdRouterHostedInputWithinLimit({
				...atThreshold,
				messages: [
					{
						...atThreshold.messages[0],
						content: `${atThreshold.messages[0].content}aaaa`,
					},
				],
			});
		} catch (candidate) {
			error = candidate;
		}
		expect(error).toMatchObject({
			code: "input_limit_exceeded",
			details: {
				estimated_input_tokens: ADROUTER_HOSTED_PROACTIVE_INPUT_TOKENS + 1,
				max_input_tokens: ADROUTER_HOSTED_MAX_INPUT_TOKENS,
				local_preflight: 1,
			},
		});
	});

	it("accounts conservatively for the current tool schema when prior usage is available", () => {
		const priorAssistant = {
			role: "assistant" as const,
			content: [{ type: "text" as const, text: "done" }],
			api: "adrouter-agent" as const,
			provider: "adrouter" as const,
			model: "deepseek-v4-flash",
			usage: {
				input: 110_000,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 110_000,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop" as const,
			timestamp: Date.now(),
		};
		expect(() =>
			assertAdRouterHostedInputWithinLimit({
				messages: [priorAssistant],
				tools: [
					{
						name: "large_tool",
						description: "a".repeat(40_000),
						parameters: Type.Object({ payload: Type.String() }),
					},
				],
			}),
		).toThrow("proactive compaction threshold");
	});

	it("wraps router assistant text and publishes live ads", async () => {
		process.env.ADROUTER_AD_MODE = "live";
		mockFetch({
			assistant: { content: "Done." },
			ads: [
				{
					id: "ad-1",
					tier: "C",
					title: "API Monitor",
					body: "Health checks for developer APIs.",
					cta: "Learn more",
					url: "https://example.com",
					label: "Sponsored",
				},
			],
			injection: { mode: "tui_panel", placement: "bottom", refresh_after_turn: true },
		});

		const message = await stream(model, { messages: [] }, { apiKey: "test-key" }).result();

		expect(message.stopReason).toBe("stop");
		expect(message.content).toEqual([{ type: "text", text: "Done." }]);
		expect(getLatestAdRouterAds()?.status).toBe("live");
		expect(getLatestAdRouterAds()?.ads[0]?.title).toBe("API Monitor");
	});

	it("correlates JSON adapter ads with the router turn id", async () => {
		process.env.ADROUTER_AD_MODE = "live";
		mockFetch({
			turn_id: "turn-json",
			assistant: { content: "Done." },
			ads: [
				{
					id: "ad-json",
					turn_id: "turn-json",
					campaign_id: "campaign-json",
					reason_code: "matched",
					tier: "B",
					title: "Build",
					body: "Fast CI",
					label: "Sponsored",
				},
			],
			settlement: { ad_subsidy: 0.002 },
		});

		const message = await stream(model, { messages: [] }, { apiKey: "test-key" }).result();

		expect(getAdRouterMessageUpdate(message)).toMatchObject({
			turnId: "turn-json",
			ads: [{ campaignId: "campaign-json", reasonCode: "matched", tier: "B" }],
		});
	});

	it("publishes a tier 3 mock ad when mock mode has no router ads", async () => {
		process.env.ADROUTER_AD_MODE = "mock";
		mockFetch({ assistant: { content: "No ads returned." }, ads: [] });

		const message = await stream(model, { messages: [] }, { apiKey: "test-key" }).result();

		expect(message.stopReason).toBe("stop");
		expect(getLatestAdRouterAds()?.status).toBe("mock");
		expect(getLatestAdRouterAds()?.ads[0]?.tier).toBe("C");
	});

	it("publishes ads before streamed text from NDJSON", async () => {
		process.env.ADROUTER_AD_MODE = "live";
		mockNdjsonFetch([
			{
				type: "ad",
				ads: [
					{
						id: "ad-1",
						tier: "A",
						title: "Compiler Cloud",
						body: "Fast build minutes for coding agents.",
						label: "Sponsored",
					},
				],
				injection: { mode: "tui_panel", placement: "bottom", refresh_after_turn: true },
				status: "live",
			},
			{ type: "text", content: "Hello" },
			{ type: "text", content: " world" },
			{ type: "settlement", usage: { input: 2, output: 3, totalTokens: 5 } },
			{ type: "done", assistant: { content: "Hello world" } },
		]);

		const events = [];
		const output = stream(model, { messages: [] }, { apiKey: "test-key" });
		for await (const event of output) {
			events.push(event.type);
			if (event.type === "text_delta") break;
		}

		expect(getLatestAdRouterAds()?.ads[0]?.title).toBe("Compiler Cloud");
		expect(events).toEqual(["start", "text_start", "text_delta"]);

		const message = await output.result();
		expect(message.content).toEqual([{ type: "text", text: "Hello world" }]);
		expect(message.usage.totalTokens).toBe(5);
	});

	it("reconciles streamed tool calls with the done snapshot without duplicating IDs", async () => {
		process.env.ADROUTER_AD_MODE = "live";
		mockNdjsonFetch([
			{ type: "ad", status: "live", ads: [] },
			{ type: "thinking", content: "  Need the file first.  " },
			{
				type: "tool_call",
				tool_call: { id: "call_once", name: "read", arguments: { path: "package.json" } },
			},
			{ type: "settlement", usage: { input: 2, output: 3, totalTokens: 5 } },
			{
				type: "done",
				assistant: {
					reasoning_content: "  Need the file first.  ",
					content: "",
					tool_calls: [{ id: "call_once", name: "read", arguments: { path: "package.json" } }],
				},
			},
		]);

		const message = await stream(model, { messages: [] }, { apiKey: "test-key" }).result();

		expect(message.stopReason).toBe("toolUse");
		expect(message.content).toEqual([
			{
				type: "thinking",
				thinking: "  Need the file first.  ",
				thinkingSignature: "reasoning_content",
			},
			{ type: "toolCall", id: "call_once", name: "read", arguments: { path: "package.json" } },
		]);
	});

	it("rejects a conflicting done snapshot before tools can execute twice", async () => {
		process.env.ADROUTER_AD_MODE = "live";
		mockNdjsonFetch([
			{ type: "ad", status: "live", ads: [] },
			{
				type: "tool_call",
				tool_call: { id: "call_conflict", name: "read", arguments: { path: "one.txt" } },
			},
			{
				type: "done",
				assistant: {
					tool_calls: [{ id: "call_conflict", name: "read", arguments: { path: "two.txt" } }],
				},
			},
		]);

		const message = await stream(model, { messages: [] }, { apiKey: "test-key" }).result();

		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).toContain("conflicting tool calls with ID call_conflict");
	});

	it("associates a settlement with its exact finalized assistant message", async () => {
		process.env.ADROUTER_AD_MODE = "live";
		mockNdjsonFetch([
			{
				type: "ad",
				turn_id: "turn-123",
				ads: [{ id: "ad-a", tier: "A", title: "Build Cloud", body: "Fast CI", label: "Sponsored" }],
			},
			{ type: "text", content: "Done" },
			{ type: "settlement", turn_id: "turn-123", settlement: { ad_subsidy: 0.001234 } },
		]);

		const message = await stream(model, { messages: [] }, { apiKey: "test-key" }).result();

		expect(getAdRouterMessageUpdate(message)).toMatchObject({
			turnId: "turn-123",
			ads: [{ tier: "A" }],
			settlement: { ad_subsidy: 0.001234 },
		});
	});

	it("publishes raw router ad events when normalized CLI ads are absent", async () => {
		process.env.ADROUTER_AD_MODE = "live";
		mockNdjsonFetch([
			{
				type: "ad",
				ad: {
					tier: "A",
					sponsor: {
						brand_name: "Compiler Cloud",
						ad_copy: "Fast build minutes for coding agents.",
						click_url: "https://example.com",
					},
				},
				injection: { mode: "tui_panel", placement: "bottom", refresh_after_turn: true },
				status: "live",
			},
			{ type: "text", content: "Hello" },
			{ type: "done", assistant: { content: "Hello" } },
		]);

		const message = await stream(model, { messages: [] }, { apiKey: "test-key" }).result();

		expect(message.content).toEqual([{ type: "text", text: "Hello" }]);
		expect(getLatestAdRouterAds()?.status).toBe("live");
		expect(getLatestAdRouterAds()?.ads[0]).toMatchObject({
			tier: "A",
			title: "Compiler Cloud",
			body: "Fast build minutes for coding agents.",
		});
	});

	it("clears a routed placement when the NDJSON stream reports an error", async () => {
		process.env.ADROUTER_AD_MODE = "live";
		mockNdjsonFetch([
			{
				type: "ad",
				ad: {
					tier: "A",
					sponsor: { brand_name: "Compiler Cloud", ad_copy: "Fast builds." },
				},
			},
			{ type: "error", message: "upstream disconnected" },
		]);

		const message = await stream(model, { messages: [] }, { apiKey: "test-key" }).result();

		expect(message.stopReason).toBe("error");
		expect(getLatestAdRouterAds()).toMatchObject({ status: "degraded", ads: [] });
	});

	it("clears an existing banner for a router opt-out outcome", async () => {
		process.env.ADROUTER_AD_MODE = "live";
		mockNdjsonFetch([
			{
				type: "ad",
				status: "off",
				ad: { turn_id: "turn-off", tier: "NONE", reason_code: "user_opt_out", reason: "Ads disabled" },
			},
			{ type: "settlement", turn_id: "turn-off", settlement: { ad_subsidy: 0 } },
		]);

		await stream(model, { messages: [] }, { apiKey: "test-key" }).result();

		expect(getLatestAdRouterAds()).toMatchObject({ status: "off", ads: [] });
	});

	it("keeps a guardrail NONE visible through settlement without treating it as opt-out", async () => {
		process.env.ADROUTER_AD_MODE = "live";
		mockNdjsonFetch([
			{
				type: "ad",
				status: "privacy_protected",
				ad: {
					turn_id: "turn-guardrail",
					tier: "NONE",
					reason_code: "guardrail",
					reason: "Sensitive category detected (health).",
				},
			},
			{
				type: "settlement",
				turn_id: "turn-guardrail",
				settlement: {
					ad_subsidy: 0,
					usage: { input_tokens: 10, cache_read_tokens: 2, cache_write_tokens: 1, output_tokens: 5 },
					cost: {
						input_cache_hit: 0.000001,
						input_cache_miss: 0.000002,
						cache_write: 0,
						output: 0.000003,
						total: 0.000006,
					},
				},
			},
		]);

		const message = await stream(model, { messages: [] }, { apiKey: "test-key" }).result();

		expect(getLatestAdRouterAds()).toMatchObject({
			turnId: "turn-guardrail",
			status: "privacy_protected",
			ads: [{ tier: "NONE", reasonCode: "guardrail" }],
			settlement: { cost: { input_cache_miss: 0.000002 } },
		});
		expect(getAdRouterMessageUpdate(message)?.status).toBe("privacy_protected");
	});

	it("clears no-inventory and routing-failure outcomes instead of showing a mock sponsor", async () => {
		process.env.ADROUTER_AD_MODE = "mock";
		mockNdjsonFetch([
			{
				type: "ad",
				ad: {
					turn_id: "turn-no-inventory",
					tier: "NONE",
					reason_code: "no_inventory",
					reason: "No sponsors are available.",
				},
			},
		]);

		await stream(model, { messages: [] }, { apiKey: "test-key" }).result();

		expect(getLatestAdRouterAds()).toMatchObject({ status: "degraded", ads: [] });
	});

	it("publishes the exact hosted catalog and maps only router-supported thinking levels", async () => {
		const catalog = readAdRouterCatalog();
		const expectedModelIds = catalog.models.map(({ id }) => id);
		expect(ADROUTER_CATALOG_SCHEMA_VERSION).toBe(catalog.schema_version);
		expect(ADROUTER_CATALOG_DIGEST).toBe(catalog.catalog_digest);
		expect(Object.keys(ADROUTER_MODELS)).toEqual(expectedModelIds);
		expect(Object.values(ADROUTER_MODELS).map(({ name }) => name)).toEqual(
			catalog.models.map(({ display_name }) => `AdRouter ${display_name}`),
		);
		expect(ADROUTER_HOSTED_LIMITS).toEqual({
			contextWindowTokens: 131_072,
			maxInputTokens: 126_976,
			maxOutputTokens: 4_096,
		});
		for (const descriptor of catalog.models) {
			const hostedModel = ADROUTER_MODELS[descriptor.id];
			expect(hostedModel).toMatchObject({
				api: "adrouter-agent",
				provider: "adrouter",
				baseUrl: "",
				reasoning: true,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: ADROUTER_HOSTED_CONTEXT_WINDOW_TOKENS,
				maxTokens: ADROUTER_HOSTED_MAX_OUTPUT_TOKENS,
			});
			expect(ADROUTER_CATALOG_METADATA[descriptor.id]).toEqual({
				provider: descriptor.provider,
				modelClass: descriptor.model_class,
				description: descriptor.description,
				thinkingLevels: descriptor.thinking_levels,
				defaultThinkingLevel: descriptor.default_thinking_level,
				maxInputTokens: descriptor.max_input_tokens,
			});
		}

		const deepseekAliases = {
			off: "none",
			minimal: null,
			low: null,
			medium: "medium",
			high: "high",
			xhigh: null,
			max: null,
		};
		const flashAliases = { ...deepseekAliases, medium: null };
		const proAliases = { ...flashAliases, off: null };
		for (const modelId of ["deepseek-v4-flash", "deepseek-v4-pro"] as const) {
			expect(ADROUTER_MODELS[modelId].thinkingLevelMap).toEqual(deepseekAliases);
			expect(getSupportedThinkingLevels(ADROUTER_MODELS[modelId])).toEqual(["off", "medium", "high"]);
		}
		for (const modelId of ["mimo-v2.5", "mimo-v2.5-pro", "agnes-2.0-flash", "agnes-2.5-flash"] as const) {
			expect(ADROUTER_MODELS[modelId].thinkingLevelMap).toEqual(flashAliases);
			expect(getSupportedThinkingLevels(ADROUTER_MODELS[modelId])).toEqual(["off", "high"]);
			for (const unsupported of ["minimal", "low", "medium", "xhigh", "max"] as const) {
				expect(clampThinkingLevel(ADROUTER_MODELS[modelId], unsupported)).toBe("high");
			}
		}
		for (const modelId of ["agnes-2.5-pro", "agnes-2.5-pro-alpha"] as const) {
			expect(ADROUTER_MODELS[modelId].thinkingLevelMap).toEqual(proAliases);
			expect(getSupportedThinkingLevels(ADROUTER_MODELS[modelId])).toEqual(["high"]);
			for (const unsupported of ["off", "minimal", "low", "medium", "xhigh", "max"] as const) {
				expect(clampThinkingLevel(ADROUTER_MODELS[modelId], unsupported)).toBe("high");
			}
		}

		const fetchMock = vi.fn(async (_input: unknown, _init?: RequestInit) => ({
			ok: true,
			status: 200,
			headers: new Headers({ "content-type": "application/json" }),
			json: async () => ({ assistant: { content: "Done." }, ads: [] }),
		}));
		vi.stubGlobal("fetch", fetchMock);

		for (const descriptor of catalog.models) {
			const hostedModel = ADROUTER_MODELS[descriptor.id];
			for (const reasoning of getSupportedThinkingLevels(hostedModel)) {
				fetchMock.mockClear();
				await stream(
					{ ...hostedModel, baseUrl: "https://router.example.test" },
					{ messages: [{ role: "user", content: "test", timestamp: Date.now() }] },
					{ apiKey: "test-key", reasoning } as Parameters<typeof stream>[2],
				).result();

				const request = fetchMock.mock.calls[0]?.[1];
				const body = parseRequestBody(request);
				expect(body.model).toBe(descriptor.id);
				expect(body.thinking_level).toBe(hostedModel.thinkingLevelMap[reasoning]);
			}
		}

		// The agent runtime represents an omitted reasoning option as undefined. The Router artifact
		// owns the default for every known hosted model.
		for (const descriptor of catalog.models) {
			fetchMock.mockClear();
			await stream(
				{ ...ADROUTER_MODELS[descriptor.id], baseUrl: "https://router.example.test" },
				{ messages: [{ role: "user", content: "test", timestamp: Date.now() }] },
				{ apiKey: "test-key", reasoning: undefined } as Parameters<typeof stream>[2],
			).result();

			const request = fetchMock.mock.calls[0]?.[1];
			const body = parseRequestBody(request);
			expect(body.model).toBe(descriptor.id);
			expect(body.thinking_level).toBe(descriptor.default_thinking_level);
		}

		fetchMock.mockClear();
		await stream(
			{ ...model, id: "custom-adrouter-model", baseUrl: "http://127.0.0.1:8787" },
			{ messages: [{ role: "user", content: "test", timestamp: Date.now() }] },
			{ apiKey: "test-key", reasoning: undefined } as Parameters<typeof stream>[2],
		).result();
		const customBody = parseRequestBody(fetchMock.mock.calls[0]?.[1]);
		expect(customBody.model).toBe("custom-adrouter-model");
		expect(customBody.thinking_level).toBe("medium");

		process.env.ADROUTER_MODEL_ROUTE = "agnes-2.5-pro";
		fetchMock.mockClear();
		await stream(
			{ ...ADROUTER_MODELS["deepseek-v4-flash"], baseUrl: "https://router.example.test" },
			{ messages: [{ role: "user", content: "test", timestamp: Date.now() }] },
			{ apiKey: "test-key", reasoning: undefined } as Parameters<typeof stream>[2],
		).result();
		const routedBody = parseRequestBody(fetchMock.mock.calls[0]?.[1]);
		expect(routedBody.model).toBe("agnes-2.5-pro");
		expect(routedBody.thinking_level).toBe("high");
	});

	it("accepts the deprecated minimum-tier variable without interpreting it", async () => {
		process.env.ADROUTER_MIN_AD_TIER = "legacy-value";
		const fetchMock = vi.fn(async (_input: unknown, _init?: RequestInit) => ({
			ok: true,
			status: 200,
			headers: new Headers({ "content-type": "application/json" }),
			json: async () => ({ assistant: { content: "Done." }, ads: [] }),
		}));
		vi.stubGlobal("fetch", fetchMock);

		await stream(model, { messages: [] }, { apiKey: "test-key" }).result();

		const request = fetchMock.mock.calls[0]?.[1];
		const body = parseRequestBody(request);
		expect(body.metadata.min_ad_tier).toBe("legacy-value");
	});

	it("sends Pi tool context and tool definitions to the router", async () => {
		const fetchMock = vi.fn(async (_input: unknown, _init?: RequestInit) => ({
			ok: true,
			status: 200,
			headers: new Headers({ "content-type": "application/json" }),
			json: async () => ({ assistant: { content: "Done." }, ads: [] }),
		}));
		vi.stubGlobal("fetch", fetchMock);

		await stream(
			model,
			{
				systemPrompt: "Use tools when needed.",
				messages: [
					{ role: "user", content: [{ type: "text", text: "read package.json" }], timestamp: Date.now() },
					{
						role: "assistant",
						content: [
							{ type: "thinking", thinking: "Need file contents.", thinkingSignature: "reasoning_content" },
							{ type: "toolCall", id: "call_1", name: "read_file", arguments: { path: "package.json" } },
							{ type: "toolCall", id: "call_1", name: "read_file", arguments: { path: "package.json" } },
						],
						api: "adrouter-agent",
						provider: "adrouter",
						model: "deepseek-v4-flash",
						usage: {
							input: 1,
							output: 1,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 2,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						stopReason: "toolUse",
						timestamp: Date.now(),
					},
					{
						role: "toolResult",
						toolCallId: "call_1",
						toolName: "read_file",
						content: [{ type: "text", text: "{}" }],
						isError: false,
						timestamp: Date.now(),
					},
					{
						role: "toolResult",
						toolCallId: "call_1",
						toolName: "read_file",
						content: [{ type: "text", text: "{}" }],
						isError: false,
						timestamp: Date.now(),
					},
				],
				tools: [
					{
						name: "read_file",
						description: "Read a file",
						parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
					},
				],
			},
			{ apiKey: "test-key" },
		).result();

		const request = fetchMock.mock.calls[0]?.[1];
		const body = parseRequestBody(request);
		expect(body.context.systemPrompt).toBe("Use tools when needed.");
		expect(body.context.messages[1].content[0].type).toBe("thinking");
		expect(body.context.messages[1].content[0].thinking).toBe("Need file contents.");
		expect(
			body.context.messages[1].content.filter((block: { type: string }) => block.type === "toolCall"),
		).toHaveLength(1);
		expect(body.context.messages[2].role).toBe("toolResult");
		expect(body.context.messages.filter((message: { role: string }) => message.role === "toolResult")).toHaveLength(
			1,
		);
		expect(body.context.tools[0].name).toBe("read_file");
	});

	it("omits local-only controls from official hosted requests", async () => {
		process.env.ADROUTER_RUNTIME_MODE = "live";
		const fetchMock = vi.fn(
			async (_input: unknown, _init?: RequestInit) =>
				new Response(JSON.stringify({ assistant: { content: "Hosted." }, ads: [] }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
		);
		vi.stubGlobal("fetch", fetchMock);
		const hostedModel = { ...model, baseUrl: "https://api-staging.adrouter.co" };
		const adrouterAuth = {
			canAuthenticate: () => true,
			getAccess: async () => ({
				accessToken: "access-token",
				expiresAt: Date.now() + 60_000,
				installationId: "installation-1",
				clientKind: "cli" as const,
				clientVersion: "0.81.0-beta.7",
			}),
			signProof: async () => ({ proof: "signed-proof", contentDigest: "sha-256=:fixture=:" }),
			rememberNonce: vi.fn(),
		};

		await stream(hostedModel, { messages: [] }, { adrouterAuth, apiKey: "ignored", maxTokens: 9000 }).result();

		const request = fetchMock.mock.calls[0]?.[1];
		const body = parseRequestBody(request);
		expect(body.runtime_mode).toBeUndefined();
		expect(body.tier_override).toBeUndefined();
		expect(body.max_output_tokens).toBe(4096);
		expect(body.metadata.ad_mode).toBe("live");
		const headers = new Headers(request?.headers);
		expect(headers.get("authorization")).toBe("DPoP access-token");
		expect(headers.get("dpop")).toBe("signed-proof");
		expect(headers.get("content-digest")).toMatch(/^sha-256=:/);
	});

	it("filters protected headers and retries one nonce challenge before consuming the response", async () => {
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ error: "use_dpop_nonce" }), {
					status: 401,
					headers: {
						"dpop-nonce": "server_nonce_1234567890",
					},
				}),
			)
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ assistant: { content: "Done." }, ads: [] }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
			);
		vi.stubGlobal("fetch", fetchMock);
		const signProof = vi.fn(async (_origin, input) => ({
			proof: `proof:${input.nonce ?? "initial"}`,
			contentDigest: "sha-256=:real-digest=:",
		}));
		const rememberNonce = vi.fn();
		const adrouterAuth = {
			canAuthenticate: () => true,
			getAccess: async () => ({
				accessToken: "real-access",
				expiresAt: Date.now() + 60_000,
				installationId: "installation-1",
				clientKind: "cli" as const,
				clientVersion: "0.81.0-beta.7",
			}),
			signProof,
			rememberNonce,
		};
		const hostedModel = { ...model, baseUrl: "https://api-staging.adrouter.co" };

		const message = await stream(
			hostedModel,
			{ messages: [] },
			{
				adrouterAuth,
				headers: {
					authorization: "Bearer attacker",
					dpop: "attacker-proof",
					"content-digest": "attacker-digest",
					"content-type": "text/plain",
					"x-adrouter-client-kind": "attacker",
					"x-adrouter-client-version": "999.0.0",
				},
			},
		).result();

		expect(message.stopReason).toBe("stop");
		expect(fetchMock).toHaveBeenCalledTimes(2);
		const first = fetchMock.mock.calls[0]![1] as RequestInit;
		const second = fetchMock.mock.calls[1]![1] as RequestInit;
		expect(new TextDecoder().decode(first.body as Uint8Array)).toBe(
			new TextDecoder().decode(second.body as Uint8Array),
		);
		const headers = new Headers(second.headers);
		expect(headers.get("authorization")).toBe("DPoP real-access");
		expect(headers.get("dpop")).toBe("proof:server_nonce_1234567890");
		expect(headers.get("content-type")).toBe("application/json");
		expect(headers.get("x-adrouter-client-kind")).toBe("cli");
		expect(headers.get("x-adrouter-client-version")).toBe("0.81.0-beta.7");
		expect(rememberNonce).toHaveBeenCalledWith("https://api-staging.adrouter.co", "server_nonce_1234567890");
	});

	it("preserves an explicitly configured runtime mode for local and custom routers", async () => {
		process.env.ADROUTER_RUNTIME_MODE = "live";
		const fetchMock = vi.fn(
			async (_input: unknown, _init?: RequestInit) =>
				new Response(JSON.stringify({ assistant: { content: "Local." }, ads: [] }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
		);
		vi.stubGlobal("fetch", fetchMock);

		await stream(model, { messages: [] }, { apiKey: "test-key" }).result();

		const request = fetchMock.mock.calls[0]?.[1];
		const body = parseRequestBody(request);
		expect(body.runtime_mode).toBe("live");
	});

	it("rejects mock mode locally before contacting an official hosted router", async () => {
		process.env.ADROUTER_RUNTIME_MODE = "mock";
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		const hostedModel = { ...model, baseUrl: "https://api-staging.adrouter.co" };

		const message = await stream(hostedModel, { messages: [] }, { apiKey: "test-key" }).result();

		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).toContain("only available with a local or custom AdRouter API URL");
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("includes router error body details in failed requests", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(
						JSON.stringify({
							error: "Invalid body",
							code: "hosted_control_not_allowed",
							details: { fieldErrors: { context: ["Required"] } },
						}),
						{
							status: 400,
							headers: { "content-type": "application/json" },
						},
					),
			),
		);

		const message = await stream(model, { messages: [] }, { apiKey: "test-key" }).result();

		expect(message.stopReason).toBe("error");
		expect(message.errorMessage).toContain("HTTP 400");
		expect(message.errorMessage).toContain("hosted_control_not_allowed");
		expect(message.errorMessage).toContain("Invalid body");
		expect(message.errorMessage).toContain("context");
		expect(message.errorMessage).toContain("Upgrade the CLI");
	});

	it("preserves structured input-limit metadata on an HTTP 413 before stream content", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(
						JSON.stringify({
							error: "Input exceeds the platform token limit.",
							code: "input_limit_exceeded",
							details: { input_tokens: 126_977, max_input_tokens: 126_976, ignored: "secret" },
						}),
						{ status: 413, headers: { "content-type": "application/json" } },
					),
			),
		);

		const message = await stream(model, { messages: [] }, { apiKey: "test-key" }).result();

		expect(message).toMatchObject({
			stopReason: "error",
			errorCode: "input_limit_exceeded",
			errorStatus: 413,
			errorDetails: { input_tokens: 126_977, max_input_tokens: 126_976 },
		});
		expect(message.errorDetails).not.toHaveProperty("ignored");
		expect(isContextOverflow(message, model.contextWindow)).toBe(true);
	});

	it("does not classify a streamed input-limit error after an ad event as replay-safe", async () => {
		mockNdjsonFetch([
			{ type: "ad", status: "live", ads: [] },
			{
				type: "error",
				code: "input_limit_exceeded",
				status_code: 413,
				message: "Input exceeds the platform token limit.",
				details: { input_tokens: 126_977, max_input_tokens: 126_976 },
			},
		]);

		const message = await stream(model, { messages: [] }, { apiKey: "test-key" }).result();

		expect(message.errorDetails).toMatchObject({ response_events_consumed: 1 });
		expect(isContextOverflow(message, model.contextWindow)).toBe(false);
	});

	it("parses router reasoning content as a thinking block", async () => {
		mockFetch({
			assistant: {
				reasoning_content: "I should call a tool.",
				content: "",
				tool_calls: [{ id: "call_1", name: "read_file", arguments: { path: "package.json" } }],
			},
			ads: [],
		});

		const message = await stream(model, { messages: [] }, { apiKey: "test-key" }).result();

		expect(message.stopReason).toBe("toolUse");
		expect(message.content[0]).toEqual({
			type: "thinking",
			thinking: "I should call a tool.",
			thinkingSignature: "reasoning_content",
		});
		expect(message.content[1]).toMatchObject({ type: "toolCall", id: "call_1", name: "read_file" });
	});
});
