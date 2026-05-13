-- Migration: 0012_indexation_checks
-- Append-only history of "is this URL indexed in Google?" checks.
--
-- Each row records the outcome of one DataForSEO `site:<url>` query.
-- The most recent row per (client_id, url) is the operator's current
-- view; older rows are kept for history + audit. A row with
-- `indexed = NULL` means the check failed or DataForSEO didn't have
-- a usable answer — caller should NOT cache that as a definitive
-- "not indexed."
--
-- `evidence_json` carries a small JSON blob with what the query
-- returned (count of organic items, the matched URL, the API
-- status_code) so operators can see *why* we said indexed/not.
--
-- Forward-only. Never edit a deployed migration.

CREATE TABLE indexation_checks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id TEXT NOT NULL,
  url TEXT NOT NULL,
  -- 0 = not indexed, 1 = indexed, NULL = unknown (API error / no answer)
  indexed INTEGER,
  evidence_json TEXT,
  checked_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  checked_by_email TEXT NOT NULL
);

CREATE INDEX idx_indexation_checks_client_url ON indexation_checks(client_id, url);
CREATE INDEX idx_indexation_checks_checked_at ON indexation_checks(checked_at);
