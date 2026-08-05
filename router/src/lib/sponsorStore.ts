// Sponsor store: JSON-file-backed, in-memory cache for the hackathon.
//
// Disk holds sponsor TEXT only (embedding: []) — never cached vectors. This
// avoids (a) bloating the seed file with huge arrays and (b) a footgun where
// stale mock vectors survive a switch to real embeddings. At startup we load
// the text, embed every sponsor in memory, and serve routes from the cache.
// In a real system this is a vector DB (Pinecone/pgvector).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import pg from 'pg';
import type { Sponsor } from './types.js';
import { generateEmbedding, sponsorEmbeddingText } from './embeddings.js';
import { bootstrapCampaignsAndAnalytics, listCampaigns, upsertCampaign } from './persistence.js';
import { getRuntimeConfig } from '../runtime/config.js';
import { getPostgresPool } from '../runtime/postgres.js';
import { strictPostgresConnection } from '../runtime/postgres-tls.js';
import { recordCampaignInventoryRefresh } from '../runtime/metrics.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = resolve(__dirname, 'sponsors.json');

/** In-memory cache — populated by initSponsorStore() at startup. */
let cache: Sponsor[] = [];
let appliedVersion = 0n;
let appliedAt: Date | null = null;
let refreshPromise: Promise<void> | undefined;
let listener: pg.Client | undefined;
let pollTimer: NodeJS.Timeout | undefined;
let reconnectTimer: NodeJS.Timeout | undefined;
let stopping = false;

type RefreshSource = 'startup' | 'notification' | 'poll' | 'mutation';

async function databaseInventoryState(): Promise<{ version: bigint; updated_at: Date; updated_by: string | null }> {
  const result = await getPostgresPool().query<{ version: string; updated_at: Date; updated_by: string | null }>(
    'select version::text,updated_at,updated_by from router.campaign_inventory_state where singleton',
  );
  const row = result.rows[0];
  if (!row) throw new Error('Campaign inventory coordination state is missing.');
  return { version: BigInt(row.version), updated_at: row.updated_at, updated_by: row.updated_by };
}

async function embedSponsors(rows: Awaited<ReturnType<typeof listCampaigns>>): Promise<Sponsor[]> {
  const next: Sponsor[] = rows.map((sponsor) => ({
    ...sponsor,
    target_keywords: JSON.parse(sponsor.target_keywords) as string[],
    embedding: [],
  }));
  let cursor = 0;
  const workers = Array.from({ length: Math.min(4, Math.max(1, next.length)) }, async () => {
    while (cursor < next.length) {
      const index = cursor;
      cursor += 1;
      const sponsor = next[index];
      if (sponsor) sponsor.embedding = await generateEmbedding(sponsorEmbeddingText(sponsor));
    }
  });
  await Promise.all(workers);
  return next;
}

async function performRefresh(source: RefreshSource): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const before = await databaseInventoryState();
    const next = await embedSponsors(await listCampaigns());
    const after = await databaseInventoryState();
    if (before.version !== after.version) continue;
    cache = next;
    appliedVersion = after.version;
    appliedAt = new Date();
    recordCampaignInventoryRefresh('success', source, appliedVersion, cache.length);
    return;
  }
  throw new Error('Campaign inventory changed repeatedly while it was being embedded.');
}

export function requestCampaignRefresh(source: RefreshSource = 'mutation'): Promise<void> {
  if (!getRuntimeConfig().serviceMode || stopping) return Promise.resolve();
  refreshPromise ??= performRefresh(source).catch((error) => {
    recordCampaignInventoryRefresh('failure', source);
    console.warn(JSON.stringify({ event: 'campaign_inventory_refresh_failed', source, error_type: error instanceof Error ? error.name : 'UnknownError' }));
  }).finally(() => { refreshPromise = undefined; });
  return refreshPromise;
}

async function pollInventory(): Promise<void> {
  try {
    const target = await databaseInventoryState();
    if (target.version > appliedVersion) await requestCampaignRefresh('poll');
  } catch (error) {
    recordCampaignInventoryRefresh('failure', 'poll');
    console.warn(JSON.stringify({ event: 'campaign_inventory_poll_failed', error_type: error instanceof Error ? error.name : 'UnknownError' }));
  }
}

async function connectInventoryListener(): Promise<void> {
  if (stopping || listener) return;
  const config = getRuntimeConfig();
  const current = new pg.Client({
    ...strictPostgresConnection(config.databaseUrl!, config.hosted),
    application_name: `adrouter-${config.environment}-campaign-listener`,
    statement_timeout: 10_000,
  });
  try {
    await current.connect();
    await current.query('listen router_campaign_inventory');
    listener = current;
    current.on('notification', (message) => {
      try {
        const target = BigInt(message.payload ?? '');
        if (target > appliedVersion) void requestCampaignRefresh('notification');
      } catch {
        console.warn(JSON.stringify({ event: 'campaign_inventory_notification_invalid' }));
      }
    });
    const reconnect = () => {
      if (listener === current) listener = undefined;
      if (!stopping && !reconnectTimer) reconnectTimer = setTimeout(() => {
        reconnectTimer = undefined;
        void connectInventoryListener();
      }, 2_000);
    };
    current.once('error', reconnect);
    current.once('end', reconnect);
    await pollInventory();
  } catch (error) {
    await current.end().catch(() => undefined);
    if (!stopping && !reconnectTimer) reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      void connectInventoryListener();
    }, 2_000);
    console.warn(JSON.stringify({ event: 'campaign_inventory_listener_failed', error_type: error instanceof Error ? error.name : 'UnknownError' }));
  }
}

/** Load the raw (text-only) sponsor list from disk. */
function readDisk(): Sponsor[] {
  const raw = readFileSync(DB_PATH, 'utf-8');
  return (JSON.parse(raw) as Array<Omit<Sponsor, 'is_synthetic' | 'disclosure'>>).map((s) => ({
    ...s,
    is_synthetic: false,
    disclosure: null,
    embedding: [],
  }));
}

/**
 * Load + embed every sponsor into the in-memory cache. Call once at startup.
 * Always re-embeds (cheap for a handful of sponsors) so a provider switch
 * (mock -> OpenAI) never leaves stale vectors in play.
 */
export async function initSponsorStore(): Promise<void> {
  const seed = getRuntimeConfig().serviceMode ? [] : readDisk();
  // Bootstrap fixtures are immutable and atomic: an interrupted startup cannot
  // leave partially imported campaigns or analytics rows behind, and a later
  // startup never restores values an advertiser edited in SQLite.
  await bootstrapCampaignsAndAnalytics(seed.map((sponsor) => ({
    ...sponsor,
    target_keywords: JSON.stringify(sponsor.target_keywords),
  })));
  if (getRuntimeConfig().serviceMode) {
    stopping = false;
    await performRefresh('startup');
    await connectInventoryListener();
    pollTimer ??= setInterval(() => { void pollInventory(); }, 15_000);
    pollTimer.unref();
    return;
  }
  cache = await embedSponsors(await listCampaigns());
}

/** Return the in-memory (embedded) sponsor list. */
export function getSponsors(): Sponsor[] {
  return cache;
}

export async function getCampaignInventoryStatus(): Promise<{
  target_version: string;
  target_updated_at: string;
  target_updated_by: string | null;
  applied_version: string;
  applied_at: string | null;
  campaign_count: number;
  propagating: boolean;
}> {
  const target = await databaseInventoryState();
  return {
    target_version: String(target.version),
    target_updated_at: target.updated_at.toISOString(),
    target_updated_by: target.updated_by,
    applied_version: String(appliedVersion),
    applied_at: appliedAt?.toISOString() ?? null,
    campaign_count: cache.length,
    propagating: appliedVersion < target.version,
  };
}

export async function stopSponsorStore(): Promise<void> {
  stopping = true;
  if (pollTimer) clearInterval(pollTimer);
  if (reconnectTimer) clearTimeout(reconnectTimer);
  pollTimer = undefined;
  reconnectTimer = undefined;
  const current = listener;
  listener = undefined;
  if (current) await current.end().catch(() => undefined);
  await refreshPromise;
}

export interface NewSponsorInput {
  brand_name: string;
  ad_copy: string;
  target_keywords: string[];
  click_url: string;
}

/** Create, embed (in memory), persist text-only, and return a new sponsor. */
export async function addSponsor(input: NewSponsorInput): Promise<Sponsor> {
  const id = input.brand_name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
  const embedding = await generateEmbedding(sponsorEmbeddingText({
    ...input,
    id,
    is_synthetic: false,
    disclosure: null,
    embedding: [],
  }));
  const sponsor: Sponsor = {
    id,
    brand_name: input.brand_name,
    ad_copy: input.ad_copy,
    target_keywords: input.target_keywords,
    click_url: input.click_url,
    is_synthetic: false,
    disclosure: null,
    embedding,
  };
  await upsertCampaign({ ...sponsor, target_keywords: JSON.stringify(sponsor.target_keywords) });
  // Update only the relevant embedded cache entry; sponsors.json is bootstrap-only.
  const existingIdx = cache.findIndex((s) => s.id === id);
  if (existingIdx >= 0) {
    cache[existingIdx] = sponsor;
  } else {
    cache.push(sponsor);
  }
  return sponsor;
}
