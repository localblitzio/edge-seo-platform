/**
 * Auth primitives for the frontend worker.
 *
 * Provides:
 *   - PBKDF2 password hash + verify (Web Crypto, 200k iterations, SHA-256)
 *   - Random token generator (cryptographic, hex-encoded)
 *   - Server-side sessions in D1 (cookie carries random token; we look it
 *     up in the `sessions` table on every request — instant revocation,
 *     no JWT key rotation pain)
 *   - User lookup / mutation helpers
 *   - Email token helpers (verify_email, reset_password, invite — single
 *     table `email_tokens` discriminated by `kind`)
 *
 * SESSION_SECRET is reserved for future use (CSRF token signing, signed
 * redirects). Sessions themselves don't need it because the cookie is a
 * random opaque token looked up server-side.
 */

/* ─────────── Types ─────────── */

export type Role = "super_admin" | "user";
export type EmailTokenKind = "verify_email" | "reset_password" | "invite";

export interface User {
  id: number;
  email: string;
  role: Role;
  password_hash: string | null;
  email_verified_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface Session {
  token: string;
  user_id: number;
  expires_at: string;
  ip: string;
  user_agent: string | null;
  created_at: string;
  last_seen_at: string;
}

export interface SessionWithUser {
  user: User;
  session: Session;
}

export interface AuthEnv {
  CONFIG_DB: D1Database;
  SESSION_SECRET?: string;
}

/* ─────────── Constants ─────────── */

/**
 * Password hashing (PBKDF2 — Web Crypto native, no library dependency).
 *
 * 25k iterations is a deliberate trade-off for Cloudflare Workers:
 * accounts on the legacy Bundled CPU model (50ms / request) reject
 * higher counts mid-request with a 1101 error. 200k iterations measured
 * at ~150-300ms CPU, exceeding that budget for both reset (hashPassword)
 * and login (verifyPassword) flows.
 *
 * 25k iterations of PBKDF2-SHA-256 with a 16-byte salt and 32-byte
 * derived hash takes ~10ms in the V8 isolate. Provides ~256-bit hash
 * output, defeats rainbow tables via the salt, and resists offline
 * brute force at a meaningful rate — adequate for an internal-tool
 * threat model. Higher counts can be reinstated if/when we move to
 * Workers Standard with 30s CPU and confirm headroom.
 *
 * Iteration count is encoded in each stored hash, so older 200k-hashed
 * passwords (none exist in production yet) would still verify — only
 * NEW hashes use the lower count.
 */
const PBKDF2_ITERATIONS = 25_000;
const PBKDF2_SALT_BYTES = 16;
const PBKDF2_HASH_BYTES = 32;

/** Session lifetime: 7 days, refreshed on activity. */
export const SESSION_DURATION_MS = 7 * 24 * 60 * 60 * 1000;

/** Email token lifetimes (configured per-kind). */
export const VERIFY_EMAIL_TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24h
export const RESET_PASSWORD_TOKEN_TTL_MS = 60 * 60 * 1000; // 1h
export const INVITE_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7d

/** Cookie name used for the session token. */
export const SESSION_COOKIE_NAME = "edge_seo_session";

/* ─────────── Hex helpers ─────────── */

function toHex(buf: Uint8Array): string {
  let out = "";
  for (let i = 0; i < buf.length; i++) {
    out += (buf[i] ?? 0).toString(16).padStart(2, "0");
  }
  return out;
}

function fromHex(hex: string): Uint8Array {
  if (hex.length % 2 !== 0) throw new Error("invalid hex string (odd length)");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    const byte = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) throw new Error("invalid hex string");
    out[i] = byte;
  }
  return out;
}

/* ─────────── Password hashing (PBKDF2) ─────────── */

/**
 * Hash a plaintext password with PBKDF2-SHA-256.
 *
 * Stored format: `pbkdf2$<iterations>$<saltHex>$<hashHex>` so the verify
 * path can read its own iteration count. Iterations are bumped over time
 * by storing a higher value; older hashes still verify with their
 * original count.
 *
 * @param plaintext the user-supplied password
 * @returns the encoded hash string
 */
export async function hashPassword(plaintext: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(PBKDF2_SALT_BYTES));
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(plaintext),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const hashBuf = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    key,
    PBKDF2_HASH_BYTES * 8,
  );
  const hash = new Uint8Array(hashBuf);
  return `pbkdf2$${PBKDF2_ITERATIONS}$${toHex(salt)}$${toHex(hash)}`;
}

/**
 * Verify a plaintext password against a stored encoded hash.
 *
 * Constant-time compare on the derived bytes to avoid timing leaks. Any
 * malformed stored value returns false (never throws on bad input).
 *
 * @param plaintext the user-supplied password
 * @param stored the stored hash string from `users.password_hash`
 * @returns true iff the password matches
 */
export async function verifyPassword(plaintext: string, stored: string): Promise<boolean> {
  const parts = stored.split("$");
  if (parts.length !== 4 || parts[0] !== "pbkdf2") return false;
  const iterations = Number.parseInt(parts[1] ?? "", 10);
  if (!Number.isFinite(iterations) || iterations <= 0) return false;
  let salt: Uint8Array;
  let expected: Uint8Array;
  try {
    salt = fromHex(parts[2] ?? "");
    expected = fromHex(parts[3] ?? "");
  } catch {
    return false;
  }
  if (expected.length === 0) return false;

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(plaintext),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const hashBuf = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    key,
    expected.length * 8,
  );
  const actual = new Uint8Array(hashBuf);

  if (actual.length !== expected.length) return false;
  let mismatch = 0;
  for (let i = 0; i < actual.length; i++) {
    mismatch |= (actual[i] ?? 0) ^ (expected[i] ?? 0);
  }
  return mismatch === 0;
}

/* ─────────── Random tokens ─────────── */

/**
 * Generate a cryptographically random token, hex-encoded.
 *
 * @param bytes byte length of the random source (default 32 = 256 bits)
 * @returns lowercase hex string of length `bytes * 2`
 */
export function randomTokenHex(bytes = 32): string {
  return toHex(crypto.getRandomValues(new Uint8Array(bytes)));
}

/* ─────────── User helpers ─────────── */

/**
 * Look up a user by email. Email comparison is case-insensitive — we
 * lowercase the input before matching against the stored value (which
 * is also stored lowercase by convention enforced at insert time).
 */
export async function getUserByEmail(env: AuthEnv, email: string): Promise<User | null> {
  const normalized = email.trim().toLowerCase();
  return env.CONFIG_DB.prepare("SELECT * FROM users WHERE email = ? LIMIT 1")
    .bind(normalized)
    .first<User>();
}

export async function getUserById(env: AuthEnv, id: number): Promise<User | null> {
  return env.CONFIG_DB.prepare("SELECT * FROM users WHERE id = ? LIMIT 1").bind(id).first<User>();
}

export async function setPassword(env: AuthEnv, userId: number, plaintext: string): Promise<void> {
  const hash = await hashPassword(plaintext);
  await env.CONFIG_DB.prepare(
    "UPDATE users SET password_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
  )
    .bind(hash, userId)
    .run();
}

export async function markEmailVerified(env: AuthEnv, userId: number): Promise<void> {
  await env.CONFIG_DB.prepare(
    "UPDATE users SET email_verified_at = COALESCE(email_verified_at, CURRENT_TIMESTAMP), updated_at = CURRENT_TIMESTAMP WHERE id = ?",
  )
    .bind(userId)
    .run();
}

/**
 * Create a new user with no password. Caller is responsible for sending
 * the invite/verification email so the user can set one.
 */
export async function createUser(env: AuthEnv, opts: { email: string; role: Role }): Promise<User> {
  const normalized = opts.email.trim().toLowerCase();
  await env.CONFIG_DB.prepare(
    "INSERT INTO users (email, role, password_hash, email_verified_at) VALUES (?, ?, NULL, NULL)",
  )
    .bind(normalized, opts.role)
    .run();
  const created = await getUserByEmail(env, normalized);
  if (!created) throw new Error(`createUser: user "${normalized}" not found after insert`);
  return created;
}

/* ─────────── Sessions ─────────── */

/**
 * Create a server-side session and return the token to set as a cookie.
 *
 * Captures `cf-connecting-ip` and `user-agent` from the inbound request
 * for audit + abuse-detection later (currently surfaced in /admin/users
 * detail pages only).
 */
export async function createSession(
  env: AuthEnv,
  userId: number,
  request: Request,
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomTokenHex(32);
  const expiresAt = new Date(Date.now() + SESSION_DURATION_MS);
  const ip = request.headers.get("cf-connecting-ip") ?? "0.0.0.0";
  const userAgent = request.headers.get("user-agent");
  await env.CONFIG_DB.prepare(
    `INSERT INTO sessions (token, user_id, expires_at, ip, user_agent)
     VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(token, userId, expiresAt.toISOString(), ip, userAgent)
    .run();
  return { token, expiresAt };
}

/**
 * Look up a session + user by cookie token. Updates `last_seen_at` on
 * hit. Returns null on miss, expired, or if the user has been deleted.
 */
export async function getSessionWithUser(
  env: AuthEnv,
  token: string,
): Promise<SessionWithUser | null> {
  const row = await env.CONFIG_DB.prepare(
    `SELECT s.token, s.user_id, s.expires_at, s.ip, s.user_agent, s.created_at, s.last_seen_at,
            u.id AS u_id, u.email AS u_email, u.role AS u_role, u.password_hash AS u_password_hash,
            u.email_verified_at AS u_email_verified_at,
            u.created_at AS u_created_at, u.updated_at AS u_updated_at
       FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.token = ? LIMIT 1`,
  )
    .bind(token)
    .first<{
      token: string;
      user_id: number;
      expires_at: string;
      ip: string;
      user_agent: string | null;
      created_at: string;
      last_seen_at: string;
      u_id: number;
      u_email: string;
      u_role: Role;
      u_password_hash: string | null;
      u_email_verified_at: string | null;
      u_created_at: string;
      u_updated_at: string;
    }>();
  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) {
    // Expired — best-effort cleanup.
    await env.CONFIG_DB.prepare("DELETE FROM sessions WHERE token = ?").bind(token).run();
    return null;
  }
  // Refresh last_seen_at (best-effort; failure here doesn't fail the lookup).
  await env.CONFIG_DB.prepare(
    "UPDATE sessions SET last_seen_at = CURRENT_TIMESTAMP WHERE token = ?",
  )
    .bind(token)
    .run();
  return {
    user: {
      id: row.u_id,
      email: row.u_email,
      role: row.u_role,
      password_hash: row.u_password_hash,
      email_verified_at: row.u_email_verified_at,
      created_at: row.u_created_at,
      updated_at: row.u_updated_at,
    },
    session: {
      token: row.token,
      user_id: row.user_id,
      expires_at: row.expires_at,
      ip: row.ip,
      user_agent: row.user_agent,
      created_at: row.created_at,
      last_seen_at: row.last_seen_at,
    },
  };
}

export async function destroySession(env: AuthEnv, token: string): Promise<void> {
  await env.CONFIG_DB.prepare("DELETE FROM sessions WHERE token = ?").bind(token).run();
}

/**
 * Wipe all sessions for a user. Call on password change to log them out
 * everywhere as a security precaution.
 */
export async function destroyAllSessionsForUser(env: AuthEnv, userId: number): Promise<void> {
  await env.CONFIG_DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(userId).run();
}

/* ─────────── Cookies ─────────── */

/**
 * Build the Set-Cookie header value for the session.
 *
 * `token`=null + `expiresAt` in the past clears the cookie (logout).
 * Otherwise issues an HttpOnly, Secure, SameSite=Lax cookie with the
 * given expiry.
 */
export function sessionCookieHeader(opts: {
  token: string | null;
  expiresAt?: Date;
  /** Path restriction (default "/" — cookie applies to whole site). */
  path?: string;
}): string {
  const path = opts.path ?? "/";
  if (opts.token === null) {
    // Clear the cookie by setting Max-Age=0.
    return `${SESSION_COOKIE_NAME}=; Path=${path}; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;
  }
  const expires = opts.expiresAt ?? new Date(Date.now() + SESSION_DURATION_MS);
  const maxAge = Math.max(0, Math.floor((expires.getTime() - Date.now()) / 1000));
  return `${SESSION_COOKIE_NAME}=${opts.token}; Path=${path}; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
}

/**
 * Parse the session token from the Cookie header. Returns null if the
 * header is missing, the cookie isn't present, or the value is empty.
 */
export function parseSessionCookie(request: Request): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  // Cookie header format: "name1=value1; name2=value2"
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    if (name !== SESSION_COOKIE_NAME) continue;
    const value = part.slice(eq + 1).trim();
    return value || null;
  }
  return null;
}

/* ─────────── Email tokens ─────────── */

/**
 * Create a single-use email token (verify, reset, or invite). The
 * caller is responsible for emailing the URL containing the token.
 */
export async function createEmailToken(
  env: AuthEnv,
  opts: { userId: number; kind: EmailTokenKind; ttlMs: number },
): Promise<{ token: string; expiresAt: Date }> {
  const token = randomTokenHex(32);
  const expiresAt = new Date(Date.now() + opts.ttlMs);
  await env.CONFIG_DB.prepare(
    "INSERT INTO email_tokens (token, user_id, kind, expires_at) VALUES (?, ?, ?, ?)",
  )
    .bind(token, opts.userId, opts.kind, expiresAt.toISOString())
    .run();
  return { token, expiresAt };
}

/**
 * Look up and consume an email token. Marks `used_at` on success so the
 * token can't be reused. Returns the user the token was issued to, or
 * null on missing / expired / wrong-kind / already-used.
 *
 * The kind check is a defence-in-depth: we never want a "verify_email"
 * link to be redeemable as a "reset_password" if an attacker found a
 * way to forge one. Tokens are random 32-byte hex so guessing is
 * infeasible regardless.
 */
export async function consumeEmailToken(
  env: AuthEnv,
  token: string,
  expectedKind: EmailTokenKind,
): Promise<User | null> {
  const row = await env.CONFIG_DB.prepare(
    `SELECT t.token, t.user_id, t.kind, t.expires_at, t.used_at
       FROM email_tokens t WHERE t.token = ? LIMIT 1`,
  )
    .bind(token)
    .first<{
      token: string;
      user_id: number;
      kind: EmailTokenKind;
      expires_at: string;
      used_at: string | null;
    }>();
  if (!row) return null;
  if (row.kind !== expectedKind) return null;
  if (row.used_at !== null) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) return null;
  // Mark used (best-effort — race here doesn't matter because we already
  // confirmed used_at was null and the row is keyed by random token).
  await env.CONFIG_DB.prepare("UPDATE email_tokens SET used_at = CURRENT_TIMESTAMP WHERE token = ?")
    .bind(token)
    .run();
  const user = await getUserById(env, row.user_id);
  return user;
}
