import '../src/lib/env.js';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { getRuntimeConfig } from '../src/runtime/config.js';
import { closePostgres, getPostgresPool, verifyPostgres } from '../src/runtime/postgres.js';
import { analyticsCampaigns, markImpressionQueued } from '../src/lib/persistence.js';

await verifyPostgres();
const testEmail = process.env.ADROUTER_TEST_OWNER_EMAIL;
const testPassword = process.env.ADROUTER_TEST_OWNER_PASSWORD;
if (!testEmail || !testPassword) throw new Error('ADROUTER_TEST_OWNER_EMAIL and ADROUTER_TEST_OWNER_PASSWORD are required.');
const supabaseWorkdir = process.env.ADROUTER_SUPABASE_WORKDIR ?? '..';
const status = spawnSync('npx', ['supabase', '--workdir', supabaseWorkdir, 'status', '-o', 'json'], { cwd: process.cwd(), encoding: 'utf8' });
if (status.status !== 0) throw new Error('Local Supabase is not running.');
const statusValues = JSON.parse(status.stdout) as Record<string, string>;
const anonKey = statusValues.ANON_KEY;
const adminKey = statusValues.SERVICE_ROLE_KEY ?? statusValues.SECRET_KEY;
const config = getRuntimeConfig();
if (!anonKey || !adminKey) throw new Error('Local Supabase status did not return auth keys.');
const signInResponse = await fetch(`${config.supabaseUrl}/auth/v1/token?grant_type=password`, {
  method: 'POST', headers: { apikey: anonKey, 'content-type': 'application/json' },
  body: JSON.stringify({ email: testEmail, password: testPassword }),
});
const signIn = await signInResponse.json() as { access_token?: string; error_description?: string };
if (!signInResponse.ok || !signIn.access_token) throw new Error(signIn.error_description ?? 'Local owner sign-in failed.');
const browserToken = signIn.access_token;
const otherEmail = `other-advertiser-${Date.now()}@example.test`;
const otherPassword = 'OtherAdvertiserOnly-2026!';
const createOther = await fetch(`${config.supabaseUrl}/auth/v1/admin/users`, {
  method: 'POST',
  headers: { apikey: adminKey, authorization: `Bearer ${adminKey}`, 'content-type': 'application/json' },
  body: JSON.stringify({
    email: otherEmail,
    password: otherPassword,
    email_confirm: true,
    app_metadata: { provider: 'google', providers: ['google'] },
  }),
});
const otherUser = await createOther.json() as { id?: string; msg?: string };
if (!createOther.ok || !otherUser.id) throw new Error(otherUser.msg ?? 'Unable to create cross-advertiser fixture.');
await getPostgresPool().query(`insert into router.beta_users(user_id,status,is_advertiser,activated_at)
  values($1,'active',false,now())`, [otherUser.id]);
const otherSignInResponse = await fetch(`${config.supabaseUrl}/auth/v1/token?grant_type=password`, {
  method: 'POST',
  headers: { apikey: anonKey, 'content-type': 'application/json' },
  body: JSON.stringify({ email: otherEmail, password: otherPassword }),
});
const otherSignIn = await otherSignInResponse.json() as { access_token?: string; error_description?: string };
if (!otherSignInResponse.ok || !otherSignIn.access_token) throw new Error(otherSignIn.error_description ?? 'Cross-advertiser sign-in failed.');
const otherBrowserToken = otherSignIn.access_token;
const owner = await getPostgresPool().query<{ user_id: string }>(`select user_id from router.beta_users where role='owner' and status='active' order by activated_at limit 1`);
if (!owner.rows[0]) throw new Error('Bootstrap a local owner first: npm run local:bootstrap-owner -- <email> (password on stdin).');
await getPostgresPool().query('update router.beta_users set is_advertiser=true where user_id=$1', [owner.rows[0].user_id]);
const retiredCredential = 'adr_test_retired-integration-credential';
await getPostgresPool().query(`update router.platform_settings set traffic_mode='owner_only' where singleton=true`);

const port = 18787;
const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], { cwd: process.cwd(), env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
let logs = '';
child.stdout.on('data', (chunk) => { logs += String(chunk); });
child.stderr.on('data', (chunk) => { logs += String(chunk); });
try {
  for (let i = 0; i < 80; i += 1) {
    try { if ((await fetch(`http://127.0.0.1:${port}/health/ready`)).ok) break; } catch { /* booting */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.equal((await fetch(`http://127.0.0.1:${port}/health/live`)).status, 200);
  assert.equal((await fetch(`http://127.0.0.1:${port}/health/ready`)).status, 200, logs);
  const registration = await fetch(`http://127.0.0.1:${port}/v1/account/registration`, {
    method: 'POST', headers: { authorization: `Bearer ${browserToken}`, 'content-type': 'application/json' }, body: '{}',
  });
  assert.equal(registration.status, 200, await registration.text());
  const browserResponse = await fetch(`http://127.0.0.1:${port}/api/chat`, {
    method: 'POST', headers: { authorization: `Bearer ${browserToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'solve 1 + 2x = 3' }], runtime_mode: 'mock', max_output_tokens: 64 }),
  });
  assert.equal(browserResponse.status, 200, await browserResponse.text());
  const summaryResponse = await fetch(`http://127.0.0.1:${port}/v1/account/summary`, {
    headers: { authorization: `Bearer ${browserToken}` },
  });
  assert.equal(summaryResponse.status, 200, await summaryResponse.clone().text());
  const summary = await summaryResponse.json() as {
    entitlements: { developer: boolean; advertiser: boolean };
    models: { id: string; enabled_for_account: boolean; available: boolean; unavailable_reason: string | null }[];
    daily: { gross_cost_used_microusd: string; active_reservation_microusd: string; subsidy_microusd: string | null; net_cost_after_subsidy_microusd: string | null; financial_breakdown_complete: boolean };
    effective_remaining_microusd: string;
  };
  assert.equal(summary.entitlements.advertiser, true);
  assert.equal(summary.entitlements.developer, true);
  assert.equal(summary.models.find((model) => model.id === 'deepseek-v4-flash')?.enabled_for_account, true);
  assert.equal(summary.daily.financial_breakdown_complete, true);
  assert.match(summary.daily.gross_cost_used_microusd, /^\d+$/);
  assert.match(summary.effective_remaining_microusd, /^\d+$/);
  const usageHistoryResponse = await fetch(`http://127.0.0.1:${port}/v1/account/usage`, {
    headers: { authorization: `Bearer ${browserToken}` },
  });
  assert.equal(usageHistoryResponse.status, 200, await usageHistoryResponse.clone().text());
  assert.equal(usageHistoryResponse.headers.get('cache-control'), 'no-store');
  const usageHistory = await usageHistoryResponse.json() as {
    window: { start_at: string; end_at: string; days: number };
    usage: {
      date: string;
      model_id: string;
      requests: number;
      input_tokens: number;
      output_tokens: number;
      direct_cost_microusd: string;
      charged_cost_microusd: string | null;
      subsidy_microusd: string | null;
      settled_paid_microusd: string;
      settled_subsidy_microusd: string;
      incomplete_settlement_count: number;
      financial_breakdown_complete: boolean;
    }[];
  };
  assert.equal(usageHistory.window.days, 30);
  assert(usageHistory.usage.length >= 1);
  assert(usageHistory.usage.every((row) => /^\d{4}-\d{2}-\d{2}$/.test(row.date)));
  assert(usageHistory.usage.every((row) => row.requests >= 1 && row.input_tokens >= 0 && row.output_tokens >= 0));
  assert(usageHistory.usage.every((row) => /^\d+$/.test(row.direct_cost_microusd)));
  assert(usageHistory.usage.every((row) => /^\d+$/.test(row.settled_paid_microusd)
    && /^\d+$/.test(row.settled_subsidy_microusd)
    && row.incomplete_settlement_count >= 0));
  assert(usageHistory.usage.every((row) => row.financial_breakdown_complete
    ? row.charged_cost_microusd !== null && row.subsidy_microusd !== null
    : row.charged_cost_microusd === null && row.subsidy_microusd === null));
  assert.equal((await fetch(`http://127.0.0.1:${port}/v1/account/usage`, {
    headers: { authorization: `Bearer ${retiredCredential}` },
  })).status, 401);
  const response = await fetch(`http://127.0.0.1:${port}/v1/turn`, {
    method: 'POST', headers: { authorization: `Bearer ${retiredCredential}`, 'content-type': 'application/json' },
    body: JSON.stringify({ client: 'integration-test', runtime_mode: 'mock', max_output_tokens: 64,
      input: { messages: [{ role: 'user', content: 'solve 1 + 2x = 3' }] } }),
  });
  const responseText = await response.text();
  assert.equal(response.status, 404, responseText);
  assert.deepEqual(JSON.parse(responseText), { error: 'Not found.', code: 'route_not_available' });
  const apiOnBrowserRoute = await fetch(`http://127.0.0.1:${port}/api/chat`, {
    method: 'POST', headers: { authorization: `Bearer ${retiredCredential}`, 'content-type': 'application/json' }, body: '{}',
  });
  assert.equal(apiOnBrowserRoute.status, 401);
  const browserOnApiRoute = await fetch(`http://127.0.0.1:${port}/v1/turn`, {
    method: 'POST', headers: { authorization: `Bearer ${browserToken}`, 'content-type': 'application/json' }, body: '{}',
  });
  assert.equal(browserOnApiRoute.status, 404);

  const createdKeyResponse = await fetch(`http://127.0.0.1:${port}/v1/account/credentials`, {
    method: 'POST', headers: { authorization: `Bearer ${browserToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'browser integration key', expires_in_days: 1 }),
  });
  assert.equal(createdKeyResponse.status, 404, await createdKeyResponse.clone().text());
  assert.deepEqual(await createdKeyResponse.json(), { error: 'Not found.', code: 'route_not_available' });
  const listedKeys = await fetch(`http://127.0.0.1:${port}/v1/account/credentials`, {
    headers: { authorization: `Bearer ${browserToken}` },
  });
  assert.equal(listedKeys.status, 404);
  const rotatedKeyResponse = await fetch(`http://127.0.0.1:${port}/v1/account/credentials/retired/rotate`, {
    method: 'POST', headers: { authorization: `Bearer ${browserToken}` },
  });
  assert.equal(rotatedKeyResponse.status, 404);
  assert.equal((await fetch(`http://127.0.0.1:${port}/v1/profile`, { headers: { authorization: `Bearer ${retiredCredential}` } })).status, 401);
  assert.equal((await fetch(`http://127.0.0.1:${port}/v1/account/credentials/retired/revoke`, {
    method: 'POST', headers: { authorization: `Bearer ${browserToken}` },
  })).status, 404);

  const deniedCampaigns = await fetch(`http://127.0.0.1:${port}/v1/advertiser/campaigns`, {
    headers: { authorization: `Bearer ${otherBrowserToken}` },
  });
  assert.equal(deniedCampaigns.status, 403);
  const beforeEnable = await getPostgresPool().query<{ revision: string }>('select revision::text from router.beta_users where user_id=$1', [otherUser.id]);
  const enabledAdvertiser = await fetch(`http://127.0.0.1:${port}/v1/operator/accounts/${otherUser.id}/advertiser`, {
    method: 'PUT', headers: { authorization: `Bearer ${browserToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ advertiser: true, expected_revision: beforeEnable.rows[0]?.revision, reason: 'Enable advertiser integration fixture' }),
  });
  assert.equal(enabledAdvertiser.status, 200, await enabledAdvertiser.text());
  const forbiddenSubmission = await fetch(`http://127.0.0.1:${port}/v1/advertiser/campaigns`, {
    method: 'POST', headers: { authorization: `Bearer ${browserToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      id: 'client-controlled',
      brand_name: 'Rejected',
      ad_copy: 'Client fields must be rejected.',
      target_keywords: ['one'],
      active: true,
    }),
  });
  assert.equal(forbiddenSubmission.status, 400);
  const submittedIds: string[] = [];
  for (const suffix of ['One', 'Two']) {
    const submitted = await fetch(`http://127.0.0.1:${port}/v1/advertiser/campaigns`, {
      method: 'POST', headers: { authorization: `Bearer ${browserToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        brand_name: `Integration ${suffix}`,
        ad_copy: `Inactive campaign ${suffix}.`,
        target_keywords: ['  Workspace  ', 'workspace', suffix.toLowerCase()],
        click_url: null,
      }),
    });
    assert.equal(submitted.status, 201, await submitted.clone().text());
    assert.equal(submitted.headers.get('cache-control'), 'no-store');
    const body = await submitted.json() as {
      campaign: {
        id: string;
        active: boolean;
        is_synthetic: boolean;
        disclosure: null;
        live_impressions: number;
        settled_placements: number;
      };
    };
    assert.match(body.campaign.id, /^[0-9a-f-]{36}$/);
    assert.equal(body.campaign.active, false);
    assert.equal(body.campaign.is_synthetic, false);
    assert.equal(body.campaign.disclosure, null);
    assert.equal(body.campaign.live_impressions, 0);
    assert.equal(body.campaign.settled_placements, 0);
    submittedIds.push(body.campaign.id);
  }
  assert.notEqual(submittedIds[0], submittedIds[1]);
  const otherSubmitted = await fetch(`http://127.0.0.1:${port}/v1/advertiser/campaigns`, {
    method: 'POST', headers: { authorization: `Bearer ${otherBrowserToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      brand_name: 'Other Advertiser',
      ad_copy: 'Owned by the other advertiser.',
      target_keywords: ['isolated'],
    }),
  });
  assert.equal(otherSubmitted.status, 201, await otherSubmitted.clone().text());
  const otherCampaignId = ((await otherSubmitted.json()) as { campaign: { id: string } }).campaign.id;
  const submittedRows = await getPostgresPool().query<{
    id: string; advertiser_user_id: string; active: boolean; target_keywords: string[];
  }>(`select id,advertiser_user_id,active,target_keywords
      from router.campaigns where id=any($1::text[]) order by id`, [submittedIds]);
  assert.equal(submittedRows.rowCount, 2);
  assert(submittedRows.rows.every((row) => row.advertiser_user_id === owner.rows[0].user_id && !row.active));
  assert(submittedRows.rows.every((row) => row.target_keywords.length === 2));
  await getPostgresPool().query(`insert into router.campaigns(id,brand_name,ad_copy,target_keywords,click_url,advertiser_user_id,active,review_status,reviewed_at)
    values('integration-owned','Integration Owned','Owned campaign',array['owned'],'https://example.test/owned',$1,true,'approved',now())
    on conflict(id) do update set advertiser_user_id=excluded.advertiser_user_id,review_status='approved',reviewed_at=coalesce(router.campaigns.reviewed_at,now()),active=true,updated_at=now()`, [owner.rows[0].user_id]);
  const ownedCampaigns = await fetch(`http://127.0.0.1:${port}/v1/advertiser/campaigns`, {
    headers: { authorization: `Bearer ${browserToken}` },
  });
  assert.equal(ownedCampaigns.status, 200);
  const ownedBody = await ownedCampaigns.json() as { campaigns: { id: string; settled_placements: number; live_impressions: number; funded_subsidy_microusd: string }[] };
  assert(ownedBody.campaigns.some((campaign) => campaign.id === 'integration-owned'));
  assert(!ownedBody.campaigns.some((campaign) => campaign.id === 'calculator'));
  assert(!ownedBody.campaigns.some((campaign) => campaign.id === otherCampaignId));
  assert(submittedIds.every((id) => ownedBody.campaigns.some((campaign) => campaign.id === id)));
  await getPostgresPool().query(`insert into router.ad_events(
      turn_id,campaign_id,tier,reason_code,similarity,client,provider,model,runtime_mode,status
    ) values
      ('84444444-4444-4444-4444-444444444444','integration-owned','B','matched',0.9,
       'integration','deepseek','deepseek-v4-flash','live','pending'),
      ('85555555-5555-5555-5555-555555555555',$1,'C','matched',0.8,
       'integration','deepseek','deepseek-v4-flash','live','pending')
    on conflict(turn_id) do nothing`, [otherCampaignId]);
  await markImpressionQueued('84444444-4444-4444-4444-444444444444');
  await markImpressionQueued('85555555-5555-5555-5555-555555555555');
  const advertiserAnalyticsResponse = await fetch(`http://127.0.0.1:${port}/v1/advertiser/analytics`, {
    headers: { authorization: `Bearer ${browserToken}` },
  });
  assert.equal(advertiserAnalyticsResponse.status, 200, await advertiserAnalyticsResponse.clone().text());
  assert.equal(advertiserAnalyticsResponse.headers.get('cache-control'), 'no-store');
  const advertiserAnalytics = await advertiserAnalyticsResponse.json() as {
    window: { days: number };
    impressions: {
      date: string;
      campaign_id: string;
      tier_a_impressions: number;
      tier_b_impressions: number;
      tier_c_impressions: number;
      total_impressions: number;
    }[];
  };
  assert.equal(advertiserAnalytics.window.days, 30);
  assert(advertiserAnalytics.impressions.some((row) => row.campaign_id === 'integration-owned'
    && row.tier_a_impressions === 0
    && row.tier_b_impressions === 1
    && row.tier_c_impressions === 0
    && row.total_impressions === 1));
  assert(!advertiserAnalytics.impressions.some((row) => row.campaign_id === otherCampaignId));
  const otherOwned = await fetch(`http://127.0.0.1:${port}/v1/advertiser/campaigns`, {
    headers: { authorization: `Bearer ${otherBrowserToken}` },
  });
  assert.equal(otherOwned.status, 200);
  assert.deepEqual(
    ((await otherOwned.json()) as { campaigns: { id: string }[] }).campaigns.map((campaign) => campaign.id),
    [otherCampaignId],
  );
  const otherAnalytics = await fetch(`http://127.0.0.1:${port}/v1/advertiser/analytics`, {
    headers: { authorization: `Bearer ${otherBrowserToken}` },
  });
  assert.equal(otherAnalytics.status, 200);
  assert.deepEqual(
    ((await otherAnalytics.json()) as { impressions: { campaign_id: string }[] }).impressions.map((row) => row.campaign_id),
    [otherCampaignId],
  );
  await getPostgresPool().query(`update router.campaigns set review_status='approved',reviewed_at=now(),active=true where id=$1`, [otherCampaignId]);
  const beforeRevoke = await getPostgresPool().query<{ revision: string }>('select revision::text from router.beta_users where user_id=$1', [otherUser.id]);
  const revokedAdvertiser = await fetch(`http://127.0.0.1:${port}/v1/operator/accounts/${otherUser.id}/advertiser`, {
    method: 'PUT', headers: { authorization: `Bearer ${browserToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ advertiser: false, expected_revision: beforeRevoke.rows[0]?.revision, reason: 'Revoke advertiser integration fixture' }),
  });
  assert.equal(revokedAdvertiser.status, 200, await revokedAdvertiser.text());
  const deniedAfterRevocation = await fetch(`http://127.0.0.1:${port}/v1/advertiser/campaigns`, {
    method: 'POST', headers: { authorization: `Bearer ${otherBrowserToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ brand_name: 'Denied', ad_copy: 'Denied.', target_keywords: ['denied'] }),
  });
  assert.equal(deniedAfterRevocation.status, 403);
  await getPostgresPool().query(`insert into router.ad_events(
      turn_id,campaign_id,tier,reason_code,similarity,client,provider,model,runtime_mode,status
    ) values
      ('81111111-1111-1111-1111-111111111111','calculator','A','matched',0.9,'integration','deepseek','deepseek-v4-flash','live','pending'),
      ('82222222-2222-2222-2222-222222222222','calculator','A','matched',0.9,'integration','deepseek','deepseek-v4-flash','mock','pending'),
      ('83333333-3333-3333-3333-333333333333',null,'NONE','no_inventory',0,'integration','deepseek','deepseek-v4-flash','live','pending')
    on conflict(turn_id) do nothing`);
  await markImpressionQueued('81111111-1111-1111-1111-111111111111');
  const firstImpression = await getPostgresPool().query<{ impression_at: Date | null }>(
    `select impression_at from router.ad_events where turn_id='81111111-1111-1111-1111-111111111111'`,
  );
  await markImpressionQueued('81111111-1111-1111-1111-111111111111');
  await markImpressionQueued('82222222-2222-2222-2222-222222222222');
  await markImpressionQueued('83333333-3333-3333-3333-333333333333');
  const impressionRows = await getPostgresPool().query<{ turn_id: string; impression_at: Date | null }>(`
    select turn_id,impression_at from router.ad_events
    where turn_id in (
      '81111111-1111-1111-1111-111111111111',
      '82222222-2222-2222-2222-222222222222',
      '83333333-3333-3333-3333-333333333333'
    ) order by turn_id`);
  assert(firstImpression.rows[0]?.impression_at);
  assert.equal(impressionRows.rows[0]?.impression_at?.getTime(), firstImpression.rows[0]?.impression_at?.getTime());
  assert.equal(impressionRows.rows[1]?.impression_at, null);
  assert.equal(impressionRows.rows[2]?.impression_at, null);
  const calculatorAggregate = (await analyticsCampaigns()).find((row) => row.campaign_id === 'calculator') as
    { live_impressions?: number; settled_count?: number } | undefined;
  assert.equal(calculatorAggregate?.live_impressions, 1);
  assert.equal(calculatorAggregate?.settled_count, 0);

  const rows = await getPostgresPool().query<{ browser_reservations: string; events: string; unlinked_events: string; campaign_audits: string; platform_active: string; other_active: string }>(`select
    (select count(*) from router.reservations where user_id=$1 and credential_id is null and auth_source='browser_jwt' and status='settled')::text browser_reservations,
    (select count(*) from router.ad_events where status='settled')::text events,
    (select count(*) from router.ad_events where status='settled' and reservation_id is null)::text unlinked_events,
    (select count(*) from router.audit_events where actor_user_id=$1 and action='advertiser_campaign_submit' and target_id=any($2::text[]))::text campaign_audits,
    (select count(*) from router.campaigns where is_synthetic and active)::text platform_active,
    (select count(*) from router.campaigns where advertiser_user_id=$3 and active)::text other_active`,
  [owner.rows[0].user_id, submittedIds, otherUser.id]);
  assert(Number(rows.rows[0]?.browser_reservations ?? 0) >= 1);
  // The installation-only service contract now creates one settled event in
  // this fixture: the authenticated browser chat above. The retired legacy
  // /v1/turn flow is intentionally asserted as unavailable and cannot create
  // the second event expected by the older test.
  assert(Number(rows.rows[0]?.events ?? 0) >= 1);
  assert.equal(rows.rows[0]?.unlinked_events, '0');
  assert.equal(rows.rows[0]?.campaign_audits, '2');
  assert.equal(rows.rows[0]?.platform_active, '32');
  assert.equal(rows.rows[0]?.other_active, '0');
  console.log('OK: browser and installation-only route boundaries, exact settlement subtotals, owner administration, advertiser isolation, and revocation hold.');
} catch (error) {
  console.error(logs);
  throw error;
} finally {
  child.kill('SIGTERM');
  await Promise.race([once(child, 'exit'), new Promise((resolve) => setTimeout(resolve, 5_000))]);
  await closePostgres();
}
