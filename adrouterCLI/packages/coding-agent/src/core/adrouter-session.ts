import type { AdRouterAd, AdRouterAdUpdate, AdRouterSettlement } from "@adrouter/ai";

export const ADROUTER_SETTLEMENT_ENTRY = "adrouter.settlement";

export interface AdRouterSettlementEntryData {
	turnId: string;
	ad: AdRouterAd;
	settlement: AdRouterSettlement;
}

/** Persist every settled outcome for accounting; only Tier A is rendered inline. */
export function adRouterSettlementEntryData(
	update: AdRouterAdUpdate | undefined,
): AdRouterSettlementEntryData | undefined {
	const ad = update?.ads[0];
	if (!update?.turnId || update.status === "off" || update.status === "degraded" || !ad || !update.settlement) {
		return undefined;
	}
	return { turnId: update.turnId, ad, settlement: update.settlement };
}

export function isAdRouterSettlementEntryData(value: unknown): value is AdRouterSettlementEntryData {
	if (!value || typeof value !== "object") return false;
	const record = value as Record<string, unknown>;
	const ad = record.ad;
	return (
		typeof record.turnId === "string" &&
		!!ad &&
		typeof ad === "object" &&
		typeof (ad as Record<string, unknown>).tier === "string" &&
		!!record.settlement &&
		typeof record.settlement === "object"
	);
}

export function cumulativeAdRouterSubsidy(
	entries: Iterable<{ type: string; customType?: string; data?: unknown }>,
): number {
	let total = 0;
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== ADROUTER_SETTLEMENT_ENTRY) continue;
		if (!isAdRouterSettlementEntryData(entry.data)) continue;
		const subsidy = entry.data.settlement.ad_subsidy;
		if (typeof subsidy === "number" && Number.isFinite(subsidy)) total += subsidy;
	}
	return total;
}

export function formatAdRouterSubsidy(amount: number): string {
	return amount < 0.01 ? amount.toFixed(6) : amount.toFixed(3);
}
