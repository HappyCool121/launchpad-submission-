import { Router } from 'express';
import { z } from 'zod';
import { analyticsCampaigns, analyticsStatusCounts, analyticsSummary, analyticsTierCounts } from '../lib/persistence.js';
import { requireRouterAuth } from '../lib/profile.js';
import { getRuntimeConfig } from '../runtime/config.js';
import { requireRole } from '../runtime/auth.js';
import type { RequestHandler } from 'express';

export const analyticsRouter = Router();
const rangeSchema = z.object({ from: z.string().datetime().optional(), to: z.string().datetime().optional() }).refine((value) => !value.from || !value.to || value.from <= value.to, { message: 'from must not be after to' });

function parseRange(query: unknown) {
  const parsed = rangeSchema.safeParse(query);
  return parsed.success ? parsed.data : undefined;
}

const requireLegacyAnalyticsRole: RequestHandler = (req, res, next) => {
  if (!getRuntimeConfig().serviceMode) {
    next();
    return;
  }
  requireRole('owner', 'operator')(req, res, next);
};

analyticsRouter.get('/analytics/summary', requireRouterAuth, requireLegacyAnalyticsRole, async (req, res) => {
  const range = parseRange(req.query);
  if (!range) return res.status(400).json({ error: 'Invalid analytics date range.' });
  return res.json({ ...await analyticsSummary(range.from, range.to), tier_counts: await analyticsTierCounts(range.from, range.to), status_counts: await analyticsStatusCounts(range.from, range.to) });
});

analyticsRouter.get('/analytics/campaigns', requireRouterAuth, requireLegacyAnalyticsRole, async (req, res) => {
  const range = parseRange(req.query);
  if (!range) return res.status(400).json({ error: 'Invalid analytics date range.' });
  return res.json({ campaigns: await analyticsCampaigns(range.from, range.to) });
});
