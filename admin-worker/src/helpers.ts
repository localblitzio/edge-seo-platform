/**
 * Pure helpers for the admin worker write surface.
 * Kept separate from `index.ts` so unit tests can exercise them directly
 * without standing up the full Worker handler.
 */

/**
 * FNV-1a 32-bit hash, returned as 8-character lowercase hex.
 *
 * Used for `audit_log.before_hash` / `after_hash` fingerprints — purely a
 * change-detection device. Not suitable for security-sensitive use.
 *
 * @param s the input string
 * @returns 8-character lowercase hex digest
 */
export function fnvHash(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/**
 * CSRF same-origin check for state-changing POSTs.
 *
 * Compares the request's `Origin` header (preferred) or `Referer` (fallback)
 * against the request URL's origin. Combined with HTTP basic auth this is
 * the right level for an internal agency tool — long-term answer is
 * Cloudflare Access SSO.
 *
 * @param request the inbound Request
 * @param url the request URL (already parsed)
 * @returns null on pass, or a 403 Response on mismatch
 */
export function checkCsrf(request: Request, url: URL): Response | null {
  const expected = `${url.protocol}//${url.host}`;
  const origin = request.headers.get("origin");
  if (origin) {
    return origin === expected
      ? null
      : new Response("CSRF: Origin mismatch", { status: 403 });
  }
  const referer = request.headers.get("referer");
  if (referer) {
    try {
      const refUrl = new URL(referer);
      return refUrl.host === url.host && refUrl.protocol === url.protocol
        ? null
        : new Response("CSRF: Referer mismatch", { status: 403 });
    } catch {
      return new Response("CSRF: invalid Referer", { status: 403 });
    }
  }
  return new Response("CSRF: missing Origin and Referer", { status: 403 });
}

/** A flash message rendered into the next page after a 303 redirect. */
export interface FlashMessage {
  text: string;
  kind: "ok" | "warn" | "err";
}

/**
 * Build a 303 redirect carrying a flash message in the query string.
 * The destination page renders the banner from `?flash=...&flash_kind=...`.
 */
export function flashRedirect(location: string, flash: FlashMessage): Response {
  const u = new URL(location, "http://placeholder.invalid");
  u.searchParams.set("flash", flash.text);
  u.searchParams.set("flash_kind", flash.kind);
  // Strip the placeholder origin — emit only path + query.
  const target = `${u.pathname}${u.search}`;
  return new Response(null, { status: 303, headers: { location: target } });
}

/** Parse the optional `?flash=...&flash_kind=...` parameters off a URL. */
export function readFlash(url: URL): FlashMessage | null {
  const text = url.searchParams.get("flash");
  if (!text) return null;
  const kindRaw = url.searchParams.get("flash_kind");
  const kind: FlashMessage["kind"] =
    kindRaw === "ok" || kindRaw === "warn" || kindRaw === "err" ? kindRaw : "ok";
  return { text, kind };
}
