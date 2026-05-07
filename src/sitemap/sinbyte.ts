/**
 * Sinbyte indexing service integration.
 * Reverse-engineered from the Sinbyte WordPress plugin
 * (https://wordpress.org/plugins/sinbyte-indexer/) — Sinbyte doesn't
 * publish a formal API reference page; the plugin source is the
 * canonical spec.
 *
 * Auth: API key carried in the JSON body (not a header), found at
 * https://app.sinbyte.com/quick-indexing/ on a Basic plan or above.
 *
 * Endpoint: POST https://app.sinbyte.com/api/indexing/
 *
 * Method choice:
 *   - "tools" (our default) — for backlinks/PBN/tier links. No GSC
 *     verification required. Works for any URL.
 *   - "money_site" — requires adding
 *     `sinbyte@sinbyte.iam.gserviceaccount.com` as an Owner in
 *     Google Search Console for the proxy domain. Sinbyte claims
 *     70–80% indexing in 1–3 days for verified domains.
 *
 * The platform uses "tools" since it's the no-friction default. To
 * use "money_site", an operator would need a per-site GSC ownership
 * claim — that's a separate workflow we may add later.
 *
 * Best-effort: every helper here swallows network/HTTP errors and
 * logs. A failed submission shouldn't block an admin save.
 */

const SINBYTE_ENDPOINT = "https://app.sinbyte.com/api/indexing/";

/**
 * No documented batch-size cap, but we chunk at 500 URLs to mirror
 * Prime Indexer's pattern and avoid posting absurdly large bodies.
 */
const MAX_URLS_PER_BATCH = 500;

export type SinbyteMethod = "tools" | "money_site";

export interface SinbyteSubmission {
  apikey: string;
  name: string;
  /** 1 enables drip-feed submission (spreads over hours rather than instant). */
  dripfeed: 0 | 1;
  method: SinbyteMethod;
  urls: string[];
}

/**
 * Submit a single batch to Sinbyte. Returns a structured result;
 * never throws. Caller chunks above MAX_URLS_PER_BATCH via
 * `pingSinbyte`.
 *
 * Sinbyte returns `{ "status": "ok" }` on success. Anything else is
 * treated as a failure and the response body is captured for
 * debugging.
 */
export async function submitToSinbyte(
  body: SinbyteSubmission,
): Promise<{ ok: boolean; status: number; responseBody?: string }> {
  try {
    const resp = await fetch(SINBYTE_ENDPOINT, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
    });
    if (resp.status !== 200) {
      const text = await resp.text().catch(() => "");
      return { ok: false, status: resp.status, responseBody: text.slice(0, 2048) };
    }
    const text = await resp.text();
    let parsed: { status?: string };
    try {
      parsed = JSON.parse(text) as { status?: string };
    } catch {
      return { ok: false, status: 200, responseBody: text.slice(0, 2048) };
    }
    if (parsed.status === "ok") return { ok: true, status: 200 };
    return { ok: false, status: 200, responseBody: text.slice(0, 2048) };
  } catch (e) {
    console.warn("sinbyte: submit failed", e);
    return { ok: false, status: 0 };
  }
}

/**
 * High-level convenience: submit a list of URLs to Sinbyte, chunking
 * above MAX_URLS_PER_BATCH and creating one batch per chunk. No-op
 * when key/urls are empty.
 *
 * Each chunk is named `${batchName}` for chunks==1, or
 * `${batchName} (n/total)` when chunked.
 */
export async function pingSinbyte(
  key: string,
  urls: readonly string[],
  batchName: string,
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
    const name = chunks.length === 1 ? batchName : `${batchName} (${i + 1}/${chunks.length})`;
    const result = await submitToSinbyte({
      apikey: key,
      name,
      dripfeed: 1,
      method: "tools",
      urls: chunk,
    });
    if (result.ok) okCount += 1;
    else failed += 1;
  }
  return { submitted: chunks.length, ok: okCount, failed };
}
