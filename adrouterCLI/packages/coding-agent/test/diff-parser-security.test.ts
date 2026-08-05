import { describe, expect, it } from "vitest";
import { parseDiffLine } from "../src/modes/interactive/components/diff.ts";

describe("diff line parsing", () => {
	it("preserves numbered and unnumbered diff formats", () => {
		expect(parseDiffLine("+ 12 added")).toEqual({ prefix: "+", lineNum: " 12", content: "added" });
		expect(parseDiffLine("- removed")).toEqual({ prefix: "-", lineNum: "", content: "removed" });
		expect(parseDiffLine(" 7 context")).toEqual({ prefix: " ", lineNum: "7", content: "context" });
		expect(parseDiffLine("not a diff line")).toBeNull();
	});

	it("handles long ambiguous whitespace without backtracking", () => {
		const spaces = " ".repeat(200_000);
		expect(parseDiffLine(`+${spaces}content`)).toEqual({
			prefix: "+",
			lineNum: spaces.slice(1),
			content: "content",
		});
	});
});
