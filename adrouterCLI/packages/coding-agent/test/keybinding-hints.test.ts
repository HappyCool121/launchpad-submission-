import { setKeybindings, visibleWidth } from "@adrouter/tui";
import { beforeAll, describe, expect, it } from "vitest";
import { KeybindingsManager } from "../src/core/keybindings.ts";
import { helperHint, helperHintRows, rawHelperHint } from "../src/modes/interactive/components/keybinding-hints.ts";
import { initTheme } from "../src/modes/interactive/theme/theme.ts";
import { stripAnsi } from "../src/utils/ansi.ts";

describe("dedicated helper hints", () => {
	beforeAll(() => {
		initTheme(undefined, false);
		setKeybindings(KeybindingsManager.create());
	});

	it("uses bracketed, capitalized key/action labels", () => {
		expect(stripAnsi(helperHint("app.interrupt", "interrupt"))).toBe("[Esc] Interrupt");
		expect(stripAnsi(rawHelperHint("/", "commands"))).toBe("[/] Commands");
	});

	it("wraps only between complete hints and stays within width", () => {
		const rows = helperHintRows(
			[helperHint("app.interrupt", "interrupt"), helperHint("app.clear", "clear"), rawHelperHint("/", "commands")],
			32,
		);
		expect(rows.length).toBeGreaterThan(1);
		expect(rows.every((row) => visibleWidth(row) <= 32)).toBe(true);
		expect(stripAnsi(rows.join("\n"))).toContain("[Esc] Interrupt");
	});
});
