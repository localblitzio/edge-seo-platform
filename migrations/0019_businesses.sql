-- Migration: 0019_businesses
-- New top-level entity: Businesses. The operator's registry of
-- agency clients / featured brands / target sites — distinct from
-- the `clients` table (proxy hosting configs) and `site_data_sources`
-- (bulk row data).
--
-- One Business = one Google Maps profile (place_id), scraped once
-- via DataForSEO (~$0.003 per refresh). The scraped fields mirror
-- a `BusinessListingRow` so the same rendering helpers we use for
-- data sources also work here.
--
-- Use cases:
--   * Mark one as `is_default_target` — its fields become
--     {{target_*}} scalars on every Generate run.
--   * Reference from a future business_card/business_map embed kind
--     (Embed integration).
--   * Auto-power an /about/ route on generated sites whose target is
--     this business (deferred to a later step).
--
-- Soft-delete via `archived_at` — once embeds + generated sites can
-- reference these, hard-delete would dangle references. Matching the
-- soft-delete pattern from migration 0015.
--
-- Forward-only. Never edit a deployed migration.

CREATE TABLE businesses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id INTEGER NOT NULL,

  /* Operator-facing identity */
  name TEXT NOT NULL,
  notes TEXT,

  /* Canonical Google identity */
  place_id TEXT NOT NULL,
  /* Optional link to a `clients` (proxy) row when this Business is
   * also a proxied site we host. NULL means it's tracked but not
   * proxied by us. */
  proxy_client_id TEXT,

  /* Scraped Maps fields — same shape as BusinessListingRow. */
  title TEXT,
  address TEXT,
  city TEXT,
  state TEXT,
  country TEXT,
  zip TEXT,
  phone TEXT,
  website TEXT,
  rating TEXT,
  rating_count TEXT,
  categories TEXT,
  latitude TEXT,
  longitude TEXT,
  hours_json TEXT,
  price_level TEXT,
  description TEXT,
  main_image_url TEXT,
  photos_json TEXT,
  attributes_json TEXT,
  /* Reviews (JSON array of ReviewItem). */
  reviews_json TEXT NOT NULL DEFAULT '[]',
  /* City facts (JSON {description, population, founded_year, wiki_url}). */
  city_facts_json TEXT,

  /* Async scrape state — mirrors site_data_sources columns. */
  scrape_status TEXT NOT NULL DEFAULT 'none'
    CHECK (scrape_status IN ('none', 'running', 'done', 'error')),
  scrape_progress_updated_at TEXT,
  scrape_error TEXT,
  reviews_status TEXT NOT NULL DEFAULT 'none'
    CHECK (reviews_status IN ('none', 'running', 'done', 'error')),
  reviews_progress_updated_at TEXT,
  reviews_error TEXT,

  /* Workflow state */
  is_default_target INTEGER NOT NULL DEFAULT 0 CHECK (is_default_target IN (0, 1)),
  archived_at TEXT,

  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_businesses_owner ON businesses(owner_id);
CREATE UNIQUE INDEX idx_businesses_owner_name ON businesses(owner_id, name);
CREATE INDEX idx_businesses_place_id ON businesses(place_id);
CREATE INDEX idx_businesses_default_target ON businesses(owner_id, is_default_target);
