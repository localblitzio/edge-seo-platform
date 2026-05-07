-- Migration: 0005_link_project_placement_selector
-- Slice 3 of the Link Projects feature: adds the `selector` strategy
-- (operator-defined CSS selector + position) alongside the existing
-- `footer` strategy, plus the columns that strategy needs.
--
-- SQLite doesn't allow ALTER on CHECK constraints, so we use the
-- canonical "create new table, copy, drop, rename" pattern. Indexes
-- are recreated at the end.
--
-- Forward-only. Never edit a deployed migration; add a new one instead.

-- =============================================================================
-- New columns:
--   target_selector — CSS selector the link is injected relative to.
--                     NULL when strategy='footer' (footer always uses 'body').
--   position        — placement position relative to target_selector.
--                     Mirrors HTMLRewriter element semantics; CHECK
--                     constraint keeps invalid values out at the DB layer.
--                     NULL when strategy='footer' (footer always uses 'append').
--
-- Strategy CHECK constraint widened from ('footer') to ('footer','selector').
-- Existing rows have strategy='footer' (the only legal value before this
-- migration) so the copy step preserves them correctly.
-- =============================================================================

CREATE TABLE link_project_placements_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  link_project_id INTEGER NOT NULL,
  client_id TEXT NOT NULL,
  page_match TEXT NOT NULL DEFAULT '^/.*',
  strategy TEXT NOT NULL CHECK (strategy IN ('footer','selector')) DEFAULT 'footer',
  target_selector TEXT,
  position TEXT CHECK (position IS NULL OR position IN ('before','after','prepend','append')),
  anchor_override TEXT,
  rel_attribute TEXT NOT NULL DEFAULT 'noopener',
  status TEXT NOT NULL CHECK (status IN ('active','paused')) DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (link_project_id) REFERENCES link_projects(id) ON DELETE CASCADE,
  FOREIGN KEY (client_id) REFERENCES clients(client_id)
);

-- Copy: existing rows are all strategy='footer' so target_selector and
-- position stay NULL. The synthesizer treats NULL on a footer placement
-- as "use the footer defaults (body, append)".
INSERT INTO link_project_placements_new (
  id, link_project_id, client_id, page_match, strategy,
  target_selector, position,
  anchor_override, rel_attribute, status, created_at, updated_at
)
SELECT
  id, link_project_id, client_id, page_match, strategy,
  NULL, NULL,
  anchor_override, rel_attribute, status, created_at, updated_at
FROM link_project_placements;

DROP TABLE link_project_placements;

ALTER TABLE link_project_placements_new RENAME TO link_project_placements;

-- Recreate indexes (lost when the original table was dropped).
CREATE INDEX idx_lpp_project ON link_project_placements(link_project_id);
CREATE INDEX idx_lpp_client ON link_project_placements(client_id);
CREATE INDEX idx_lpp_status ON link_project_placements(status);
