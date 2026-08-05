import { authorizedModelsForAccount, listModels } from './modelRegistry.js';
import { MODEL_PRICING } from './pricing.js';
import type { RouterModelId } from './types.js';
import type { Principal } from '../runtime/auth.js';
import { getRuntimeConfig } from '../runtime/config.js';
import { getPostgresPool } from '../runtime/postgres.js';

type SummaryRow = {
  status: Principal['status'];
  role: Principal['role'];
  is_developer: boolean;
  is_advertiser: boolean;
  flash_enabled: boolean;
  pro_enabled: boolean;
  daily_limit_microusd: string;
  monthly_limit_microusd: string;
  traffic_mode: 'disabled' | 'owner_only' | 'beta';
  active_reservation_microusd: string;
  day_requests: string;
  day_input_tokens: string;
  day_cache_hit_tokens: string;
  day_output_tokens: string;
  day_gross_microusd: string;
  day_subsidy_microusd: string;
  day_net_microusd: string;
  day_incomplete: string;
  month_requests: string;
  month_input_tokens: string;
  month_cache_hit_tokens: string;
  month_output_tokens: string;
  month_gross_microusd: string;
  month_subsidy_microusd: string;
  month_net_microusd: string;
  month_incomplete: string;
  day_reset_at: Date;
  month_reset_at: Date;
};

function money(value: string | number | bigint): string {
  return BigInt(value).toString();
}

function count(value: string): number {
  return Number(value);
}

function availability(
  modelId: string,
  configured: boolean,
  enabled: boolean,
  row: SummaryRow,
): { available: boolean; unavailable_reason: string | null } {
  const config = getRuntimeConfig();
  if (!configured) return { available: false, unavailable_reason: 'provider_not_configured' };
  if (!enabled) return { available: false, unavailable_reason: 'model_not_enabled' };
  if (row.status !== 'active') return { available: false, unavailable_reason: 'account_inactive' };
  if (!row.is_developer) return { available: false, unavailable_reason: 'developer_required' };
  if (!config.liveTrafficEnabled) return { available: false, unavailable_reason: 'deployment_live_traffic_disabled' };
  if (row.traffic_mode === 'disabled') return { available: false, unavailable_reason: 'traffic_disabled' };
  if (row.traffic_mode === 'owner_only' && row.role !== 'owner') {
    return { available: false, unavailable_reason: 'owner_only' };
  }
  if (!(modelId in MODEL_PRICING)) return { available: false, unavailable_reason: 'pricing_unavailable' };
  return { available: true, unavailable_reason: null };
}

function period(
  prefix: 'day' | 'month',
  row: SummaryRow,
  limit: string,
  resetAt: Date,
) {
  const gross = BigInt(row[`${prefix}_gross_microusd`]);
  const held = BigInt(row.active_reservation_microusd);
  const allowance = BigInt(limit);
  const remaining = allowance > gross + held ? allowance - gross - held : 0n;
  const incomplete = BigInt(row[`${prefix}_incomplete`]) > 0n;
  return {
    settled_requests: count(row[`${prefix}_requests`]),
    input_tokens: count(row[`${prefix}_input_tokens`]),
    cache_hit_tokens: count(row[`${prefix}_cache_hit_tokens`]),
    output_tokens: count(row[`${prefix}_output_tokens`]),
    gross_cost_used_microusd: money(gross),
    active_reservation_microusd: money(held),
    limit_microusd: money(allowance),
    remaining_allowance_microusd: money(remaining),
    reset_at: resetAt.toISOString(),
    subsidy_microusd: incomplete ? null : money(row[`${prefix}_subsidy_microusd`]),
    net_cost_after_subsidy_microusd: incomplete ? null : money(row[`${prefix}_net_microusd`]),
    financial_breakdown_complete: !incomplete,
  };
}

export async function loadAccountSummary(userId: string) {
  const result = await getPostgresPool().query<SummaryRow>(`
    with bounds as (
      select
        date_trunc('day', now() at time zone 'UTC') at time zone 'UTC' as day_start,
        (date_trunc('day', now() at time zone 'UTC') + interval '1 day') at time zone 'UTC' as day_reset_at,
        date_trunc('month', now() at time zone 'UTC') at time zone 'UTC' as month_start,
        (date_trunc('month', now() at time zone 'UTC') + interval '1 month') at time zone 'UTC' as month_reset_at
    ),
    account as (
      select u.*, p.traffic_mode
      from router.beta_users u
      cross join router.platform_settings p
      where u.user_id = $1 and p.singleton
    ),
    held as (
      select coalesce(sum(reserved_microusd), 0)::text as active_reservation_microusd
      from router.reservations
      where user_id = $1 and status = 'reserved'
    )
    select
      account.status,
      account.role,
      account.is_developer,
      account.is_advertiser,
      account.flash_enabled,
      account.pro_enabled,
      account.daily_limit_microusd::text,
      account.monthly_limit_microusd::text,
      account.traffic_mode,
      held.active_reservation_microusd,
      count(u.reservation_id) filter (where u.created_at >= bounds.day_start)::text as day_requests,
      coalesce(sum(u.input_tokens) filter (where u.created_at >= bounds.day_start), 0)::text as day_input_tokens,
      coalesce(sum(u.cache_hit_tokens) filter (where u.created_at >= bounds.day_start), 0)::text as day_cache_hit_tokens,
      coalesce(sum(u.output_tokens) filter (where u.created_at >= bounds.day_start), 0)::text as day_output_tokens,
      coalesce(sum(u.cost_microusd) filter (where u.created_at >= bounds.day_start), 0)::text as day_gross_microusd,
      coalesce(sum(e.subsidy_microusd) filter (where u.created_at >= bounds.day_start), 0)::text as day_subsidy_microusd,
      coalesce(sum(e.paid_microusd) filter (where u.created_at >= bounds.day_start), 0)::text as day_net_microusd,
      count(u.reservation_id) filter (
        where u.created_at >= bounds.day_start
          and (e.reservation_id is null or e.status <> 'settled' or e.subsidy_microusd is null or e.paid_microusd is null)
      )::text as day_incomplete,
      count(u.reservation_id) filter (where u.created_at >= bounds.month_start)::text as month_requests,
      coalesce(sum(u.input_tokens) filter (where u.created_at >= bounds.month_start), 0)::text as month_input_tokens,
      coalesce(sum(u.cache_hit_tokens) filter (where u.created_at >= bounds.month_start), 0)::text as month_cache_hit_tokens,
      coalesce(sum(u.output_tokens) filter (where u.created_at >= bounds.month_start), 0)::text as month_output_tokens,
      coalesce(sum(u.cost_microusd) filter (where u.created_at >= bounds.month_start), 0)::text as month_gross_microusd,
      coalesce(sum(e.subsidy_microusd) filter (where u.created_at >= bounds.month_start), 0)::text as month_subsidy_microusd,
      coalesce(sum(e.paid_microusd) filter (where u.created_at >= bounds.month_start), 0)::text as month_net_microusd,
      count(u.reservation_id) filter (
        where u.created_at >= bounds.month_start
          and (e.reservation_id is null or e.status <> 'settled' or e.subsidy_microusd is null or e.paid_microusd is null)
      )::text as month_incomplete,
      bounds.day_reset_at,
      bounds.month_reset_at
    from account
    cross join bounds
    cross join held
    left join router.usage u on u.user_id = account.user_id
    left join router.ad_events e on e.reservation_id = u.reservation_id
    group by
      account.status, account.role, account.is_developer, account.is_advertiser, account.flash_enabled, account.pro_enabled,
      account.daily_limit_microusd, account.monthly_limit_microusd, account.traffic_mode,
      held.active_reservation_microusd, bounds.day_reset_at, bounds.month_reset_at
  `, [userId]);
  const row = result.rows[0];
  if (!row) return undefined;

  const authorizedModels = new Set(authorizedModelsForAccount({
    isDeveloper: row.is_developer,
    flashEnabled: row.flash_enabled,
    proEnabled: row.pro_enabled,
  }));
  const models = listModels().map((descriptor) => {
    const enabled = authorizedModels.has(descriptor.id);
    const pricing = MODEL_PRICING[descriptor.id as RouterModelId];
    return {
      ...descriptor,
      configured: descriptor.configured,
      enabled_for_account: enabled,
      ...availability(descriptor.id, descriptor.configured, enabled, row),
      pricing_microusd_per_million_tokens: pricing ? {
        input_cache_hit: money(Math.round(pricing.input_cache_hit * 1_000_000)),
        input_cache_miss: money(Math.round(pricing.input_cache_miss * 1_000_000)),
        output: money(Math.round(pricing.output * 1_000_000)),
        cache_write: money(Math.round((pricing.cache_write ?? 0) * 1_000_000)),
      } : null,
    };
  });
  const daily = period('day', row, row.daily_limit_microusd, row.day_reset_at);
  const monthly = period('month', row, row.monthly_limit_microusd, row.month_reset_at);
  const effective = BigInt(daily.remaining_allowance_microusd) < BigInt(monthly.remaining_allowance_microusd)
    ? daily.remaining_allowance_microusd : monthly.remaining_allowance_microusd;
  return {
    entitlements: { developer: row.is_developer, advertiser: row.is_advertiser },
    models,
    daily,
    monthly,
    effective_remaining_microusd: effective,
    financial_breakdown_complete: daily.financial_breakdown_complete && monthly.financial_breakdown_complete,
  };
}
