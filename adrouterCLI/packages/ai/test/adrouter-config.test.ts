import { describe, expect, it, vi } from "vitest";
import {
	AdRouterApiError,
	adRouterApiErrorFromResponse,
	DEFAULT_ADROUTER_API_URL,
	isOfficialAdRouterApiUrl,
	resolveAdRouterAdMode,
	resolveAdRouterApiUrl,
	validateAdRouterApiKey,
} from "../src/adrouter-config.ts";

describe("AdRouter hosted configuration", () => {
	it("uses environment, credential, model, then staging URL precedence", () => {
		expect(
			resolveAdRouterApiUrl({
				environmentUrl: "https://env.example/",
				credentialUrl: "https://credential.example",
				modelUrl: "https://model.example",
			}),
		).toBe("https://env.example");
		expect(resolveAdRouterApiUrl({ credentialUrl: "https://credential.example/" })).toBe(
			"https://credential.example",
		);
		expect(resolveAdRouterApiUrl({ modelUrl: "http://localhost:8787/" })).toBe("http://localhost:8787");
		expect(resolveAdRouterApiUrl()).toBe(DEFAULT_ADROUTER_API_URL);
	});

	it("recognizes staging and production as official hosted origins", () => {
		expect(isOfficialAdRouterApiUrl("https://api-staging.adrouter.co/")).toBe(true);
		expect(isOfficialAdRouterApiUrl("https://api.adrouter.co/v1")).toBe(true);
		expect(isOfficialAdRouterApiUrl("http://localhost:8787")).toBe(false);
		expect(resolveAdRouterAdMode(DEFAULT_ADROUTER_API_URL)).toBe("live");
		expect(resolveAdRouterAdMode("http://localhost:8787")).toBe("mock");
		expect(resolveAdRouterAdMode(DEFAULT_ADROUTER_API_URL, "off")).toBe("off");
	});

	it("validates a key through the authenticated profile endpoint", async () => {
		const fetchImpl = vi.fn(
			async () =>
				new Response(
					JSON.stringify({
						id: "user-1",
						role: "user",
						status: "active",
						auth_source: "api_credential",
						credential_id: "credential-1",
						mode: "service",
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				),
		);

		await expect(validateAdRouterApiKey({ apiKey: "adr_live_secret", fetchImpl })).resolves.toEqual({
			id: "user-1",
			role: "user",
			status: "active",
			authSource: "api_credential",
			credentialId: "credential-1",
			mode: "service",
		});
		expect(fetchImpl).toHaveBeenCalledWith(
			`${DEFAULT_ADROUTER_API_URL}/v1/profile`,
			expect.objectContaining({
				method: "GET",
				headers: expect.objectContaining({ authorization: "Bearer adr_live_secret" }),
			}),
		);
	});

	it("preserves structured server errors and adds login guidance", async () => {
		const error = await adRouterApiErrorFromResponse(
			new Response(JSON.stringify({ error: "unauthorized", code: "invalid_api_key" }), {
				status: 401,
				headers: { "content-type": "application/json" },
			}),
		);

		expect(error).toBeInstanceOf(AdRouterApiError);
		expect(error.status).toBe(401);
		expect(error.code).toBe("invalid_api_key");
		expect(error.message).toContain("/login adrouter");
	});

	it("retains only finite numeric structured details for recovery logic", async () => {
		const error = await adRouterApiErrorFromResponse(
			new Response(
				JSON.stringify({
					error: "Input exceeds the platform token limit.",
					code: "input_limit_exceeded",
					details: {
						input_tokens: 126_977,
						max_input_tokens: 126_976,
						secret: "do-not-propagate",
						not_finite: "Infinity",
					},
				}),
				{ status: 413, headers: { "content-type": "application/json" } },
			),
		);

		expect(error.details).toEqual({ input_tokens: 126_977, max_input_tokens: 126_976 });
	});
});
