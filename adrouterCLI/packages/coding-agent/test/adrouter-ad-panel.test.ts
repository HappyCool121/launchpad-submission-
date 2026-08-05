import { publishAdRouterAds } from "@adrouter/ai";
import { resetCapabilitiesCache, setCapabilities, TUI, visibleWidth } from "@adrouter/tui";
import chalk from "chalk";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { VirtualTerminal } from "../../tui/test/virtual-terminal.ts";
import { AdRouterAdPanel } from "../src/modes/interactive/components/adrouter-ad-panel.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const originalColorLevel = chalk.level;

function createPanel(): { panel: AdRouterAdPanel; requestRender: ReturnType<typeof vi.fn> } {
	const requestRender = vi.fn();
	return { panel: new AdRouterAdPanel({ requestRender } as unknown as TUI), requestRender };
}

function visibleLines(panel: AdRouterAdPanel, width: number): string[] {
	return panel.render(width).map((line) => stripAnsi(line).trimEnd());
}

describe("AdRouterAdPanel", () => {
	beforeAll(() => initTheme(undefined, false));

	afterEach(() => {
		chalk.level = originalColorLevel;
		delete process.env.ADROUTER_MIN_AD_TIER;
		publishAdRouterAds({ status: "off", ads: [] });
		resetCapabilitiesCache();
		vi.restoreAllMocks();
	});

	it("renders a highlighted sponsor without tier or CTA text", () => {
		chalk.level = 3;
		setCapabilities({ images: null, trueColor: true, hyperlinks: false });
		const { panel, requestRender } = createPanel();

		publishAdRouterAds({
			status: "live",
			ads: [
				{
					id: "ad-1",
					tier: "A",
					title: "Compiler Cloud",
					body: "Fast build minutes for coding agents.",
					cta: "Start building",
					url: "https://compiler.example/path",
					label: "Sponsored",
				},
			],
		});

		const lines = panel.render(80);
		expect(lines.map((line) => stripAnsi(line).trimEnd())).toEqual([
			"Sponsored by: Compiler Cloud",
			"Fast build minutes for coding agents.",
			"https://compiler.example/path",
		]);
		expect(lines.every((line) => visibleWidth(line) === 80)).toBe(true);
		expect(stripAnsi(lines.join("\n"))).not.toContain("Start building");
		expect(stripAnsi(lines.join("\n"))).not.toContain("TIER A");
		expect(requestRender).toHaveBeenCalled();
		panel.dispose();
	});

	it("uses OSC-8 only when hyperlinks are supported while preserving visible URL text", () => {
		const { panel } = createPanel();
		publishAdRouterAds({
			status: "live",
			ads: [
				{
					id: "link",
					tier: "B",
					title: "Brand",
					body: "Body",
					url: "https://example.com/deal",
					label: "Sponsored",
				},
			],
		});

		setCapabilities({ images: null, trueColor: true, hyperlinks: false });
		const plain = panel.render(60);
		expect(plain.join("\n")).not.toContain("\x1b]8;;");
		expect(stripAnsi(plain.join("\n"))).toContain("https://example.com/deal");

		setCapabilities({ images: null, trueColor: true, hyperlinks: true });
		const linked = panel.render(60);
		expect(linked.join("\n")).toContain("\x1b]8;;https://example.com/deal");
		expect(stripAnsi(linked.join("\n"))).toContain("https://example.com/deal");
		panel.dispose();
	});

	it("rejects unsafe URLs and sanitizes sponsor text", () => {
		setCapabilities({ images: null, trueColor: true, hyperlinks: true });
		for (const url of [
			"javascript:alert(1)",
			"https://user:secret@example.com",
			"https://example.com/\npath",
			"not a URL",
		]) {
			const { panel } = createPanel();
			publishAdRouterAds({
				status: "live",
				ads: [
					{
						id: url,
						tier: "C",
						title: "\x1b[31mSafe\x1b[0m\nTitle",
						body: "Body\u0000 text",
						url,
						label: "Sponsored",
					},
				],
			});
			const rendered = panel.render(50);
			expect(visibleLines(panel, 50).slice(0, 2)).toEqual(["Sponsored by: Safe Title", "Body text"]);
			expect(rendered.join("\n")).not.toContain("\x1b]8;;");
			expect(stripAnsi(rendered.join("\n"))).not.toContain(url);
			panel.dispose();
		}
	});

	it("falls back to Sponsored and ellipsizes the third wrapped body line", () => {
		const { panel } = createPanel();
		publishAdRouterAds({
			status: "live",
			ads: [
				{
					id: "wrapped",
					tier: "C",
					title: "\u0000",
					body: "one two three four five six seven eight nine ten eleven twelve",
					label: "Sponsored",
				},
			],
		});
		const lines = visibleLines(panel, 12);
		expect(lines[0]).toBe("Sponsored by");
		expect(lines).toHaveLength(4);
		expect(lines.at(-1)).toMatch(/…$/);
		panel.dispose();
	});

	it("preserves the neutral three-line NONE state", () => {
		const { panel } = createPanel();
		publishAdRouterAds({
			status: "privacy_protected",
			ads: [
				{
					id: "guardrail",
					tier: "NONE",
					title: "No sponsored content",
					body: "Sensitive category detected.",
					label: "TIER NONE",
				},
			],
		});
		expect(visibleLines(panel, 80)).toEqual(["No sponsored content", "TIER NONE", "Sensitive category detected."]);
		panel.dispose();
	});

	it("atomically replaces the latest event and clears off, degraded, and empty states", () => {
		const { panel } = createPanel();
		publishAdRouterAds({
			status: "live",
			ads: [{ id: "old", tier: "A", title: "Old Brand", body: "Old offer", label: "Sponsored" }],
		});
		publishAdRouterAds({
			status: "live",
			ads: [{ id: "new", tier: "B", title: "New Brand", body: "New offer", label: "Sponsored" }],
		});
		expect(visibleLines(panel, 80).join("\n")).toContain("New Brand");
		expect(visibleLines(panel, 80).join("\n")).not.toContain("Old Brand");

		for (const update of [
			{ status: "live" as const, ads: [] },
			{ status: "degraded" as const, ads: [] },
			{ status: "off" as const, ads: [] },
		]) {
			publishAdRouterAds(update);
			expect(panel.render(80)).toEqual([]);
		}
		panel.dispose();
	});

	it("returns no rows at zero and at least three full-width rows at every positive width", () => {
		const { panel } = createPanel();
		publishAdRouterAds({
			status: "live",
			ads: [{ id: "tiny", tier: "C", title: "Brand", body: "Copy", label: "Sponsored" }],
		});
		expect(panel.render(0)).toEqual([]);
		for (let width = 1; width <= 12; width++) {
			const lines = panel.render(width);
			expect(lines.length).toBeGreaterThanOrEqual(3);
			expect(lines.every((line) => visibleWidth(line) === width)).toBe(true);
		}
		panel.dispose();
	});

	it("clears stale rows through long-to-short and long-to-empty differential renders", async () => {
		setCapabilities({ images: null, trueColor: true, hyperlinks: false });
		const terminal = new VirtualTerminal(40, 8);
		const tui = new TUI(terminal);
		const panel = new AdRouterAdPanel(tui);
		tui.addChild(panel);

		publishAdRouterAds({
			status: "live",
			ads: [
				{
					id: "long",
					tier: "A",
					title: "Long Sponsor",
					body: "First long body row that wraps across several terminal rows and remains visible",
					url: "https://example.com/long",
					label: "Sponsored",
				},
			],
		});
		tui.start();
		await terminal.waitForRender();
		expect(terminal.getViewport().join("\n")).toContain("Long Sponsor");

		publishAdRouterAds({
			status: "live",
			ads: [{ id: "short", tier: "B", title: "Short", body: "Done", label: "Sponsored" }],
		});
		await terminal.waitForRender();
		const shortViewport = terminal.getViewport().join("\n");
		expect(shortViewport).toContain("Short");
		expect(shortViewport).not.toContain("Long Sponsor");
		expect(shortViewport).not.toContain("example.com/long");

		publishAdRouterAds({ status: "off", ads: [] });
		await terminal.waitForRender();
		const emptyViewport = terminal.getViewport().join("\n");
		expect(emptyViewport).not.toContain("Short");
		expect(emptyViewport).not.toContain("Done");

		tui.stop();
		panel.dispose();
	});
});
