-- Migration: 0021_aggregate_template_kind
-- Adds an `aggregate_per_group` template kind alongside the existing
-- `pages_in_client` and `client_per_row` kinds, plus the three
-- columns that drive aggregate behavior.
--
-- The aggregate kind groups data-source rows by a shared column
-- (e.g. `city`) and renders ONE page per unique group value with up
-- to top-N rows exposed as a `{{#each businesses}}` array. Operators
-- get "Top 10 Pool Builders in San Diego" listicle pages from the
-- same data source they use for `client_per_row`.
--
-- For SQLite we can't ALTER CHECK on `kind`. Following the pattern
-- from migration 0015: keep the column as TEXT, drop the CHECK via
-- recreate-and-copy. site_templates has only one inbound FK
-- (generated_pages → template_id) so the recreate is low-risk.
--
-- Forward-only. Never edit a deployed migration.

PRAGMA foreign_keys = OFF;

CREATE TABLE site_templates_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('pages_in_client', 'client_per_row', 'aggregate_per_group')),
  html_template TEXT NOT NULL,
  path_pattern TEXT NOT NULL,
  placeholder_schema TEXT NOT NULL DEFAULT '[]',
  llm_enrichment_spec TEXT,
  cross_link_strategy TEXT NOT NULL DEFAULT 'none'
    CHECK (cross_link_strategy IN ('none', 'same_category_nearby_cities', 'same_city_other_categories')),
  cross_link_count INTEGER NOT NULL DEFAULT 0,
  /* aggregate-mode columns. NULL for non-aggregate templates. */
  group_by_column TEXT,
  top_n INTEGER NOT NULL DEFAULT 10,
  sort_by_column TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE
);

INSERT INTO site_templates_new (
  id, owner_id, name, kind, html_template, path_pattern, placeholder_schema,
  llm_enrichment_spec, cross_link_strategy, cross_link_count,
  group_by_column, top_n, sort_by_column,
  created_at, updated_at
)
SELECT
  id, owner_id, name, kind, html_template, path_pattern, placeholder_schema,
  llm_enrichment_spec, cross_link_strategy, cross_link_count,
  NULL, 10, NULL,
  created_at, updated_at
FROM site_templates;

DROP TABLE site_templates;
ALTER TABLE site_templates_new RENAME TO site_templates;

-- Recreate the indexes from 0013_site_templates.sql + 0016.
CREATE INDEX idx_site_templates_owner ON site_templates(owner_id);
CREATE UNIQUE INDEX idx_site_templates_owner_name ON site_templates(owner_id, name);

PRAGMA foreign_keys = ON;
