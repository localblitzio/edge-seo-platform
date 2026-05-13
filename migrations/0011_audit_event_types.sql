-- Migration: 0011_audit_event_types
-- Expand audit_log.event_type CHECK constraint to include the new
-- events introduced by later features:
--   - config_create_bypass — bulk-create + SERP flow when operator
--     bypasses third-party attestation
--   - embed_apply / embed_remove — bulk Embeds feature
--
-- SQLite doesn't support ALTER TABLE ... DROP CONSTRAINT for CHECK
-- constraints, so we use the standard recreate-and-copy pattern.
-- Forward-only. Never edit a deployed migration.

PRAGMA foreign_keys = OFF;

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
    'embed_remove'
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

-- Indexes get dropped with the old table; recreate with the same
-- names as 0001_initial.sql for consistency.
CREATE INDEX idx_audit_client ON audit_log(client_id);
CREATE INDEX idx_audit_occurred ON audit_log(occurred_at);

PRAGMA foreign_keys = ON;
