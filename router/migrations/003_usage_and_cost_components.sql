ALTER TABLE ad_events ADD COLUMN cache_write_tokens INTEGER;
ALTER TABLE ad_events ADD COLUMN cost_input_cache_hit REAL;
ALTER TABLE ad_events ADD COLUMN cost_input_cache_miss REAL;
ALTER TABLE ad_events ADD COLUMN cost_cache_write REAL;
ALTER TABLE ad_events ADD COLUMN cost_output REAL;
