import { describe, expect, it } from "vitest";
import { parseSkillBlock } from "../src/core/agent-session.ts";

describe("skill block parsing", () => {
	it("parses a skill block and optional user message", () => {
		expect(
			parseSkillBlock('<skill name="inspect" location="/tmp/SKILL.md">\nBody\n</skill>\n\nCheck errors.'),
		).toEqual({
			name: "inspect",
			location: "/tmp/SKILL.md",
			content: "Body",
			userMessage: "Check errors.",
		});
	});

	it("rejects malformed suffixes and handles large bodies linearly", () => {
		expect(parseSkillBlock('<skill name="inspect" location="/tmp/SKILL.md">\nBody\n</skill>trailing')).toBeNull();
		const body = "x".repeat(500_000);
		expect(parseSkillBlock(`<skill name="inspect" location="/tmp/SKILL.md">\n${body}\n</skill>`)).toMatchObject({
			name: "inspect",
			content: body,
		});
	});
});
