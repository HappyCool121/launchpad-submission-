import { Router } from 'express';
import { z } from 'zod';
import { loadAccountUsageHistory, loadAdvertiserAnalytics } from '../lib/account-history.js';
import { loadAccountSummary } from '../lib/account-summary.js';
import {
  principalFrom,
  requireAdvertiser,
  requireBrowserAuth,
  requireRole,
} from '../runtime/auth.js';
import { getPostgresPool } from '../runtime/postgres.js';
import { refreshOperationalMetrics } from '../runtime/metrics.js';

export const accountRouter = Router();

const TrafficSchema = z.object({ traffic_mode: z.enum(['disabled', 'owner_only', 'beta']) });
const PlatformLimitSchema = z.object({ max_concurrency: z.number().int().min(1).max(100), daily_limit_microusd: z.number().int().min(0), monthly_limit_microusd: z.number().int().min(0) });
const CampaignSubmissionSchema = z.object({
  brand_name: z.string().trim().min(1).max(120),
  ad_copy: z.string().trim().min(1).max(500),
  target_keywords: z.array(z.string().trim().min(1).max(64)).min(1).max(20)
    .transform((keywords) => {
      const seen = new Set<string>();
      return keywords.filter((keyword) => {
        const normalized = keyword.toLocaleLowerCase('en-US');
        if (seen.has(normalized)) return false;
        seen.add(normalized);
        return true;
      });
    })
    .refine((keywords) => keywords.length >= 1),
  click_url: z.string().trim().url().max(2048)
    .refine((value) => new URL(value).protocol === 'https:', 'URL must use HTTPS.')
    .nullable()
    .optional(),
}).strict();

accountRouter.all(['/account/credentials', '/account/credentials/*'], (_req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.status(404).json({ error: 'Not found.', code: 'route_not_available' });
});

accountRouter.post('/account/registration', requireBrowserAuth, async (_req, res) => {
  const principal = principalFrom(res);
  if (!principal.email || !principal.provider) {
    res.status(401).json({ error: 'The access token is not authorized for registration.', code: 'invalid_access_token' });
    return;
  }
  const client = await getPostgresPool().connect();
  try {
    await client.query('begin');
    const invite = await client.query<{
      status: 'invited' | 'claimed' | 'revoked'; claimed_by: string | null; expires_at: Date | null;
    }>('select status, claimed_by, expires_at from router.auth_invites where email=$1 for update', [principal.email]);
    const invitation = invite.rows[0];
    const expired = invitation?.expires_at ? invitation.expires_at.getTime() <= Date.now() : false;
    if (!invitation || invitation.status === 'revoked' || expired) {
      await client.query('rollback');
      res.status(403).json({ error: 'This account cannot access AdRouter staging.', code: 'invite_not_authorized' });
      return;
    }
    if (invitation.status === 'claimed' && invitation.claimed_by !== principal.userId) {
      await client.query('rollback');
      res.status(409).json({ error: 'This invitation is already associated with another account.', code: 'invite_conflict' });
      return;
    }

    let changed = false;
    if (invitation.status === 'invited') {
      const claim = await client.query(`update router.auth_invites set status='claimed',claimed_by=$2,claimed_at=now()
        where email=$1 and status='invited' returning email`, [principal.email, principal.userId]);
      changed = (claim.rowCount ?? 0) === 1;
    }
    const activated = await client.query(`insert into router.beta_users(user_id,status,activated_at)
      values($1,'active',now())
      on conflict(user_id) do update set status='active',activated_at=coalesce(router.beta_users.activated_at,now())
      where router.beta_users.status='pending'
      returning user_id`, [principal.userId]);
    changed ||= (activated.rowCount ?? 0) === 1;
    if (changed) {
      await client.query(`insert into router.audit_events(actor_user_id,action,target_type,target_id,outcome)
        values($1::uuid,'account_registration','user',$1::text,'success')`, [principal.userId]);
    }
    const result = await client.query(`select user_id,display_label,status,role,is_developer,is_advertiser,daily_limit_microusd,monthly_limit_microusd,
      max_concurrency,max_output_tokens,flash_enabled,pro_enabled,revision,created_at,activated_at,updated_at
      from router.beta_users where user_id=$1`, [principal.userId]);
    await client.query('commit');
    res.status(200).json({ account: result.rows[0] });
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
});

accountRouter.get('/account', requireBrowserAuth, async (_req, res) => {
  const principal = principalFrom(res);
  const result = await getPostgresPool().query(`select user_id,display_label,status,role,is_developer,is_advertiser,daily_limit_microusd,monthly_limit_microusd,
    max_concurrency,max_output_tokens,flash_enabled,pro_enabled,revision,created_at,activated_at,updated_at from router.beta_users where user_id=$1`, [principal.userId]);
  res.setHeader('Cache-Control', 'no-store');
  res.json({ account: result.rows[0] ?? { user_id: principal.userId, status: 'unregistered', role: 'user', is_developer: false, is_advertiser: false } });
});

accountRouter.get('/account/summary', requireBrowserAuth, async (_req, res) => {
  const summary = await loadAccountSummary(principalFrom(res).userId);
  if (!summary) {
    res.status(404).json({ error: 'Account not found.', code: 'account_not_found' });
    return;
  }
  res.setHeader('Cache-Control', 'no-store');
  res.json(summary);
});

accountRouter.get('/account/usage', requireBrowserAuth, async (_req, res) => {
  const history = await loadAccountUsageHistory(principalFrom(res).userId);
  res.setHeader('Cache-Control', 'no-store');
  res.json(history);
});

accountRouter.get('/advertiser/campaigns', requireBrowserAuth, requireAdvertiser, async (_req, res) => {
  const principal = principalFrom(res);
  const result = await getPostgresPool().query(`
    select
      c.id,
      c.brand_name,
      c.ad_copy,
      c.target_keywords,
      c.click_url,
      c.active,
      c.review_status,
      c.reviewed_at,
      c.activated_at,
      c.deactivated_at,
      c.revision,
      c.is_synthetic,
      c.disclosure,
      c.created_at,
      c.updated_at,
      count(e.turn_id) filter (where e.status='settled')::int as settled_placements,
      count(e.turn_id) filter (where e.status='settled' and e.tier='A')::int as tier_a_placements,
      count(e.turn_id) filter (where e.status='settled' and e.tier='B')::int as tier_b_placements,
      count(e.turn_id) filter (where e.status='settled' and e.tier='C')::int as tier_c_placements,
      count(e.turn_id) filter (where e.status='settled' and e.tier='NONE')::int as no_ad_placements,
      count(e.turn_id) filter (where e.runtime_mode='live' and e.impression_at is not null)::int as live_impressions,
      coalesce(sum(e.subsidy_microusd) filter (where e.status='settled'),0)::text as funded_subsidy_microusd
    from router.campaigns c
    left join router.ad_events e on e.campaign_id=c.id
    where c.advertiser_user_id=$1
    group by c.id
    order by c.created_at desc
  `, [principal.userId]);
  res.setHeader('Cache-Control', 'no-store');
  res.json({ campaigns: result.rows });
});

accountRouter.get('/advertiser/analytics', requireBrowserAuth, requireAdvertiser, async (_req, res) => {
  const principal = principalFrom(res);
  const history = await loadAdvertiserAnalytics(principal.userId, false);
  res.setHeader('Cache-Control', 'no-store');
  res.json(history);
});

accountRouter.post('/advertiser/campaigns', requireBrowserAuth, requireAdvertiser, async (req, res) => {
  const parsed = CampaignSubmissionSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: 'Invalid campaign submission.',
      code: 'invalid_campaign_submission',
      details: parsed.error.flatten(),
    });
    return;
  }
  const principal = principalFrom(res);
  const client = await getPostgresPool().connect();
  try {
    await client.query('begin');
    const account = await client.query<{ status: string; is_advertiser: boolean }>(
      'select status,is_advertiser from router.beta_users where user_id=$1 for update',
      [principal.userId],
    );
    if (account.rows[0]?.status !== 'active' || !account.rows[0].is_advertiser) {
      await client.query('rollback');
      res.status(403).json({ error: 'Active advertiser entitlement required.', code: 'advertiser_required' });
      return;
    }
    const created = await client.query(`
      insert into router.campaigns(
        brand_name,ad_copy,target_keywords,click_url,active,advertiser_user_id,is_synthetic,disclosure,review_status
      ) values($1,$2,$3,$4,false,$5,false,null,'pending')
      returning id,brand_name,ad_copy,target_keywords,click_url,active,review_status,reviewed_at,activated_at,deactivated_at,revision,is_synthetic,disclosure,created_at,updated_at
    `, [
      parsed.data.brand_name,
      parsed.data.ad_copy,
      parsed.data.target_keywords,
      parsed.data.click_url ?? null,
      principal.userId,
    ]);
    await client.query(`insert into router.audit_events(actor_user_id,action,target_type,target_id,outcome)
      values($1,'advertiser_campaign_submit','campaign',$2,'success')`,
    [principal.userId, created.rows[0].id]);
    await client.query('commit');
    res.setHeader('Cache-Control', 'no-store');
    res.status(201).json({
      campaign: {
        ...created.rows[0],
        settled_placements: 0,
        tier_a_placements: 0,
        tier_b_placements: 0,
        tier_c_placements: 0,
        no_ad_placements: 0,
        live_impressions: 0,
        funded_subsidy_microusd: '0',
      },
    });
  } catch (error) {
    await client.query('rollback');
    throw error;
  } finally {
    client.release();
  }
});

accountRouter.get('/operator/users', requireBrowserAuth, requireRole('owner', 'operator'), async (_req, res) => {
  const result = await getPostgresPool().query(`select user_id,display_label,status,role,is_developer,is_advertiser,daily_limit_microusd,monthly_limit_microusd,max_concurrency,max_output_tokens,flash_enabled,pro_enabled,revision,created_at,updated_at
    from router.beta_users order by created_at`);
  res.setHeader('Cache-Control', 'no-store');
  res.json({ users: result.rows });
});

accountRouter.put('/operator/platform/traffic', requireBrowserAuth, requireRole('owner', 'operator'), async (req, res) => {
  const parsed = TrafficSchema.safeParse(req.body); if (!parsed.success) { res.status(400).json({ error: 'Invalid traffic mode.' }); return; }
  const actor = principalFrom(res);
  const result = await getPostgresPool().query(`update router.platform_settings set traffic_mode=$1,updated_at=now(),updated_by=$2 where singleton=true returning *`, [parsed.data.traffic_mode, actor.userId]);
  await getPostgresPool().query(`insert into router.audit_events(actor_user_id,action,target_type,target_id,outcome) values($1,'platform_traffic','platform','singleton','success')`, [actor.userId]);
  await refreshOperationalMetrics();
  res.json({ platform: result.rows[0] });
});

accountRouter.put('/operator/platform/limits', requireBrowserAuth, requireRole('owner'), async (req, res) => {
  const parsed = PlatformLimitSchema.safeParse(req.body); if (!parsed.success) { res.status(400).json({ error: 'Invalid platform limits.' }); return; }
  const actor = principalFrom(res);
  const result = await getPostgresPool().query(`update router.platform_settings set max_concurrency=$1,daily_limit_microusd=$2,monthly_limit_microusd=$3,updated_at=now(),updated_by=$4 where singleton=true returning *`, [parsed.data.max_concurrency, parsed.data.daily_limit_microusd, parsed.data.monthly_limit_microusd, actor.userId]);
  await getPostgresPool().query(`insert into router.audit_events(actor_user_id,action,target_type,target_id,outcome) values($1,'platform_limits','platform','singleton','success')`, [actor.userId]);
  await refreshOperationalMetrics();
  res.json({ platform: result.rows[0] });
});
