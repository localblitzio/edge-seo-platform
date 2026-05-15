-- Migration: 0013_site_templates
-- Programmatic SEO foundation: reusable HTML templates with
-- placeholders, structured data sources, and per-row generated
-- pages tracked for re-render / removal.
--
-- Lifecycle:
--   1. Operator authors `site_templates` row (HTML + placeholder
--      schema + optional LLM enrichment spec for Phase C).
--   2. Operator authors `site_data_sources` row (CSV upload,
--      inline-edited table, or DataForSEO scrape — Phase B).
--   3. Operator runs render against (template × data_source) for a
--      target client. Each rendered page lands in `generated_pages`
--      with the R2 key + content hash for idempotent re-renders.
--
-- Forward-only. Never edit a deployed migration.

-- =============================================================================
-- site_templates — reusable HTML blocks with placeholders.
--
-- `kind`:
--   - `pages_in_client` — generated pages append as `custom_page`
--     routes inside ONE target client. Best for deep-page coverage
--     on a single brand (acme.com/plumbers-in-springfield).
--   - `client_per_row` — each data-source row becomes its OWN new
--     client (single-page custom-page site). Best for agency-scale
--     site networks.
--
-- `html_template` is Mustache-flavoured: `{{key}}` for HTML-escaped
-- substitution, `{{{key}}}` for raw HTML (operator opt-in), and
-- `{{#if key}}...{{/if}}` for conditional sections. The renderer
-- supports a small fixed set of helpers (`slugify`, lower, upper).
--
-- `path_pattern` is the URL pattern for each generated page. Same
-- placeholder syntax. Example: `/{{slugify(service)}}-in-{{slugify(city)}}`.
-- The platform slugifies the result automatically (no double-slug).
--
-- `placeholder_schema` is a JSON array describing each placeholder
-- the template uses (name + type + LLM-augmented flag). Auto-detected
-- on save; operator can edit. Validates against the data source at
-- generate time so missing columns fail loud.
--
-- `llm_enrichment_spec` is reserved for Phase C — JSON array of
-- `{ field, provider, model, prompt, schema }` entries that
-- describe LLM-generated fields the template uses. NULL until C.
-- =============================================================================
CREATE TABLE site_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('pages_in_client', 'client_per_row')),
  html_template TEXT NOT NULL,
  path_pattern TEXT NOT NULL,
  placeholder_schema TEXT NOT NULL DEFAULT '[]',
  llm_enrichment_spec TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX idx_site_templates_owner ON site_templates(owner_id);
CREATE UNIQUE INDEX idx_site_templates_owner_name ON site_templates(owner_id, name);

-- =============================================================================
-- site_data_sources — tabular data the operator feeds into templates.
--
-- `source_kind`:
--   - `csv`             — uploaded CSV file (parsed to `rows` JSON)
--   - `inline`          — operator typed directly in the admin UI
--   - `dataforseo_business_listings` — Phase B scrape result
--   - `dataforseo_serp` — Phase B scrape result
--
-- `columns` is JSON array of column names in stable order so the
-- renderer can reliably pull `rows[i][col]`.
--
-- `rows` is JSON array of objects (each object keyed by column name).
-- Stored inline because batch sizes are bounded (≤500 rows hard cap)
-- and D1 row size limits are generous. If we ever need >500, we'd
-- denormalize to a `data_source_rows` table.
--
-- `source_config` carries the scrape params for re-scrape (keyword,
-- locations, etc.). NULL for CSV/inline sources.
--
-- `llm_enrichment_status`: `none` / `pending` / `complete` / `error`
-- — set by the Phase C enrichment runner. `none` until C.
-- =============================================================================
CREATE TABLE site_data_sources (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  source_kind TEXT NOT NULL CHECK (source_kind IN (
    'csv', 'inline', 'dataforseo_business_listings', 'dataforseo_serp'
  )),
  columns TEXT NOT NULL DEFAULT '[]',
  rows TEXT NOT NULL DEFAULT '[]',
  source_config TEXT,
  llm_enrichment_status TEXT NOT NULL DEFAULT 'none' CHECK (llm_enrichment_status IN (
    'none', 'pending', 'complete', 'error'
  )),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX idx_site_data_sources_owner ON site_data_sources(owner_id);
CREATE UNIQUE INDEX idx_site_data_sources_owner_name ON site_data_sources(owner_id, name);

-- =============================================================================
-- generated_pages — one row per rendered page.
--
-- Lets us:
--   * Re-render only what changed (content_hash diff)
--   * Remove generated pages cleanly when an operator deletes a
--     template or data source
--   * Track LLM cost per page (Phase C)
--   * Show generated pages in indexation overview (joins on client_id
--     just like any other URL)
--
-- `client_id` is the target client whose config_json holds the
-- custom_page route. `r2_key` is where the rendered HTML lives
-- (`generated/<client_id>/<path>` convention).
--
-- `content_hash` is fnv1a of the rendered HTML. On re-render we
-- skip writing when the hash matches.
--
-- `llm_cost_usd` is the accumulated cost of LLM calls that produced
-- this page's enriched fields (Phase C). NULL until C ships.
-- =============================================================================
CREATE TABLE generated_pages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  template_id INTEGER NOT NULL,
  data_source_id INTEGER NOT NULL,
  client_id TEXT NOT NULL,
  row_index INTEGER NOT NULL,
  generated_path TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  llm_cost_usd REAL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (template_id) REFERENCES site_templates(id) ON DELETE CASCADE,
  FOREIGN KEY (data_source_id) REFERENCES site_data_sources(id) ON DELETE CASCADE
);

CREATE INDEX idx_generated_pages_template ON generated_pages(template_id);
CREATE INDEX idx_generated_pages_data_source ON generated_pages(data_source_id);
CREATE INDEX idx_generated_pages_client ON generated_pages(client_id);
CREATE UNIQUE INDEX idx_generated_pages_template_row_client ON generated_pages(
  template_id, data_source_id, row_index, client_id
);
