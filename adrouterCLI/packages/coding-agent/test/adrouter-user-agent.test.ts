import { describe, expect, it } from "vitest";
import { getAdRouterUserAgent } from "../src/utils/adrouter-user-agent.ts";

describe("getAdRouterUserAgent", () => {
	it("formats the AdRouterCLI user agent", () => {
		const runtime = process.versions.bun ? `bun/${process.versions.bun}` : `node/${process.version}`;
		const userAgent = getAdRouterUserAgent("1.2.3");

		expect(userAgent).toBe(`adrouter/1.2.3 (${process.platform}; ${runtime}; ${process.arch})`);
		expect(userAgent).toMatch(/^adrouter\/[^\s()]+ \([^;()]+;\s*[^;()]+;\s*[^()]+\)$/);
	});
});
