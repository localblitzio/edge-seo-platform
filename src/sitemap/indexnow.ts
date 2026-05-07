/**
 * IndexNow auto-pinger.
 * Spec: docs/prd.md §7.7.
 *
 * IndexNow (https://www.indexnow.org/) is a protocol for telling search
 * engines that a URL has changed. One POST request notifies Bing,
 * Yandex, Seznam, and any other participating engine. Google has not
 * adopted IndexNow — GSC integration is a separate (deferred) module.
 *
 * Verification model: the search engines fetch
 * `https://<host>/<key>.txt` and expect the response body to equal the
 * key string. The proxy worker handles this special-case route in
 * `src/worker.ts` so every proxy domain is automatically verified
 * without per-domain DNS or content uploads — the operator just needs
 * to set the `INDEXNOW_KEY` worker secret.
 *
 * Hook points (admin write paths):
 *   - per-page editor save (text/meta/canonicals/etc rule edited or
 *     added on a literal path)
 *   - placement create/edit/delete (cluster cross-link, link-project)
 *   - custom-page create/edit/delete
 *
 * Best-effort: every helper here swallows network/HTTP errors and logs.
 * IndexNow is fire-and-forget; a failed ping isn't worth blocking an
 * admin save on.
 */

const INDEXNOW_ENDPOINT = "https://api.indexnow.org/indexnow";

/**
 * Body schema for the IndexNow POST per
 * https://www.indexnow.org/documentation. Up to 10,000 URLs per
 * submission. We chunk above MAX_URLS_PER_REQUEST.
 */
export interface IndexNowSubmission {
  host: string;
  key: string;
  keyLocation: string;
  urlList: string[];
}

const MAX_URLS_PER_REQUEST = 10_000;

/**
 * Build an IndexNow submission body for a list of full URLs on a single
 * host. Caller is responsible for ensuring all URLs share the same
 * host as the supplied `host` argument — IndexNow rejects cross-host
 * submissions in a single body.
 *
 * Returns one submission body per chunk of MAX_URLS_PER_REQUEST.
 */
export function buildSubmissions(
  host: string,
  key: string,
  urls: readonly string[],
): IndexNowSubmission[] {
  if (urls.length === 0 || key.length === 0) return [];
  const keyLocation = `https://${host}/${key}.txt`;
  const out: IndexNowSubmission[] = [];
  for (let i = 0; i < urls.length; i += MAX_URLS_PER_REQUEST) {
    const chunk = urls.slice(i, i + MAX_URLS_PER_REQUEST);
    out.push({ host, key, keyLocation, urlList: [...chunk] });
  }
  return out;
}

/**
 * Submit a single body to the IndexNow API. Best-effort — returns
 * `{ ok, status }` on completion, never throws. 200 / 202 are both
 * documented success responses.
 *
 * The IndexNow spec also documents 422 (invalid URL) and 403 (key
 * mismatch) as "your fault, not ours" — those statuses are surfaced
 * for callers that want to log diagnostics without retrying.
 */
export async function submitToIndexNow(
  body: IndexNowSubmission,
): Promise<{ ok: boolean; status: number }> {
  try {
    const resp = await fetch(INDEXNOW_ENDPOINT, {
      method: "POST",
      headers: {
        "content-type": "application/json; charset=utf-8",
        accept: "application/json",
      },
      body: JSON.stringify(body),
    });
    return { ok: resp.status === 200 || resp.status === 202, status: resp.status };
  } catch (e) {
    console.warn("indexnow: fetch failed", e);
    return { ok: false, status: 0 };
  }
}

/**
 * Convenience: ping IndexNow for a list of URLs on a single host. No-op
 * when `key` is empty (operator hasn't bound the secret yet) or when
 * `urls` is empty.
 *
 * Use the lower-level `buildSubmissions` + `submitToIndexNow` when you
 * want per-chunk control or to inspect each response.
 */
export async function pingIndexNow(
  host: string,
  key: string,
  urls: readonly string[],
): Promise<{ submitted: number; ok: number; failed: number }> {
  const submissions = buildSubmissions(host, key, urls);
  let ok = 0;
  let failed = 0;
  for (const body of submissions) {
    const result = await submitToIndexNow(body);
    if (result.ok) ok += 1;
    else failed += 1;
  }
  return { submitted: submissions.length, ok, failed };
}

/**
 * Returns true when the request path looks like an IndexNow key
 * verification probe. Used by the Worker to decide whether to special-
 * case-serve the key file before running the regular pipeline.
 *
 * Path is `/<key>.txt`. We don't check that the embedded segment
 * matches our key here — the Worker does that comparison and 404s on
 * mismatch.
 */
export function isIndexNowVerificationPath(pathname: string): boolean {
  // /xxxxxxxx.txt — at least one path segment, only [a-z0-9-], .txt extension.
  // IndexNow keys per spec are 8–128 hex-ish chars; we don't enforce
  // length here, just the shape.
  return /^\/[a-zA-Z0-9-]+\.txt$/.test(pathname);
}

/**
 * Extract the key segment from a path that passed isIndexNowVerificationPath.
 * Returns null if the path doesn't match.
 */
export function extractKeyFromVerificationPath(pathname: string): string | null {
  const match = pathname.match(/^\/([a-zA-Z0-9-]+)\.txt$/);
  return match?.[1] ?? null;
}
