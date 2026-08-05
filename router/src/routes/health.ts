// Health + configuration probe. The frontend reads this to show a "MOCK MODE"
// banner when no LLM key is configured.

import { Router } from 'express';
import { getRuntimeConfig } from '../runtime/config.js';
import { requireBrowserAuth, requireRole } from '../runtime/auth.js';
import { getPostgresPool, poolStats } from '../runtime/postgres.js';
import { activeRequestCount, isReady } from '../runtime/state.js';

export const healthRouter = Router();

healthRouter.get('/health', (_req, res) => res.json({ status: 'ok' }));
healthRouter.get('/health/live', (_req, res) => res.json({ status: 'live' }));
healthRouter.get('/health/ready', async (_req, res) => {
  if (!isReady()) { res.status(503).json({ status: 'unavailable' }); return; }
  const config = getRuntimeConfig();
  if (config.serviceMode) {
    try { await getPostgresPool().query('select 1'); }
    catch { res.status(503).json({ status: 'unavailable' }); return; }
  }
  res.json({ status: 'ready' });
});
healthRouter.get('/v1/operator/health', requireBrowserAuth, requireRole('owner', 'operator'), async (_req, res) => {
  const config = getRuntimeConfig();
  let database = 'not_applicable';
  if (config.serviceMode) {
    try { await getPostgresPool().query('select 1'); database = 'ok'; } catch { database = 'unavailable'; }
  }
  res.status(database === 'unavailable' ? 503 : 200).json({
    status: isReady() && database !== 'unavailable' ? 'ready' : 'unavailable',
    environment: config.environment,
    runtime_profile: config.runtimeProfile,
    database,
    active_requests: activeRequestCount(),
    postgres_pool: config.serviceMode ? poolStats() : undefined,
  });
});
