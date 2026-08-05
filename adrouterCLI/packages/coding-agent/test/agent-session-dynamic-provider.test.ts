import { describe, expect, it } from "vitest";
import { createEventBus } from "../src/core/event-bus.ts";
import { createExtensionRuntime, loadExtensionFromFactory } from "../src/core/extensions/loader.ts";
import type { ExtensionAPI } from "../src/core/extensions/types.ts";

describe("extension provider-registration boundary", () => {
	it("does not expose provider mutation methods to JavaScript extensions", async () => {
		let extensionApi: ExtensionAPI | undefined;
		await loadExtensionFromFactory(
			(pi) => {
				extensionApi = pi;
			},
			process.cwd(),
			createEventBus(),
			createExtensionRuntime(),
		);

		expect(extensionApi).toBeDefined();
		expect(Object.hasOwn(extensionApi as object, "registerProvider")).toBe(false);
		expect(Object.hasOwn(extensionApi as object, "unregisterProvider")).toBe(false);
	});
});
