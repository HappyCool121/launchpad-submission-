CREATE TABLE IF NOT EXISTS campaigns (
  id TEXT PRIMARY KEY,
  brand_name TEXT NOT NULL,
  ad_copy TEXT NOT NULL,
  target_keywords TEXT NOT NULL,
  click_url TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS ad_events (
  turn_id TEXT PRIMARY KEY,
  campaign_id TEXT REFERENCES campaigns(id),
  tier TEXT NOT NULL,
  reason_code TEXT NOT NULL,
  similarity REAL NOT NULL,
  client TEXT,
  provider TEXT,
  model TEXT,
  runtime_mode TEXT,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  settled_at TEXT,
  input_tokens INTEGER,
  cache_hit_tokens INTEGER,
  cache_miss_tokens INTEGER,
  output_tokens INTEGER,
  prompt_cost REAL,
  ad_subsidy REAL,
  paid REAL
);

CREATE INDEX IF NOT EXISTS ad_events_campaign_time ON ad_events(campaign_id, created_at);
CREATE INDEX IF NOT EXISTS ad_events_tier_time ON ad_events(tier, created_at);
