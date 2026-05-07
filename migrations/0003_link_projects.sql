-- Migration: 0003_link_projects
-- Slice 1 of the Link Projects feature: a registry of money-site
-- targets that operators want to push from their proxied client sites.
-- This migration adds the registry only — placement records (Slice 2)
-- and worker pipeline integration come in later migrations.
-- Forward-only. Never edit a deployed migration; add a new one instead.

-- =============================================================================
-- link_projects — operator-defined pushes to a target URL.
--
-- Each row is one campaign-like grouping: "I want links pointing at
-- https://xyz.com/services" with a label, anchor variations, and a
-- status that gates whether the per-page placements (added in Slice 2)
-- run at request time.
--
-- Multi-tenant: owner_id scopes visibility the same way clients.owner_id
-- does. Super-admin sees all rows.
--
-- target_url stores the *full URL* (including path), not just the
-- hostname — operators commonly push to a specific landing page, not
-- the apex.
--
-- anchor_options is a JSON array of strings; the first entry is the
-- default anchor for any placement that doesn't override it. Stored as
-- JSON rather than a separate table because it's a small bounded list
-- (cap at ~10 in the validator) and never queried independently.
--
-- status semantics:
--   draft     — created, no placements yet active. Default on create.
--   active    — placements (Slice 2) run at request time.
--   paused    — placements exist but are skipped at request time.
--   archived  — historical; kept for audit but never run.
--
-- =============================================================================
CREATE TABLE link_projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id INTEGER NOT NULL,
  label TEXT NOT NULL,
  target_url TEXT NOT NULL,
  anchor_options TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL CHECK (status IN ('draft','active','paused','archived')) DEFAULT 'draft',
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX idx_link_projects_owner ON link_projects(owner_id);
CREATE INDEX idx_link_projects_status ON link_projects(status);
