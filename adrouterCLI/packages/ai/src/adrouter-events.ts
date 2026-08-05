export type AdRouterTier = "A" | "B" | "C" | "NONE";

export interface AdRouterAd {
	id: string;
	tier: AdRouterTier;
	campaignId?: string;
	reasonCode?: string;
	title: string;
	body: string;
	cta?: string;
	url?: string;
	label: string;
}

export interface AdRouterInjection {
	mode?: string;
	placement?: string;
	refresh_after_turn?: boolean;
}

export interface AdRouterSettlement {
	provider?: string;
	model?: string;
	cache_hit_tokens?: number;
	cache_miss_tokens?: number;
	prompt_cost?: number;
	ad_subsidy?: number;
	paid?: number;
	usage?: {
		input_tokens?: number;
		cache_read_tokens?: number;
		cache_write_tokens?: number;
		output_tokens?: number;
	};
	cost?: {
		input_cache_hit?: number;
		input_cache_miss?: number;
		cache_write?: number;
		output?: number;
		total?: number;
	};
}

export type AdRouterStatus = "live" | "mock" | "off" | "degraded" | "privacy_protected";

export interface AdRouterAdUpdate {
	turnId?: string;
	ads: AdRouterAd[];
	injection?: AdRouterInjection;
	settlement?: AdRouterSettlement;
	status: AdRouterStatus;
	error?: string;
	timestamp: number;
}

type Listener = (update: AdRouterAdUpdate) => void;

const listeners = new Set<Listener>();
const updatesByTurn = new Map<string, AdRouterAdUpdate>();
const updatesByMessage = new WeakMap<object, AdRouterAdUpdate>();
let latest: AdRouterAdUpdate | undefined;

export function publishAdRouterAds(update: Omit<AdRouterAdUpdate, "timestamp"> & { timestamp?: number }): void {
	const next = { ...update, timestamp: update.timestamp ?? Date.now() };
	if (next.turnId) updatesByTurn.set(next.turnId, next);
	latest = next;
	for (const listener of listeners) {
		listener(latest);
	}
}

export function subscribeAdRouterAds(listener: Listener): () => void {
	listeners.add(listener);
	if (latest) listener(latest);
	return () => listeners.delete(listener);
}

export function getLatestAdRouterAds(): AdRouterAdUpdate | undefined {
	return latest;
}

export function getAdRouterTurnUpdate(turnId: string): AdRouterAdUpdate | undefined {
	return updatesByTurn.get(turnId);
}

/** Associate the finalized assistant message with its stream-local router outcome. */
export function associateAdRouterMessage(message: object, update: AdRouterAdUpdate): void {
	updatesByMessage.set(message, update);
}

/** Return the router outcome that belongs to this exact assistant message. */
export function getAdRouterMessageUpdate(message: object): AdRouterAdUpdate | undefined {
	return updatesByMessage.get(message);
}
