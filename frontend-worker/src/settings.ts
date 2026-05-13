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
  getSecret,
  listSecretRows,
  maskSecret,
  setSecret,
} from "../../src/secrets/store.js";
import {
  type TestResult,
  testDataForSeoCredentials,
  testGscServiceAccount,
  testIndexNowKey,
  testOmegaIndexerKey,
  testPrimeIndexerKey,
  testSinbyteKey,
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
  const reveal =
    value !== null && value.length > 0
      ? `<details class="reveal"><summary>Show</summary><code class="mono reveal-value">${esc(value)}</code></details>`
      : "";
  const inputField =
    inputType === "textarea"
      ? `<textarea id="${esc(fieldId)}" name="value" rows="6" placeholder="Paste new value to update; leave blank to test/clear saved" autocomplete="off"></textarea>`
      : `<input id="${esc(fieldId)}" type="password" name="value" placeholder="Paste new value to update; leave blank to test/clear saved" autocomplete="off">`;
  const resultBlock = testResult ? renderTestResult(testResult) : "";
  return `<section class="section settings-slot">
  <header class="settings-slot-header">
    <h3>${esc(slot.label)}</h3>
    ${docsLink}
  </header>
  <p class="settings-slot-desc">${esc(slot.description)}</p>
  <div class="settings-slot-current"><strong>Current:</strong> <code class="mono">${masked}</code> ${reveal}</div>
  ${meta}
  <form method="post" action="/app/settings/api-keys" class="settings-slot-form">
    <input type="hidden" name="key" value="${esc(slot.key)}">
    <label for="${esc(fieldId)}" class="visually-hidden">${esc(slot.label)}</label>
    ${inputField}
    <p class="settings-test-hint">Tip: leave the field blank and click Test to verify the saved value.</p>
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
.settings-slot input[type=password],.settings-slot input[type=text],.settings-slot textarea{width:100%;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.85rem;padding:.5rem;border:1px solid var(--border);border-radius:var(--radius);background:var(--bg);margin-bottom:.4rem}
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
.settings-slot .reveal{display:inline}
.settings-slot .reveal>summary{display:inline-block;cursor:pointer;font-size:.75rem;color:var(--fg-muted);margin-left:.4rem;user-select:none}
.settings-slot .reveal>summary:hover{color:var(--fg)}
.settings-slot .reveal[open]>summary{color:var(--fg)}
.settings-slot .reveal-value{display:inline-block;margin-left:.4rem;padding:.1rem .35rem;background:var(--bg-elevated,var(--bg));border:1px dashed var(--border);border-radius:var(--radius);font-size:.8rem;word-break:break-all}
.settings-test-hint{margin:.35rem 0 .55rem;color:var(--fg-muted);font-size:.78rem}
`;

/**
 * Render the Settings → API keys page body.
 *
 * Caller is responsible for wrapping in `appLayout`.
 *
 * @param testResults transient per-slot test outcomes from the most
 *   recent POST. Empty/undefined when the page was loaded directly.
 */
/**
 * Slot keys grouped into the DataForSEO credential pair card. These
 * are NOT rendered as individual rows — they share a single form
 * with one Save (persists both) and one Test (verifies as a combo
 * directly from form values, no save-first required).
 */
const DATAFORSEO_PAIR_KEYS = new Set(["DATAFORSEO_LOGIN", "DATAFORSEO_PASSWORD"]);

/** Sentinel value posted in the `pair` field for the DataForSEO card. */
const DATAFORSEO_PAIR = "DATAFORSEO";

function renderDataForSeoPairCard(
  loginValue: string | null,
  passwordValue: string | null,
  loginRow: SecretRow | null,
  passwordRow: SecretRow | null,
  testResult: TestResult | undefined,
): string {
  const maskedLogin = esc(maskSecret(loginValue));
  const maskedPassword = esc(maskSecret(passwordValue));
  const revealLogin =
    loginValue && loginValue.length > 0
      ? `<details class="reveal"><summary>Show</summary><code class="mono reveal-value">${esc(loginValue)}</code></details>`
      : "";
  const revealPassword =
    passwordValue && passwordValue.length > 0
      ? `<details class="reveal"><summary>Show</summary><code class="mono reveal-value">${esc(passwordValue)}</code></details>`
      : "";
  const lastUpdated =
    loginRow || passwordRow
      ? `<div class="meta">Last updated ${esc(
          formatTimestamp(Math.max(loginRow?.updated_at ?? 0, passwordRow?.updated_at ?? 0)),
        )}${
          (loginRow?.updated_by_email ?? passwordRow?.updated_by_email)
            ? ` by ${esc(loginRow?.updated_by_email ?? passwordRow?.updated_by_email ?? "")}`
            : ""
        }</div>`
      : `<div class="meta">Not set.</div>`;
  const resultBlock = testResult ? renderTestResult(testResult) : "";
  return `<section class="section settings-slot">
  <header class="settings-slot-header">
    <h3>DataForSEO credentials</h3>
    <a href="https://docs.dataforseo.com/v3/auth/" target="_blank" rel="noopener noreferrer">Docs ↗</a>
  </header>
  <p class="settings-slot-desc">Login + API password used together (HTTP Basic auth). Both required for the Create-from-SERP flow. Get the API password from app.dataforseo.com → API Dashboard — it's separate from your account login password.</p>
  <div class="settings-slot-current">
    <div><strong>Login:</strong> <code class="mono">${maskedLogin}</code> ${revealLogin}</div>
    <div><strong>API password:</strong> <code class="mono">${maskedPassword}</code> ${revealPassword}</div>
  </div>
  ${lastUpdated}
  <form method="post" action="/app/settings/api-keys" class="settings-slot-form">
    <input type="hidden" name="pair" value="${DATAFORSEO_PAIR}">
    <label for="dataforseo-login" class="visually-hidden">DataForSEO login</label>
    <input id="dataforseo-login" name="login" type="text" placeholder="DataForSEO login (email) — leave blank to keep saved" autocomplete="off">
    <label for="dataforseo-password" class="visually-hidden">DataForSEO API password</label>
    <input id="dataforseo-password" name="password" type="password" placeholder="DataForSEO API password — leave blank to keep saved" autocomplete="off">
    <p class="settings-test-hint">Tip: leave both fields blank and click Test to verify the saved credentials.</p>
    <div class="form-actions">
      <button type="submit" name="action" value="save_pair" class="btn-primary">Save both</button>
      <button type="submit" name="action" value="test_pair" class="btn-secondary">Test</button>
      ${loginValue !== null || passwordValue !== null ? '<button type="submit" name="action" value="clear_pair" class="btn-secondary">Clear both</button>' : ""}
    </div>
  </form>
  ${resultBlock}
</section>`;
}

export async function renderSettingsApiKeysPage(
  env: SettingsEnv,
  testResults: TestResultsByKey = {},
): Promise<string> {
  const [values, rows] = await Promise.all([getAllSlotValues(env), listSecretRows(env)]);
  // Render non-paired slots one per card; render DataForSEO as a
  // single combined card after the regular slots.
  const regularSlots = SECRET_SLOTS.filter((s) => !DATAFORSEO_PAIR_KEYS.has(s.key));
  const rowsHtml = regularSlots
    .map((slot) =>
      renderSlotRow(slot, values[slot.key] ?? null, findRow(rows, slot.key), testResults[slot.key]),
    )
    .join("");
  const dataForSeoCard = renderDataForSeoPairCard(
    values.DATAFORSEO_LOGIN ?? null,
    values.DATAFORSEO_PASSWORD ?? null,
    findRow(rows, "DATAFORSEO_LOGIN"),
    findRow(rows, "DATAFORSEO_PASSWORD"),
    // Either key's test result surfaces on the combined card.
    testResults.DATAFORSEO_LOGIN ?? testResults.DATAFORSEO_PASSWORD,
  );
  return `<style>${SETTINGS_CSS}</style>
<header class="page-header">
  <h2>API keys</h2>
  <p style="color:var(--fg-muted);margin:.25rem 0 1.25rem;max-width:60ch">
    Operator-managed credentials for every external service this platform talks to.
    Values are stored in D1 (table <code>secrets</code>) and cached in KV; the proxy worker reads
    them at request time. Setting a value here overrides any equivalent <code>wrangler secret put</code>-bound value on next request.
  </p>
</header>
${rowsHtml}
${dataForSeoCard}`;
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
  const pair = String(form.get("pair") ?? "");
  const action = String(form.get("action") ?? "save");

  // DataForSEO combined-card actions: one form with `login` +
  // `password` fields, no per-row save needed.
  if (pair === DATAFORSEO_PAIR) {
    return handleDataForSeoPairPost(env, user, action, form);
  }

  const key = String(form.get("key") ?? "");
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
 * Combined DataForSEO credential pair handler.
 *
 *   - `save_pair`  → persist both `login` and `password` form fields
 *                    (only the ones with non-empty values; blanks are
 *                    skipped so a partial update doesn't blow away
 *                    the half the operator didn't retype).
 *   - `test_pair`  → call `testDataForSeoCredentials` directly with
 *                    the form values, no save required. Falls back to
 *                    the stored value when a field is blank so a half-
 *                    update can still be verified.
 *   - `clear_pair` → wipe both slots in one shot.
 */
async function handleDataForSeoPairPost(
  env: SettingsEnv,
  user: User,
  action: string,
  form: FormData,
): Promise<SettingsPostOutcome> {
  const login = String(form.get("login") ?? "");
  const password = String(form.get("password") ?? "");

  if (action === "test_pair") {
    // Fall back to saved values when a field is blank — lets the
    // operator test "just changed the password" without retyping
    // the login.
    const effectiveLogin =
      login.trim().length > 0 ? login : ((await getSecret(env, "DATAFORSEO_LOGIN")) ?? "");
    const effectivePassword =
      password.trim().length > 0 ? password : ((await getSecret(env, "DATAFORSEO_PASSWORD")) ?? "");
    const result = await testDataForSeoCredentials(effectiveLogin, effectivePassword);
    // Surface the result under whichever key the renderer picks up
    // first (login). The renderer checks both keys.
    return { testResults: { DATAFORSEO_LOGIN: result } };
  }

  if (action === "clear_pair") {
    await Promise.all([
      setSecret(env, "DATAFORSEO_LOGIN", "", user.email),
      setSecret(env, "DATAFORSEO_PASSWORD", "", user.email),
    ]);
    return {
      redirect: flashRedirect("/app/settings/api-keys", {
        text: "Cleared DataForSEO credentials.",
        kind: "ok",
      }),
    };
  }

  // Default: save_pair — persist whichever fields the operator typed
  // a value into. Skip blanks so a partial update is non-destructive.
  const updates: Array<{ key: string; value: string }> = [];
  if (login.trim().length > 0) updates.push({ key: "DATAFORSEO_LOGIN", value: login });
  if (password.trim().length > 0) updates.push({ key: "DATAFORSEO_PASSWORD", value: password });
  if (updates.length === 0) {
    return {
      redirect: flashRedirect("/app/settings/api-keys", {
        text: "Nothing to save — paste a login and/or API password first.",
        kind: "warn",
      }),
    };
  }
  for (const u of updates) {
    const r = await setSecret(env, u.key, u.value, user.email);
    if (!r.ok) {
      return {
        redirect: flashRedirect("/app/settings/api-keys", { text: r.error, kind: "err" }),
      };
    }
  }
  const labels = updates.map((u) => (u.key === "DATAFORSEO_LOGIN" ? "login" : "password"));
  return {
    redirect: flashRedirect("/app/settings/api-keys", {
      text: `Updated DataForSEO ${labels.join(" + ")}.`,
      kind: "ok",
    }),
  };
}

/**
 * Resolve the value to test: if the form value is non-empty use it,
 * otherwise fall back to the saved secret value. Lets the operator
 * leave the input blank and click Test to verify what's stored.
 */
async function effectiveTestValue(
  env: SettingsEnv,
  key: string,
  formValue: string,
): Promise<string> {
  if (formValue.trim().length > 0) return formValue;
  return (await getSecret(env, key)) ?? "";
}

/**
 * Dispatch table — given a slot key + form value, run the matching
 * tester. When the form value is blank, falls back to the saved
 * value so "Test" verifies the stored secret.
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
      const v = await effectiveTestValue(env, key, value);
      return testIndexNowKey(v, host ?? "");
    }
    case "GSC_SERVICE_ACCOUNT_JSON": {
      const v = await effectiveTestValue(env, key, value);
      return testGscServiceAccount(v);
    }
    case "OMEGA_INDEXER_KEY": {
      const host = await pickIndexNowTestHost(env, user);
      const v = await effectiveTestValue(env, key, value);
      return testOmegaIndexerKey(v, host ?? "");
    }
    case "SINBYTE_API_KEY": {
      const host = await pickIndexNowTestHost(env, user);
      const v = await effectiveTestValue(env, key, value);
      return testSinbyteKey(v, host ?? "");
    }
    case "PRIME_INDEXER_KEY": {
      const v = await effectiveTestValue(env, key, value);
      return testPrimeIndexerKey(v);
    }
    case "DATAFORSEO_LOGIN": {
      // Pair the form value with the saved password. Operator must
      // save the password first if they're updating both — the form
      // only POSTs the single tested row's value.
      const effLogin = await effectiveTestValue(env, "DATAFORSEO_LOGIN", value);
      const savedPassword = (await getSecret(env, "DATAFORSEO_PASSWORD")) ?? "";
      return testDataForSeoCredentials(effLogin, savedPassword);
    }
    case "DATAFORSEO_PASSWORD": {
      const savedLogin = (await getSecret(env, "DATAFORSEO_LOGIN")) ?? "";
      const effPassword = await effectiveTestValue(env, "DATAFORSEO_PASSWORD", value);
      return testDataForSeoCredentials(savedLogin, effPassword);
    }
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
