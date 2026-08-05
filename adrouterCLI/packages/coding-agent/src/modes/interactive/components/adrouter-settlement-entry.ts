import { Box, type Component, Text } from "@adrouter/tui";
import { formatAdRouterSubsidy, isAdRouterSettlementEntryData } from "../../../core/adrouter-session.ts";
import type { CustomEntry } from "../../../core/session-manager.ts";
import { theme } from "../theme/theme.ts";

/** Render the response-specific Tier A sponsor from a context-excluded session entry. */
export function renderAdRouterSettlementEntry(entry: CustomEntry<unknown>): Component | undefined {
	if (!isAdRouterSettlementEntryData(entry.data) || entry.data.ad.tier !== "A") return undefined;
	const { ad, settlement } = entry.data;
	const url = ad.url ? ` ${ad.url}` : "";
	const cta = ad.cta ? ` — ${ad.cta}` : "";
	const box = new Box(1, 1, (text) => theme.bg("sponsoredHighlight", text));
	box.addChild(new Text(theme.bold(theme.fg("sponsoredLabel", `${ad.label} · TIER A`)), 0, 0));
	box.addChild(new Text(theme.fg("sponsoredText", `${ad.title} — ${ad.body}${cta}${url}`), 0, 0));
	if (typeof settlement.ad_subsidy === "number") {
		box.addChild(new Text(theme.fg("subsidy", `Saved $${formatAdRouterSubsidy(settlement.ad_subsidy)}`), 0, 0));
	}
	return box;
}
