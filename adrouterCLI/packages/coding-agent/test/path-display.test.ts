import { visibleWidth } from "@adrouter/tui";
import { describe, expect, it } from "vitest";
import {
	fitDisplayDirectory,
	formatDisplayDirectory,
	truncateDisplayDirectory,
} from "../src/modes/interactive/components/path-display.ts";

describe("directory display formatting", () => {
	it("uses ~ only for the home directory and its descendants", () => {
		expect(formatDisplayDirectory("/opt/people/example", "/opt/people/example")).toBe("~");
		expect(formatDisplayDirectory("/opt/people/example////", "/opt/people/example")).toBe("~");
		expect(formatDisplayDirectory("/opt/people/example/projects/cli", "/opt/people/example")).toBe("~/projects/cli");
		expect(formatDisplayDirectory("/opt/people/example2/project", "/opt/people/example")).toBe(
			"/opt/people/example2/project",
		);
	});

	it("collapses middle directories while preserving the prefix and trailing segments", () => {
		expect(truncateDisplayDirectory("~/antigravity/3days/adrouter_release", 22)).toBe("~/…/adrouter_release");
		expect(truncateDisplayDirectory("/opt/workspaces/adrouter/cli", 18)).toBe("/…/adrouter/cli");
		expect(truncateDisplayDirectory("C:\\Workspaces\\example\\work\\adrouterCLI", 19)).toBe("C:/…/adrouterCLI");
	});

	it("never exceeds the terminal width for unicode and tiny paths", () => {
		for (const width of [1, 2, 3, 8, 14]) {
			const rendered = fitDisplayDirectory("/opt/example/项目/🚀/adrouterCLI", "/opt/example", width);
			expect(visibleWidth(rendered)).toBeLessThanOrEqual(width);
		}
	});
});
