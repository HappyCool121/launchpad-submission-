import { ADROUTER_HOSTED_LIMITS } from "./providers/adrouter.models.ts";

export const ADROUTER_PROVIDER_ID = "adrouter";
export const DEFAULT_ADROUTER_API_URL = "https://api-staging.adrouter.co";
export const OFFICIAL_ADROUTER_API_ORIGINS = ["https://api-staging.adrouter.co", "https://api.adrouter.co"] as const;
export const ADROUTER_HOSTED_CONTEXT_WINDOW_TOKENS = ADROUTER_HOSTED_LIMITS.contextWindowTokens;
export const ADROUTER_HOSTED_MAX_INPUT_TOKENS = ADROUTER_HOSTED_LIMITS.maxInputTokens;
export const ADROUTER_HOSTED_MAX_OUTPUT_TOKENS = ADROUTER_HOSTED_LIMITS.maxOutputTokens;
export const ADROUTER_HOSTED_COMPACTION_RESERVE_TOKENS = 16_384;
export const ADROUTER_HOSTED_PROACTIVE_INPUT_TOKENS =
	ADROUTER_HOSTED_CONTEXT_WINDOW_TOKENS - ADROUTER_HOSTED_COMPACTION_RESERVE_TOKENS;

export interface AdRouterApiUrlSources {
	environmentUrl?: string;
	credentialUrl?: string;
	modelUrl?: string;
}

export interface AdRouterProfile {
	id: string;
	role?: string;
	status?: string;
	authSource?: string;
	credentialId?: string;
	mode?: string;
}

export interface ValidateAdRouterApiKeyOptions {
	apiKey: string;
	apiUrl?: string;
	signal?: AbortSignal;
	timeoutMs?: number;
	fetchImpl?: typeof fetch;
}

function sanitizeErrorText(value: unknown, fallback = ""): string {
	return String(value ?? fallback)
		.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
		.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
		.replace(/\b(?:Bearer|DPoP)\s+[^\s,;]+/gi, "[redacted authorization]")
		.replace(/\badr_(?:live|test)_[A-Za-z0-9_-]+\b/g, "[redacted credential]")
		.replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[redacted proof]")
		.trim()
		.slice(0, 800);
}

function errorDetailsText(value: unknown): string {
	if (!value || typeof value !== "object") return "";
	try {
		return sanitizeErrorText(JSON.stringify(value));
	} catch {
		return "";
	}
}

function errorGuidance(code: string | undefined, status: number): string {
	switch (code) {
		case "invalid_api_key":
			return "For a custom router, replace its bearer key. Official hosted access requires /login adrouter installation approval.";
		case "installation_required":
		case "invalid_installation":
		case "refresh_family_expired":
		case "refresh_reuse_detected":
			return "Run /login adrouter to approve a new CLI installation.";
		case "client_upgrade_required":
			return "Update AdRouterCLI to the required minimum version before retrying.";
		case "account_inactive":
			return "Activate the account in app-staging.adrouter.co before retrying.";
		case "model_forbidden":
			return "This account is not enabled for the selected AdRouter model.";
		case "input_limit_exceeded":
			return "Run /compact or reduce the current session context before retrying.";
		case "concurrency_limit":
			return "Wait for the other AdRouter request to finish, then retry.";
		case "user_budget_limit":
			return "The account has reached its configured AdRouter spend limit.";
		case "platform_budget_limit":
		case "traffic_disabled":
			return "API staging is not currently admitting this request. Try again later.";
		case "draining":
			return "API staging is restarting or draining. Try again shortly.";
		case "hosted_control_not_allowed":
			return "This AdRouterCLI build sent a local-only control to the hosted API. Upgrade the CLI or report this compatibility error.";
		default:
			if (status === 401) return "Run /login adrouter to verify or replace this CLI installation.";
			if (status === 429) return "Wait briefly, then retry.";
			if (status >= 500) return "API staging is temporarily unavailable. Try again later.";
			return "";
	}
}

export class AdRouterApiError extends Error {
	readonly status?: number;
	readonly code?: string;
	readonly details?: Readonly<Record<string, number>>;

	constructor(
		message: string,
		options: { status?: number; code?: string; details?: Readonly<Record<string, number>>; cause?: unknown } = {},
	) {
		super(message, options.cause === undefined ? undefined : { cause: options.cause });
		this.name = "AdRouterApiError";
		this.status = options.status;
		this.code = options.code;
		this.details = options.details;
	}
}

function numericErrorDetails(value: unknown): Record<string, number> | undefined {
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
	const details: Record<string, number> = {};
	for (const [key, candidate] of Object.entries(value)) {
		if (!/^[a-zA-Z0-9_]{1,64}$/.test(key)) continue;
		if (typeof candidate !== "number" || !Number.isFinite(candidate)) continue;
		details[key] = candidate;
		if (Object.keys(details).length >= 16) break;
	}
	return Object.keys(details).length > 0 ? details : undefined;
}

export function normalizeAdRouterApiUrl(value: string): string {
	const trimmed = value.trim();
	if (!trimmed) throw new AdRouterApiError("AdRouter API URL cannot be empty.", { code: "invalid_api_url" });

	let url: URL;
	try {
		url = new URL(trimmed);
	} catch (cause) {
		throw new AdRouterApiError("AdRouter API URL must be a valid absolute URL.", {
			code: "invalid_api_url",
			cause,
		});
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		throw new AdRouterApiError("AdRouter API URL must use http or https.", { code: "invalid_api_url" });
	}
	url.hash = "";
	url.search = "";
	return url.toString().replace(/\/+$/, "");
}

export function resolveAdRouterApiUrl(sources: AdRouterApiUrlSources = {}): string {
	return normalizeAdRouterApiUrl(
		sources.environmentUrl || sources.credentialUrl || sources.modelUrl || DEFAULT_ADROUTER_API_URL,
	);
}

export function isOfficialAdRouterApiUrl(value: string): boolean {
	const origin = new URL(normalizeAdRouterApiUrl(value)).origin;
	return (OFFICIAL_ADROUTER_API_ORIGINS as readonly string[]).includes(origin);
}

export function resolveAdRouterAdMode(apiUrl: string, configuredMode?: string): string {
	return configuredMode ?? (isOfficialAdRouterApiUrl(apiUrl) ? "live" : "mock");
}

export async function adRouterApiErrorFromResponse(response: Response): Promise<AdRouterApiError> {
	const fallback = `AdRouter request failed with HTTP ${response.status}`;
	let code: string | undefined;
	let details: Record<string, number> | undefined;
	let message = "";
	try {
		const contentType = response.headers.get("content-type") ?? "";
		const body: unknown = contentType.includes("application/json") ? await response.json() : await response.text();
		if (typeof body === "string") {
			message = sanitizeErrorText(body);
		} else if (body && typeof body === "object") {
			const record = body as Record<string, unknown>;
			const candidateCode = sanitizeErrorText(record.code);
			code = /^[a-z0-9_]{1,64}$/.test(candidateCode) ? candidateCode : undefined;
			details = numericErrorDetails(record.details);
			message = [
				sanitizeErrorText(record.error),
				sanitizeErrorText(record.message),
				errorDetailsText(record.details),
			]
				.filter(Boolean)
				.join(" ");
		}
	} catch {
		// Use the status-only fallback when an error body cannot be decoded safely.
	}
	if (response.status === 401 || response.status === 403 || response.status === 426) message = "";

	const guidance = errorGuidance(code, response.status);
	const codeLabel = code ? ` [${code}]` : "";
	const detail = message ? `: ${message}` : "";
	const suffix = guidance ? ` ${guidance}` : "";
	return new AdRouterApiError(`${fallback}${codeLabel}${detail}${suffix}`, {
		status: response.status,
		code,
		details,
	});
}

export async function validateAdRouterApiKey(options: ValidateAdRouterApiKeyOptions): Promise<AdRouterProfile> {
	const apiKey = options.apiKey.trim();
	if (!apiKey) throw new AdRouterApiError("AdRouter API key cannot be empty.", { code: "invalid_api_key" });

	const apiUrl = normalizeAdRouterApiUrl(options.apiUrl ?? DEFAULT_ADROUTER_API_URL);
	const timeoutMs = options.timeoutMs ?? 10_000;
	const controller = new AbortController();
	let timedOut = false;
	const timeout = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, timeoutMs);
	const abortFromCaller = () => controller.abort(options.signal?.reason);
	options.signal?.addEventListener("abort", abortFromCaller, { once: true });

	try {
		const fetchImpl = options.fetchImpl ?? globalThis.fetch;
		const response = await fetchImpl(`${apiUrl}/v1/profile`, {
			method: "GET",
			headers: {
				accept: "application/json",
				authorization: `Bearer ${apiKey}`,
			},
			signal: controller.signal,
		});
		if (!response.ok) throw await adRouterApiErrorFromResponse(response);

		const body = (await response.json()) as Record<string, unknown>;
		const id = sanitizeErrorText(body.id);
		if (!id) {
			throw new AdRouterApiError("AdRouter returned an invalid profile response.", {
				status: response.status,
				code: "invalid_profile_response",
			});
		}
		return {
			id,
			role: sanitizeErrorText(body.role) || undefined,
			status: sanitizeErrorText(body.status) || undefined,
			authSource: sanitizeErrorText(body.auth_source) || undefined,
			credentialId: sanitizeErrorText(body.credential_id) || undefined,
			mode: sanitizeErrorText(body.mode) || undefined,
		};
	} catch (error) {
		if (error instanceof AdRouterApiError) throw error;
		if (timedOut) {
			throw new AdRouterApiError(
				`AdRouter API key validation timed out after ${Math.ceil(timeoutMs / 1000)} seconds.`,
				{
					code: "network_timeout",
					cause: error,
				},
			);
		}
		if (options.signal?.aborted) throw error;
		throw new AdRouterApiError(`Could not reach AdRouter at ${apiUrl}.`, {
			code: "network_error",
			cause: error,
		});
	} finally {
		clearTimeout(timeout);
		options.signal?.removeEventListener("abort", abortFromCaller);
	}
}
