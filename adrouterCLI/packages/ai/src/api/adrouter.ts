import {
	ADROUTER_HOSTED_CONTEXT_WINDOW_TOKENS,
	ADROUTER_HOSTED_MAX_INPUT_TOKENS,
	ADROUTER_HOSTED_MAX_OUTPUT_TOKENS,
	ADROUTER_HOSTED_PROACTIVE_INPUT_TOKENS,
	AdRouterApiError,
	adRouterApiErrorFromResponse,
	isOfficialAdRouterApiUrl,
	resolveAdRouterAdMode,
	resolveAdRouterApiUrl,
} from "../adrouter-config.ts";
import {
	type AdRouterAd,
	type AdRouterAdUpdate,
	type AdRouterInjection,
	type AdRouterSettlement,
	associateAdRouterMessage,
	publishAdRouterAds,
} from "../adrouter-events.ts";
import { areAdRouterAdsEnabled } from "../adrouter-settings.ts";
import { ADROUTER_CATALOG_METADATA } from "../providers/adrouter.models.ts";
import type {
	Api,
	AssistantMessage,
	Context,
	Message,
	Model,
	SimpleStreamOptions,
	StreamOptions,
	ToolCall,
	Usage,
} from "../types.ts";
import { estimateContextTokens, estimateTextTokens } from "../utils/estimate.ts";
import { AssistantMessageEventStream } from "../utils/event-stream.ts";
import { isValidAdRouterNonce } from "./adrouter-installation-auth-types.ts";
import { transformMessages } from "./transform-messages.ts";

interface RouterAssistant {
	content?: unknown;
	delta?: unknown;
	reasoning_content?: unknown;
	tool_calls?: unknown;
	toolCalls?: unknown;
}

interface RouterResponse {
	turn_id?: unknown;
	assistant?: RouterAssistant;
	ad?: unknown;
	ads?: unknown;
	injection?: unknown;
	usage?: Partial<Usage>;
	settlement?: unknown;
	status?: unknown;
}

interface RouterStreamEvent {
	type?: unknown;
	code?: unknown;
	status_code?: unknown;
	details?: unknown;
	ad?: unknown;
	ads?: unknown;
	injection?: unknown;
	status?: unknown;
	content?: unknown;
	delta?: unknown;
	tool_call?: unknown;
	settlement?: unknown;
	turn_id?: unknown;
	usage?: unknown;
	assistant?: RouterAssistant;
	message?: unknown;
}

const RESPONSE_CONTENT_EVENT_TYPES = new Set(["ad", "text", "thinking", "tool_call", "settlement", "done"]);

const EMPTY_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function usageFromRouter(input: Partial<Usage> | undefined): Usage {
	return {
		...EMPTY_USAGE,
		...input,
		cost: { ...EMPTY_USAGE.cost, ...input?.cost },
	};
}

function sanitizeTerminalText(value: unknown, fallback = ""): string {
	return String(value ?? fallback)
		.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
		.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
		.trim();
}

function sanitizeErrorCode(value: unknown): string | undefined {
	const code = sanitizeTerminalText(value);
	return /^[a-z0-9_]{1,64}$/.test(code) ? code : undefined;
}

function sanitizeNumericErrorDetails(value: unknown): Record<string, number> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	const details: Record<string, number> = {};
	for (const [key, candidate] of Object.entries(value)) {
		if (!/^[a-zA-Z0-9_]{1,64}$/.test(key)) continue;
		if (typeof candidate !== "number" || !Number.isFinite(candidate)) continue;
		details[key] = candidate;
		if (Object.keys(details).length >= 16) break;
	}
	return details;
}

export function assertAdRouterHostedInputWithinLimit(context: Context): number {
	const estimate = estimateContextTokens(context);
	let estimatedInputTokens = estimate.tokens;
	// Reported usage describes the prior request prefix. Count the current prefix again when
	// usage is present because extensions may have changed the system prompt or tool schemas.
	// The deliberate overestimate is safer than silently delaying hosted compaction.
	if (estimate.lastUsageIndex !== null) {
		if (context.systemPrompt) estimatedInputTokens += estimateTextTokens(context.systemPrompt);
		if (context.tools?.length) estimatedInputTokens += estimateTextTokens(JSON.stringify(context.tools));
	}
	if (estimatedInputTokens <= ADROUTER_HOSTED_PROACTIVE_INPUT_TOKENS) return estimatedInputTokens;

	throw new AdRouterApiError(
		"AdRouter context exceeds the proactive compaction threshold. " +
			"AdRouterCLI will compact once before sending; if it remains too large, run /compact or reduce or split the largest message or tool input.",
		{
			code: "input_limit_exceeded",
			details: {
				estimated_input_tokens: estimatedInputTokens,
				proactive_input_tokens: ADROUTER_HOSTED_PROACTIVE_INPUT_TOKENS,
				max_input_tokens: ADROUTER_HOSTED_MAX_INPUT_TOKENS,
				context_window_tokens: ADROUTER_HOSTED_CONTEXT_WINDOW_TOKENS,
				local_preflight: 1,
			},
		},
	);
}

function modelText(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function normalizeAdTier(value: unknown): AdRouterAd["tier"] | undefined {
	if (value === 1 || value === "1" || value === "A") return "A";
	if (value === 2 || value === "2" || value === "B") return "B";
	if (value === 3 || value === "3" || value === "C") return "C";
	if (value === "NONE") return "NONE";
	return undefined;
}

function parseCliAdRecord(record: Record<string, unknown>): AdRouterAd[] {
	const title = sanitizeTerminalText(record.title);
	const body = sanitizeTerminalText(record.body);
	const tier = normalizeAdTier(record.tier) ?? "C";
	if (!title || !body) return [];
	return [
		{
			id: sanitizeTerminalText(record.id, `ad-${Date.now()}`),
			tier,
			campaignId: sanitizeTerminalText(record.campaign_id),
			reasonCode: sanitizeTerminalText(record.reason_code),
			title,
			body,
			cta: sanitizeTerminalText(record.cta),
			url: sanitizeTerminalText(record.url),
			label: sanitizeTerminalText(record.label, "Sponsored") || "Sponsored",
		},
	];
}

function parseAds(value: unknown): AdRouterAd[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap((item): AdRouterAd[] => {
		if (!item || typeof item !== "object") return [];
		return parseCliAdRecord(item as Record<string, unknown>);
	});
}

function parseRouterAd(value: unknown): AdRouterAd[] {
	if (!value || typeof value !== "object") return [];
	const record = value as Record<string, unknown>;
	const tier = normalizeAdTier(record.tier);
	if (!tier) return [];
	if (tier === "NONE") {
		return [
			{
				id: sanitizeTerminalText(record.id, `ad-${Date.now()}`),
				tier,
				campaignId: sanitizeTerminalText(record.campaign_id),
				reasonCode: sanitizeTerminalText(record.reason_code),
				title: "No sponsored content",
				body: sanitizeTerminalText(record.reason, "Routed without sponsored content."),
				label: "TIER NONE",
			},
		];
	}
	const sponsor =
		record.sponsor && typeof record.sponsor === "object" ? (record.sponsor as Record<string, unknown>) : undefined;
	const title = sanitizeTerminalText(record.title ?? sponsor?.brand_name);
	const body = sanitizeTerminalText(record.body ?? sponsor?.ad_copy);
	if (!title || !body) {
		return [
			{
				id: sanitizeTerminalText(record.id, `ad-${Date.now()}`),
				tier,
				title: "No sponsor content available",
				body: sanitizeTerminalText(record.reason, "Baseline routing fallback."),
				label: "TIER C",
			},
		];
	}
	const url = sanitizeTerminalText(record.url ?? sponsor?.click_url);
	return [
		{
			id: sanitizeTerminalText(record.id, `ad-${Date.now()}`),
			tier,
			campaignId: sanitizeTerminalText(record.campaign_id),
			reasonCode: sanitizeTerminalText(record.reason_code),
			title,
			body,
			cta: sanitizeTerminalText(record.cta, url ? "Learn more" : ""),
			url,
			label: sanitizeTerminalText(record.label, "Sponsored") || "Sponsored",
		},
	];
}

function parseAnyAds(ads: unknown, ad: unknown): AdRouterAd[] {
	const normalizedAds = parseAds(ads);
	return normalizedAds.length > 0 ? normalizedAds : parseRouterAd(ad);
}

function isOptOut(ads: AdRouterAd[]): boolean {
	return ads.some((ad) => ad.reasonCode === "user_opt_out");
}

function isGuardrail(ads: AdRouterAd[]): boolean {
	return ads.some((ad) => ad.reasonCode === "guardrail");
}

function isDegradedOutcome(ads: AdRouterAd[]): boolean {
	return ads.some((ad) => ad.reasonCode === "routing_failure" || ad.reasonCode === "no_inventory");
}

function parseRouterStatus(value: unknown): AdRouterAdUpdate["status"] | undefined {
	return value === "live" ||
		value === "mock" ||
		value === "off" ||
		value === "degraded" ||
		value === "privacy_protected"
		? value
		: undefined;
}

function presentationForRouterOutcome(
	ads: AdRouterAd[],
	backendStatus: AdRouterAdUpdate["status"] | undefined,
	adMode: string,
	adsEnabled: boolean,
): Pick<AdRouterAdUpdate, "ads" | "status"> {
	if (!adsEnabled || backendStatus === "off" || isOptOut(ads)) return { ads: [], status: "off" };
	if (backendStatus === "degraded" || isDegradedOutcome(ads)) return { ads: [], status: "degraded" };
	if (backendStatus === "privacy_protected" || isGuardrail(ads)) {
		return { ads: ads.filter((ad) => ad.tier === "NONE"), status: "privacy_protected" };
	}
	if (ads.length > 0) return { ads, status: backendStatus === "mock" ? "mock" : "live" };
	if (backendStatus === "mock" || adMode === "mock") return { ads: [mockAd()], status: "mock" };
	return { ads: [], status: "degraded" };
}

function parseInjection(value: unknown): AdRouterInjection | undefined {
	if (!value || typeof value !== "object") return undefined;
	const record = value as Record<string, unknown>;
	return {
		mode: sanitizeTerminalText(record.mode),
		placement: sanitizeTerminalText(record.placement),
		refresh_after_turn: typeof record.refresh_after_turn === "boolean" ? record.refresh_after_turn : undefined,
	};
}

function turnIdFromValue(value: unknown): string | undefined {
	if (!value || typeof value !== "object") return undefined;
	const valueId = (value as Record<string, unknown>).turn_id;
	return typeof valueId === "string" && valueId ? valueId : undefined;
}

function turnIdFromEvent(value: RouterStreamEvent): string | undefined {
	if (typeof value.turn_id === "string" && value.turn_id) return value.turn_id;
	return turnIdFromValue(value.ad);
}

function parseSettlement(value: unknown): AdRouterSettlement | undefined {
	if (!value || typeof value !== "object") return undefined;
	const record = value as Record<string, unknown>;
	return {
		provider: sanitizeTerminalText(record.provider),
		model: sanitizeTerminalText(record.model),
		cache_hit_tokens: typeof record.cache_hit_tokens === "number" ? record.cache_hit_tokens : undefined,
		cache_miss_tokens: typeof record.cache_miss_tokens === "number" ? record.cache_miss_tokens : undefined,
		prompt_cost: typeof record.prompt_cost === "number" ? record.prompt_cost : undefined,
		ad_subsidy: typeof record.ad_subsidy === "number" ? record.ad_subsidy : undefined,
		paid: typeof record.paid === "number" ? record.paid : undefined,
		usage: parseNumericRecord(record.usage),
		cost: parseNumericRecord(record.cost),
	};
}

function parseNumericRecord(value: unknown): Record<string, number> | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const result: Record<string, number> = {};
	for (const [key, candidate] of Object.entries(value)) {
		if (typeof candidate === "number") result[key] = candidate;
	}
	return Object.keys(result).length > 0 ? result : undefined;
}

function parseToolCalls(value: unknown): ToolCall[] {
	if (!Array.isArray(value)) return [];
	return value.flatMap((item): ToolCall[] => {
		if (!item || typeof item !== "object") return [];
		const record = item as Record<string, unknown>;
		const fn =
			typeof record.function === "object" && record.function
				? (record.function as Record<string, unknown>)
				: undefined;
		const id = record.id;
		const name = record.name ?? fn?.name;
		if (typeof id !== "string" || !id) {
			throw new Error("AdRouter returned a tool call without a stable ID");
		}
		if (typeof name !== "string" || !name) {
			throw new Error(`AdRouter returned tool call ${id} without a name`);
		}
		const rawArguments = record.arguments ?? fn?.arguments ?? {};
		let parsedArguments: Record<string, unknown> = {};
		if (typeof rawArguments === "string") {
			try {
				const parsed = JSON.parse(rawArguments);
				if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
					parsedArguments = parsed as Record<string, unknown>;
				}
			} catch {
				parsedArguments = {};
			}
		} else if (rawArguments && typeof rawArguments === "object" && !Array.isArray(rawArguments)) {
			parsedArguments = rawArguments as Record<string, unknown>;
		}
		return [
			{
				type: "toolCall",
				id,
				name,
				arguments: parsedArguments,
			},
		];
	});
}

function createMessage(
	model: Model<Api>,
	response: RouterResponse,
	contentText: string,
	reasoningText: string,
	toolCalls: ToolCall[],
	stopReason: AssistantMessage["stopReason"] = toolCalls.length > 0 ? "toolUse" : "stop",
	errorMessage?: string,
): AssistantMessage {
	return {
		role: "assistant",
		content: [
			...(reasoningText
				? [{ type: "thinking" as const, thinking: reasoningText, thinkingSignature: "reasoning_content" }]
				: []),
			...(contentText ? [{ type: "text" as const, text: contentText }] : []),
			...toolCalls,
		],
		api: model.api,
		provider: model.provider,
		model: model.id,
		responseModel: process.env.ADROUTER_MODEL_ROUTE ?? model.id,
		usage: usageFromRouter(response.usage),
		stopReason,
		errorMessage,
		timestamp: Date.now(),
	};
}

function beginMessage(model: Model<Api>, usage?: Partial<Usage>): AssistantMessage {
	return createMessage(model, { usage }, "", "", [], "stop");
}

function emitMessage(stream: AssistantMessageEventStream, message: AssistantMessage): void {
	stream.push({ type: "start", partial: message });
	for (let i = 0; i < message.content.length; i++) {
		const content = message.content[i];
		if (content.type === "thinking") {
			stream.push({ type: "thinking_start", contentIndex: i, partial: message });
			stream.push({ type: "thinking_delta", contentIndex: i, delta: content.thinking, partial: message });
			stream.push({ type: "thinking_end", contentIndex: i, content: content.thinking, partial: message });
		} else if (content.type === "text") {
			stream.push({ type: "text_start", contentIndex: i, partial: message });
			stream.push({ type: "text_delta", contentIndex: i, delta: content.text, partial: message });
			stream.push({ type: "text_end", contentIndex: i, content: content.text, partial: message });
		} else if (content.type === "toolCall") {
			stream.push({ type: "toolcall_start", contentIndex: i, partial: message });
			stream.push({ type: "toolcall_end", contentIndex: i, toolCall: content, partial: message });
		}
	}
	if (message.stopReason === "error" || message.stopReason === "aborted") {
		stream.push({ type: "error", reason: message.stopReason, error: message });
	} else {
		stream.push({ type: "done", reason: message.stopReason, message });
	}
	stream.end(message);
}

function ensureTextBlock(message: AssistantMessage): number {
	const index = message.content.findIndex((content) => content.type === "text");
	if (index !== -1) return index;
	message.content.push({ type: "text", text: "" });
	return message.content.length - 1;
}

function ensureThinkingBlock(message: AssistantMessage): number {
	const index = message.content.findIndex((content) => content.type === "thinking");
	if (index !== -1) return index;
	message.content.push({ type: "thinking", thinking: "", thinkingSignature: "reasoning_content" });
	return message.content.length - 1;
}

function appendTextDelta(
	stream: AssistantMessageEventStream,
	message: AssistantMessage,
	delta: string,
	textStarted: { value: boolean },
): void {
	const contentIndex = ensureTextBlock(message);
	const block = message.content[contentIndex];
	if (block.type !== "text") return;
	if (!textStarted.value) {
		textStarted.value = true;
		stream.push({ type: "text_start", contentIndex, partial: message });
	}
	block.text += delta;
	stream.push({ type: "text_delta", contentIndex, delta, partial: message });
}

function appendThinkingDelta(
	stream: AssistantMessageEventStream,
	message: AssistantMessage,
	delta: string,
	thinkingStarted: { value: boolean },
): void {
	const contentIndex = ensureThinkingBlock(message);
	const block = message.content[contentIndex];
	if (block.type !== "thinking") return;
	if (!thinkingStarted.value) {
		thinkingStarted.value = true;
		stream.push({ type: "thinking_start", contentIndex, partial: message });
	}
	block.thinking += delta;
	stream.push({ type: "thinking_delta", contentIndex, delta, partial: message });
}

function appendToolCall(stream: AssistantMessageEventStream, message: AssistantMessage, toolCall: ToolCall): void {
	const existing = message.content.find(
		(content): content is ToolCall => content.type === "toolCall" && content.id === toolCall.id,
	);
	if (existing) {
		if (
			existing.name !== toolCall.name ||
			JSON.stringify(existing.arguments) !== JSON.stringify(toolCall.arguments)
		) {
			throw new Error(`AdRouter returned conflicting tool calls with ID ${toolCall.id}`);
		}
		return;
	}
	const contentIndex = message.content.length;
	message.content.push(toolCall);
	message.stopReason = "toolUse";
	stream.push({ type: "toolcall_start", contentIndex, partial: message });
	stream.push({ type: "toolcall_end", contentIndex, toolCall, partial: message });
}

function createErrorStream(model: Model<Api>, error: unknown): AssistantMessageEventStream {
	const stream = new AssistantMessageEventStream();
	const message = createMessage(
		model,
		{},
		"",
		"",
		[],
		"error",
		error instanceof Error ? error.message : String(error),
	);
	if (error instanceof AdRouterApiError) {
		message.errorCode = error.code;
		message.errorStatus = error.status;
		message.errorDetails = error.details ? { ...error.details } : undefined;
	}
	publishAdRouterAds({
		ads: [],
		status: "degraded",
		error: message.errorMessage,
	});
	emitMessage(stream, message);
	return stream;
}

function mapThinkingLevel(modelId: string, value: unknown): "none" | "medium" | "high" {
	if (value === undefined) {
		const metadata = ADROUTER_CATALOG_METADATA[modelId as keyof typeof ADROUTER_CATALOG_METADATA];
		return metadata?.defaultThinkingLevel ?? "medium";
	}
	if (value === "off" || value === "minimal") return "none";
	if (value === "high" || value === "xhigh" || value === "max") return "high";
	return "medium";
}

function resolveRouterModel(model: Model<Api>): string {
	return process.env.ADROUTER_MODEL_ROUTE ?? model.id;
}

function toolCallSignature(toolCall: ToolCall): string {
	return JSON.stringify({ name: toolCall.name, arguments: toolCall.arguments });
}

function normalizeMessagesForRouter(model: Model<Api>, messages: Message[]): Message[] {
	const transformed = transformMessages(messages, model, (id) => {
		if (!id.includes("|")) return id;
		const [callId] = id.split("|");
		return callId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 40);
	});
	const knownCalls = new Map<string, string>();
	const knownResults = new Map<string, string>();
	const normalized: Message[] = [];

	for (const message of transformed) {
		if (message.role === "assistant") {
			const content = message.content.filter((block) => {
				if (block.type !== "toolCall") return true;
				if (!block.id || !block.name) throw new Error("Invalid tool call in AdRouter session context");
				const signature = toolCallSignature(block);
				const existing = knownCalls.get(block.id);
				if (existing === undefined) {
					knownCalls.set(block.id, signature);
					return true;
				}
				if (existing !== signature) {
					throw new Error(`Conflicting tool calls reuse ID ${block.id} in AdRouter session context`);
				}
				return false;
			});
			normalized.push({ ...message, content });
			continue;
		}
		if (message.role === "toolResult") {
			if (!message.toolCallId) throw new Error("Tool result is missing an ID in AdRouter session context");
			const signature = JSON.stringify({
				toolName: message.toolName,
				content: message.content,
				isError: message.isError,
			});
			const existing = knownResults.get(message.toolCallId);
			if (existing === undefined) {
				knownResults.set(message.toolCallId, signature);
				normalized.push(message);
			} else if (existing !== signature) {
				throw new Error(`Conflicting tool results reuse ID ${message.toolCallId} in AdRouter session context`);
			}
			continue;
		}
		normalized.push(message);
	}

	return normalized;
}

function buildRouterBody(
	model: Model<Api>,
	context: Context,
	baseUrl: string,
	adMode: string,
	options?: StreamOptions,
): Record<string, unknown> {
	const extendedOptions = options as StreamOptions & { reasoning?: unknown };
	const runtimeMode = (options?.env?.ADROUTER_RUNTIME_MODE ?? process.env.ADROUTER_RUNTIME_MODE)?.trim().toLowerCase();
	const officialHosted = isOfficialAdRouterApiUrl(baseUrl);
	if (officialHosted && runtimeMode === "mock") {
		throw new AdRouterApiError(
			"ADROUTER_RUNTIME_MODE=mock is only available with a local or custom AdRouter API URL. Hosted AdRouter traffic is always live.",
			{ code: "hosted_mock_not_allowed" },
		);
	}
	if (runtimeMode && runtimeMode !== "auto" && runtimeMode !== "mock" && runtimeMode !== "live") {
		throw new AdRouterApiError("ADROUTER_RUNTIME_MODE must be auto, mock, or live.", {
			code: "invalid_runtime_mode",
		});
	}
	const routerModel = resolveRouterModel(model);

	const body: Record<string, unknown> = {
		model: routerModel,
		thinking_level: mapThinkingLevel(routerModel, extendedOptions?.reasoning),
		context: {
			...context,
			messages: normalizeMessagesForRouter(model, context.messages),
		},
		metadata: {
			client: "adrouterCLI",
			workspace: process.env.ADROUTER_WORKSPACE ?? (typeof process !== "undefined" ? process.cwd() : undefined),
			ad_mode: adMode,
			ads_enabled: areAdRouterAdsEnabled(),
			min_ad_tier: process.env.ADROUTER_MIN_AD_TIER ?? "3",
		},
	};
	if (!officialHosted && (runtimeMode === "mock" || runtimeMode === "live")) {
		body.runtime_mode = runtimeMode;
	}
	if (options?.maxTokens !== undefined && Number.isFinite(options.maxTokens) && options.maxTokens > 0) {
		body.max_output_tokens = Math.min(Math.floor(options.maxTokens), ADROUTER_HOSTED_MAX_OUTPUT_TOKENS);
	}
	return body;
}

async function fetchRouter(
	model: Model<Api>,
	context: Context,
	options?: StreamOptions,
): Promise<{ response: Response; adMode: string }> {
	const baseUrl = resolveAdRouterApiUrl({
		environmentUrl: options?.env?.ADROUTER_API_URL,
		modelUrl: model.baseUrl,
	});
	const adMode = resolveAdRouterAdMode(baseUrl, options?.env?.ADROUTER_AD_MODE ?? process.env.ADROUTER_AD_MODE);
	const url = `${baseUrl}/v1/agent/turn`;
	const officialHosted = isOfficialAdRouterApiUrl(baseUrl);
	if (officialHosted) assertAdRouterHostedInputWithinLimit(context);
	const body = new TextEncoder().encode(JSON.stringify(buildRouterBody(model, context, baseUrl, adMode, options)));
	const callerHeaders = new Headers();
	const protectedHeaders = new Set([
		"authorization",
		"dpop",
		"content-digest",
		"content-type",
		"x-adrouter-client-kind",
		"x-adrouter-client-version",
	]);
	for (const [name, value] of Object.entries(options?.headers ?? {})) {
		if (value !== null && !protectedHeaders.has(name.toLowerCase())) callerHeaders.set(name, value);
	}
	callerHeaders.set("accept", callerHeaders.get("accept") ?? "application/x-ndjson, application/json");
	callerHeaders.set("content-type", "application/json");

	let response: Response;
	if (officialHosted) {
		const auth = options?.adrouterAuth;
		const origin = new URL(baseUrl).origin;
		if (!auth?.canAuthenticate(origin)) {
			throw new AdRouterApiError(
				"This hosted AdRouter endpoint requires an approved CLI installation. Run /login adrouter.",
				{
					code: "installation_required",
				},
			);
		}
		const access = await auth.getAccess(origin, options?.signal);
		const send = async (nonce?: string): Promise<Response> => {
			const headers = new Headers(callerHeaders);
			const signed = await auth.signProof(origin, {
				method: "POST",
				url,
				body,
				accessToken: access.accessToken,
				nonce,
			});
			headers.set("authorization", `DPoP ${access.accessToken}`);
			headers.set("content-digest", signed.contentDigest);
			headers.set("x-adrouter-client-kind", access.clientKind);
			headers.set("x-adrouter-client-version", access.clientVersion);
			headers.set("dpop", signed.proof);
			const result = await fetch(url, {
				method: "POST",
				headers,
				body,
				signal: options?.signal,
				redirect: "error",
			});
			if (result.redirected)
				throw new AdRouterApiError("Authenticated redirects are not allowed", { code: "redirect_rejected" });
			return result;
		};
		response = await send();
		let nonce = response.headers.get("dpop-nonce");
		if (response.status === 401 && isValidAdRouterNonce(nonce)) {
			await response.body?.cancel();
			auth.rememberNonce(origin, nonce);
			response = await send(nonce);
			nonce = response.headers.get("dpop-nonce");
		}
		if (isValidAdRouterNonce(nonce)) auth.rememberNonce(origin, nonce);
	} else {
		const apiKey = options?.apiKey ?? options?.env?.ADROUTER_API_KEY;
		if (!apiKey) throw new Error("ADROUTER_API_KEY is not configured for the custom AdRouter endpoint");
		callerHeaders.set("authorization", `Bearer ${apiKey}`);
		response = await fetch(url, {
			method: "POST",
			headers: callerHeaders,
			body,
			signal: options?.signal,
			redirect: "error",
		});
		if (response.redirected)
			throw new AdRouterApiError("Authenticated redirects are not allowed", { code: "redirect_rejected" });
	}
	if (!response.ok) {
		throw await adRouterApiErrorFromResponse(response);
	}
	return { response, adMode };
}

function mockAd(): AdRouterAd {
	return {
		id: "mock-tier-3-001",
		tier: "C",
		title: "Developer Tooling",
		body: "Mock sponsored message for validating the AdRouterCLI ad surface.",
		cta: "Learn more",
		url: "https://example.com",
		label: "Sponsored",
	};
}

export function stream(model: Model<Api>, context: Context, options?: StreamOptions): AssistantMessageEventStream {
	const output = new AssistantMessageEventStream();
	(async () => {
		try {
			const { response, adMode } = await fetchRouter(model, context, options);
			const contentType = response.headers.get("content-type") ?? "";
			if (contentType.includes("application/x-ndjson") && response.body) {
				await consumeNdjsonStream(output, model, response, adMode);
				return;
			}
			const jsonResponse = (await response.json()) as RouterResponse;
			emitRouterJson(output, model, jsonResponse, adMode);
		} catch (error) {
			const failed = createErrorStream(model, error);
			for await (const event of failed) {
				output.push(event);
			}
			output.end(await failed.result());
		}
	})();
	return output;
}

function emitRouterJson(
	output: AssistantMessageEventStream,
	model: Model<Api>,
	response: RouterResponse,
	adMode: string,
): void {
	const contentText = modelText(response.assistant?.content);
	const reasoningText = modelText(response.assistant?.reasoning_content);
	const toolCalls = parseToolCalls(response.assistant?.tool_calls ?? response.assistant?.toolCalls);
	const ads = parseAnyAds(response.ads, response.ad);
	const adsEnabled = areAdRouterAdsEnabled();
	const presentation = presentationForRouterOutcome(ads, parseRouterStatus(response.status), adMode, adsEnabled);
	const update: Omit<AdRouterAdUpdate, "timestamp"> = {
		turnId:
			turnIdFromValue(response) ??
			turnIdFromValue(response.ad) ??
			(Array.isArray(response.ads) ? turnIdFromValue(response.ads[0]) : undefined),
		ads: presentation.ads,
		injection: parseInjection(response.injection),
		settlement: parseSettlement(response.settlement),
		status: presentation.status,
	};
	publishAdRouterAds(update);
	const message = createMessage(model, response, contentText, reasoningText, toolCalls);
	associateAdRouterMessage(message, { ...update, timestamp: Date.now() });
	emitMessage(output, message);
}

async function consumeNdjsonStream(
	output: AssistantMessageEventStream,
	model: Model<Api>,
	response: Response,
	adMode: string,
): Promise<void> {
	const message = beginMessage(model);
	const textStarted = { value: false };
	const thinkingStarted = { value: false };
	const responseContentEvents = { value: 0 };
	let currentUpdate: AdRouterAdUpdate | undefined;
	output.push({ type: "start", partial: message });

	const decoder = new TextDecoder();
	let buffer = "";
	for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
		buffer += decoder.decode(chunk, { stream: true });
		let newlineIndex = buffer.indexOf("\n");
		while (newlineIndex !== -1) {
			const line = buffer.slice(0, newlineIndex).trim();
			buffer = buffer.slice(newlineIndex + 1);
			if (line) {
				const event = JSON.parse(line) as RouterStreamEvent;
				currentUpdate = handleRouterStreamEvent(
					output,
					message,
					event,
					textStarted,
					thinkingStarted,
					responseContentEvents,
					currentUpdate,
					adMode,
				);
				if (RESPONSE_CONTENT_EVENT_TYPES.has(String(event.type))) responseContentEvents.value++;
				// Let the interactive TUI paint the early ad side-channel before a
				// fast mock response is consumed from the same network chunk.
				if (event.type === "ad") await new Promise<void>((resolve) => setTimeout(resolve, 0));
			}
			newlineIndex = buffer.indexOf("\n");
		}
	}
	buffer += decoder.decode();
	if (buffer.trim()) {
		const finalEvent = JSON.parse(buffer.trim()) as RouterStreamEvent;
		currentUpdate = handleRouterStreamEvent(
			output,
			message,
			finalEvent,
			textStarted,
			thinkingStarted,
			responseContentEvents,
			currentUpdate,
			adMode,
		);
		if (RESPONSE_CONTENT_EVENT_TYPES.has(String(finalEvent.type))) {
			responseContentEvents.value++;
		}
	}
	if (thinkingStarted.value) {
		const contentIndex = message.content.findIndex((content) => content.type === "thinking");
		const block = contentIndex >= 0 ? message.content[contentIndex] : undefined;
		if (contentIndex >= 0 && block?.type === "thinking") {
			output.push({ type: "thinking_end", contentIndex, content: block.thinking, partial: message });
		}
	}
	if (textStarted.value) {
		const contentIndex = message.content.findIndex((content) => content.type === "text");
		const block = contentIndex >= 0 ? message.content[contentIndex] : undefined;
		if (contentIndex >= 0 && block?.type === "text") {
			output.push({ type: "text_end", contentIndex, content: block.text, partial: message });
		}
	}
	if (message.stopReason === "error" || message.stopReason === "aborted") {
		output.end(message);
		return;
	}
	if (currentUpdate) associateAdRouterMessage(message, currentUpdate);
	output.push({ type: "done", reason: message.stopReason === "toolUse" ? "toolUse" : "stop", message });
	output.end(message);
}

function handleRouterStreamEvent(
	output: AssistantMessageEventStream,
	message: AssistantMessage,
	event: RouterStreamEvent,
	textStarted: { value: boolean },
	thinkingStarted: { value: boolean },
	responseContentEvents: { value: number },
	priorUpdate: AdRouterAdUpdate | undefined,
	adMode: string,
): AdRouterAdUpdate | undefined {
	switch (event.type) {
		case "ad": {
			const ads = parseAnyAds(event.ads, event.ad);
			const adsEnabled = areAdRouterAdsEnabled();
			const presentation = presentationForRouterOutcome(ads, parseRouterStatus(event.status), adMode, adsEnabled);
			const update: Omit<AdRouterAdUpdate, "timestamp"> = {
				turnId: turnIdFromEvent(event),
				ads: presentation.ads,
				injection: parseInjection(event.injection),
				status: presentation.status,
			};
			publishAdRouterAds(update);
			return { ...update, timestamp: Date.now() };
		}
		case "text": {
			const delta = modelText(event.content ?? event.delta);
			if (delta) appendTextDelta(output, message, delta, textStarted);
			break;
		}
		case "thinking": {
			const delta = modelText(event.content ?? event.delta);
			if (delta) appendThinkingDelta(output, message, delta, thinkingStarted);
			break;
		}
		case "tool_call": {
			const [toolCall] = parseToolCalls([event.tool_call]);
			if (toolCall) appendToolCall(output, message, toolCall);
			break;
		}
		case "settlement": {
			message.usage = usageFromRouter(event.usage as Partial<Usage> | undefined);
			const update: Omit<AdRouterAdUpdate, "timestamp"> = {
				ads: priorUpdate?.ads ?? [],
				turnId: turnIdFromEvent(event) ?? priorUpdate?.turnId,
				injection: priorUpdate?.injection,
				settlement: parseSettlement(event.settlement),
				status: priorUpdate?.status ?? "degraded",
			};
			publishAdRouterAds(update);
			return { ...update, timestamp: Date.now() };
		}
		case "done": {
			const assistant = event.assistant;
			const assistantText = modelText(assistant?.content);
			const reasoningText = modelText(assistant?.reasoning_content);
			const thinkingBlock = message.content.find((content) => content.type === "thinking");
			if (reasoningText) {
				if (!thinkingBlock) appendThinkingDelta(output, message, reasoningText, thinkingStarted);
				else thinkingBlock.thinking = reasoningText;
			}
			const textBlock = message.content.find((content) => content.type === "text");
			if (assistantText) {
				if (!textBlock) appendTextDelta(output, message, assistantText, textStarted);
				else textBlock.text = assistantText;
			}
			for (const toolCall of parseToolCalls(assistant?.tool_calls ?? assistant?.toolCalls)) {
				appendToolCall(output, message, toolCall);
			}
			break;
		}
		case "error": {
			message.stopReason = "error";
			message.errorMessage = sanitizeTerminalText(event.message, "AdRouter stream error");
			message.errorCode = sanitizeErrorCode(event.code);
			message.errorStatus =
				typeof event.status_code === "number" && Number.isInteger(event.status_code)
					? event.status_code
					: undefined;
			message.errorDetails = {
				...sanitizeNumericErrorDetails(event.details),
				response_events_consumed: responseContentEvents.value,
			};
			const update = { ads: [], status: "degraded" as const, error: message.errorMessage };
			publishAdRouterAds(update);
			output.push({ type: "error", reason: "error", error: message });
			return { ...update, timestamp: Date.now() };
		}
	}
	return priorUpdate;
}

export function streamSimple(
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	return stream(model, context, options);
}
