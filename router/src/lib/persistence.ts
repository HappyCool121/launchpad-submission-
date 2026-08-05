import type { AdPayload, RuntimeMode, Settlement } from './types.js';
import { getRuntimeConfig } from '../runtime/config.js';
import { getPostgresPool } from '../runtime/postgres.js';

const local = getRuntimeConfig().serviceMode ? undefined : await import('./database.js');
export type CampaignRow = {
  id: string;
  brand_name: string;
  ad_copy: string;
  target_keywords: string;
  click_url: string | null;
  is_synthetic: boolean;
  disclosure: string | null;
};

function microusd(value: number): number { return Math.max(0, Math.round(value * 1_000_000)); }

export async function listCampaigns(): Promise<CampaignRow[]> {
  if (local) return local.listCampaigns();
  const result = await getPostgresPool().query<Omit<CampaignRow, 'target_keywords'> & { target_keywords: string[] }>(
    `select id,brand_name,ad_copy,target_keywords,click_url,is_synthetic,disclosure
      from router.campaigns where active=true and review_status='approved' order by id`,
  );
  return result.rows.map((row) => ({ ...row, target_keywords: JSON.stringify(row.target_keywords) }));
}

export async function upsertCampaign(row: CampaignRow): Promise<void> {
  if (local) { local.upsertCampaign(row); return; }
  await getPostgresPool().query(`insert into router.campaigns(id,brand_name,ad_copy,target_keywords,click_url,is_synthetic,disclosure,active,review_status,reviewed_at)
    values($1,$2,$3,$4,$5,$6,$7,true,'approved',now())
    on conflict(id) do update set brand_name=excluded.brand_name,ad_copy=excluded.ad_copy,target_keywords=excluded.target_keywords,
      click_url=excluded.click_url,is_synthetic=excluded.is_synthetic,disclosure=excluded.disclosure,updated_at=now()`,
  [row.id, row.brand_name, row.ad_copy, JSON.parse(row.target_keywords), row.click_url, row.is_synthetic, row.disclosure]);
}

export async function bootstrapCampaignsAndAnalytics(rows: CampaignRow[]): Promise<void> {
  if (local) { local.bootstrapCampaignsAndAnalytics(rows); return; }
  const client = await getPostgresPool().connect();
  try {
    await client.query('begin');
    for (const row of rows) await client.query(`insert into router.campaigns(id,brand_name,ad_copy,target_keywords,click_url,is_synthetic,disclosure,active,review_status,reviewed_at)
      values($1,$2,$3,$4,$5,$6,$7,true,'approved',now()) on conflict(id) do nothing`,
      [row.id, row.brand_name, row.ad_copy, JSON.parse(row.target_keywords), row.click_url, row.is_synthetic, row.disclosure]);
    await client.query('commit');
  } catch (error) { await client.query('rollback'); throw error; } finally { client.release(); }
}

export async function insertEvent(ad: AdPayload, meta: { client?: string; provider: string; model: string; runtimeMode: RuntimeMode; reservationId?: string }): Promise<void> {
  if (local) { local.insertEvent(ad, meta); return; }
  await getPostgresPool().query(`insert into router.ad_events(
      turn_id,reservation_id,installation_id,token_family_id,campaign_id,tier,reason_code,similarity,client,provider,model,runtime_mode,status
    ) select $1,$2,r.installation_id,r.token_family_id,$3,$4,$5,$6,$7,$8,$9,$10,'pending'
      from (values(1)) seed(value)
      left join router.reservations r on r.id=$2
      on conflict(turn_id) do nothing`,
  [ad.turn_id, meta.reservationId ?? null, ad.campaign_id ?? null, ad.tier, ad.reason_code, ad.similarity, meta.client ?? null, meta.provider, meta.model, meta.runtimeMode]);
}

export async function markImpressionQueued(turnId: string): Promise<void> {
  if (local) return;
  await getPostgresPool().query(`update router.ad_events
    set impression_at=coalesce(impression_at,now())
    where turn_id=$1
      and runtime_mode='live'
      and campaign_id is not null
      and tier <> 'NONE'
      and reason_code='matched'`, [turnId]);
}

export async function recordQueuedImpression(turnId: string): Promise<void> {
  try {
    await markImpressionQueued(turnId);
  } catch (error) {
    console.warn(JSON.stringify({
      event: 'impression_record_failed',
      error_type: error instanceof Error ? error.name : 'UnknownError',
    }));
  }
}

export async function settleEvent(turnId: string, settlement: Settlement): Promise<void> {
  if (local) { local.settleEvent(turnId, settlement); return; }
  await getPostgresPool().query(`update router.ad_events set status='settled',settled_at=now(),input_tokens=$2,cache_hit_tokens=$3,cache_miss_tokens=$4,
    output_tokens=$5,cost_microusd=$6,subsidy_microusd=$7,paid_microusd=$8 where turn_id=$1 and status in ('pending','off')`,
  [turnId, settlement.input_tokens, settlement.cache_hit_tokens, settlement.cache_miss_tokens, settlement.output_tokens, microusd(settlement.prompt_cost), microusd(settlement.ad_subsidy), microusd(settlement.paid)]);
}

export async function failEvent(turnId: string): Promise<void> {
  if (local) { local.failEvent(turnId); return; }
  await getPostgresPool().query(`update router.ad_events set status='failed' where turn_id=$1 and status in ('pending','off')`, [turnId]);
}

export async function markEventRecoveryRequired(turnId: string): Promise<void> {
  if (local) { local.failEvent(turnId); return; }
  await getPostgresPool().query(`update router.ad_events set status='recovery_required'
    where turn_id=$1 and status in ('pending','off','failed','aborted')`, [turnId]);
}

export async function abortEvent(turnId: string): Promise<void> {
  if (local) { local.abortEvent(turnId); return; }
  await getPostgresPool().query(`update router.ad_events set status='aborted' where turn_id=$1 and status in ('pending','off')`, [turnId]);
}

export function abortOnResponseClose(response: { once: (event: 'close', listener: () => void) => unknown }, turnId: string): () => void {
  let finalized = false;
  response.once('close', () => { if (!finalized) void abortEvent(turnId); });
  return () => { finalized = true; };
}

export async function analyticsSummary(from?: string, to?: string): Promise<Record<string, unknown>> {
  if (local) return local.analyticsSummary(from, to) as Record<string, unknown>;
  const values: string[] = []; const clauses: string[] = [];
  if (from) { values.push(from); clauses.push(`created_at >= $${values.length}`); }
  if (to) { values.push(to); clauses.push(`created_at <= $${values.length}`); }
  const where = clauses.length ? `where ${clauses.join(' and ')}` : '';
  const result = await getPostgresPool().query(`select count(*)::int total,count(campaign_id)::int campaign_hits,
    count(*) filter(where tier='NONE')::int none_count,count(*) filter(where status='settled')::int settled_count,
    coalesce(sum(subsidy_microusd),0)::bigint subsidy_total_microusd from router.ad_events ${where}`, values);
  return result.rows[0] ?? {};
}

export async function analyticsCampaigns(from?: string, to?: string): Promise<Record<string, unknown>[]> {
  if (local) return local.analyticsCampaigns(from, to) as Record<string, unknown>[];
  const values: string[] = []; const clauses = ['e.campaign_id is not null'];
  if (from) { values.push(from); clauses.push(`e.created_at >= $${values.length}`); }
  if (to) { values.push(to); clauses.push(`e.created_at <= $${values.length}`); }
  const result = await getPostgresPool().query(`select e.campaign_id,c.brand_name,count(*)::int hits,
    count(*) filter(where e.tier='A')::int a_count,count(*) filter(where e.tier='B')::int b_count,count(*) filter(where e.tier='C')::int c_count,
    count(*) filter(where e.status='settled')::int settled_count,
    count(*) filter(where e.runtime_mode='live' and e.impression_at is not null)::int live_impressions,
    coalesce(sum(e.subsidy_microusd),0)::bigint funded_subsidy_microusd
    from router.ad_events e join router.campaigns c on c.id=e.campaign_id where ${clauses.join(' and ')} group by e.campaign_id,c.brand_name`, values);
  return result.rows;
}

async function grouped(column: 'tier'|'status', from?: string, to?: string): Promise<Record<string, number>> {
  if (local) return column === 'tier' ? local.analyticsTierCounts(from, to) : local.analyticsStatusCounts(from, to);
  const values: string[] = []; const clauses: string[] = [];
  if (from) { values.push(from); clauses.push(`created_at >= $${values.length}`); } if (to) { values.push(to); clauses.push(`created_at <= $${values.length}`); }
  const result = await getPostgresPool().query<{ key: string; count: number }>(`select ${column} key,count(*)::int count from router.ad_events ${clauses.length ? `where ${clauses.join(' and ')}` : ''} group by ${column}`, values);
  return Object.fromEntries(result.rows.map((row) => [row.key, row.count]));
}
export function analyticsTierCounts(from?: string, to?: string): Promise<Record<string, number>> { return grouped('tier', from, to); }
export function analyticsStatusCounts(from?: string, to?: string): Promise<Record<string, number>> { return grouped('status', from, to); }

export function closePersistence(): void { if (local) local.closeDatabase(); }
