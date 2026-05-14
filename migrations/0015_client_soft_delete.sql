-- Migration: 0015_client_soft_delete
-- Adds a reversible "soft delete" state for clients.
--
-- Design: instead of expanding `clients.status` CHECK with a new
-- `deleted` value (which would require a recreate-and-copy of the
-- clients table — risky on production due to inbound FKs from
-- attestations / cluster_members / link_project_placements /
-- form_submissions), we represent soft delete as:
--
--     status = 'paused'  AND  deleted_at IS NOT NULL
--
-- - The worker's auth check (src/worker.ts) already returns 410 Gone
--   for any status != 'active', so soft-deleted clients stop serving
--   immediately with no worker-side change.
-- - The app distinguishes "regular paused" (deleted_at IS NULL) from
--   "soft-deleted" (deleted_at IS NOT NULL) for the list filter and
--   the delete/restore UI buttons.
-- - Restore sets status='active' and clears deleted_at.
--
-- A future cron sweep will hard-delete rows where deleted_at is older
-- than 30 days. The column + index give that sweep a key to filter.
--
-- audit_log gets two new event types so the trail is explicit:
-- `soft_delete` (status flip + deleted_at set) and `restore` (the
-- reverse). audit_log has no incoming FKs so the recreate-and-copy
-- pattern is safe here.
--
-- Forward-only. Never edit a deployed migration.

PRAGMA foreign_keys = OFF;

-- ─── clients: just add deleted_at; no CHECK change needed ──────────
ALTER TABLE clients ADD COLUMN deleted_at TEXT;
CREATE INDEX IF NOT EXISTS idx_clients_deleted_at ON clients(deleted_at);

-- ─── audit_log: expand event_type CHECK ────────────────────────────
CREATE TABLE audit_log_new (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id TEXT NOT NULL,
  actor_email TEXT NOT NULL,
  actor_ip TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN (
    'config_create',
    'config_create_bypass',
    'config_update',
    'status_change',
    'revocation',
    'authorization_update',
    'embed_apply',
    'embed_remove',
    'soft_delete',
    'restore'
  )),
  before_hash TEXT,
  after_hash TEXT,
  previous_status TEXT,
  new_status TEXT,
  notes TEXT,
  occurred_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO audit_log_new (
  id, client_id, actor_email, actor_ip, event_type,
  before_hash, after_hash, previous_status, new_status, notes, occurred_at
)
SELECT
  id, client_id, actor_email, actor_ip, event_type,
  before_hash, after_hash, previous_status, new_status, notes, occurred_at
FROM audit_log;

DROP TABLE audit_log;
ALTER TABLE audit_log_new RENAME TO audit_log;

CREATE INDEX idx_audit_client ON audit_log(client_id);
CREATE INDEX idx_audit_occurred ON audit_log(occurred_at);

PRAGMA foreign_keys = ON;
