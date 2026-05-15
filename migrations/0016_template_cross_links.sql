-- Migration: 0016_template_cross_links
-- Adds cross-linking strategy + count to site_templates.
--
-- When a `client_per_row` template is generated, each page gets a
-- pre-computed list of related-business links — internal-link equity
-- that the operator gets for free. Two strategies in v1:
--
--   `same_category_nearby_cities` — for the current row's `categories`,
--     pick other rows in the same data source from DIFFERENT cities.
--     Prefer geographically near (Haversine on lat/lng if available,
--     otherwise alphabetical).
--
--   `same_city_other_categories` — for the current row's `city`,
--     pick other rows from the SAME city but different categories.
--
-- The renderer exposes the chosen list as a `cross_links` array,
-- consumed by templates via `{{#each cross_links}}...{{/each}}`.
--
-- Forward-only. Never edit a deployed migration.

ALTER TABLE site_templates ADD COLUMN cross_link_strategy TEXT NOT NULL DEFAULT 'none'
  CHECK (cross_link_strategy IN ('none', 'same_category_nearby_cities', 'same_city_other_categories'));
ALTER TABLE site_templates ADD COLUMN cross_link_count INTEGER NOT NULL DEFAULT 0;
