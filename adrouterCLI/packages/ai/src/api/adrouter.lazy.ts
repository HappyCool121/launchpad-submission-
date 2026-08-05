import { lazyApi } from "./lazy.ts";

export function adRouterApi() {
	return lazyApi(() => import("./adrouter.ts"));
}
