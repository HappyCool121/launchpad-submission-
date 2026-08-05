// Sponsor ingestion + listing routes (Phase 4 advertiser dashboard supply side).

import { Router } from 'express';
import { z } from 'zod';
import { addSponsor, getSponsors } from '../lib/sponsorStore.js';
import { requireRouterAuth } from '../lib/profile.js';

export const sponsorsRouter = Router();
const ENABLE_SPONSOR_WRITES = process.env.ENABLE_SPONSOR_WRITES === 'true';

const AddSchema = z.object({
  brand_name: z.string().min(1),
  ad_copy: z.string().min(1),
  target_keywords: z.array(z.string().min(1)).min(1),
  click_url: z.string().url().refine(isSafeClickUrl, {
    message: 'click_url must use https://, or http://localhost for local development',
  }),
});

function isSafeClickUrl(value: string): boolean {
  try {
    const url = new URL(value);
    if (url.protocol === 'https:') return true;
    return url.protocol === 'http:' && ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
  } catch {
    return false;
  }
}

/** GET /api/sponsors — list current sponsors (without their embedding vectors). */
sponsorsRouter.get('/sponsors', (_req, res) => {
  const sponsors = getSponsors().map(({ embedding: _embedding, ...rest }) => rest);
  res.json({ sponsors });
});

/** POST /api/sponsors/add — ingest + embed a new sponsor. */
sponsorsRouter.post('/sponsors/add', requireRouterAuth, async (req, res) => {
  if (!ENABLE_SPONSOR_WRITES) {
    res.status(403).json({ error: 'Sponsor creation is disabled for this environment.' });
    return;
  }

  const parsed = AddSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Invalid body', details: parsed.error.flatten() });
    return;
  }
  try {
    const sponsor = await addSponsor(parsed.data);
    // Don't leak the embedding back.
    const { embedding: _embedding, ...safe } = sponsor;
    res.status(201).json({ sponsor: safe });
  } catch (err) {
    res.status(500).json({
      error: 'Failed to ingest sponsor',
      message: err instanceof Error ? err.message : String(err),
    });
  }
});
