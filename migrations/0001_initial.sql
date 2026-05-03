-- Migration: 0001_initial
-- Spec: docs/tech-spec.md §7
-- Forward-only. Never edit a deployed migration; add a new one instead.

CREATE TABLE clients (
  client_id TEXT PRIMARY KEY,
  proxy_domain TEXT NOT NULL UNIQUE,
  source_domain TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'paused', 'terminated')),
  config_json TEXT NOT NULL,           -- full ClientConfig serialized; Zod schema in src/config/schema.ts is source of truth
  schema_version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_clients_proxy_domain ON clients(proxy_domain);
CREATE INDEX idx_clients_status ON clients(status);

CREATE TABLE attestations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id TEXT NOT NULL,
  proxy_domain TEXT NOT NULL,
  source_domain TEXT NOT NULL,
  attested_by_email TEXT NOT NULL,
  attested_at TEXT NOT NULL,
  attested_ip TEXT NOT NULL,
  user_agent TEXT,
  scope TEXT NOT NULL,
  scope_paths_json TEXT,
  FOREIGN KEY (client_id) REFERENCES clients(client_id)
);

CREATE INDEX idx_attestations_client ON attestations(client_id);

CREATE TABLE form_submissions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id TEXT NOT NULL,
  proxy_domain TEXT NOT NULL,
  submitted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  payload_json TEXT NOT NULL,
  forwarded_status INTEGER,
  FOREIGN KEY (client_id) REFERENCES clients(client_id)
);

CREATE INDEX idx_forms_client ON form_submissions(client_id);

-- Audit log: every config write and every revocation event. Append-only.
-- Required by spec §7 constraints and §6.1 revocation propagation.
CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id TEXT NOT NULL,
  actor_email TEXT NOT NULL,
  actor_ip TEXT NOT NULL,
  event_type TEXT NOT NULL CHECK (event_type IN (
    'config_create',
    'config_update',
    'status_change',
    'revocation',
    'authorization_update'
  )),
  before_hash TEXT,
  after_hash TEXT,
  previous_status TEXT,
  new_status TEXT,
  notes TEXT,
  occurred_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (client_id) REFERENCES clients(client_id)
);

CREATE INDEX idx_audit_client ON audit_log(client_id);
CREATE INDEX idx_audit_occurred ON audit_log(occurred_at);
