-- Migration: 0017_reviews_scrape
-- Adds async job-tracking columns for the per-business reviews scrape.
--
-- Reviews enrichment runs AFTER a `dataforseo_business_listings`
-- scrape completes. For each row with a `place_id`, we fetch up to
-- 5 customer reviews via `/v3/business_data/google/reviews/live`
-- (~$0.003 per business). The reviews are stored as a JSON array on
-- the row itself (`reviews_json` field) so templates can render
-- them via `{{#each reviews}}...{{/each}}` without a new join table.
--
-- The columns added here mirror the listings-scrape columns from
-- migration 0014 — same async progress UI pattern.
--
-- Forward-only. Never edit a deployed migration.

ALTER TABLE site_data_sources ADD COLUMN reviews_status TEXT NOT NULL DEFAULT 'none'
  CHECK (reviews_status IN ('none', 'running', 'done', 'error'));
ALTER TABLE site_data_sources ADD COLUMN reviews_progress_total INTEGER NOT NULL DEFAULT 0;
ALTER TABLE site_data_sources ADD COLUMN reviews_progress_done INTEGER NOT NULL DEFAULT 0;
ALTER TABLE site_data_sources ADD COLUMN reviews_progress_updated_at TEXT;
ALTER TABLE site_data_sources ADD COLUMN reviews_error TEXT;

CREATE INDEX idx_site_data_sources_reviews_status
  ON site_data_sources(reviews_status, reviews_progress_updated_at);
