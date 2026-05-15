-- Migration: 0018_city_facts
-- Cached Wikipedia city facts for free per-page enrichment.
--
-- For every unique (city, state, country) combination across a
-- data source, we fetch a Wikipedia summary once and cache it
-- for 30 days. Operator triggers via "+ Enrich cities (free)"
-- button on the data source page. Each row in the data source
-- gets a `city_description` field appended so templates can use
-- it via {{city_description}}.
--
-- Forward-only. Never edit a deployed migration.

CREATE TABLE city_facts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  city TEXT NOT NULL,
  region TEXT NOT NULL,
  country TEXT NOT NULL,
  /** First paragraph from the Wikipedia summary, plain text. */
  description TEXT NOT NULL DEFAULT '',
  /** Population (most recent census or estimate) or NULL when unknown. */
  population INTEGER,
  /** Year founded / incorporated, or NULL. */
  founded_year INTEGER,
  /** Canonical Wikipedia page URL. */
  wiki_url TEXT NOT NULL DEFAULT '',
  /** When we last hit Wikipedia. Used by future cron refresh. */
  fetched_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX idx_city_facts_lookup ON city_facts(city, region, country);
CREATE INDEX idx_city_facts_fetched_at ON city_facts(fetched_at);
