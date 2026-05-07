/**
 * Operator-managed secret store.
 *
 * Read path (used by both proxy worker + admin frontend):
 *   1. KV `secret:<KEY>` — primary cache (60s write-through TTL)
 *   2. D1 `secrets` table — source of truth
 *   3. `env[KEY]` — legacy fallback for keys still set via
 *      `wrangler secret put`. This exists so a redeploy doesn't break
 *      IndexNow until the operator pastes the value into the new UI.
 *
 * Write path (admin only):
 *   - `setSecret` does D1 UPSERT then KV write — KV is authoritative
 *     after the write, no purge required because we overwrite the
 *     same key with the new value.
 *   - `deleteSecret` does D1 DELETE then KV DELETE.
 *
 * No encryption-at-rest yet. The same admin session can already read
 * any D1 row, so adding an envelope-encryption layer here doesn't
 * narrow the attack surface — it would only protect against a stolen
 * D1 backup, which is a separate concern handled at the Cloudflare
 * platform level.
 */

import type { Env } from "../env.js";
import { SECRET_SLOT_KEYS } from "./slots.js";

const KV_TTL_SECONDS = 60;

/** Shape of a row in the `secrets` table. */
export interface SecretRow {
  key: string;
  value: string;
  updated_at: number;
  updated_by_email: string | null;
}

/**
 * Read a secret by key.
 *
 * Returns the value or null when the key is unset across all three
 * tiers (KV, D1, env). Caller decides what "unset" means — for
 * IndexNow it means "skip the ping"; for GSC it means "feature off".
 */
export async function getSecret(env: Env, key: string): Promise<string | null> {
  const kvHit = await env.CONFIG_KV.get(`secret:${key}`);
  if (kvHit !== null) return kvHit;

  // D1 read is wrapped in try/catch so a transient D1 error or a
  // not-yet-applied migration (table missing during the
  // deploy-then-migrate window) doesn't break the env fallback that
  // would otherwise satisfy this lookup.
  try {
    const row = await env.CONFIG_DB.prepare("SELECT value FROM secrets WHERE key = ?")
      .bind(key)
      .first<{ value: string }>();
    if (row !== null) {
      await env.CONFIG_KV.put(`secret:${key}`, row.value, { expirationTtl: KV_TTL_SECONDS });
      return row.value;
    }
  } catch (e) {
    console.warn(`secrets: D1 read failed for ${key}, falling back to env`, e);
  }

  // Legacy fallback: env-bound Worker secret. Bridges the transition
  // from `wrangler secret put` to the D1-backed store.
  const envValue = (env as unknown as Record<string, unknown>)[key];
  if (typeof envValue === "string" && envValue.length > 0) return envValue;

  return null;
}

/**
 * Read every known slot's current value. Used by the Settings page to
 * render the "currently set / unset" state for each slot.
 *
 * Note: returned values include the actual secret text. Callers that
 * render to HTML must mask before display (see `maskSecret`).
 */
export async function getAllSlotValues(env: Env): Promise<Record<string, string | null>> {
  const out: Record<string, string | null> = {};
  for (const key of SECRET_SLOT_KEYS) {
    out[key] = await getSecret(env, key);
  }
  return out;
}

/**
 * Write a secret value. Validates the key is a known slot — unknown
 * keys are rejected so the table doesn't accumulate orphan rows from
 * a typo in a future caller.
 *
 * `value` is trimmed; an empty result is treated as a delete.
 */
export async function setSecret(
  env: Env,
  key: string,
  value: string,
  updatedByEmail: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  if (!SECRET_SLOT_KEYS.has(key)) {
    return { ok: false, error: `Unknown secret key: ${key}` };
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    await deleteSecret(env, key);
    return { ok: true };
  }
  const now = Date.now();
  await env.CONFIG_DB.prepare(
    `INSERT INTO secrets (key, value, updated_at, updated_by_email)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET
       value = excluded.value,
       updated_at = excluded.updated_at,
       updated_by_email = excluded.updated_by_email`,
  )
    .bind(key, trimmed, now, updatedByEmail)
    .run();
  await env.CONFIG_KV.put(`secret:${key}`, trimmed, { expirationTtl: KV_TTL_SECONDS });
  return { ok: true };
}

/**
 * Delete a secret. Idempotent — deleting an unset key is a no-op.
 * After this returns, `getSecret` may still return the env-fallback
 * value (legacy Worker secret) if one is bound; that's intentional —
 * deleting from the UI shouldn't silently break IndexNow if the
 * operator hasn't also unset the legacy secret.
 */
export async function deleteSecret(env: Env, key: string): Promise<void> {
  await env.CONFIG_DB.prepare("DELETE FROM secrets WHERE key = ?").bind(key).run();
  await env.CONFIG_KV.delete(`secret:${key}`);
}

/**
 * Mask a secret for display. Shows last 4 chars when long enough,
 * otherwise full mask. Empty/null → "(not set)".
 */
export function maskSecret(value: string | null): string {
  if (value === null || value.length === 0) return "(not set)";
  if (value.length <= 8) return "•".repeat(value.length);
  return `${"•".repeat(value.length - 4)}${value.slice(-4)}`;
}

/**
 * Read every secrets-table row (NOT including KV cache or env
 * fallback). Used by the Settings page to surface `updated_at` and
 * `updated_by_email` metadata alongside slot values.
 */
export async function listSecretRows(env: Env): Promise<SecretRow[]> {
  const r = await env.CONFIG_DB.prepare(
    "SELECT key, value, updated_at, updated_by_email FROM secrets ORDER BY key",
  ).all<SecretRow>();
  return r.results ?? [];
}
