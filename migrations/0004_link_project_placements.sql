-- Migration: 0004_link_project_placements
-- Slice 2 (Phase A) of the Link Projects feature: per-client placement
-- records that say "push this link project from this client, on pages
-- matching this regex." Phase A is data + admin UI only — Phase B
-- compiles these to KV and injects them at request time.
-- Forward-only. Never edit a deployed migration; add a new one instead.

-- =============================================================================
-- link_project_placements — one row per (link_project × client × page_match).
--
-- A placement says "the worker should inject a link to <link_project.target_url>
-- on <client>'s pages whose path matches <page_match>, using <strategy>."
--
-- strategy is currently restricted to 'footer' (anchor injected before
-- </body>). Slice 3 will add more strategies (CSS-selector position, after-
-- first-paragraph, etc.). The CHECK clause keeps invalid values out of the
-- database; relaxing the check requires a new migration.
--
-- anchor_override: when null, the placement uses link_projects.anchor_options[0].
-- When set, it overrides per-placement (e.g. the operator wants a different
-- anchor on this client than the project's default).
--
-- rel_attribute: shipped as a separate column rather than a JSON blob because
-- it's a small bounded string ('noopener', 'nofollow', 'sponsored noopener',
-- etc.) and we want it indexable for "show me all sponsored links" queries.
-- Default 'noopener' matches HTML's recommended baseline for outbound links.
--
-- status (active/paused): per-placement override of the parent project's
-- status. A placement is rendered at request time only when BOTH the
-- project AND the placement are active. Lets operators pause one client's
-- placement without affecting the rest of the project.
--
-- ON DELETE CASCADE on link_project_id — deleting the parent project
-- removes its placements. clients.client_id has no CASCADE (TEXT FK),
-- so deleting a client leaves orphaned placement rows; the worker
-- pipeline (Phase B) will simply skip placements whose client doesn't
-- resolve, and the admin UI hides them via a JOIN.
-- =============================================================================
CREATE TABLE link_project_placements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  link_project_id INTEGER NOT NULL,
  client_id TEXT NOT NULL,
  page_match TEXT NOT NULL DEFAULT '^/.*',
  strategy TEXT NOT NULL CHECK (strategy IN ('footer')) DEFAULT 'footer',
  anchor_override TEXT,
  rel_attribute TEXT NOT NULL DEFAULT 'noopener',
  status TEXT NOT NULL CHECK (status IN ('active','paused')) DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (link_project_id) REFERENCES link_projects(id) ON DELETE CASCADE,
  FOREIGN KEY (client_id) REFERENCES clients(client_id)
);

CREATE INDEX idx_lpp_project ON link_project_placements(link_project_id);
CREATE INDEX idx_lpp_client ON link_project_placements(client_id);
CREATE INDEX idx_lpp_status ON link_project_placements(status);
