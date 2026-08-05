import { Buffer } from 'node:buffer';
import { Router, type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { loadAccountUsageHistory } from '../lib/account-history.js';
import { loadAccountSummary } from '../lib/account-summary.js';
import { getCampaignInventoryStatus, requestCampaignRefresh } from '../lib/sponsorStore.js';
import { principalFrom, requireBrowserAuth, requireRole, type Principal } from '../runtime/auth.js';
import { getPostgresPool } from '../runtime/postgres.js';
import { authorizedModelsForAccount, OWNER_MANAGED_MODELS, SUPPORTED_MODELS } from '../lib/modelRegistry.js';

export const ownerRouter = Router();

const UuidSchema = z.string().uuid();
const CampaignIdSchema = z.string().trim().min(1).max(120).regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/);
const RevisionSchema = z.union([z.string().regex(/^\d{1,20}$/), z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER)])
  .transform((value) => String(value));
const ReasonSchema = z.string().trim().min(3).max(240).refine((value) => !/(?:\badr_(?:at|rt|dc|live|test)_|\bsk-[A-Za-z0-9]|\bBearer\s+|postgres(?:ql)?:\/\/|\beyJ[A-Za-z0-9_-]{10,})/i.test(value), {
  message: 'The reason appears to contain secret material.',
});
const MutationBase = z.object({
  expected_revision: RevisionSchema,
  reason: ReasonSchema,
  confirm_user_id: z.string().uuid().optional(),
}).strict();
const DeveloperMutation = MutationBase.extend({ developer: z.boolean() }).strict();
const AdvertiserMutation = MutationBase.extend({ advertiser: z.boolean() }).strict();
export const LimitsMutation = MutationBase.extend({
  daily_limit_microusd: z.union([z.string().regex(/^\d{1,20}$/), z.number().int().nonnegative()]).transform(String),
  monthly_limit_microusd: z.union([z.string().regex(/^\d{1,20}$/), z.number().int().nonnegative()]).transform(String),
  max_concurrency: z.number().int().min(1).max(10),
  max_output_tokens: z.number().int().min(1).max(196_608),
}).strict();
const ModelsMutation = MutationBase.extend({
  models: z.array(z.enum(OWNER_MANAGED_MODELS as [string, ...string[]])).max(OWNER_MANAGED_MODELS.length)
    .refine((models) => new Set(models).size === models.length, { message: 'Model identifiers must be unique.' }),
}).strict();
const StatusMutation = MutationBase.extend({
  status: z.enum(['active', 'suspended', 'disabled']),
  confirm_status: z.literal('disabled').optional(),
}).strict();
const CampaignMutationBase = z.object({ expected_revision: RevisionSchema, reason: ReasonSchema }).strict();
const CampaignApproveMutation = CampaignMutationBase.extend({ activate: z.boolean().default(false) }).strict();

const BooleanQuery = z.enum(['true', 'false']).transform((value) => value === 'true');
const AccountListQuery = z.object({
  q: z.string().trim().max(120).optional(),
  status: z.enum(['pending', 'active', 'suspended', 'disabled']).optional(),
  role: z.enum(['user', 'operator', 'owner']).optional(),
  developer: BooleanQuery.optional(),
  advertiser: BooleanQuery.optional(),
  model: z.enum(SUPPORTED_MODELS as [string, ...string[]]).optional(),
  client: z.enum(['browser', 'cli', 'desktop', 'opencode']).optional(),
  warning: BooleanQuery.optional(),
  sort: z.enum(['created_at', 'email', 'last_settled_at']).default('created_at'),
  direction: z.enum(['asc', 'desc']).default('desc'),
  cursor: z.string().max(1024).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
}).strict();
const CampaignListQuery = z.object({
  q: z.string().trim().max(120).optional(),
  review_status: z.enum(['pending', 'approved', 'rejected']).optional(),
  active: BooleanQuery.optional(),
  advertiser: z.string().trim().max(120).optional(),
  keyword: z.string().trim().max(64).optional(),
  created_from: z.string().datetime({ offset: true }).optional(),
  created_to: z.string().datetime({ offset: true }).optional(),
  sort: z.enum(['created_at', 'reviewed_at', 'brand_name']).default('created_at'),
  direction: z.enum(['asc', 'desc']).default('desc'),
  cursor: z.string().max(1024).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
}).strict();
const SettlementQuery = z.object({
  cursor: z.string().max(1024).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
}).strict();

type AccountMutationKind = 'developer' | 'advertiser' | 'limits' | 'models' | 'status';
type AccountRow = {
  user_id: string;
  display_label: string | null;
  status: Principal['status'];
  role: Principal['role'];
  is_developer: boolean;
  is_advertiser: boolean;
  daily_limit_microusd: string;
  monthly_limit_microusd: string;
  max_concurrency: number;
  max_output_tokens: number;
  flash_enabled: boolean;
  pro_enabled: boolean;
  revision: string;
  created_at: Date;
  activated_at: Date | null;
  disabled_at: Date | null;
  updated_at: Date;
};

type CampaignRow = {
  id: string;
  brand_name: string;
  ad_copy: string;
  target_keywords: string[];
  click_url: string | null;
  advertiser_user_id: string | null;
  active: boolean;
  is_synthetic: boolean;
  disclosure: string | null;
  review_status: 'pending' | 'approved' | 'rejected';
  reviewed_by: string | null;
  reviewed_at: Date | null;
  review_note: string | null;
  activated_at: Date | null;
  deactivated_at: Date | null;
  revision: string;
  created_at: Date;
  updated_at: Date;
};

function noStore(_req: Request, res: Response, next: NextFunction): void {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
  next();
}

const ownerOnly: RequestHandler[] = [requireBrowserAuth, requireRole('owner'), noStore];

function asyncRoute(handler: (req: Request, res: Response) => Promise<void>): RequestHandler {
  return (req, res, next) => { void handler(req, res).catch(next); };
}

function invalid(res: Response, code: string, message: string, details?: unknown): void {
  res.status(400).json({ error: message, code, ...(details ? { details } : {}) });
}

function encodeCursor(value: string, id: string, rank?: number): string {
  return Buffer.from(JSON.stringify({ value, id, ...(rank === undefined ? {} : { rank }) }), 'utf8').toString('base64url');
}

function decodeCursor(value: string | undefined): { value: string; id: string; rank?: number } | undefined {
  if (!value) return undefined;
  try {
    const decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown;
    const parsed = z.object({ value: z.string().max(200), id: z.string().max(120), rank: z.number().int().min(0).max(1).optional() }).strict().safeParse(decoded);
    return parsed.success ? parsed.data : undefined;
  } catch { return undefined; }
}

function safeAccount(row: AccountRow): Record<string, unknown> {
  const models = [row.flash_enabled ? 'deepseek-v4-flash' : null, row.pro_enabled ? 'deepseek-v4-pro' : null].filter(Boolean);
  return {
    user_id: row.user_id,
    display_label: row.display_label,
    status: row.status,
    role: row.role,
    is_developer: row.is_developer,
    is_advertiser: row.is_advertiser,
    daily_limit_microusd: String(row.daily_limit_microusd),
    monthly_limit_microusd: String(row.monthly_limit_microusd),
    max_concurrency: row.max_concurrency,
    max_output_tokens: row.max_output_tokens,
    models,
    authorized_models: authorizedModelsForAccount({ isDeveloper: row.is_developer, flashEnabled: row.flash_enabled, proEnabled: row.pro_enabled }),
    revision: String(row.revision),
    created_at: row.created_at.toISOString(),
    activated_at: row.activated_at?.toISOString() ?? null,
    disabled_at: row.disabled_at?.toISOString() ?? null,
    updated_at: row.updated_at.toISOString(),
  };
}

function safeCampaign(row: CampaignRow): Record<string, unknown> {
  return {
    id: row.id,
    brand_name: row.brand_name,
    ad_copy: row.ad_copy,
    target_keywords: row.target_keywords,
    click_url: row.click_url,
    advertiser_user_id: row.advertiser_user_id,
    internal: row.advertiser_user_id === null,
    active: row.active,
    is_synthetic: row.is_synthetic,
    disclosure: row.disclosure,
    review_status: row.review_status,
    reviewed_by: row.reviewed_by,
    reviewed_at: row.reviewed_at?.toISOString() ?? null,
    review_note: row.review_note,
    activated_at: row.activated_at?.toISOString() ?? null,
    deactivated_at: row.deactivated_at?.toISOString() ?? null,
    revision: String(row.revision),
    created_at: row.created_at.toISOString(),
    updated_at: row.updated_at.toISOString(),
  };
}

export function campaignAuditState(row: CampaignRow): Record<string, unknown> {
  return {
    advertiser_user_id: row.advertiser_user_id,
    internal: row.advertiser_user_id === null,
    active: row.active,
    review_status: row.review_status,
    reviewed_by: row.reviewed_by,
    reviewed_at: row.reviewed_at?.toISOString() ?? null,
    activated_at: row.activated_at?.toISOString() ?? null,
    deactivated_at: row.deactivated_at?.toISOString() ?? null,
    revision: String(row.revision),
  };
}

export async function setOwnerActorContext(client: Pick<PoolClient, 'query'>, actorUserId: string): Promise<void> {
  await client.query(`select set_config('router.actor_user_id',$1,true)`, [actorUserId]);
}

ownerRouter.get('/operator/accounts', ...ownerOnly, asyncRoute(async (req, res) => {
  const parsed = AccountListQuery.safeParse(req.query);
  if (!parsed.success) { invalid(res, 'invalid_account_query', 'The account query is invalid.', parsed.error.flatten()); return; }
  const input = parsed.data;
  const cursor = decodeCursor(input.cursor);
  if (input.cursor && !cursor) { invalid(res, 'invalid_cursor', 'The pagination cursor is invalid.'); return; }
  const params: unknown[] = [];
  const bind = (value: unknown) => { params.push(value); return `$${params.length}`; };
  const clauses: string[] = [];
  if (input.q) {
    const parameter = bind(`%${input.q.replace(/[\\%_]/g, '\\$&')}%`);
    clauses.push(`(coalesce(identity.email,'') ilike ${parameter} escape '\\' or u.user_id::text ilike ${parameter} escape '\\' or coalesce(u.display_label,'') ilike ${parameter} escape '\\')`);
  }
  if (input.status) clauses.push(`u.status=${bind(input.status)}`);
  if (input.role) clauses.push(`u.role=${bind(input.role)}`);
  if (input.developer !== undefined) clauses.push(`u.is_developer=${bind(input.developer)}`);
  if (input.advertiser !== undefined) clauses.push(`u.is_advertiser=${bind(input.advertiser)}`);
  if (input.model) clauses.push(input.model === 'deepseek-v4-flash' ? 'u.flash_enabled'
    : input.model === 'deepseek-v4-pro' ? 'u.pro_enabled' : 'u.is_developer');
  if (input.client) clauses.push(`${bind(input.client)}=any(coalesce(client_types.client_types,array[]::text[]))`);
  if (input.warning !== undefined) {
    const expression = `(coalesce(reservation_stats.unresolved_count,0)>0 or coalesce(usage_stats.incomplete_count,0)>0)`;
    clauses.push(input.warning ? expression : `not ${expression}`);
  }
  const sortExpression = input.sort === 'email' ? `coalesce(identity.email,'')`
    : input.sort === 'last_settled_at' ? `coalesce(usage_stats.last_settled_at,'epoch'::timestamptz)` : 'u.created_at';
  if (cursor) {
    const comparison = input.direction === 'desc' ? '<' : '>';
    const cursorValue = bind(cursor.value);
    const cursorId = bind(cursor.id);
    const cast = input.sort === 'email' ? 'text' : 'timestamptz';
    clauses.push(`(${sortExpression},u.user_id) ${comparison} (${cursorValue}::${cast},${cursorId}::uuid)`);
  }
  const limitParameter = bind(input.limit + 1);
  const direction = input.direction === 'desc' ? 'desc' : 'asc';
  const result = await getPostgresPool().query(`
    with identity as (
      select claimed_by user_id,max(email) email,max(claimed_at) registered_at
      from router.auth_invites where claimed_by is not null group by claimed_by
    ), usage_stats as (
      select u.user_id,
        coalesce(sum(u.cost_microusd) filter(where u.created_at>=date_trunc('day',now())),0)::text day_gross_microusd,
        coalesce(sum(u.cost_microusd) filter(where u.created_at>=date_trunc('month',now())),0)::text month_gross_microusd,
        max(e.settled_at) filter(where e.status='settled') last_settled_at,
        count(*) filter(where e.reservation_id is null or e.status<>'settled' or e.subsidy_microusd is null or e.paid_microusd is null)::int incomplete_count
      from router.usage u left join router.ad_events e on e.reservation_id=u.reservation_id group by u.user_id
    ), reservation_stats as (
      select user_id,
        coalesce(sum(reserved_microusd) filter(where status='reserved'),0)::text active_reservation_microusd,
        count(*) filter(where status='recovery_required')::int unresolved_count
      from router.reservations group by user_id
    ), observed_clients as (
      select user_id,case when client_kind='opencode' then 'opencode' else client_kind end client_type from router.client_installations
      union select r.user_id,case when e.client='webui' then 'browser' when e.client ilike '%desktop%' then 'desktop' when e.client ilike '%opencode%' then 'opencode' else 'cli' end
        from router.ad_events e join router.reservations r on r.id=e.reservation_id where e.client is not null
    ), client_types as (
      select user_id,array_agg(distinct client_type order by client_type) client_types from observed_clients group by user_id
    )
    select u.*,identity.email,identity.registered_at,
      coalesce(client_types.client_types,array[]::text[]) client_types,
      coalesce(usage_stats.day_gross_microusd,'0') day_gross_microusd,
      coalesce(usage_stats.month_gross_microusd,'0') month_gross_microusd,
      coalesce(reservation_stats.active_reservation_microusd,'0') active_reservation_microusd,
      coalesce(reservation_stats.unresolved_count,0) unresolved_reservation_count,
      coalesce(usage_stats.incomplete_count,0)>0 financial_correlation_warning,
      usage_stats.last_settled_at,
      (date_trunc('day',now() at time zone 'UTC')+interval '1 day') at time zone 'UTC' day_reset_at,
      (date_trunc('month',now() at time zone 'UTC')+interval '1 month') at time zone 'UTC' month_reset_at,
      greatest(u.daily_limit_microusd-coalesce(usage_stats.day_gross_microusd,'0')::bigint-coalesce(reservation_stats.active_reservation_microusd,'0')::bigint,0)::text day_remaining_microusd,
      greatest(u.monthly_limit_microusd-coalesce(usage_stats.month_gross_microusd,'0')::bigint-coalesce(reservation_stats.active_reservation_microusd,'0')::bigint,0)::text month_remaining_microusd
    from router.beta_users u
    left join identity on identity.user_id=u.user_id
    left join usage_stats on usage_stats.user_id=u.user_id
    left join reservation_stats on reservation_stats.user_id=u.user_id
    left join client_types on client_types.user_id=u.user_id
    ${clauses.length ? `where ${clauses.join(' and ')}` : ''}
    order by ${sortExpression} ${direction},u.user_id ${direction}
    limit ${limitParameter}
  `, params);
  const hasMore = result.rows.length > input.limit;
  const rows = result.rows.slice(0, input.limit);
  const accounts = rows.map((row) => ({
    ...safeAccount(row as AccountRow),
    email: row.email ?? null,
    registered_at: row.registered_at?.toISOString?.() ?? null,
    client_types: row.client_types,
    daily: {
      gross_cost_used_microusd: row.day_gross_microusd,
      active_reservation_microusd: row.active_reservation_microusd,
      limit_microusd: String(row.daily_limit_microusd),
      remaining_allowance_microusd: row.day_remaining_microusd,
      reset_at: row.day_reset_at.toISOString(),
    },
    monthly: {
      gross_cost_used_microusd: row.month_gross_microusd,
      active_reservation_microusd: row.active_reservation_microusd,
      limit_microusd: String(row.monthly_limit_microusd),
      remaining_allowance_microusd: row.month_remaining_microusd,
      reset_at: row.month_reset_at.toISOString(),
    },
    effective_remaining_microusd: BigInt(row.day_remaining_microusd) < BigInt(row.month_remaining_microusd) ? row.day_remaining_microusd : row.month_remaining_microusd,
    last_settled_at: row.last_settled_at?.toISOString?.() ?? null,
    unresolved_reservation_count: row.unresolved_reservation_count,
    financial_correlation_warning: row.financial_correlation_warning,
  }));
  const last = rows.at(-1);
  const value = last ? (input.sort === 'email' ? last.email ?? '' : input.sort === 'last_settled_at' ? (last.last_settled_at?.toISOString?.() ?? '1970-01-01T00:00:00.000Z') : last.created_at.toISOString()) : '';
  res.json({ accounts, page: { limit: input.limit, next_cursor: hasMore && last ? encodeCursor(value, last.user_id) : null } });
}));

ownerRouter.get('/operator/accounts/:userId', ...ownerOnly, asyncRoute(async (req, res) => {
  const userId = UuidSchema.safeParse(req.params.userId);
  if (!userId.success) { invalid(res, 'invalid_user_id', 'The account identifier is invalid.'); return; }
  const [accountResult, summary, usage, reservations, installations, totals, audits] = await Promise.all([
    getPostgresPool().query<AccountRow & { email: string | null }>(`
      select u.*,identity.email from router.beta_users u
      left join lateral (select email from router.auth_invites where claimed_by=u.user_id limit 1) identity on true
      where u.user_id=$1`, [userId.data]),
    loadAccountSummary(userId.data),
    loadAccountUsageHistory(userId.data),
    getPostgresPool().query(`select id,model,reserved_microusd::text,settled_microusd::text,status,auth_source,created_at,settled_at,recovery_marked_at
      from router.reservations where user_id=$1 and status in ('reserved','recovery_required') order by created_at desc limit 100`, [userId.data]),
    getPostgresPool().query(`select id,client_kind,display_name,key_thumbprint,scopes,storage_class,claimed_version,status,created_at,approved_at,last_used_at,revoked_at,revocation_reason
      from router.client_installations where user_id=$1 order by created_at desc limit 100`, [userId.data]),
    getPostgresPool().query(`select count(u.reservation_id)::text settled_requests,coalesce(sum(u.input_tokens),0)::text input_tokens,
      coalesce(sum(u.cache_hit_tokens),0)::text cache_hit_tokens,coalesce(sum(u.output_tokens),0)::text output_tokens,
      coalesce(sum(u.cost_microusd),0)::text gross_cost_microusd,
      case when count(*) filter(where e.reservation_id is null or e.status<>'settled' or e.subsidy_microusd is null or e.paid_microusd is null)=0 then coalesce(sum(e.subsidy_microusd),0)::text end subsidy_microusd,
      case when count(*) filter(where e.reservation_id is null or e.status<>'settled' or e.subsidy_microusd is null or e.paid_microusd is null)=0 then coalesce(sum(e.paid_microusd),0)::text end paid_microusd,
      count(*) filter(where e.reservation_id is null or e.status<>'settled' or e.subsidy_microusd is null or e.paid_microusd is null)::int incomplete_count
      from router.usage u left join router.ad_events e on e.reservation_id=u.reservation_id where u.user_id=$1`, [userId.data]),
    getPostgresPool().query(`select id::text,actor_user_id,action,outcome,details,created_at from router.audit_events
      where target_type='user' and target_id=$1 order by created_at desc,id desc limit 50`, [userId.data]),
  ]);
  const account = accountResult.rows[0];
  if (!account || !summary) { res.status(404).json({ error: 'Account not found.', code: 'account_not_found' }); return; }
  res.json({
    account: { ...safeAccount(account), email: account.email, effective_developer_access: account.status === 'active' && account.is_developer },
    summary,
    usage,
    reservations: reservations.rows,
    installations: installations.rows.map((row) => ({ ...row, key_thumbprint: `${String(row.key_thumbprint).slice(0, 8)}…${String(row.key_thumbprint).slice(-6)}` })),
    totals: { ...totals.rows[0], financial_breakdown_complete: (totals.rows[0]?.incomplete_count ?? 0) === 0 },
    audit_events: audits.rows,
  });
}));

ownerRouter.get('/operator/accounts/:userId/settlements', ...ownerOnly, asyncRoute(async (req, res) => {
  const userId = UuidSchema.safeParse(req.params.userId);
  const parsed = SettlementQuery.safeParse(req.query);
  const cursor = parsed.success ? decodeCursor(parsed.data.cursor) : undefined;
  if (!userId.success || !parsed.success || (parsed.data.cursor && !cursor)) { invalid(res, 'invalid_settlement_query', 'The settlement query is invalid.'); return; }
  const account = await getPostgresPool().query('select 1 from router.beta_users where user_id=$1', [userId.data]);
  if (!account.rowCount) { res.status(404).json({ error: 'Account not found.', code: 'account_not_found' }); return; }
  const params: unknown[] = [userId.data];
  const cursorClause = cursor ? `and (e.settled_at,u.reservation_id) < ($2::timestamptz,$3::uuid)` : '';
  if (cursor) params.push(cursor.value, cursor.id);
  params.push(parsed.data.limit + 1);
  const result = await getPostgresPool().query(`select u.reservation_id,e.settled_at,u.model,e.client,e.cache_miss_tokens,e.cache_hit_tokens,e.output_tokens,
      u.cost_microusd::text gross_cost_microusd,e.subsidy_microusd::text,e.paid_microusd::text,u.outcome
    from router.usage u join router.ad_events e on e.reservation_id=u.reservation_id and e.status='settled'
    where u.user_id=$1 and e.settled_at is not null ${cursorClause}
    order by e.settled_at desc,u.reservation_id desc limit $${params.length}`, params);
  const rows = result.rows.slice(0, parsed.data.limit);
  const last = rows.at(-1);
  res.json({ settlements: rows, page: { limit: parsed.data.limit, next_cursor: result.rows.length > parsed.data.limit && last ? encodeCursor(last.settled_at.toISOString(), last.reservation_id) : null } });
}));

async function mutateAccount(req: Request, res: Response, kind: AccountMutationKind, data: Record<string, unknown>): Promise<void> {
  const userId = UuidSchema.safeParse(req.params.userId);
  if (!userId.success) { invalid(res, 'invalid_user_id', 'The account identifier is invalid.'); return; }
  const actor = principalFrom(res);
  if (actor.userId === userId.data && data.confirm_user_id !== userId.data) {
    res.status(409).json({ error: 'Confirm the signed-in owner account UUID before changing it.', code: 'self_confirmation_required' });
    return;
  }
  if (kind === 'status' && data.status === 'disabled' && data.confirm_status !== 'disabled') {
    res.status(409).json({ error: 'Type the disabled status confirmation before disabling an account.', code: 'destructive_confirmation_required' });
    return;
  }
  const client = await getPostgresPool().connect();
  try {
    await client.query('begin');
    await setOwnerActorContext(client, actor.userId);
    const currentResult = await client.query<AccountRow>('select * from router.beta_users where user_id=$1 for update', [userId.data]);
    const current = currentResult.rows[0];
    if (!current) { await client.query('rollback'); res.status(404).json({ error: 'Account not found.', code: 'account_not_found' }); return; }
    const models = new Set((data.models as string[] | undefined) ?? []);
    const achieved = kind === 'developer' ? current.is_developer === data.developer
      : kind === 'advertiser' ? current.is_advertiser === data.advertiser
      : kind === 'limits' ? current.daily_limit_microusd === data.daily_limit_microusd && current.monthly_limit_microusd === data.monthly_limit_microusd && current.max_concurrency === data.max_concurrency && current.max_output_tokens === data.max_output_tokens
      : kind === 'models' ? current.flash_enabled === models.has('deepseek-v4-flash') && current.pro_enabled === models.has('deepseek-v4-pro')
      : current.status === data.status;
    if (!achieved && String(current.revision) !== data.expected_revision) {
      await client.query('rollback'); res.status(409).json({ error: 'The account changed after it was loaded.', code: 'stale_account_revision', current_revision: String(current.revision) }); return;
    }
    if (kind === 'advertiser' && data.advertiser === true && current.status !== 'active') {
      await client.query('rollback'); res.status(409).json({ error: 'Advertiser entitlement requires an active account.', code: 'account_inactive' }); return;
    }
    if (kind === 'status' && current.role === 'owner' && current.status === 'active' && data.status !== 'active') {
      const owners = await client.query<{ count: string }>(`select count(*)::text count from router.beta_users where role='owner' and status='active' and user_id<>$1`, [userId.data]);
      if (Number(owners.rows[0]?.count ?? 0) < 1) { await client.query('rollback'); res.status(409).json({ error: 'The last active owner cannot be suspended or disabled.', code: 'last_active_owner' }); return; }
    }
    let updated = current;
    if (!achieved) {
      const update = kind === 'developer'
        ? await client.query<AccountRow>('update router.beta_users set is_developer=$2 where user_id=$1 returning *', [userId.data, data.developer])
        : kind === 'advertiser'
          ? await client.query<AccountRow>('update router.beta_users set is_advertiser=$2 where user_id=$1 returning *', [userId.data, data.advertiser])
          : kind === 'limits'
            ? await client.query<AccountRow>('update router.beta_users set daily_limit_microusd=$2,monthly_limit_microusd=$3,max_concurrency=$4,max_output_tokens=$5 where user_id=$1 returning *', [userId.data, data.daily_limit_microusd, data.monthly_limit_microusd, data.max_concurrency, data.max_output_tokens])
            : kind === 'models'
              ? await client.query<AccountRow>('update router.beta_users set flash_enabled=$2,pro_enabled=$3 where user_id=$1 returning *', [userId.data, models.has('deepseek-v4-flash'), models.has('deepseek-v4-pro')])
              : await client.query<AccountRow>(`update router.beta_users set status=$2,activated_at=case when $2='active' then coalesce(activated_at,now()) else activated_at end,disabled_at=case when $2='disabled' then now() else disabled_at end where user_id=$1 returning *`, [userId.data, data.status]);
      updated = update.rows[0]!;
    }
    const details = { reason: data.reason, expected_revision: data.expected_revision, previous: safeAccount(current), resulting: safeAccount(updated), no_op: achieved };
    const audit = await client.query<{ id: string }>(`insert into router.audit_events(actor_user_id,action,target_type,target_id,outcome,details)
      values($1,$2,'user',$3,$4,$5::jsonb) returning id::text`, [actor.userId, `owner_account_${kind}`, userId.data, achieved ? 'no_op' : 'success', JSON.stringify(details)]);
    const inventory = await client.query<{ version: string }>('select version::text from router.campaign_inventory_state where singleton');
    await client.query('commit');
    res.json({ target_user_id: userId.data, account: safeAccount(updated), audit_event_id: audit.rows[0]!.id, no_op: achieved, inventory_target_version: inventory.rows[0]?.version ?? null });
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally { client.release(); }
}

function accountMutationRoute(kind: AccountMutationKind, schema: z.ZodTypeAny): RequestHandler {
  return asyncRoute(async (req, res) => {
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) { invalid(res, `invalid_${kind}_update`, `The ${kind} update is invalid.`, parsed.error.flatten()); return; }
    await mutateAccount(req, res, kind, parsed.data as Record<string, unknown>);
  });
}

ownerRouter.put('/operator/accounts/:userId/developer', ...ownerOnly, accountMutationRoute('developer', DeveloperMutation));
ownerRouter.put('/operator/accounts/:userId/advertiser', ...ownerOnly, accountMutationRoute('advertiser', AdvertiserMutation));
ownerRouter.put('/operator/accounts/:userId/limits', ...ownerOnly, accountMutationRoute('limits', LimitsMutation));
ownerRouter.put('/operator/accounts/:userId/models', ...ownerOnly, accountMutationRoute('models', ModelsMutation));
ownerRouter.put('/operator/accounts/:userId/status', ...ownerOnly, accountMutationRoute('status', StatusMutation));

// Deprecated compatibility aliases. They retain their paths but now use owner-only,
// reasoned, optimistic-concurrency mutations. Role changes are deliberately rejected.
ownerRouter.put('/operator/users/:userId/developer', ...ownerOnly, accountMutationRoute('developer', DeveloperMutation));
ownerRouter.put('/operator/users/:userId/advertiser', ...ownerOnly, accountMutationRoute('advertiser', AdvertiserMutation));
ownerRouter.put('/operator/users/:userId/limits', ...ownerOnly, accountMutationRoute('limits', LimitsMutation));
ownerRouter.put('/operator/users/:userId/models', ...ownerOnly, accountMutationRoute('models', ModelsMutation));
ownerRouter.put('/operator/users/:userId/approval', ...ownerOnly, asyncRoute(async (req, res) => {
  if (req.body && typeof req.body === 'object' && 'role' in req.body) { invalid(res, 'role_change_not_supported', 'Role changes are not supported by this endpoint.'); return; }
  const parsed = StatusMutation.safeParse(req.body);
  if (!parsed.success) { invalid(res, 'invalid_status_update', 'The status update is invalid.', parsed.error.flatten()); return; }
  await mutateAccount(req, res, 'status', parsed.data as Record<string, unknown>);
}));

const campaignSelect = `select c.*,identity.email advertiser_email,
  coalesce(stats.settled_placements,0) settled_placements,
  coalesce(stats.tier_a_placements,0) tier_a_placements,
  coalesce(stats.tier_b_placements,0) tier_b_placements,
  coalesce(stats.tier_c_placements,0) tier_c_placements,
  coalesce(stats.no_ad_placements,0) no_ad_placements,
  coalesce(stats.live_impressions,0) live_impressions,
  coalesce(stats.funded_subsidy_microusd,'0') funded_subsidy_microusd
from router.campaigns c
left join lateral (select email from router.auth_invites where claimed_by=c.advertiser_user_id limit 1) identity on true
left join lateral (
  select count(*) filter(where status='settled')::int settled_placements,
    count(*) filter(where status='settled' and tier='A')::int tier_a_placements,
    count(*) filter(where status='settled' and tier='B')::int tier_b_placements,
    count(*) filter(where status='settled' and tier='C')::int tier_c_placements,
    count(*) filter(where status='settled' and tier='NONE')::int no_ad_placements,
    count(*) filter(where runtime_mode='live' and impression_at is not null)::int live_impressions,
    coalesce(sum(subsidy_microusd) filter(where status='settled'),0)::text funded_subsidy_microusd
  from router.ad_events where campaign_id=c.id
) stats on true`;

ownerRouter.get('/operator/campaigns', ...ownerOnly, asyncRoute(async (req, res) => {
  const parsed = CampaignListQuery.safeParse(req.query);
  if (!parsed.success) { invalid(res, 'invalid_campaign_query', 'The campaign query is invalid.', parsed.error.flatten()); return; }
  const input = parsed.data;
  const cursor = decodeCursor(input.cursor);
  if (input.cursor && !cursor) { invalid(res, 'invalid_cursor', 'The pagination cursor is invalid.'); return; }
  const params: unknown[] = [];
  const bind = (value: unknown) => { params.push(value); return `$${params.length}`; };
  const clauses: string[] = [];
  if (input.q) { const q = bind(`%${input.q}%`); clauses.push(`(c.id ilike ${q} or c.brand_name ilike ${q} or c.ad_copy ilike ${q})`); }
  if (input.review_status) clauses.push(`c.review_status=${bind(input.review_status)}`);
  if (input.active !== undefined) clauses.push(`c.active=${bind(input.active)}`);
  if (input.advertiser) { const advertiser = bind(`%${input.advertiser}%`); clauses.push(`(c.advertiser_user_id::text ilike ${advertiser} or identity.email ilike ${advertiser})`); }
  if (input.keyword) clauses.push(`exists(select 1 from unnest(c.target_keywords) keyword where keyword ilike ${bind(`%${input.keyword}%`)})`);
  if (input.created_from) clauses.push(`c.created_at>=${bind(input.created_from)}::timestamptz`);
  if (input.created_to) clauses.push(`c.created_at<=${bind(input.created_to)}::timestamptz`);
  const sortExpression = input.sort === 'reviewed_at' ? `coalesce(c.reviewed_at,'epoch'::timestamptz)` : input.sort === 'brand_name' ? 'lower(c.brand_name)' : 'c.created_at';
  if (cursor) {
    const comparison = input.direction === 'desc' ? '<' : '>';
    const cast = input.sort === 'brand_name' ? 'text' : 'timestamptz';
    const rank = cursor.rank ?? 0;
    clauses.push(`((case when c.review_status='pending' then 0 else 1 end)>${bind(rank)} or ((case when c.review_status='pending' then 0 else 1 end)=${bind(rank)} and (${sortExpression},c.id) ${comparison} (${bind(cursor.value)}::${cast},${bind(cursor.id)}::text)))`);
  }
  const direction = input.direction === 'desc' ? 'desc' : 'asc';
  const limit = bind(input.limit + 1);
  const result = await getPostgresPool().query(`${campaignSelect}
    ${clauses.length ? `where ${clauses.join(' and ')}` : ''}
    order by case when c.review_status='pending' then 0 else 1 end asc,${sortExpression} ${direction},c.id ${direction}
    limit ${limit}`, params);
  const rows = result.rows.slice(0, input.limit);
  const last = rows.at(-1);
  const value = last ? (input.sort === 'brand_name' ? last.brand_name.toLowerCase() : input.sort === 'reviewed_at' ? (last.reviewed_at?.toISOString?.() ?? '1970-01-01T00:00:00.000Z') : last.created_at.toISOString()) : '';
  res.json({
    campaigns: rows.map((row) => ({ ...safeCampaign(row as CampaignRow), advertiser_email: row.advertiser_email ?? null,
      analytics: { settled_placements: row.settled_placements, tier_a_placements: row.tier_a_placements, tier_b_placements: row.tier_b_placements, tier_c_placements: row.tier_c_placements, no_ad_placements: row.no_ad_placements, live_impressions: row.live_impressions, funded_subsidy_microusd: row.funded_subsidy_microusd } })),
    page: { limit: input.limit, next_cursor: result.rows.length > input.limit && last ? encodeCursor(value, last.id, last.review_status === 'pending' ? 0 : 1) : null },
    inventory: await getCampaignInventoryStatus(),
  });
}));

ownerRouter.get('/operator/campaigns/:campaignId', ...ownerOnly, asyncRoute(async (req, res) => {
  const campaignId = CampaignIdSchema.safeParse(req.params.campaignId);
  if (!campaignId.success) { invalid(res, 'invalid_campaign_id', 'The campaign identifier is invalid.'); return; }
  const result = await getPostgresPool().query(`${campaignSelect} where c.id=$1`, [campaignId.data]);
  const row = result.rows[0];
  if (!row) { res.status(404).json({ error: 'Campaign not found.', code: 'campaign_not_found' }); return; }
  const audits = await getPostgresPool().query(`select id::text,actor_user_id,action,outcome,details,created_at from router.audit_events where target_type='campaign' and target_id=$1 order by created_at desc,id desc limit 50`, [campaignId.data]);
  res.json({ campaign: { ...safeCampaign(row as CampaignRow), advertiser_email: row.advertiser_email ?? null,
    analytics: { settled_placements: row.settled_placements, tier_a_placements: row.tier_a_placements, tier_b_placements: row.tier_b_placements, tier_c_placements: row.tier_c_placements, no_ad_placements: row.no_ad_placements, live_impressions: row.live_impressions, funded_subsidy_microusd: row.funded_subsidy_microusd } }, audit_events: audits.rows, inventory: await getCampaignInventoryStatus() });
}));

ownerRouter.get('/operator/campaign-inventory', ...ownerOnly, asyncRoute(async (_req, res) => {
  res.json({ inventory: await getCampaignInventoryStatus(), propagation_slo_seconds: 60, fallback_poll_seconds: 15 });
}));

async function mutateCampaign(req: Request, res: Response, action: 'approve' | 'reject' | 'activate' | 'deactivate', data: { expected_revision: string; reason: string; activate?: boolean }): Promise<void> {
  const campaignId = CampaignIdSchema.safeParse(req.params.campaignId);
  if (!campaignId.success) { invalid(res, 'invalid_campaign_id', 'The campaign identifier is invalid.'); return; }
  const actor = principalFrom(res);
  const client = await getPostgresPool().connect();
  try {
    await client.query('begin');
    await setOwnerActorContext(client, actor.userId);
    const currentResult = await client.query<CampaignRow>('select * from router.campaigns where id=$1 for update', [campaignId.data]);
    const current = currentResult.rows[0];
    if (!current) { await client.query('rollback'); res.status(404).json({ error: 'Campaign not found.', code: 'campaign_not_found' }); return; }
    const achieved = action === 'approve' ? current.review_status === 'approved' && current.active === Boolean(data.activate)
      : action === 'reject' ? current.review_status === 'rejected' && !current.active
      : action === 'activate' ? current.review_status === 'approved' && current.active
      : !current.active;
    if (!achieved && String(current.revision) !== data.expected_revision) {
      await client.query('rollback'); res.status(409).json({ error: 'The campaign changed after it was loaded.', code: 'stale_campaign_revision', current_revision: String(current.revision) }); return;
    }
    if (!achieved && (action === 'approve' || action === 'reject') && current.review_status !== 'pending') {
      await client.query('rollback'); res.status(409).json({ error: 'Only pending campaigns can be reviewed.', code: 'campaign_review_conflict' }); return;
    }
    if (!achieved && action === 'activate' && current.review_status !== 'approved') {
      await client.query('rollback'); res.status(409).json({ error: 'Only approved campaigns can be activated.', code: 'campaign_not_approved' }); return;
    }
    let updated = current;
    if (!achieved) {
      try {
        const result = action === 'approve'
          ? await client.query<CampaignRow>(`update router.campaigns set review_status='approved',reviewed_by=$2,reviewed_at=now(),review_note=$3,active=$4 where id=$1 returning *`, [campaignId.data, actor.userId, data.reason, Boolean(data.activate)])
          : action === 'reject'
            ? await client.query<CampaignRow>(`update router.campaigns set review_status='rejected',reviewed_by=$2,reviewed_at=now(),review_note=$3,active=false where id=$1 returning *`, [campaignId.data, actor.userId, data.reason])
            : action === 'activate'
              ? await client.query<CampaignRow>('update router.campaigns set active=true where id=$1 returning *', [campaignId.data])
              : await client.query<CampaignRow>('update router.campaigns set active=false where id=$1 returning *', [campaignId.data]);
        updated = result.rows[0]!;
      } catch (error) {
        if (error && typeof error === 'object' && 'code' in error && (error as { code?: string }).code === '23514') {
          await client.query('rollback'); res.status(409).json({ error: 'The campaign owner is not eligible for activation.', code: 'campaign_owner_ineligible' }); return;
        }
        throw error;
      }
    }
    const inventory = await client.query<{ version: string }>('select version::text from router.campaign_inventory_state where singleton');
    const details = { reason: data.reason, expected_revision: data.expected_revision, previous: campaignAuditState(current), resulting: campaignAuditState(updated), inventory_version: inventory.rows[0]?.version ?? null, no_op: achieved };
    const audit = await client.query<{ id: string }>(`insert into router.audit_events(actor_user_id,action,target_type,target_id,outcome,details) values($1,$2,'campaign',$3,$4,$5::jsonb) returning id::text`, [actor.userId, `owner_campaign_${action}`, campaignId.data, achieved ? 'no_op' : 'success', JSON.stringify(details)]);
    await client.query('commit');
    if (!achieved) void requestCampaignRefresh('mutation');
    res.json({ target_campaign_id: campaignId.data, campaign: safeCampaign(updated), audit_event_id: audit.rows[0]!.id, no_op: achieved, inventory: await getCampaignInventoryStatus() });
  } catch (error) {
    await client.query('rollback').catch(() => undefined);
    throw error;
  } finally { client.release(); }
}

for (const action of ['approve', 'reject', 'activate', 'deactivate'] as const) {
  ownerRouter.post(`/operator/campaigns/:campaignId/${action}`, ...ownerOnly, asyncRoute(async (req, res) => {
    const schema = action === 'approve' ? CampaignApproveMutation : CampaignMutationBase;
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) { invalid(res, `invalid_campaign_${action}`, `The campaign ${action} request is invalid.`, parsed.error.flatten()); return; }
    await mutateCampaign(req, res, action, parsed.data);
  }));
}
