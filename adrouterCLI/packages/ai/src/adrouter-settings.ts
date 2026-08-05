/** ADROUTER_AD_MODE=off is intentionally a non-overridable safety switch. */
export function areAdRouterAdsEnabled(): boolean {
	if (process.env.ADROUTER_AD_MODE === "off") return false;
	return process.env.ADROUTER_ADS_ENABLED !== "false";
}
