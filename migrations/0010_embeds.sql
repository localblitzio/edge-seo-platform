-- Migration: 0010_embeds
-- Embed library + per-client placements.
--
-- An "embed" is a named, reusable HTML block (typically an <iframe>
-- — Google Maps, video, social widget) that the operator authors
-- once and applies across many proxied sites for SEO. Applying an
-- embed to a cluster:
--   1. Appends a content_injection rule into every member's config_json
--      (idempotent via data-edge-seo-rule="embed:<id>" marker)
--   2. Upserts a wildcard canonical rule with strategy=self
--   3. Upserts a wildcard indexation rule with robots=index,follow
--   4. (optional) fires the operator-selected indexers for each
--      site's seed paths
--   5. Records a row in embed_placements so we can reapply on edit
--
-- Forward-only. Never edit a deployed migration; add a new one instead.

-- =============================================================================
-- embeds — the reusable HTML library.
--
-- `kind` discriminates intent (iframe = generic, google_maps_embed =
-- validated to be a Google Maps src). The kind drives validation in
-- the admin form, NOT runtime — at request time the worker just
-- injects the html string verbatim.
--
-- `default_position` is the position the apply form pre-fills:
--   - `bottom`: append at end of <main>
--   - `middle`: after <main> > p:nth-of-type(2)
-- Operator can override per-apply.
--
-- Multi-tenant: owner_id scopes visibility identically to clusters +
-- link_projects. Super-admin sees all rows.
-- =============================================================================
CREATE TABLE embeds (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('iframe','google_maps_embed')),
  html TEXT NOT NULL,
  default_position TEXT NOT NULL CHECK (default_position IN ('middle','bottom')) DEFAULT 'bottom',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX idx_embeds_owner ON embeds(owner_id);
CREATE UNIQUE INDEX idx_embeds_owner_name ON embeds(owner_id, name);

-- =============================================================================
-- embed_placements — per-client record of every applied embed.
--
-- One row per (embed × client) instance. When operator clicks Apply,
-- we INSERT OR REPLACE for each cluster member. When operator edits
-- the embed html, the "Reapply to all" button re-runs apply for
-- every row whose embed_id matches.
--
-- `position` is captured per placement because the operator can
-- override the embed's default at apply time.
--
-- `source_cluster_id` records the cluster context the apply was
-- made under. NULL means a direct single-site apply (future). When
-- the cluster's membership changes after the fact, this row stays —
-- the cluster id is only the "where was this applied from" pointer.
-- =============================================================================
CREATE TABLE embed_placements (
  embed_id INTEGER NOT NULL,
  client_id TEXT NOT NULL,
  position TEXT NOT NULL CHECK (position IN ('middle','bottom')),
  source_cluster_id INTEGER,
  applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  applied_by_email TEXT NOT NULL,
  PRIMARY KEY (embed_id, client_id),
  FOREIGN KEY (embed_id) REFERENCES embeds(id) ON DELETE CASCADE,
  FOREIGN KEY (source_cluster_id) REFERENCES clusters(id) ON DELETE SET NULL
);

CREATE INDEX idx_embed_placements_client ON embed_placements(client_id);
CREATE INDEX idx_embed_placements_cluster ON embed_placements(source_cluster_id);
