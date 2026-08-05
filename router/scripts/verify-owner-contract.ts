import assert from 'node:assert/strict';
import { campaignAuditState, LimitsMutation, setOwnerActorContext } from '../src/routes/owner.js';

const limitMutation = { expected_revision: '1', reason: 'Approved capacity change', daily_limit_microusd: '1000', monthly_limit_microusd: '10000', max_concurrency: 1 };
assert.equal(LimitsMutation.safeParse({ ...limitMutation, max_output_tokens: 196_608 }).success, true);
assert.equal(LimitsMutation.safeParse({ ...limitMutation, max_output_tokens: 196_609 }).success, false);
assert.equal(LimitsMutation.safeParse({ ...limitMutation, max_output_tokens: 0 }).success, false);

const row = {
  id: 'campaign-test',
  brand_name: 'Private brand',
  ad_copy: 'Campaign copy must not enter audit details.',
  target_keywords: ['private-target'],
  click_url: 'https://example.test/private-destination',
  advertiser_user_id: '11111111-1111-4111-8111-111111111111',
  active: true,
  is_synthetic: false,
  disclosure: null,
  review_status: 'approved' as const,
  reviewed_by: '22222222-2222-4222-8222-222222222222',
  reviewed_at: new Date('2026-07-30T00:00:00.000Z'),
  review_note: 'Internal review note',
  activated_at: new Date('2026-07-30T00:01:00.000Z'),
  deactivated_at: null,
  revision: '8',
  created_at: new Date('2026-07-29T00:00:00.000Z'),
  updated_at: new Date('2026-07-30T00:01:00.000Z'),
};

const audit = campaignAuditState(row);
const serialized = JSON.stringify(audit);
for (const protectedValue of [row.brand_name, row.ad_copy, ...row.target_keywords, row.click_url, row.review_note]) {
  assert(!serialized.includes(protectedValue), 'Campaign presentation or targeting data entered owner audit state.');
}
assert.deepEqual(audit, {
  advertiser_user_id: row.advertiser_user_id,
  internal: false,
  active: true,
  review_status: 'approved',
  reviewed_by: row.reviewed_by,
  reviewed_at: '2026-07-30T00:00:00.000Z',
  activated_at: '2026-07-30T00:01:00.000Z',
  deactivated_at: null,
  revision: '8',
});

const queries: Array<{ text: string; values: unknown[] | undefined }> = [];
const client = {
  query: async (text: string, values?: unknown[]) => {
    queries.push({ text, values });
    return undefined;
  },
};
await setOwnerActorContext(client as never, '22222222-2222-4222-8222-222222222222');
assert.equal(queries.length, 1);
assert.match(queries[0]!.text, /set_config\('router\.actor_user_id',\$1,true\)/);
assert.deepEqual(queries[0]!.values, ['22222222-2222-4222-8222-222222222222']);

console.log('OK: owner audit state excludes campaign content and account/campaign mutations attach actor context.');
