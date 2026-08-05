import { type AdRouterAd, type AdRouterAdUpdate, subscribeAdRouterAds } from "@adrouter/ai";
import {
	type Component,
	getCapabilities,
	hyperlink,
	type TUI,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@adrouter/tui";
import { stripAnsi } from "../../../utils/ansi.ts";
import { theme } from "../theme/theme.ts";

function sanitize(value: string | undefined): string {
	return stripAnsi(value ?? "")
		.replace(/[\r\n\t]/g, " ")
		.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, "")
		.replace(/ +/g, " ")
		.trim();
}

function safeHttpUrl(value: string | undefined): string {
	if (!value || value !== value.trim() || /[\u0000-\u001f\u007f-\u009f]/.test(value)) return "";
	try {
		const parsed = new URL(value);
		if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.username || parsed.password)
			return "";
		return value;
	} catch {
		return "";
	}
}

function truncate(text: string, width: number): string {
	if (width <= 0) return "";
	if (visibleWidth(text) <= width) return text;
	if (width <= 3) return ".".repeat(width);
	return truncateToWidth(text, width, "...");
}

function initialUpdate(): AdRouterAdUpdate {
	return {
		status:
			process.env.ADROUTER_ADS_ENABLED === "false" || process.env.ADROUTER_AD_MODE === "off"
				? "off"
				: process.env.ADROUTER_AD_MODE === "mock"
					? "mock"
					: "live",
		ads:
			process.env.ADROUTER_ADS_ENABLED !== "false" && process.env.ADROUTER_AD_MODE === "mock"
				? [
						{
							id: "mock-tier-3-001",
							tier: "C",
							title: "Developer Tooling",
							body: "Mock sponsored message for validating the AdRouterCLI ad surface.",
							cta: "Learn more",
							url: "https://example.com",
							label: "Sponsored",
						},
					]
				: [],
		timestamp: Date.now(),
	};
}

export class AdRouterAdPanel implements Component {
	private update: AdRouterAdUpdate = initialUpdate();
	private readonly unsubscribe: () => void;
	private readonly ui: TUI;

	constructor(ui: TUI) {
		this.ui = ui;
		this.unsubscribe = subscribeAdRouterAds((update) => {
			// Replace the complete display state per event. In particular an off,
			// degraded, or NONE event must never leave a prior sponsor visible.
			this.update = { ...update, ads: [...update.ads] };
			this.ui.requestRender();
		});
	}

	dispose(): void {
		this.unsubscribe();
	}

	invalidate(): void {
		// Render is derived from the latest event.
	}

	render(width: number): string[] {
		if (width <= 0) return [];
		if (this.update.status === "off" || this.update.status === "degraded") return [];
		const ad = this.update.ads[0];
		if (!ad) return [];
		return this.renderAd(ad, width);
	}

	private renderAd(ad: AdRouterAd, width: number): string[] {
		if (ad.tier === "NONE") return this.renderNone(ad, width);

		const title = sanitize(ad.title) || "Sponsored";
		const body = sanitize(ad.body);
		const url = safeHttpUrl(ad.url);
		const wrappedBody = body ? wrapTextWithAnsi(body, width) : [];
		const bodyLines = wrappedBody.slice(0, 3);
		if (wrappedBody.length > 3 && bodyLines.length > 0) {
			bodyLines[bodyLines.length - 1] = truncateToWidth(`${bodyLines.at(-1)}…`, width, "…");
		}

		const heading = `${theme.italic("Sponsored by:")} ${theme.bold(title)}`;
		const lines = [heading, ...bodyLines];
		if (url) {
			const visibleLink = theme.underline(theme.fg("sponsoredFooterLink", url));
			lines.push(getCapabilities().hyperlinks ? hyperlink(visibleLink, url) : visibleLink);
		}
		while (lines.length < 3) lines.push("");
		return lines.map((line) => this.highlightRow(line, width));
	}

	private renderNone(ad: AdRouterAd, width: number): string[] {
		const title = sanitize(ad.title) || "No sponsored content";
		const label = sanitize(ad.label) || "TIER NONE";
		const body = sanitize(ad.body);
		return [truncate(title, width), truncate(label, width), truncate(body, width)];
	}

	private highlightRow(content: string, width: number): string {
		const clipped = visibleWidth(content) > width ? truncateToWidth(content, width, "") : content;
		const padded = `${clipped}${" ".repeat(Math.max(0, width - visibleWidth(clipped)))}`;
		return theme.bg("sponsoredFooterHighlight", padded);
	}
}
