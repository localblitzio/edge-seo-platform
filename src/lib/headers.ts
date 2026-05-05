/**
 * Header transformation helpers.
 * Spec: docs/tech-spec.md §10 (security requirements) and §5 step 10.
 *
 * Two operations the worker pipeline needs on the post-transform response:
 *   1. Strip origin-leaking headers, add missing security headers without
 *      ever weakening existing CSP / X-Frame-Options / HSTS.
 *   2. Rewrite the `Domain=` attribute on every Set-Cookie from the source
 *      domain to the proxy domain.
 */

/** Headers that must be stripped from any origin response (§10). */
export const STRIP_RESPONSE_HEADERS: readonly string[] = [
  "server",
  "x-powered-by",
  "x-aspnet-version",
  "x-aspnetmvc-version",
];

/** Headers that must be added (not overridden) on any response (§10). */
export const SECURITY_HEADERS_ADD_IF_MISSING: ReadonlyArray<readonly [string, string]> = [
  ["x-content-type-options", "nosniff"],
  ["referrer-policy", "strict-origin-when-cross-origin"],
];

/**
 * Headers we never weaken — preserved untouched if origin sent them.
 * Listed for documentation and for tests to assert against; the
 * implementation simply does not modify these values.
 */
export const SECURITY_HEADERS_PRESERVE: readonly string[] = [
  "content-security-policy",
  "x-frame-options",
  "strict-transport-security",
];

/**
 * Apply the security-header policy from §10 to a response.
 *
 * @param response upstream response
 * @returns a new Response with banned headers stripped, missing security
 *   headers added, and CSP/X-Frame-Options/HSTS preserved untouched
 * @throws never
 */
export function applySecurityHeaders(response: Response): Response {
  const headers = new Headers(response.headers);

  for (const name of STRIP_RESPONSE_HEADERS) {
    headers.delete(name);
  }

  for (const [name, value] of SECURITY_HEADERS_ADD_IF_MISSING) {
    if (!headers.has(name)) {
      headers.set(name, value);
    }
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * Rewrite the `Domain=` attribute on every Set-Cookie header from
 * `sourceDomain` to `proxyDomain`. Cookies without an explicit `Domain=`
 * are left unchanged.
 *
 * Handles a leading dot (`.example.com`) and matches case-insensitively
 * since `Domain=` and `domain=` are both seen in the wild.
 *
 * Multiple Set-Cookie headers are read individually via
 * `Headers.getSetCookie()` and re-emitted one per call to
 * `headers.append("set-cookie", ...)` so the per-cookie boundary is
 * preserved (joining with comma is ambiguous because Date headers
 * contain commas).
 *
 * @param response response carrying zero or more Set-Cookie headers
 * @param sourceDomain the origin's hostname
 * @param proxyDomain the proxy hostname the response is being served from
 * @returns response with Set-Cookie domains rewritten (or original on no cookies)
 * @throws never
 */
export function rewriteCookieDomain(
  response: Response,
  sourceDomain: string,
  proxyDomain: string,
): Response {
  const cookies = response.headers.getSetCookie();
  if (cookies.length === 0) return response;

  const headers = new Headers(response.headers);
  headers.delete("set-cookie");

  const domainRe = buildDomainRewriteRegex(sourceDomain);

  for (const cookie of cookies) {
    headers.append("set-cookie", cookie.replace(domainRe, `$1${proxyDomain}`));
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function buildDomainRewriteRegex(sourceDomain: string): RegExp {
  const escapedSource = sourceDomain.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Capture group 1 = the `; Domain=` prefix (with optional leading dot
  // consumed); replacement preserves the prefix and substitutes the host.
  // The trailing word boundary stops mid-word matches of a longer domain.
  return new RegExp(`(;\\s*Domain=)\\.?${escapedSource}(?=$|;|\\s)`, "gi");
}

/**
 * Rewrite the `Location` header on an upstream redirect response so that
 * an absolute URL pointing at the source domain (e.g. WordPress's
 * trailing-slash 301 to `https://source.com/path/`) lands on the proxy
 * domain instead of bouncing the user off the proxy.
 *
 * Why this is needed:
 *   Many origins (WordPress, Shopify, .NET) generate absolute Location
 *   URLs from their configured site URL, not from the inbound request's
 *   Host header. Without this rewrite the proxy is "leaky": the very
 *   first redirect drops users back on the source.
 *
 * What gets rewritten (case-insensitive):
 *   - Absolute URLs: `https://<source>` and `http://<source>` → proxy
 *   - With or without a leading `www.` on the source host
 *   - Protocol-relative URLs: `//<source>/...` → `//<proxy>/...`
 *
 * What is preserved:
 *   - Scheme: `http://` stays `http://`, `https://` stays `https://`
 *   - Path, query, fragment — only the host segment is replaced
 *   - Same-origin relative redirects (no host) — left untouched
 *   - Redirects pointing at OTHER hosts (e.g. an external partner) —
 *     left untouched. The rewrite only fires when the redirect is to
 *     the source itself.
 *
 * @param response upstream response (3xx or otherwise — we don't gate on
 *   status; the caller decides which responses to rewrite)
 * @param sourceDomain the origin's hostname (no scheme, no port)
 * @param proxyDomain the proxy hostname the response is being served from
 * @returns response with Location rewritten if applicable, or the
 *   original response if no rewrite was needed (no allocation)
 * @throws never
 */
export function rewriteRedirectLocation(
  response: Response,
  sourceDomain: string,
  proxyDomain: string,
): Response {
  const location = response.headers.get("location");
  if (!location) return response;

  const rewritten = rewriteHostInUrl(location, sourceDomain, proxyDomain);
  if (rewritten === location) return response;

  const headers = new Headers(response.headers);
  headers.set("location", rewritten);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

/**
 * Rewrite the host portion of a URL string if (and only if) the host
 * matches `sourceDomain` (with optional `www.` prefix). Returns the
 * input unchanged on any non-match — including relative URLs, foreign
 * hosts, and unparseable strings.
 */
function rewriteHostInUrl(input: string, sourceDomain: string, proxyDomain: string): string {
  const escapedSource = sourceDomain.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Two patterns: absolute (`https://host…`) and protocol-relative
  // (`//host…`). Both anchor at the start of the URL since Location is
  // a single value, not a list. The trailing lookahead requires the
  // host to end at a URL boundary — `/`, `?`, `#`, or end-of-string —
  // so a longer suffix like `source.com.evil.com` doesn't match.
  // `\b` is too loose here because `.` is a word boundary.
  const tail = "(?=$|[/?#])";
  const absRe = new RegExp(`^(https?:)\\/\\/(?:www\\.)?${escapedSource}${tail}`, "i");
  const protoRelRe = new RegExp(`^\\/\\/(?:www\\.)?${escapedSource}${tail}`, "i");
  if (absRe.test(input)) {
    return input.replace(absRe, `$1//${proxyDomain}`);
  }
  if (protoRelRe.test(input)) {
    return input.replace(protoRelRe, `//${proxyDomain}`);
  }
  return input;
}
