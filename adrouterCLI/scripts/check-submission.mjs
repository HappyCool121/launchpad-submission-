import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const env = await readFile(new URL("../.env.example", import.meta.url), "utf8");
const resolver = await readFile(
	new URL("../packages/coding-agent/src/core/model-resolver.ts", import.meta.url),
	"utf8",
);
const launcher = await readFile(new URL("./launchpad.mjs", import.meta.url), "utf8");
const provider = await readFile(
	new URL("../packages/ai/src/api/adrouter.ts", import.meta.url),
	"utf8",
);
const sponsorPanel = await readFile(
	new URL("../packages/coding-agent/src/modes/interactive/components/adrouter-ad-panel.ts", import.meta.url),
	"utf8",
);

assert.match(env, /^LAUNCHPAD_SUBMISSION=true$/m);
assert.match(env, /^ADROUTER_API_URL=http:\/\/127\.0\.0\.1:8787$/m);
assert.match(env, /^ADROUTER_MODEL_ROUTE=agnes-2\.5-flash$/m);
assert.doesNotMatch(env, /^AGNES_API_KEY=/m);
assert.match(resolver, /LAUNCHPAD_SUBMISSION.*agnes-2\.5-flash/s);
assert.match(launcher, /AGNES_API_KEY must not be supplied/);
assert.match(provider, /ADROUTER_API_KEY/);
assert.match(provider, /\/v1\/agent\/turn/);
assert.match(sponsorPanel, /Sponsored|Sponsor/);

console.log("OK: CLI submission defaults, credential boundary, Router transport, and sponsor panel are present.");
