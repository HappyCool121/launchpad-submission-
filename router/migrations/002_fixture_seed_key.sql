ALTER TABLE ad_events ADD COLUMN seed_key TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS ad_events_seed_key ON ad_events(seed_key) WHERE seed_key IS NOT NULL;
