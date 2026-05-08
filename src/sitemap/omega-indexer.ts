/**
 * Omega Indexer integration.
 * Docs: https://www.omegaindexer.com/api-integration/
 *
 * Endpoint: POST https://www.omegaindexer.com/amember/dashboard/api
 * Content-Type: application/x-www-form-urlencoded (NOT JSON)
 *
 * Body fields:
 *   - apikey       — from the operator's Omega Indexer dashboard
 *   - campaignname — URL-encoded campaign name (shown in dashboard)
 *   - urls         — URLs separated by `|`, value URL-encoded
 *   - dripfeed     — number (Omega's docs example uses `2`; we
 *                    default to that since the docs page doesn't
 *                    enumerate the full set of values)
 *
 * No documented read-only endpoint (balance, verify) — submission IS
 * verification, like Sinbyte. The Test button does a real one-URL
 * submission against the operator's first proxied site.
 *
 * Best-effort: every helper here swallows network/HTTP errors and
 * logs. A failed submission shouldn't block an admin save.
 */

const OMEGA_ENDPOINT = "https://www.omegaindexer.com/amember/dashboard/api";

/**
 * No documented batch-size cap, but we chunk at 500 URLs to mirror
 * Prime + Sinbyte's pattern and keep request bodies sane.
 */
const MAX_URLS_PER_BATCH = 500;

/** Default dripfeed value, per the Omega API docs example. */
const DEFAULT_DRIPFEED = 2;

export interface OmegaSubmission {
  apikey: string;
  campaignname: string;
  urls: string[];
  dripfeed?: number;
}

/**
 * Build the form-encoded body Omega expects. URLSearchParams handles
 * the percent-encoding correctly: spaces → `+`, `:` → `%3A`,
 * `/` → `%2F`, `|` → `%7C`. The example in the API docs shows the
 * URL list joined with `|` then encoded as a single form field.
 */
function buildFormBody(submission: OmegaSubmission): string {
  const params = new URLSearchParams();
  params.set("apikey", submission.apikey);
  params.set("campaignname", submission.campaignname);
  params.set("urls", submission.urls.join("|"));
  params.set("dripfeed", String(submission.dripfeed ?? DEFAULT_DRIPFEED));
  return params.toString();
}

/**
 * Submit a single batch to Omega Indexer. Returns a structured
 * result; never throws. Caller chunks above MAX_URLS_PER_BATCH via
 * `pingOmegaIndexer`.
 *
 * Omega's response shape isn't documented — we treat any 2xx as
 * success and capture the response body on non-success so operators
 * can debug from the Test panel.
 */
export async function submitToOmegaIndexer(
  body: OmegaSubmission,
): Promise<{ ok: boolean; status: number; responseBody?: string }> {
  try {
    const resp = await fetch(OMEGA_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: buildFormBody(body),
    });
    const ok = resp.status >= 200 && resp.status < 300;
    if (!ok) {
      const text = await resp.text().catch(() => "");
      return { ok: false, status: resp.status, responseBody: text.slice(0, 2048) };
    }
    // Capture body on success too — Omega may return error text in a 200
    // (some indexers do). Surface to caller for inspection but don't fail.
    const text = await resp.text().catch(() => "");
    if (text.length > 0) {
      return { ok: true, status: resp.status, responseBody: text.slice(0, 2048) };
    }
    return { ok: true, status: resp.status };
  } catch (e) {
    console.warn("omega-indexer: submit failed", e);
    return { ok: false, status: 0 };
  }
}

/**
 * High-level convenience: submit a list of URLs to Omega Indexer,
 * chunking above MAX_URLS_PER_BATCH and creating one campaign per
 * chunk. No-op when key/urls are empty.
 *
 * Each chunk is named `${campaignName}` for chunks==1, or
 * `${campaignName} (n/total)` when chunked, so operators see related
 * chunks grouped in their Omega dashboard.
 */
export async function pingOmegaIndexer(
  key: string,
  urls: readonly string[],
  campaignName: string,
): Promise<{ submitted: number; ok: number; failed: number }> {
  if (key.length === 0 || urls.length === 0) {
    return { submitted: 0, ok: 0, failed: 0 };
  }
  const chunks: string[][] = [];
  for (let i = 0; i < urls.length; i += MAX_URLS_PER_BATCH) {
    chunks.push([...urls.slice(i, i + MAX_URLS_PER_BATCH)]);
  }
  let okCount = 0;
  let failed = 0;
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    if (!chunk) continue;
    const name = chunks.length === 1 ? campaignName : `${campaignName} (${i + 1}/${chunks.length})`;
    const result = await submitToOmegaIndexer({
      apikey: key,
      campaignname: name,
      urls: chunk,
    });
    if (result.ok) okCount += 1;
    else failed += 1;
  }
  return { submitted: chunks.length, ok: okCount, failed };
}
