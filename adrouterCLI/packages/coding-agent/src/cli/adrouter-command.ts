import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { resolveAdRouterAdMode } from "@adrouter/ai";
import { APP_NAME, getSettingsPath, VERSION } from "../config.ts";
import { AdRouterInstallationAuth, resolveAdRouterCredentials } from "../core/adrouter-auth.ts";
import { AuthStorage } from "../core/auth-storage.ts";
import { inspectInstallation } from "../core/installation.ts";

type JsonRecord = Record<string, unknown>;

function hasJsonFlag(args: readonly string[]): boolean {
	return args.includes("--json") || args.includes("--mode=json") || (args.includes("--mode") && args.includes("json"));
}

function stripGlobalFlags(args: readonly string[]): string[] {
	const result: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--json") continue;
		if (arg === "--mode" && args[i + 1] === "json") {
			i++;
			continue;
		}
		if (arg === "--workspace" && args[i + 1]) {
			i++;
			continue;
		}
		if (arg === "--api-key" && args[i + 1]) {
			i++;
			continue;
		}
		if (arg.startsWith("--api-key=")) continue;
		result.push(arg);
	}
	return result;
}

function outputJson(value: JsonRecord): void {
	process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function outputError(message: string, details?: JsonRecord): void {
	outputJson({ ok: false, error: { message, ...details } });
}

function readAdsEnabled(): boolean {
	const path = getSettingsPath();
	if (!existsSync(path)) return true;
	try {
		const parsed = JSON.parse(readFileSync(path, "utf-8")) as JsonRecord;
		return parsed.adsEnabled !== false;
	} catch {
		return true;
	}
}

function writeAdsEnabled(value: boolean): void {
	const path = getSettingsPath();
	let settings: JsonRecord = {};
	if (existsSync(path)) {
		try {
			settings = JSON.parse(readFileSync(path, "utf-8")) as JsonRecord;
		} catch {
			throw new Error(`Cannot update invalid settings file: ${path}`);
		}
	}
	mkdirSync(resolve(path, ".."), { recursive: true });
	writeFileSync(path, `${JSON.stringify({ ...settings, adsEnabled: value }, null, 2)}\n`, "utf-8");
}

function adsStatus(): JsonRecord {
	const hardOverride = process.env.ADROUTER_AD_MODE === "off";
	return {
		enabled: hardOverride ? false : readAdsEnabled(),
		hardOverride,
		message: hardOverride
			? "ADROUTER_AD_MODE=off overrides the saved preference."
			: readAdsEnabled()
				? "Sponsored placements are enabled; eligible turns can receive a subsidy."
				: "WARNING: Ads are off. Sponsorship subsidy is disabled; all turns are charged at full model cost.",
	};
}

export function resolveAdRouterWorkspace(args: readonly string[]): string | undefined {
	const index = args.indexOf("--workspace");
	const raw = index >= 0 ? args[index + 1] : process.env.ADROUTER_WORKSPACE;
	if (!raw) return undefined;
	const workspace = resolve(raw);
	if (!existsSync(workspace) || !statSync(workspace).isDirectory()) {
		throw new Error(`Workspace does not exist or is not a directory: ${workspace}`);
	}
	return workspace;
}

async function checkRouter(url: string): Promise<JsonRecord> {
	try {
		const response = await fetch(`${url}/health`, {
			signal: AbortSignal.timeout(10_000),
		});
		return { status: response.ok ? "live" : "error", reachable: response.ok, httpStatus: response.status };
	} catch (error) {
		return {
			status: "error",
			reachable: false,
			detail: error instanceof Error ? error.message : String(error),
		};
	}
}

async function doctor(cwd: string, authStorage: AuthStorage): Promise<void> {
	const { apiKey, apiUrl, source } = await resolveAdRouterCredentials(authStorage);
	const adMode = resolveAdRouterAdMode(apiUrl, process.env.ADROUTER_AD_MODE);
	const router = await checkRouter(apiUrl);
	const installationManager = new AdRouterInstallationAuth(authStorage);
	const installationAuth = await installationManager.diagnosticsWithServer(AbortSignal.timeout(10_000));
	outputJson({
		ok: true,
		app: APP_NAME,
		version: VERSION,
		cwd,
		router: {
			endpoint: apiUrl,
			...router,
		},
		auth: {
			available: !!apiKey || installationAuth.signedRequests,
			source,
			installation: installationAuth,
		},
		ads: {
			mode: adMode,
			display: "all tiers",
			deprecatedMinTier: process.env.ADROUTER_MIN_AD_TIER ?? "3",
			authRequired: adMode !== "off",
		},
		modelRoute:
			process.env.ADROUTER_MODEL_ROUTE ??
			(process.env.LAUNCHPAD_SUBMISSION === "true" ? "agnes-2.5-flash" : "deepseek-v4-flash"),
		installation: inspectInstallation(),
	});
}

async function requestGet(path: string, authStorage: AuthStorage): Promise<void> {
	const { apiKey, apiUrl } = await resolveAdRouterCredentials(authStorage);
	const url =
		path.startsWith("http://") || path.startsWith("https://")
			? path
			: `${apiUrl}${path.startsWith("/") ? path : `/${path}`}`;
	try {
		if (
			authStorage.getAdRouterInstallation() &&
			new URL(url).origin === new URL(apiUrl).origin &&
			new URL(url).pathname === "/v1/profile"
		) {
			const body = await new AdRouterInstallationAuth(authStorage).getProfile(new URL(apiUrl).origin);
			outputJson({ ok: true, status: 200, url, body });
			return;
		}
		const response = await fetch(url, {
			headers: apiKey ? { authorization: `Bearer ${apiKey}` } : undefined,
		});
		const text = await response.text();
		let body: unknown = text;
		try {
			body = text ? JSON.parse(text) : null;
		} catch {
			// Keep non-JSON responses as text.
		}
		outputJson({ ok: response.ok, status: response.status, url, body });
		if (!response.ok) process.exitCode = 1;
	} catch (error) {
		outputError("Router request failed", { detail: error instanceof Error ? error.message : String(error) });
		process.exitCode = 1;
	}
}

export async function handleAdRouterCommand(args: readonly string[], cwd: string): Promise<boolean> {
	const json = hasJsonFlag(args);
	const normalized = stripGlobalFlags(args);
	const [command, subcommand, value] = normalized;
	const authStorage = AuthStorage.create();
	const apiKeyIndex = args.indexOf("--api-key");
	const runtimeApiKey =
		(apiKeyIndex >= 0 ? args[apiKeyIndex + 1] : undefined) ??
		args.find((argument) => argument.startsWith("--api-key="))?.slice("--api-key=".length);
	if (runtimeApiKey) authStorage.setRuntimeApiKey("adrouter", runtimeApiKey);

	if (command === "doctor") {
		if (!json) {
			process.stdout.write("Use --json doctor for machine-readable diagnostics.\n");
		}
		await doctor(cwd, authStorage);
		return true;
	}

	if (command === "ads") {
		if (subcommand === "status" || !subcommand) {
			outputJson({ ok: true, ads: adsStatus() });
			return true;
		}
		if (subcommand === "on") {
			writeAdsEnabled(true);
			outputJson({ ok: true, ads: adsStatus() });
			return true;
		}
		if (subcommand === "off") {
			writeAdsEnabled(false);
			outputJson({ ok: true, ads: adsStatus() });
			return true;
		}
		outputError("Usage: adrouter ads [status|on|off]");
		process.exitCode = 2;
		return true;
	}

	if (command === "request" && subcommand === "get") {
		if (!value) {
			outputError("Usage: adrouter --json request get <path>");
			process.exitCode = 1;
			return true;
		}
		await requestGet(value, authStorage);
		return true;
	}

	return false;
}
