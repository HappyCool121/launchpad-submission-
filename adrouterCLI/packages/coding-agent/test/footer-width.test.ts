import { visibleWidth } from "@adrouter/tui";
import { beforeAll, describe, expect, it } from "vitest";
import type { AgentSession } from "../src/core/agent-session.ts";
import type { ReadonlyFooterDataProvider } from "../src/core/footer-data-provider.ts";
import {
	collectFooterMetrics,
	FooterComponent,
	formatCwdForFooter,
} from "../src/modes/interactive/components/footer.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

type AssistantUsage = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: { total: number };
};

function createSession(
	options: {
		sessionName?: string;
		modelId?: string;
		provider?: string;
		reasoning?: boolean;
		thinkingLevel?: string;
		usage?: AssistantUsage | AssistantUsage[];
		contextTokens?: number | null;
		contextWindow?: number;
		subsidy?: number;
	} = {},
): AgentSession {
	const usages = options.usage === undefined ? [] : Array.isArray(options.usage) ? options.usage : [options.usage];
	const entries: Array<Record<string, unknown>> = usages.map((usage) => ({
		type: "message",
		message: { role: "assistant", usage },
	}));
	if (options.subsidy !== undefined) {
		entries.push({
			type: "custom",
			customType: "adrouter.settlement",
			data: {
				turnId: "turn-1",
				ad: { tier: "A" },
				settlement: { ad_subsidy: options.subsidy },
			},
		});
	}

	const contextWindow = options.contextWindow ?? 200_000;
	const contextTokens = options.contextTokens === undefined ? 24_600 : options.contextTokens;
	const session = {
		state: {
			model: {
				id: options.modelId ?? "test-model",
				provider: options.provider ?? "test",
				contextWindow,
				reasoning: options.reasoning ?? false,
			},
			thinkingLevel: options.thinkingLevel ?? "off",
		},
		sessionManager: {
			getEntries: () => entries,
			getSessionName: () => options.sessionName ?? "demo",
			getCwd: () => "/tmp/project",
		},
		getContextUsage: () => ({
			tokens: contextTokens,
			contextWindow,
			percent: contextTokens === null ? null : (contextTokens / contextWindow) * 100,
		}),
	};

	return session as unknown as AgentSession;
}

function createFooterData(statuses = new Map<string, string>()): ReadonlyFooterDataProvider {
	return {
		getGitBranch: () => "main",
		getExtensionStatuses: () => statuses,
		getAvailableProviderCount: () => 1,
		onBranchChange: (callback: () => void) => {
			void callback;
			return () => {};
		},
	};
}

describe("formatCwdForFooter", () => {
	it("does not abbreviate sibling paths that share the home prefix", () => {
		expect(formatCwdForFooter("/home/user2", "/home/user")).toBe("/home/user2");
	});

	it("abbreviates the home directory and descendants", () => {
		expect(formatCwdForFooter("/home/user", "/home/user")).toBe("~");
		expect(formatCwdForFooter("/home/user/project", "/home/user")).toBe("~/project");
	});
});

describe("footer session metrics", () => {
	it("collects cost and sorts extension statuses by key", () => {
		const statuses = new Map([
			["z-status", "other"],
			["pi-cache-stats", "OpenAI cache 3/10 · 0.002M/0.005M tok (40%)"],
		]);
		const session = createSession({
			usage: [
				{ input: 100, output: 10, cacheRead: 50, cacheWrite: 50, cost: { total: 0.1 } },
				{ input: 100, output: 20, cacheRead: 100, cacheWrite: 0, cost: { total: 0.2 } },
			],
		});
		const metrics = collectFooterMetrics(session, createFooterData(statuses));

		expect(metrics.extensionStatuses).toEqual(["OpenAI cache 3/10 · 0.002M/0.005M tok (40%)", "other"]);
		expect(metrics.totalCost).toBeCloseTo(0.3);
	});

	it("reports unknown context and zero usage explicitly", () => {
		const metrics = collectFooterMetrics(
			createSession({ contextTokens: null, usage: undefined }),
			createFooterData(),
		);
		expect(metrics.contextTokens).toBeNull();
		expect(metrics.contextWindow).toBe(200_000);
		expect(metrics.extensionStatuses).toEqual([]);
		expect(metrics.totalCost).toBe(0);
	});

	it("clamps effective cost when subsidy exceeds total cost", () => {
		const metrics = collectFooterMetrics(
			createSession({
				usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0.01 } },
				subsidy: 0.2,
			}),
			createFooterData(),
		);
		expect(metrics.totalSubsidy).toBeCloseTo(0.2);
		expect(metrics.effectiveCost).toBe(0);
	});
});

describe("FooterComponent status continuation", () => {
	beforeAll(() => initTheme(undefined, false));

	it("renders extension statuses in deterministic order and within width", () => {
		const statuses = new Map([
			["z", "second\nstatus"],
			["pi-cache-stats", "cache\x1b[31m status"],
			["a", "first\tstatus"],
		]);
		const footer = new FooterComponent(createSession(), createFooterData(statuses));
		const lines = footer.render(24);

		expect(lines).toHaveLength(1);
		expect(stripAnsi(lines[0]!)).toMatch(/^first status {2}cache/);
		expect(visibleWidth(lines[0]!)).toBeLessThanOrEqual(24);
	});

	it("does not add a third row when statuses are embedded in the built-in editor", () => {
		const footer = new FooterComponent(
			createSession(),
			createFooterData(new Map([["pi-cache-stats", "OpenAI cache 3/10"]])),
		);
		footer.setStatusesEmbeddedInEditor(true);
		expect(footer.render(80)).toEqual([]);
	});

	it("does not reserve a row when no extension status exists", () => {
		const footer = new FooterComponent(createSession(), createFooterData());
		expect(footer.render(80)).toEqual([]);
	});
});
