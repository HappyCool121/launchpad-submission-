import { setCapabilities, visibleWidth } from "@adrouter/tui";
import chalk from "chalk";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
	JELLYFISH_PIXELS,
	ResponsiveStartupHeader,
} from "../src/modes/interactive/components/responsive-startup-header.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const originalColorLevel = chalk.level;
const originalNoColor = process.env.NO_COLOR;

function createHeader(): ResponsiveStartupHeader {
	return new ResponsiveStartupHeader({
		version: "0.81.0-beta.8",
		expanded: false,
		compactInstructions: "esc interrupt · / commands",
		expandedInstructions: "esc to interrupt\n/ for commands",
		compactOnboarding: "Press ctrl+o for more.",
		onboarding: "AdRouterCLI can explain its own features.",
		getModelLabel: () => "deepseek-v4-pro · high",
		getCwdLabel: () => "~/antigravity/a/very/long/project/path",
	});
}

describe.sequential("ResponsiveStartupHeader", () => {
	beforeAll(() => {
		setCapabilities({ images: null, trueColor: false, hyperlinks: false });
		initTheme("dark", false);
	});

	afterEach(() => {
		chalk.level = originalColorLevel;
		if (originalNoColor === undefined) delete process.env.NO_COLOR;
		else process.env.NO_COLOR = originalNoColor;
		setCapabilities({ images: null, trueColor: false, hyperlinks: false });
		initTheme("dark", false);
	});

	it("embeds the exact 30x32 bead sprite", () => {
		expect(JELLYFISH_PIXELS).toEqual([
			"..............................",
			"..............................",
			"..........3333333333..........",
			"..........66666666664.........",
			".......666BBBBBBBBBB666.......",
			".....66BBHHBHBBBBBBBBBB66.....",
			"....766BHHHBBBBBBBBBBBB6652...",
			"....6BBBGHBBBBBBBBBBBBBBB62...",
			"..11ABHHBBBBBBBBBBBBBBBBBAA...",
			"..26BBHHBBBBBBBBBBBBBBBBBBB6..",
			"..56BB6BBC0BBBBBBBBB0BBBBBB6..",
			"..56BBBBBB00BBBBBBB00BBBBBB6..",
			"..566BBBBBB00BBBBB00BBBBBB66..",
			"..266BBBBB07BBBBBBB00BBBBB66..",
			"..25666BBBBBBB0B0BBBBBBB6665..",
			"..2566666BBBBBB0BBBBBB66666...",
			"....566666BBBBBBBBBB6666652...",
			".....55555555555555555555.....",
			"......256B566B65D565BB691.....",
			".......66D666D66D666DD5.......",
			".......66D666D66D666DD6.......",
			".......66D666D66D665DE6.......",
			".......66D666D66D666DE6.......",
			"......6DDF566D66D665FGD6......",
			".....5DDD656DB65BD6566DD5.....",
			".....5BDD656DB65BD6566DB6.....",
			".....5B6656DBB65BBD6526B5.....",
			"......665.66B6..6BB65465......",
			"..........5665..66655.........",
			"..........8558...55...........",
			".................11...........",
			"..............................",
		]);
	});

	it("keeps the exact split-pane composition and safely crops the right edge", () => {
		chalk.level = 0;
		process.env.NO_COLOR = "1";
		const header = createHeader();
		const expectedLogo = [
			"                              ",
			"          ██████████▄         ",
			"     ▄▄██▓▓█▓██████████▄▄     ",
			"    ████▓▓▓████████████████   ",
			"  ████▓▓███████████████████▄  ",
			"  ████████ ▀███████▀ ███████  ",
			"  ████████▀▄▄█████▄ ▀███████  ",
			"  ████████████▄▀▄██████████▀  ",
			"    ▀████████████████████▀▀   ",
			"      ▀██▓███▓██▓███▓▓█▀▀     ",
			"       ██▓███▓██▓███▓▓█       ",
			"      ▄▓▓▓███▓██▓███▓▓▓▄      ",
			"     █▓▓▓███▓████▓████▓▓█     ",
			"     ▀███▀█▓██▀▀██▓█████▀     ",
			"          ████  ▀██▀▀         ",
			"                 ▀▀           ",
		];
		const expectedPrompt = [
			"          ",
			"          ",
			"████╗     ",
			"╚████╗    ",
			" ╚████╗   ",
			"  ╚████╗  ",
			"   ╚████╗ ",
			"    ╚████╗",
			"    ████╔╝",
			"   ████╔╝ ",
			"  ████╔╝  ",
			" ████╔╝   ",
			"████╔╝    ",
			"╚═══╝     ",
			"          ",
			"          ",
		];

		for (const width of [18, 31, 32, 60, 95, 140]) {
			const lines = header.render(width);
			expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
			const rendered = lines.join("\n");
			expect(rendered.includes("> adrouterCLI")).toBe(width < 32);
			expect(rendered.includes("> adrouterCLI v0.81.0-beta.8")).toBe(width === 31);
			expect(rendered.includes("adrouterCLI")).toBe(width < 32 || width >= 60);
		}

		const referenceBanner = header.render(95).slice(0, 16).map(stripAnsi);
		const wideBanner = header.render(140).slice(0, 16).map(stripAnsi);
		expect(referenceBanner.map((line) => line.slice(1, 31))).toEqual(expectedLogo);
		expect(wideBanner.map((line) => line.slice(1, 31))).toEqual(expectedLogo);
		expect(referenceBanner.map((line) => line.slice(32, 42))).toEqual(expectedPrompt);
		expect(wideBanner.map((line) => line.slice(32, 42))).toEqual(expectedPrompt);
		expect(referenceBanner.map((line) => line.slice(1, 90))).toEqual(wideBanner.map((line) => line.slice(1, 90)));
		const bubbleRows = [3, 4, 11, 12];
		const countBubbles = (lines: string[]): number =>
			bubbleRows
				.map((row) => lines[row]?.slice(43) ?? "")
				.join("")
				.match(/[°○.∘o]/g)?.length ?? 0;
		expect(countBubbles(referenceBanner)).toBeGreaterThan(32);
		expect(countBubbles(wideBanner)).toBeGreaterThan(countBubbles(referenceBanner));
		expect(wideBanner[3]!.slice(43).trimEnd().length).toBeGreaterThan(
			referenceBanner[3]!.slice(43).trimEnd().length + 30,
		);

		expect(referenceBanner[3]?.slice(43)).toMatch(/^° {5}○ {3}\. {6}∘/);
		expect(referenceBanner[4]?.slice(43)).toMatch(/^ {2}\. {3}° {5}o {2}°/);
		expect(referenceBanner[6]?.slice(43).trimEnd()).toBe("adrouterCLI");
		expect(referenceBanner[7]?.slice(43).trimEnd()).toBe("v0.81.0-beta.8");
		expect(referenceBanner[8]?.slice(43).trimEnd()).toBe("deepseek-v4-pro · high");
		expect(referenceBanner[9]?.slice(43).trimEnd()).toBe("~/antigravity/a/very/long/project/path");
	});

	it("renders deterministic 256-color and truecolor palettes with a monochrome fallback", () => {
		chalk.level = 2;
		delete process.env.NO_COLOR;
		setCapabilities({ images: null, trueColor: false, hyperlinks: false });
		initTheme("dark", false);
		expect(createHeader().render(95).join("\n")).toContain("\x1b[38;5;69m");

		chalk.level = 3;
		setCapabilities({ images: null, trueColor: true, hyperlinks: false });
		initTheme("dark", false);
		expect(createHeader().render(95).join("\n")).toContain("\x1b[38;2;77;155;255m");

		process.env.NO_COLOR = "1";
		expect(createHeader().render(95).join("\n")).not.toContain("\x1b[38;2;77;155;255m");
	});

	it("switches between compact and expanded help without changing the banner", () => {
		chalk.level = 0;
		const header = createHeader();
		const compactBanner = header.render(80).slice(0, 16);
		expect(header.render(80).join("\n")).toContain("esc interrupt · / commands");

		header.setExpanded(true);
		const expanded = header.render(80);
		expect(expanded.join("\n")).toContain("/ for commands");
		expect(expanded.slice(0, 16)).toEqual(compactBanner);
	});
});
