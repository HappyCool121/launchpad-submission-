import { describe, expect, it } from "vitest";
import {
	ADROUTER_SETTLEMENT_ENTRY,
	adRouterSettlementEntryData,
	cumulativeAdRouterSubsidy,
	formatAdRouterSubsidy,
} from "../src/core/adrouter-session.ts";

describe("AdRouter settlement session entries", () => {
	it("persists settled Tier A outcomes and totals their subsidy", () => {
		const data = adRouterSettlementEntryData({
			turnId: "turn-a",
			status: "live",
			ads: [{ id: "ad-a", tier: "A", title: "Build Cloud", body: "Fast CI", label: "Sponsored" }],
			settlement: { ad_subsidy: 0.001234 },
			timestamp: 1,
		});
		expect(data).toMatchObject({ turnId: "turn-a", ad: { tier: "A" } });
		expect(
			cumulativeAdRouterSubsidy([
				{ type: "custom", customType: ADROUTER_SETTLEMENT_ENTRY, data },
				{
					type: "custom",
					customType: ADROUTER_SETTLEMENT_ENTRY,
					data: { ...data!, settlement: { ad_subsidy: 0.02 } },
				},
			]),
		).toBeCloseTo(0.021234);
	});

	it("persists B/C/NONE settlements for accounting but excludes off and unsettled responses", () => {
		for (const update of [
			{
				turnId: "turn-b",
				status: "live" as const,
				ads: [{ id: "b", tier: "B" as const, title: "B", body: "B", label: "Sponsored" }],
				settlement: { ad_subsidy: 1 },
				timestamp: 1,
			},
			{
				turnId: "turn-c",
				status: "live" as const,
				ads: [{ id: "c", tier: "C" as const, title: "C", body: "C", label: "Sponsored" }],
				settlement: { ad_subsidy: 0.1 },
				timestamp: 1,
			},
			{
				turnId: "turn-none",
				status: "live" as const,
				ads: [{ id: "none", tier: "NONE" as const, title: "None", body: "None", label: "TIER NONE" }],
				settlement: { ad_subsidy: 0 },
				timestamp: 1,
			},
		]) {
			expect(adRouterSettlementEntryData(update)).toBeDefined();
		}
		for (const update of [
			{ turnId: "turn-off", status: "off" as const, ads: [], settlement: { ad_subsidy: 0 }, timestamp: 1 },
			{
				turnId: "turn-unsettled",
				status: "live" as const,
				ads: [{ id: "a", tier: "A" as const, title: "A", body: "A", label: "Sponsored" }],
				timestamp: 1,
			},
		]) {
			expect(adRouterSettlementEntryData(update)).toBeUndefined();
		}
	});

	it("formats sub-cent and cent-or-greater savings as specified", () => {
		expect(formatAdRouterSubsidy(0.001234)).toBe("0.001234");
		expect(formatAdRouterSubsidy(0.01234)).toBe("0.012");
	});
});
