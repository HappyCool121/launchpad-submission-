import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { areAdRouterAdsEnabled } from "../../ai/src/adrouter-settings.ts";
import { handleAdRouterCommand } from "../src/cli/adrouter-command.ts";

const originalAgentDir = process.env.ADROUTER_CODING_AGENT_DIR;
const originalAdMode = process.env.ADROUTER_AD_MODE;
const originalAdsEnabled = process.env.ADROUTER_ADS_ENABLED;
const originalApiKey = process.env.ADROUTER_API_KEY;
const originalApiUrl = process.env.ADROUTER_API_URL;
const originalExitCode = process.exitCode;
const temporaryDirectories: string[] = [];

afterEach(() => {
	if (originalAgentDir === undefined) delete process.env.ADROUTER_CODING_AGENT_DIR;
	else process.env.ADROUTER_CODING_AGENT_DIR = originalAgentDir;
	if (originalAdMode === undefined) delete process.env.ADROUTER_AD_MODE;
	else process.env.ADROUTER_AD_MODE = originalAdMode;
	if (originalAdsEnabled === undefined) delete process.env.ADROUTER_ADS_ENABLED;
	else process.env.ADROUTER_ADS_ENABLED = originalAdsEnabled;
	if (originalApiKey === undefined) delete process.env.ADROUTER_API_KEY;
	else process.env.ADROUTER_API_KEY = originalApiKey;
	if (originalApiUrl === undefined) delete process.env.ADROUTER_API_URL;
	else process.env.ADROUTER_API_URL = originalApiUrl;
	process.exitCode = originalExitCode;
	for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
	vi.restoreAllMocks();
});

async function runAdsCommand(args: string[]): Promise<Record<string, unknown>> {
	const output: string[] = [];
	const write = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
		output.push(String(chunk));
		return true;
	});
	try {
		expect(await handleAdRouterCommand(args, process.cwd())).toBe(true);
		return JSON.parse(output.join("")) as Record<string, unknown>;
	} finally {
		write.mockRestore();
	}
}

async function runJsonCommand(args: string[]): Promise<Record<string, unknown>> {
	const output: string[] = [];
	const write = vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
		output.push(String(chunk));
		return true;
	});
	try {
		expect(await handleAdRouterCommand(args, process.cwd())).toBe(true);
		return JSON.parse(output.join("")) as Record<string, unknown>;
	} finally {
		write.mockRestore();
	}
}

describe("AdRouterCLI ads command", () => {
	it("disables immediately, persists the choice, and respects the hard off override", async () => {
		const directory = mkdtempSync(join(tmpdir(), "adrouter-ads-command-"));
		temporaryDirectories.push(directory);
		process.env.ADROUTER_CODING_AGENT_DIR = directory;
		delete process.env.ADROUTER_AD_MODE;

		process.exitCode = undefined;
		const disabled = await runAdsCommand(["ads", "off"]);
		expect(process.exitCode).toBeUndefined();
		expect(disabled).toMatchObject({
			ok: true,
			ads: { enabled: false, hardOverride: false, message: expect.stringContaining("full model cost") },
		});
		expect(JSON.parse(readFileSync(join(directory, "settings.json"), "utf8"))).toMatchObject({ adsEnabled: false });

		const disabledAgain = await runAdsCommand(["ads", "off"]);
		expect(disabledAgain).toMatchObject({ ok: true, ads: { enabled: false, hardOverride: false } });
		// The command exits after persistence. On an interactive restart, main
		// reflects this saved value in ADROUTER_ADS_ENABLED before router calls.
		process.env.ADROUTER_ADS_ENABLED = "false";
		expect(areAdRouterAdsEnabled()).toBe(false);

		delete process.env.ADROUTER_ADS_ENABLED;
		const enabled = await runAdsCommand(["ads", "on"]);
		expect(enabled).toMatchObject({ ok: true, ads: { enabled: true, hardOverride: false } });
		expect(areAdRouterAdsEnabled()).toBe(true);

		process.env.ADROUTER_AD_MODE = "off";
		const overridden = await runAdsCommand(["ads", "status"]);
		expect(overridden).toMatchObject({
			ok: true,
			ads: { enabled: false, hardOverride: true, message: expect.stringContaining("overrides") },
		});
		expect(areAdRouterAdsEnabled()).toBe(false);
	});
});

describe("AdRouterCLI doctor command", () => {
	it("does not send a stored legacy key to official hosted health checks", async () => {
		const directory = mkdtempSync(join(tmpdir(), "adrouter-doctor-command-"));
		temporaryDirectories.push(directory);
		process.env.ADROUTER_CODING_AGENT_DIR = directory;
		delete process.env.ADROUTER_API_KEY;
		delete process.env.ADROUTER_API_URL;
		const secret = "invite-secret-key";
		writeFileSync(join(directory, "auth.json"), JSON.stringify({ adrouter: { type: "api_key", key: secret } }));
		const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }));

		const result = await runJsonCommand(["--json", "doctor"]);

		expect(fetchMock).toHaveBeenCalledWith(
			"https://api-staging.adrouter.co/health",
			expect.not.objectContaining({ headers: expect.anything() }),
		);
		expect(result).toMatchObject({
			router: { endpoint: "https://api-staging.adrouter.co", reachable: true },
			auth: {
				available: false,
				source: "stored",
				installation: {
					state: "invalid",
					storage: "file_protected",
					signedRequests: false,
					reenrollmentRequired: true,
				},
			},
			ads: { mode: "live" },
			installation: {
				kind: "source-linked",
				deployable: false,
				bundledFeatures: { mode: "required" },
			},
		});
		const installation = result.installation as { bundledDependencies: Record<string, unknown> };
		expect(Object.keys(installation.bundledDependencies).sort()).toEqual([
			"@adrouter/agent-core",
			"@adrouter/ai",
			"@adrouter/tui",
		]);
		expect(JSON.stringify(result)).not.toContain(secret);
	});

	it("prefers the environment endpoint and runtime API key", async () => {
		const directory = mkdtempSync(join(tmpdir(), "adrouter-doctor-command-"));
		temporaryDirectories.push(directory);
		process.env.ADROUTER_CODING_AGENT_DIR = directory;
		process.env.ADROUTER_API_URL = "https://override.example.test/";
		const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 200 }));

		const result = await runJsonCommand(["--api-key", "runtime-secret", "--json", "doctor"]);

		expect(fetchMock).toHaveBeenCalledWith(
			"https://override.example.test/health",
			expect.not.objectContaining({ headers: expect.anything() }),
		);
		expect(result).toMatchObject({ auth: { source: "runtime" } });
		expect(JSON.stringify(result)).not.toContain("runtime-secret");
	});
});
