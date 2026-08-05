import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setCapabilities, TUI, visibleWidth } from "@adrouter/tui";
import chalk from "chalk";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { CustomEditor, type EditorMetadata } from "../src/modes/interactive/components/custom-editor.ts";
import { getEditorTheme, initTheme, loadThemeFromPath } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

const originalColorLevel = chalk.level;
const originalNoColor = process.env.NO_COLOR;

function createTui(columns = 80): TUI {
	return new TUI({ columns, rows: 24 } as TUI["terminal"]);
}

function createMetadata(overrides: Partial<EditorMetadata> = {}): EditorMetadata {
	return {
		cwd: "/tmp/project",
		gitBranch: "main",
		sessionName: "demo",
		profileName: "deepseek-live",
		modeLabel: "AdRouterCLI",
		modelLabel: "deepseek-v4-flash",
		providerLabel: "adrouter",
		thinkingLabel: "high",
		contextTokens: 24_600,
		contextWindow: 200_000,
		extensionStatuses: ["OpenAI cache 3/10 · 0.002M/0.005M tok (40%)"],
		totalCost: 1.234,
		totalSubsidy: 0.234,
		effectiveCost: 1,
		autoCompactEnabled: true,
		...overrides,
	};
}

function createEditor(width = 80, metadata: EditorMetadata = createMetadata()): CustomEditor {
	const editor = new CustomEditor(createTui(width), getEditorTheme(), KeybindingsManager.create());
	editor.setMetadataProvider(() => metadata);
	return editor;
}

describe.sequential("CustomEditor input panel", () => {
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

	it("renders one metadata row, a framed prompt, and exactly two unframed status rows", () => {
		chalk.level = 0;
		process.env.NO_COLOR = "1";
		const lines = createEditor(140).render(140);
		const plain = lines.map(stripAnsi);

		expect(plain).toHaveLength(6);
		expect(plain[0]).toContain("/tmp/project (main)");
		expect(plain[0]).toContain("demo  │  deepseek-live");
		expect(plain[1]).toMatch(/^▄+$/);
		expect(plain[2]).toMatch(/^❯ {2}Ask anything\.\.\./);
		expect(plain[3]).toMatch(/^▀+$/);
		expect(plain[4]).toMatch(/^context 25k\/200k auto/);
		expect(plain[4]).toMatch(/adrouter · deepseek-v4-flash · thinking high$/);
		expect(plain[5]).toMatch(/^cost \$1\.234 · subsidy \$0\.234 · effective \$1\.000/);
		expect(plain[5]).toMatch(/OpenAI cache 3\/10/);
		expect(plain.join("\n")).not.toContain("─");
		expect(lines.every((line) => visibleWidth(line) === 140)).toBe(true);
	});

	it("shows unknown context, zero metrics, and no-profile state", () => {
		chalk.level = 0;
		process.env.NO_COLOR = "1";
		const lines = createEditor(
			110,
			createMetadata({
				profileName: undefined,
				contextTokens: null,
				extensionStatuses: [],
				totalCost: 0,
				totalSubsidy: 0,
				effectiveCost: 0,
			}),
		)
			.render(110)
			.map(stripAnsi);

		expect(lines[0]).toContain("no profile loaded");
		expect(lines.at(-2)).toContain("context ?/200k auto");
		expect(lines.at(-1)).not.toContain("cache 0.0%");
		expect(lines.at(-1)).toContain("effective $0.000000");
	});

	it("truncates long Unicode labels before violating narrow widths", () => {
		chalk.level = 0;
		process.env.NO_COLOR = "1";
		const metadata = createMetadata({
			cwd: `/非常に長い/${"目".repeat(30)}`,
			sessionName: "한글".repeat(30),
			modelLabel: "模".repeat(40),
		});
		for (const width of [24, 40, 60, 93]) {
			const lines = createEditor(width, metadata).render(width);
			expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
		}
	});

	it("uses requested truecolor, 256-color, and no-color fallbacks", () => {
		chalk.level = 3;
		delete process.env.NO_COLOR;
		setCapabilities({ images: null, trueColor: true, hyperlinks: false });
		initTheme("dark", false);
		const truecolor = createEditor(120).render(120).join("\n");
		expect(truecolor).toContain("\x1b[38;2;95;135;255m");
		expect(truecolor).toContain("\x1b[38;2;128;128;128m");
		expect(truecolor).toContain("\x1b[38;2;143;207;255m");
		expect(truecolor).toContain("\x1b[38;2;181;189;104m");

		chalk.level = 2;
		setCapabilities({ images: null, trueColor: false, hyperlinks: false });
		initTheme("dark", false);
		const ansi256 = createEditor(120).render(120).join("\n");
		expect(ansi256).toContain("\x1b[38;5;");
		expect(ansi256).not.toContain("\x1b[38;2;");

		process.env.NO_COLOR = "1";
		chalk.level = 0;
		initTheme("dark", false);
		const monochrome = createEditor(120).render(120).join("\n");
		expect(monochrome).not.toMatch(/\x1b\[(?:38|48);/);
		expect(stripAnsi(monochrome)).toContain("❯  Ask anything...");
	});

	it("uses the approved dark grayscale progression as the input panel background", () => {
		chalk.level = 3;
		delete process.env.NO_COLOR;
		setCapabilities({ images: null, trueColor: true, hyperlinks: false });
		initTheme("dark", false);
		const currentDir = dirname(fileURLToPath(import.meta.url));
		const darkTheme = loadThemeFromPath(join(currentDir, "../src/modes/interactive/theme/dark.json"), "truecolor");
		const expected = {
			off: "35;35;35",
			minimal: "35;35;35",
			low: "35;35;35",
			medium: "52;52;52",
			high: "70;70;70",
			xhigh: "87;87;87",
			max: "87;87;87",
		} as const;

		for (const [level, rgb] of Object.entries(expected)) {
			const editorTheme = {
				...getEditorTheme(),
				borderColor: darkTheme.getThinkingBorderColor(level as keyof typeof expected),
			};
			const editor = new CustomEditor(createTui(40), editorTheme, KeybindingsManager.create());
			const rendered = editor.render(40).join("\n");
			expect(rendered).toContain(`\x1b[48;2;${rgb}m`);
		}
	});
});
