-- Migration: 0020_business_embeds
-- Extends `embeds` so an embed can be backed by a Business row,
-- rendering its HTML from the Business's scraped Maps fields.
--
-- Two nullable columns added:
--   business_id    — FK to businesses(id). NULL means this is a
--                    classic iframe/google_maps_embed.
--   business_kind  — one of business_card | business_cta |
--                    business_map | business_reviews | business_hours
--                    when business_id is set. Validation enforced
--                    in app code, NOT a CHECK constraint, because
--                    expanding the CHECK on `kind` would require a
--                    recreate-and-copy of `embeds` and that table
--                    has an inbound FK from `embed_placements`
--                    (same risk that bit us in migration 0015).
--
-- HTML model: snapshot-at-write. When a Business-backed embed is
-- created, we render the HTML from the Business's current fields and
-- store it in `embeds.html`. Operators hit "Refresh" on the embed
-- detail page after a Business update to re-render. Trade-off vs
-- render-time injection: stale until refresh, but simpler — existing
-- HTMLRewriter path doesn't need to know about Businesses.
--
-- Forward-only. Never edit a deployed migration.

ALTER TABLE embeds ADD COLUMN business_id INTEGER REFERENCES businesses(id) ON DELETE SET NULL;
ALTER TABLE embeds ADD COLUMN business_kind TEXT;

CREATE INDEX idx_embeds_business ON embeds(business_id);
