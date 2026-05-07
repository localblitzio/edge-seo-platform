/**
 * Settings → API keys page.
 *
 * Surfaces the fixed set of secret slots (src/secrets/slots.ts) and
 * lets a super-admin set or clear each one. Values are masked on
 * display; an empty submit clears the slot.
 *
 * Super-admin only — secrets are global (not per-site) and a regular
 * admin should not be able to rotate them.
 */

import type { AppEnv, FlashMessage } from "./app.js";
import { esc } from "./app.js";
import type { User } from "./auth.js";

import { SECRET_SLOTS, type SecretSlot } from "../../src/secrets/slots.js";
import {
  type SecretRow,
  getAllSlotValues,
  listSecretRows,
  maskSecret,
  setSecret,
} from "../../src/secrets/store.js";

export type SettingsEnv = AppEnv;

/**
 * Format a Unix-millis timestamp the way the rest of the admin UI
 * shows times — local-style ISO (YYYY-MM-DD HH:MM:SS UTC).
 */
function formatTimestamp(ms: number): string {
  return new Date(ms)
    .toISOString()
    .replace("T", " ")
    .replace(/\.\d{3}Z$/, " UTC");
}

/**
 * Look up the row metadata (updated_at, updated_by_email) for a given
 * slot key from a pre-loaded list. Returns null when no row exists
 * (slot is unset or value comes from env-fallback).
 */
function findRow(rows: SecretRow[], key: string): SecretRow | null {
  return rows.find((r) => r.key === key) ?? null;
}

function renderSlotRow(slot: SecretSlot, value: string | null, row: SecretRow | null): string {
  const inputType = slot.multiline ? "textarea" : "password";
  const fieldId = `slot-${slot.key}`;
  const meta = row
    ? `<div class="meta">Last updated ${esc(formatTimestamp(row.updated_at))}${
        row.updated_by_email ? ` by ${esc(row.updated_by_email)}` : ""
      }</div>`
    : value !== null
      ? `<div class="meta">Bound via legacy <code>wrangler secret put ${esc(slot.key)}</code> — paste here to migrate.</div>`
      : `<div class="meta">Not set.</div>`;
  const docsLink = slot.docs_url
    ? `<a href="${esc(slot.docs_url)}" target="_blank" rel="noopener noreferrer">Docs ↗</a>`
    : "";
  const masked = esc(maskSecret(value));
  const inputField =
    inputType === "textarea"
      ? `<textarea id="${esc(fieldId)}" name="value" rows="6" placeholder="Paste new value to update; leave blank to clear" autocomplete="off"></textarea>`
      : `<input id="${esc(fieldId)}" type="password" name="value" placeholder="Paste new value to update; leave blank to clear" autocomplete="off">`;
  return `<section class="section settings-slot">
  <header class="settings-slot-header">
    <h3>${esc(slot.label)}</h3>
    ${docsLink}
  </header>
  <p class="settings-slot-desc">${esc(slot.description)}</p>
  <div class="settings-slot-current"><strong>Current:</strong> <code class="mono">${masked}</code></div>
  ${meta}
  <form method="post" action="/app/settings/api-keys" class="settings-slot-form">
    <input type="hidden" name="key" value="${esc(slot.key)}">
    <label for="${esc(fieldId)}" class="visually-hidden">${esc(slot.label)}</label>
    ${inputField}
    <div class="form-actions">
      <button type="submit" class="btn-primary">Save</button>
      ${value !== null && row !== null ? '<button type="submit" name="action" value="clear" class="btn-secondary">Clear</button>' : ""}
    </div>
  </form>
</section>`;
}

const SETTINGS_CSS = `
.settings-slot{margin-bottom:1.5rem}
.settings-slot-header{display:flex;align-items:baseline;justify-content:space-between;gap:1rem}
.settings-slot-header h3{margin:0;font-size:1rem}
.settings-slot-desc{color:var(--fg-muted);margin:.35rem 0 .75rem;font-size:.9rem}
.settings-slot-current{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.85rem;margin-bottom:.25rem}
.settings-slot .meta{color:var(--fg-muted);font-size:.78rem;margin-bottom:.6rem}
.settings-slot input[type=password],.settings-slot textarea{width:100%;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.85rem;padding:.5rem;border:1px solid var(--border);border-radius:var(--radius);background:var(--bg)}
.settings-slot textarea{resize:vertical}
.settings-slot .form-actions{margin-top:.5rem;display:flex;gap:.5rem}
.visually-hidden{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
`;

/**
 * Render the Settings → API keys page body.
 *
 * Caller is responsible for wrapping in `appLayout`.
 */
export async function renderSettingsApiKeysPage(env: SettingsEnv): Promise<string> {
  const [values, rows] = await Promise.all([getAllSlotValues(env), listSecretRows(env)]);
  const rowsHtml = SECRET_SLOTS.map((slot) =>
    renderSlotRow(slot, values[slot.key] ?? null, findRow(rows, slot.key)),
  ).join("");
  return `<style>${SETTINGS_CSS}</style>
<header class="page-header">
  <h2>API keys</h2>
  <p style="color:var(--fg-muted);margin:.25rem 0 1.25rem;max-width:60ch">
    Operator-managed credentials for every external service this platform talks to.
    Values are stored in D1 (table <code>secrets</code>) and cached in KV; the proxy worker reads
    them at request time. Setting a value here overrides any equivalent <code>wrangler secret put</code>-bound value on next request.
  </p>
</header>
${rowsHtml}`;
}

/**
 * Handle the form POST. One handler covers both "save" (value present
 * → setSecret) and "clear" (action=clear or empty value → setSecret
 * with empty string, which the store treats as a delete).
 *
 * Returns a flash redirect — rendering of the updated page is handled
 * by the next GET.
 */
export async function handleSettingsApiKeysPost(
  request: Request,
  env: SettingsEnv,
  user: User,
): Promise<Response> {
  const form = await request.formData();
  const key = String(form.get("key") ?? "");
  const action = String(form.get("action") ?? "");
  const value = action === "clear" ? "" : String(form.get("value") ?? "");
  const result = await setSecret(env, key, value, user.email);
  if (!result.ok) {
    return flashRedirect("/app/settings/api-keys", { text: result.error, kind: "err" });
  }
  const text = value.trim().length === 0 ? `Cleared ${key}.` : `Updated ${key}.`;
  return flashRedirect("/app/settings/api-keys", { text, kind: "ok" });
}

/**
 * Local copy of the flash-redirect helper so this module doesn't have
 * to re-export a private function from app.ts. Same shape.
 */
function flashRedirect(location: string, flash: FlashMessage): Response {
  const sep = location.includes("?") ? "&" : "?";
  const target = `${location}${sep}flash=${encodeURIComponent(flash.text)}&flash_kind=${flash.kind}`;
  return new Response(null, { status: 303, headers: { location: target } });
}
