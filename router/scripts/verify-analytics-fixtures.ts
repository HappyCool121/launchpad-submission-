import { strict as assert } from 'node:assert';
import {
  abortEvent,
  abortOnResponseClose,
  analyticsCampaigns,
  analyticsSchemaColumns,
  analyticsStatusCounts,
  analyticsSummary,
  analyticsTierCounts,
  assertAnalyticsPrivacySchema,
  closeDatabase,
  eventByTurnId,
  failEvent,
  insertEvent,
  listCampaigns,
  settleEvent,
  upsertCampaign,
} from '../src/lib/database.js';
import { finalizeSettlement } from '../src/lib/agent-routing.js';
import { initSponsorStore } from '../src/lib/sponsorStore.js';

await initSponsorStore();

const summary = analyticsSummary() as { total?: number; settled_count?: number; subsidy_total?: number };
assert.equal(summary.total, 30, 'a fresh database should contain one deterministic event for each of the last 30 days');
assert.equal(summary.settled_count, 30, 'fixture events should be settled so aggregate subsidy is available');
assert.ok(Number(summary.subsidy_total) > 0, 'fixture events should include funded subsidy');
assert.ok(Object.keys(analyticsTierCounts()).length >= 4, 'fixture events should cover A/B/C/NONE tiers');
assert.ok(analyticsCampaigns().length > 0, 'fixture events should include campaign aggregates');
assertAnalyticsPrivacySchema();
const columns = analyticsSchemaColumns();
for (const forbidden of ['prompt', 'model_output', 'tool_data', 'api_key', 'user_id']) {
  assert.ok(!columns.includes(forbidden), `analytics must not contain ${forbidden}`);
}
for (const required of ['cache_write_tokens', 'cost_input_cache_hit', 'cost_input_cache_miss', 'cost_cache_write', 'cost_output']) {
  assert.ok(columns.includes(required), `analytics must preserve ${required}`);
}

// Repeated startup is idempotent because each fixture row has a stable seed key.
await initSponsorStore();
assert.equal((analyticsSummary() as { total?: number }).total, 30, 'repeated startup must not duplicate fixture rows');

const seeded = listCampaigns()[0];
assert.ok(seeded, 'fixture must include a campaign to test bootstrap preservation');
upsertCampaign({ ...seeded, ad_copy: 'advertiser-edited copy' });
await initSponsorStore();
assert.equal(listCampaigns().find((campaign) => campaign.id === seeded.id)?.ad_copy, 'advertiser-edited copy', 'fixture import must not overwrite an existing campaign on restart');

const auditEvent = (turn_id: string) => ({ turn_id, tier: 'NONE' as const, reason_code: 'routing_failure' as const, similarity: 0, provisional_savings: 0, reason: 'test' });
insertEvent(auditEvent('failed-turn'), { provider: 'deepseek', model: 'deepseek-v4-flash', runtimeMode: 'mock' });
insertEvent(auditEvent('aborted-turn'), { provider: 'deepseek', model: 'deepseek-v4-flash', runtimeMode: 'mock' });
failEvent('failed-turn');
abortEvent('aborted-turn');
const statuses = analyticsStatusCounts();
assert.equal(statuses.failed, 1, 'failed turns must remain visible to analytics');
assert.equal(statuses.aborted, 1, 'aborted turns must remain visible to analytics');

const settledTurn = 'component-cost-turn';
insertEvent({ ...auditEvent(settledTurn), tier: 'B', reason_code: 'matched' }, { provider: 'deepseek', model: 'deepseek-v4-flash', runtimeMode: 'mock' });
const settlement = finalizeSettlement('B', {
  provider: 'deepseek',
  model: 'deepseek-v4-flash',
  thinkingLevel: 'medium',
  runtimeMode: 'mock',
  inputTokens: 90,
  promptTokens: 120,
  cacheHitTokens: 30,
  cacheWriteTokens: 11,
  outputTokens: 60,
});
settleEvent(settledTurn, settlement);
const settledRow = eventByTurnId(settledTurn);
assert.equal(settledRow?.status, 'settled', 'a completed turn must be settled');
assert.equal(settledRow?.cache_write_tokens, 11, 'cache-write usage must persist');
assert.equal(settledRow?.cost_cache_write, settlement.cost.cache_write, 'cache-write cost must persist');
assert.equal(settledRow?.cost_input_cache_hit, settlement.cost.input_cache_hit, 'cache-hit cost must persist');

let closeListener: (() => void) | undefined;
const response = { once: (_event: 'close', listener: () => void) => { closeListener = listener; } };
const abortedBeforeSettlement = 'response-close-turn';
insertEvent(auditEvent(abortedBeforeSettlement), { provider: 'deepseek', model: 'deepseek-v4-flash', runtimeMode: 'mock' });
abortOnResponseClose(response, abortedBeforeSettlement);
closeListener?.();
settleEvent(abortedBeforeSettlement, settlement);
assert.equal(eventByTurnId(abortedBeforeSettlement)?.status, 'aborted', 'a late settlement must not overwrite an aborted turn');

closeDatabase();
closeDatabase();
console.log('OK: transactional deterministic fixtures, restart preservation, privacy-safe component analytics, and terminal failed/aborted auditing.');
