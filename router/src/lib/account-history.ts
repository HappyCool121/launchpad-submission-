import { getPostgresPool } from '../runtime/postgres.js';

const HISTORY_DAYS = 30;

type UsageHistoryRow = {
  date: string;
  model_id: string;
  requests: number;
  input_tokens: string;
  cache_hit_tokens: string;
  output_tokens: string;
  direct_cost_microusd: string;
  charged_cost_microusd: string | null;
  subsidy_microusd: string | null;
  settled_paid_microusd: string;
  settled_subsidy_microusd: string;
  incomplete_settlement_count: number;
  financial_breakdown_complete: boolean;
};

type AdvertiserHistoryRow = {
  date: string;
  campaign_id: string;
  tier_a_impressions: number;
  tier_b_impressions: number;
  tier_c_impressions: number;
  total_impressions: number;
};

function historyWindow() {
  const end = new Date();
  end.setUTCHours(0, 0, 0, 0);
  end.setUTCDate(end.getUTCDate() + 1);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - HISTORY_DAYS);
  return {
    start_at: start.toISOString(),
    end_at: end.toISOString(),
    days: HISTORY_DAYS,
  };
}

export async function loadAccountUsageHistory(userId: string) {
  const result = await getPostgresPool().query<UsageHistoryRow>(`
    with bounds as (
      select
        (date_trunc('day', now() at time zone 'UTC') - interval '29 days') at time zone 'UTC' as start_at,
        (date_trunc('day', now() at time zone 'UTC') + interval '1 day') at time zone 'UTC' as end_at
    )
    select
      to_char(u.created_at at time zone 'UTC', 'YYYY-MM-DD') as date,
      u.model as model_id,
      count(*)::int as requests,
      coalesce(sum(u.input_tokens), 0)::text as input_tokens,
      coalesce(sum(u.cache_hit_tokens), 0)::text as cache_hit_tokens,
      coalesce(sum(u.output_tokens), 0)::text as output_tokens,
      coalesce(sum(u.cost_microusd), 0)::text as direct_cost_microusd,
      case when count(*) filter (
        where e.reservation_id is null
          or e.status <> 'settled'
          or e.paid_microusd is null
          or e.subsidy_microusd is null
      ) = 0 then coalesce(sum(e.paid_microusd), 0)::text else null end as charged_cost_microusd,
      case when count(*) filter (
        where e.reservation_id is null
          or e.status <> 'settled'
          or e.paid_microusd is null
          or e.subsidy_microusd is null
      ) = 0 then coalesce(sum(e.subsidy_microusd), 0)::text else null end as subsidy_microusd,
      coalesce(sum(e.paid_microusd) filter (
        where e.reservation_id is not null
          and e.status = 'settled'
          and e.paid_microusd is not null
          and e.subsidy_microusd is not null
      ), 0)::text as settled_paid_microusd,
      coalesce(sum(e.subsidy_microusd) filter (
        where e.reservation_id is not null
          and e.status = 'settled'
          and e.paid_microusd is not null
          and e.subsidy_microusd is not null
      ), 0)::text as settled_subsidy_microusd,
      count(*) filter (
        where e.reservation_id is null
          or e.status <> 'settled'
          or e.paid_microusd is null
          or e.subsidy_microusd is null
      )::int as incomplete_settlement_count,
      count(*) filter (
        where e.reservation_id is null
          or e.status <> 'settled'
          or e.paid_microusd is null
          or e.subsidy_microusd is null
      ) = 0 as financial_breakdown_complete
    from router.usage u
    cross join bounds
    left join router.ad_events e on e.reservation_id = u.reservation_id
    where u.user_id = $1
      and u.created_at >= bounds.start_at
      and u.created_at < bounds.end_at
    group by date, u.model
    order by date, u.model
  `, [userId]);

  return {
    window: historyWindow(),
    usage: result.rows.map((row) => ({
      ...row,
      input_tokens: Number(row.input_tokens),
      cache_hit_tokens: Number(row.cache_hit_tokens),
      output_tokens: Number(row.output_tokens),
    })),
  };
}

export async function loadAdvertiserAnalytics(userId: string, includeAllCampaigns = false) {
  const result = await getPostgresPool().query<AdvertiserHistoryRow>(`
    with bounds as (
      select
        (date_trunc('day', now() at time zone 'UTC') - interval '29 days') at time zone 'UTC' as start_at,
        (date_trunc('day', now() at time zone 'UTC') + interval '1 day') at time zone 'UTC' as end_at
    )
    select
      to_char(e.impression_at at time zone 'UTC', 'YYYY-MM-DD') as date,
      c.id as campaign_id,
      count(*) filter (where e.tier = 'A')::int as tier_a_impressions,
      count(*) filter (where e.tier = 'B')::int as tier_b_impressions,
      count(*) filter (where e.tier = 'C')::int as tier_c_impressions,
      count(*)::int as total_impressions
    from router.campaigns c
    join router.ad_events e on e.campaign_id = c.id
    cross join bounds
    where ($2::boolean or c.advertiser_user_id = $1)
      and e.runtime_mode = 'live'
      and e.impression_at is not null
      and e.impression_at >= bounds.start_at
      and e.impression_at < bounds.end_at
      and e.tier in ('A', 'B', 'C')
    group by date, c.id
    order by date, c.id
  `, [userId, includeAllCampaigns]);

  return {
    window: historyWindow(),
    impressions: result.rows,
  };
}
