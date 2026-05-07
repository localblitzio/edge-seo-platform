/**
 * Settings → API keys page.
 *
 * Surfaces the fixed set of secret slots (src/secrets/slots.ts) and
 * lets a super-admin set, clear, or test each one. Values are masked
 * on display; an empty submit clears the slot.
 *
 * Test flow: clicking Test posts the in-form value (NOT the saved
 * value) to a per-slot tester (src/secrets/tester.ts). The page
 * re-renders with a green/red result panel below the slot row so the
 * operator can verify before committing.
 *
 * Super-admin only — secrets are global (not per-site) and a regular
 * admin should not be able to rotate them.
 */

import type { AppEnv, FlashMessage } from "./app.js";
import { canSeeAllClients, esc } from "./app.js";
import type { User } from "./auth.js";

import { SECRET_SLOTS, type SecretSlot } from "../../src/secrets/slots.js";
import {
  type SecretRow,
  getAllSlotValues,
  listSecretRows,
  maskSecret,
  setSecret,
} from "../../src/secrets/store.js";
import {
  type TestResult,
  testGscServiceAccount,
  testIndexNowKey,
  testPrimeIndexerKey,
  testStubIndexerKey,
} from "../../src/secrets/tester.js";

export type SettingsEnv = AppEnv;

/**
 * Test result keyed by slot key — the post-handler stashes the result
 * here, then the renderer surfaces it below the matching row. We
 * don't persist the result anywhere durable; if the operator
 * navigates away the result vanishes (which is fine — it was a
 * transient diagnostic).
 */
export type TestResultsByKey = Partial<Record<string, TestResult>>;

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

function renderTestResult(result: TestResult): string {
  const detailsBlock = result.details
    ? `<details><summary>Details</summary><pre class="settings-test-details">${esc(result.details)}</pre></details>`
    : "";
  return `<div class="settings-test-result settings-test-${esc(result.kind)}" role="status">
    <strong>${result.kind === "ok" ? "✓" : result.kind === "warn" ? "!" : "✗"}</strong>
    <div class="settings-test-body">
      <p>${esc(result.message)}</p>
      ${detailsBlock}
    </div>
  </div>`;
}

function renderSlotRow(
  slot: SecretSlot,
  value: string | null,
  row: SecretRow | null,
  testResult: TestResult | undefined,
): string {
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
  const resultBlock = testResult ? renderTestResult(testResult) : "";
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
      <button type="submit" name="action" value="save" class="btn-primary">Save</button>
      <button type="submit" name="action" value="test" class="btn-secondary">Test</button>
      ${value !== null && row !== null ? '<button type="submit" name="action" value="clear" class="btn-secondary">Clear</button>' : ""}
    </div>
  </form>
  ${resultBlock}
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
.settings-test-result{margin-top:.85rem;padding:.7rem .9rem;border-radius:var(--radius);display:flex;gap:.7rem;align-items:flex-start;border:1px solid transparent}
.settings-test-result strong{font-size:1rem;line-height:1;flex:0 0 auto;width:1.4rem;height:1.4rem;display:inline-flex;align-items:center;justify-content:center;border-radius:50%;font-weight:700}
.settings-test-body{flex:1;min-width:0}
.settings-test-body p{margin:.05rem 0 .25rem;line-height:1.45;font-size:.92rem}
.settings-test-ok{background:var(--green-bg);border-color:var(--green);color:var(--green)}
.settings-test-ok strong{background:var(--green);color:#fff}
.settings-test-warn{background:var(--amber-bg);border-color:var(--amber);color:var(--amber)}
.settings-test-warn strong{background:var(--amber);color:#fff}
.settings-test-err{background:var(--red-bg);border-color:var(--red);color:var(--red)}
.settings-test-err strong{background:var(--red);color:#fff}
.settings-test-details{margin:.4rem 0 0;padding:.5rem;background:var(--bg);border-radius:var(--radius);font-size:.8rem;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap;color:var(--fg)}
.visually-hidden{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}
`;

/**
 * Render the Settings → API keys page body.
 *
 * Caller is responsible for wrapping in `appLayout`.
 *
 * @param testResults transient per-slot test outcomes from the most
 *   recent POST. Empty/undefined when the page was loaded directly.
 */
export async function renderSettingsApiKeysPage(
  env: SettingsEnv,
  testResults: TestResultsByKey = {},
): Promise<string> {
  const [values, rows] = await Promise.all([getAllSlotValues(env), listSecretRows(env)]);
  const rowsHtml = SECRET_SLOTS.map((slot) =>
    renderSlotRow(slot, values[slot.key] ?? null, findRow(rows, slot.key), testResults[slot.key]),
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
 * Pick a proxy_domain to use as the IndexNow test target. Strategy:
 * super-admins use any client (we just need a domain the worker
 * serves so the /<key>.txt verification file resolves); regular users
 * use one of their own clients. Returns null when no candidate exists.
 */
async function pickIndexNowTestHost(env: SettingsEnv, user: User): Promise<string | null> {
  const sql = canSeeAllClients(user)
    ? "SELECT proxy_domain FROM clients WHERE status = 'active' ORDER BY client_id LIMIT 1"
    : "SELECT proxy_domain FROM clients WHERE status = 'active' AND owner_id = ? ORDER BY client_id LIMIT 1";
  const stmt = env.CONFIG_DB.prepare(sql);
  const bound = canSeeAllClients(user) ? stmt : stmt.bind(user.id);
  const row = await bound.first<{ proxy_domain: string }>();
  return row?.proxy_domain ?? null;
}

/**
 * Result of a POST that the route handler can either redirect (save /
 * clear) or render inline (test). The route layer in `index.ts`
 * branches on which field is set.
 */
export interface SettingsPostOutcome {
  /** Set when the action was save/clear and we should 303 to the page. */
  redirect?: Response;
  /** Set when action=test — caller should re-render the page with these inline results. */
  testResults?: TestResultsByKey;
}

/**
 * Handle the form POST. Branches on `action`:
 *   - "save" (default) → setSecret, redirect with flash
 *   - "clear"          → setSecret with empty value (= delete), redirect
 *   - "test"           → run the per-slot tester, return result for inline render
 */
export async function handleSettingsApiKeysPost(
  request: Request,
  env: SettingsEnv,
  user: User,
): Promise<SettingsPostOutcome> {
  const form = await request.formData();
  const key = String(form.get("key") ?? "");
  const action = String(form.get("action") ?? "save");
  const value = String(form.get("value") ?? "");

  if (action === "test") {
    const result = await runTest(env, user, key, value);
    return { testResults: { [key]: result } };
  }

  const persistValue = action === "clear" ? "" : value;
  const setResult = await setSecret(env, key, persistValue, user.email);
  if (!setResult.ok) {
    return {
      redirect: flashRedirect("/app/settings/api-keys", { text: setResult.error, kind: "err" }),
    };
  }
  const text = persistValue.trim().length === 0 ? `Cleared ${key}.` : `Updated ${key}.`;
  return { redirect: flashRedirect("/app/settings/api-keys", { text, kind: "ok" }) };
}

/**
 * Dispatch table — given a slot key + form value, run the matching
 * tester. Unknown keys return a generic error.
 */
async function runTest(
  env: SettingsEnv,
  user: User,
  key: string,
  value: string,
): Promise<TestResult> {
  switch (key) {
    case "INDEXNOW_KEY": {
      const host = await pickIndexNowTestHost(env, user);
      return testIndexNowKey(value, host ?? "");
    }
    case "GSC_SERVICE_ACCOUNT_JSON":
      return testGscServiceAccount(value);
    case "OMEGA_INDEXER_KEY":
      return testStubIndexerKey(value, "Omega Indexer");
    case "SINBYTE_API_KEY":
      return testStubIndexerKey(value, "Sinbyte");
    case "PRIME_INDEXER_KEY":
      return testPrimeIndexerKey(value);
    default:
      return { kind: "err", message: `No tester defined for slot "${key}".` };
  }
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
