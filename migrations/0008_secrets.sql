-- Migration: 0008_secrets
-- Operator-managed API keys / secrets, edited from the admin UI
-- ("Settings → API keys" page) instead of `wrangler secret put`.
--
-- Spec: docs/prd.md §7.7 (IndexNow), §7.8 (GSC). The Worker reads
-- these via src/secrets/store.ts which is KV-first (key
-- `secret:<KEY>`), D1 fallback, env fallback (so existing
-- `wrangler secret`-bound values keep working until the operator
-- moves them into D1).
--
-- Global, not per-site. Each row's `key` is one of a fixed set of
-- known slots defined in src/secrets/slots.ts — the UI only exposes
-- those slots, the Worker only reads those slots, and an unknown key
-- in the table is harmless (it just isn't surfaced anywhere).
--
-- Forward-only. Never edit a deployed migration; add a new one instead.

CREATE TABLE secrets (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  updated_by_email TEXT
);
