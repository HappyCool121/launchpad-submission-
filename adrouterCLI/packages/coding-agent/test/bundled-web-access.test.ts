import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getWebSearchConfigPath } from "../bundled/pi-web-access-0.13.0/utils.ts";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "../src/core/extensions/index.ts";
import { DefaultResourceLoader } from "../src/core/resource-loader.ts";

const originalAgentDir = process.env.ADROUTER_CODING_AGENT_DIR;
const originalPiAgentDir = process.env.PI_CODING_AGENT_DIR;
const temporaryDirectories: string[] = [];

async function loadFreshWebAccessExtension(agentDir: string) {
	process.env.ADROUTER_CODING_AGENT_DIR = agentDir;
	vi.resetModules();
	const bundleUrl = new URL("../bundled/pi-web-access-0.13.0/dist/index.js", import.meta.url);
	bundleUrl.searchParams.set("browserless-test", `${process.pid}-${Math.random().toString(36).slice(2)}`);
	return import(/* @vite-ignore */ bundleUrl.href);
}

function createExtensionHarness(extensionFactory: (pi: ExtensionAPI) => void) {
	const commands = new Map<string, { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> }>();
	const tools = new Map<string, { execute: (...args: any[]) => Promise<any> }>();
	const shortcuts: string[] = [];
	const messages: Array<Record<string, unknown>> = [];
	const execCalls: Array<{ command: string; args: string[] }> = [];
	const pi = {
		on: () => {},
		registerCommand: (
			name: string,
			command: { handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> },
		) => {
			commands.set(name, command);
		},
		registerTool: (tool: { name: string; execute: (...args: any[]) => Promise<any> }) => {
			tools.set(tool.name, tool);
		},
		registerShortcut: (shortcut: string) => {
			shortcuts.push(shortcut);
		},
		appendEntry: () => {},
		sendMessage: (message: Record<string, unknown>) => {
			messages.push(message);
		},
		exec: async (command: string, args: string[]) => {
			execCalls.push({ command, args });
			return { code: 0, stdout: "", stderr: "" };
		},
	} as unknown as ExtensionAPI;
	extensionFactory(pi);
	return { commands, tools, shortcuts, messages, execCalls };
}

function createBrowserlessContext(cwd: string, input?: string) {
	const notifications: string[] = [];
	const context = {
		cwd,
		hasUI: true,
		model: undefined,
		modelRegistry: {
			getAvailable: () => [],
			find: () => undefined,
			getApiKeyAndHeaders: async () => ({ ok: false }),
		},
		isProjectTrusted: () => true,
		ui: {
			input: async () => input,
			notify: (message: string) => notifications.push(message),
		},
	} as unknown as ExtensionContext & ExtensionCommandContext;
	return { context, notifications };
}

afterEach(() => {
	if (originalAgentDir === undefined) delete process.env.ADROUTER_CODING_AGENT_DIR;
	else process.env.ADROUTER_CODING_AGENT_DIR = originalAgentDir;
	if (originalPiAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = originalPiAgentDir;
	for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("bundled web access", () => {
	it("stores configuration beneath ADROUTER_CODING_AGENT_DIR", () => {
		process.env.ADROUTER_CODING_AGENT_DIR = join(tmpdir(), "adrouter-web-config-test");
		process.env.PI_CODING_AGENT_DIR = join(tmpdir(), "forbidden-pi-web-config-test");
		expect(getWebSearchConfigPath()).toBe(join(process.env.ADROUTER_CODING_AGENT_DIR, "web-search.json"));
		expect(getWebSearchConfigPath()).not.toContain(process.env.PI_CODING_AGENT_DIR);
	});

	it("executes the fetch tool validation path without credentials or network", async () => {
		const root = join(tmpdir(), `adrouter-web-tool-${process.pid}-${Math.random().toString(36).slice(2)}`);
		temporaryDirectories.push(root);
		const agentDir = join(root, "agent");
		const cwd = join(root, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(cwd, { recursive: true });
		const loader = new DefaultResourceLoader({ cwd, agentDir, includeBundledFeatures: true });
		await loader.reload();
		const fetchTool = loader
			.getExtensions()
			.extensions.flatMap((extension) => [...extension.tools.values()])
			.find((tool) => tool.definition.name === "fetch_content");
		expect(fetchTool).toBeDefined();
		const result = await fetchTool!.definition.execute("test", {}, undefined, undefined, {} as never);
		expect(result.content).toEqual([{ type: "text", text: "Error: No URL provided." }]);
	});

	it("normalizes default and legacy curator workflows to browserless auto-summary", async () => {
		const root = join(tmpdir(), `adrouter-web-workflow-${process.pid}-${Math.random().toString(36).slice(2)}`);
		temporaryDirectories.push(root);
		mkdirSync(root, { recursive: true });
		const { resolveWorkflow } = await loadFreshWebAccessExtension(root);

		expect(resolveWorkflow(undefined, true)).toBe("auto-summary");
		expect(resolveWorkflow(undefined, false)).toBe("auto-summary");
		expect(resolveWorkflow("summary-review", true)).toBe("auto-summary");
		expect(resolveWorkflow("on", true)).toBe("auto-summary");
		expect(resolveWorkflow("none", true)).toBe("none");
	});

	it("runs legacy summary-review and /websearch entirely in CLI without an opener", async () => {
		const root = join(tmpdir(), `adrouter-web-browserless-${process.pid}-${Math.random().toString(36).slice(2)}`);
		temporaryDirectories.push(root);
		const agentDir = join(root, "agent");
		const cwd = join(root, "project");
		mkdirSync(agentDir, { recursive: true });
		mkdirSync(cwd, { recursive: true });
		const configPath = join(agentDir, "web-search.json");
		writeFileSync(configPath, JSON.stringify({ provider: "brave", workflow: "summary-review" }));

		const webAccess = await loadFreshWebAccessExtension(agentDir);
		const harness = createExtensionHarness(webAccess.default);
		const { context, notifications } = createBrowserlessContext(cwd, "browserless test query");

		expect(harness.shortcuts).toEqual(["ctrl+shift+w"]);
		const tool = harness.tools.get("web_search");
		expect(tool).toBeDefined();
		const toolResult = await tool!.execute(
			"call-1",
			{ query: "legacy config query", provider: "brave", workflow: "summary-review" },
			undefined,
			undefined,
			context,
		);
		expect(toolResult.details.summary.workflow).toBe("auto-summary");
		expect(toolResult.details.summary.fallbackUsed).toBe(true);

		const command = harness.commands.get("websearch");
		expect(command).toBeDefined();
		await command!.handler("", context);
		expect(harness.messages).toHaveLength(1);
		const commandDetails = harness.messages[0]!.details as {
			summary?: { workflow?: string; fallbackUsed?: boolean };
		};
		expect(commandDetails.summary).toMatchObject({ workflow: "auto-summary", fallbackUsed: true });
		expect(notifications).toContain("Web search complete.");
		expect(harness.execCalls).toEqual([]);
	});

	it("maps /curator on and stale summary-review config to auto-summary", async () => {
		const root = join(tmpdir(), `adrouter-web-curator-alias-${process.pid}-${Math.random().toString(36).slice(2)}`);
		temporaryDirectories.push(root);
		const agentDir = join(root, "agent");
		const cwd = join(root, "project");
		const configPath = join(agentDir, "web-search.json");
		mkdirSync(dirname(configPath), { recursive: true });
		mkdirSync(cwd, { recursive: true });
		writeFileSync(configPath, JSON.stringify({ workflow: "summary-review" }));

		const webAccess = await loadFreshWebAccessExtension(agentDir);
		const harness = createExtensionHarness(webAccess.default);
		const { context } = createBrowserlessContext(cwd);
		await harness.commands.get("curator")!.handler("on", context);

		const saved = JSON.parse(readFileSync(configPath, "utf8")) as { workflow?: string };
		expect(saved.workflow).toBe("auto-summary");
		expect(harness.execCalls).toEqual([]);
	});
});
