-- Migration: 0002_users
-- Phase 2 multi-user auth: users, sessions, email_tokens; multi-tenant
-- ownership on clients; super-admin seed.
-- Forward-only. Never edit a deployed migration; add a new one instead.

-- =============================================================================
-- users — application accounts
--
-- email is unique and stored lowercase (the application normalizes on insert
-- and lookup; SQLite is case-insensitive on COLLATE NOCASE strings but we
-- keep the discipline at the application layer for portability).
--
-- password_hash is nullable: invited / unverified-yet users have no password
-- until they set one via the reset flow. Format: "pbkdf2$iter$saltHex$hashHex".
--
-- email_verified_at: NULL = unverified; non-null = verified at that time.
-- =============================================================================
CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT,
  role TEXT NOT NULL CHECK (role IN ('super_admin', 'user')),
  email_verified_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_users_email ON users(email);

-- =============================================================================
-- sessions — server-side session tokens, looked up via cookie value
--
-- Token is a random 64-char hex string (32 bytes). Server-side rather than
-- JWT so logout / "log out everywhere" / role change can revoke instantly.
-- ON DELETE CASCADE so removing a user wipes their sessions.
-- =============================================================================
CREATE TABLE sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  expires_at TEXT NOT NULL,
  ip TEXT NOT NULL,
  user_agent TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);

-- =============================================================================
-- email_tokens — single-use tokens for email verification, password reset,
-- and invite-set-password flows. Discriminated by `kind`.
--
-- Token is a random 64-char hex string (32 bytes), single-use (used_at flips
-- to a timestamp on consumption; consuming an already-used token must fail).
-- ON DELETE CASCADE so removing a user wipes their pending tokens.
-- =============================================================================
CREATE TABLE email_tokens (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('verify_email', 'reset_password', 'invite')),
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
);

CREATE INDEX idx_email_tokens_user ON email_tokens(user_id);
CREATE INDEX idx_email_tokens_kind ON email_tokens(kind);
CREATE INDEX idx_email_tokens_expires ON email_tokens(expires_at);

-- =============================================================================
-- Multi-tenant ownership on clients.
--
-- SQLite ALTER TABLE only supports adding columns; we add owner_id as
-- nullable (FK can't be added via ALTER in SQLite without table recreation).
-- The application layer enforces NOT NULL on insert and references the
-- users table via WHERE owner_id = ? predicates. Backfill below assigns
-- the seeded super-admin as the owner of all existing rows.
-- =============================================================================
ALTER TABLE clients ADD COLUMN owner_id INTEGER;

CREATE INDEX idx_clients_owner ON clients(owner_id);

-- =============================================================================
-- Seed: super-admin row.
--
-- password_hash is NULL — first login uses /forgot to set a password via
-- the email reset flow. email_verified_at is set so the verify path is
-- skipped (the super-admin email is trusted at seed time). role super_admin
-- grants visibility to all clients regardless of owner_id.
-- =============================================================================
INSERT INTO users (email, password_hash, role, email_verified_at)
VALUES ('simon@localblitzmarketing.com', NULL, 'super_admin', CURRENT_TIMESTAMP);

-- =============================================================================
-- Backfill: assign existing clients to the super-admin.
--
-- This makes the new ownership semantics retroactively consistent:
-- lantern-crest, rfengineer, acceptance-test-1 — and anything else
-- currently in the table — all become super-admin's clients. Super-admin
-- still sees everyone else's clients regardless of owner_id; this just
-- gives existing rows a non-null owner so the UI rendering doesn't have
-- a special "unowned" case.
-- =============================================================================
UPDATE clients
SET owner_id = (SELECT id FROM users WHERE email = 'simon@localblitzmarketing.com')
WHERE owner_id IS NULL;
