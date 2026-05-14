-- Migration: 0014_scrape_jobs
-- Async scrape jobs for `dataforseo_business_listings` data sources.
--
-- Phase B v1 ran scrapes inline in the POST request handler, which
-- meant the operator's browser hung for the whole batch (25 locations
-- × ~3s/task = ~75s) with no progress feedback and no way to come
-- back to the job later.
--
-- v2 (this migration) splits the flow:
--   1. POST creates the data source row with `scrape_status='running'`,
--      empty `rows`, and a known `scrape_progress_total` (= location count).
--   2. The request handler kicks off the actual scrape via
--      `ctx.waitUntil(...)` and returns immediately; the operator's
--      browser navigates to the data source detail page.
--   3. The background job updates `scrape_progress_done` +
--      `scrape_progress_updated_at` after each location, appending rows
--      and per-location status. Detail page meta-refreshes every 2s
--      and renders a progress bar while running.
--   4. On completion `scrape_status` flips to `done` (or `error`).
--
-- Stuck-job detection: if `scrape_status='running'` but
-- `scrape_progress_updated_at` is older than 2 minutes, the worker
-- handling the job is presumed dead and the UI offers a "Retry"
-- button that restarts the scrape from scratch.
--
-- The columns are nullable / default to safe values so existing rows
-- (CSV / inline data sources from Phase A) don't need backfill.

ALTER TABLE site_data_sources ADD COLUMN scrape_status TEXT NOT NULL DEFAULT 'none'
  CHECK (scrape_status IN ('none', 'running', 'done', 'error'));
ALTER TABLE site_data_sources ADD COLUMN scrape_progress_total INTEGER NOT NULL DEFAULT 0;
ALTER TABLE site_data_sources ADD COLUMN scrape_progress_done INTEGER NOT NULL DEFAULT 0;
ALTER TABLE site_data_sources ADD COLUMN scrape_progress_updated_at TEXT;
ALTER TABLE site_data_sources ADD COLUMN scrape_per_location TEXT NOT NULL DEFAULT '[]';
ALTER TABLE site_data_sources ADD COLUMN scrape_error TEXT;

-- Index on (scrape_status, updated_at) so the future cron-based
-- stuck-job sweeper can cheaply find live jobs to mark dead.
CREATE INDEX idx_site_data_sources_scrape_status
  ON site_data_sources(scrape_status, scrape_progress_updated_at);
