-- Migration: 0007_cluster_cross_linking
-- Slice C of the Clusters feature: opt-in "Related sites" footer block
-- that links every cluster member to every other.
--
-- This migration only adds the toggle column. The synthesis +
-- request-time injection live in worker code; KV key is
-- `cluster_links:<client_id>`.
-- Forward-only. Never edit a deployed migration; add a new one instead.

-- =============================================================================
-- cross_link_enabled — per-cluster opt-in for the cross-linking
-- behavior. Default 0 (off) so existing clusters keep their Slice A /
-- B behavior unchanged. When set to 1, the admin pipeline compiles a
-- ContentInjectRule for each member site that injects a
-- "Related sites" footer block linking to the other members; the
-- proxy worker reads `cluster_links:<client_id>` from KV alongside
-- the existing `config:<id>` and `placements:<id>` lookups, merges
-- the rules into config.content_injections, and the existing
-- HTMLRewriter pipeline does the injection.
--
-- Stored as INTEGER (SQLite has no native bool). 0 = off, 1 = on.
-- =============================================================================

ALTER TABLE clusters ADD COLUMN cross_link_enabled INTEGER NOT NULL DEFAULT 0
  CHECK (cross_link_enabled IN (0, 1));
