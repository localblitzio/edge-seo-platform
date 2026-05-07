/**
 * Response cache layer. Spec: docs/tech-spec.md §5 step 11, §9, §9.1.
 *
 * Responsibilities:
 *   - Match the in-flight request against the config's `caching[]`
 *     CacheRule array; first-match-wins.
 *   - Derive a cache key URL that includes any cookies named in
 *     `cache_key_includes_cookies` so per-variant content stays
 *     isolated.
 *   - Decide whether a request is eligible to READ from the shared
 *     cache (skip on Authorization, skip on bypass cookie).
 *   - Decide whether a response is eligible to WRITE to the shared
 *     cache (skip on Authorization, skip on Set-Cookie, skip 5xx,
 *     skip bot UAs — §9.1 invariants 1, 2, 4, 5).
 *   - Compute a TTL per §9: HTML defaults to the matched CacheRule,
 *     redirects 5min, 4xx 60s, 5xx never.
 *
 * Spec compliance notes:
 *   - The stored response is the POST-transform response (§5 step 11
 *     "store the POST-transform response"). The worker passes the
 *     final response to `writeCache`.
 *   - The cache lookup runs early (between §5 steps 1 and 3); on hit
 *     for an HTML response, the worker returns the stored body
 *     directly without re-running steps 3-10.
 *   - Subrequest cache (the `cf` object on origin fetch) is disabled
 *     elsewhere (§6.5 step 8); only this response-layer cache runs.
 */

import type { CacheRule, ClientConfig } from "../config/schema.js";
import { getCookieValue } from "../redirects/conditional.js";

/** TTL defaults per §9 when no CacheRule explicitly governs the response. */
const REDIRECT_CACHE_TTL_SECONDS = 5 * 60;
const FOUR_XX_CACHE_TTL_SECONDS = 60;

const BOT_UA_RE = /Googlebot|bingbot|PerplexityBot|ClaudeBot|Claude-|GPTBot|OAI-SearchBot/i;

/**
 * The first matching CacheRule for a path, or null on no match.
 *
 * @param path the URL pathname
 * @param rules the config's caching array (compile happens here; for
 *   hot-path callers a WeakMap-cached version can be added later)
 * @returns the matched rule, or null
 * @throws never
 */
export function matchCacheRule(path: string, rules: readonly CacheRule[]): CacheRule | null {
  for (const rule of rules) {
    if (new RegExp(rule.match).test(path)) return rule;
  }
  return null;
}

/**
 * Build the cache key Request for a given in-flight request.
 *
 * Cookies named in `cache_key_includes_cookies` are appended to the
 * key URL as synthetic query params (`__cookie_<name>=<value>`) so
 * the shared cache can keep per-cookie variants isolated. The actual
 * cookies are NOT sent on the cache lookup; we just want the key.
 *
 * @param request the incoming Request
 * @param rule the matched CacheRule
 * @returns a Request usable as a key for `caches.default.match` / `.put`
 * @throws never
 */
export function deriveCacheKey(request: Request, rule: CacheRule): Request {
  const url = new URL(request.url);
  const cookieHeader = request.headers.get("cookie");
  for (const name of rule.cache_key_includes_cookies) {
    const value = getCookieValue(cookieHeader, name);
    if (value !== null) {
      url.searchParams.set(`__cookie_${name}`, value);
    }
  }
  return new Request(url.toString(), { method: "GET" });
}

/**
 * Whether a request is eligible to READ from the shared cache.
 * Returns false when:
 *   - Method is not GET / HEAD
 *   - The `Authorization` header is present (§9.1 invariant 1)
 *   - Any cookie listed in `bypass_on_cookie` is present
 */
export function canReadFromCache(request: Request, rule: CacheRule): boolean {
  const method = request.method.toUpperCase();
  if (method !== "GET" && method !== "HEAD") return false;
  if (request.headers.has("authorization")) return false;
  const cookieHeader = request.headers.get("cookie");
  for (const name of rule.bypass_on_cookie) {
    if (getCookieValue(cookieHeader, name) !== null) return false;
  }
  return true;
}

/**
 * Whether a response is eligible to WRITE to the shared cache.
 * Returns false when ANY §9.1 invariant disqualifies the write:
 *   1. Authorization-bearing request → skip
 *   2. Response carries Set-Cookie → skip (private to one client)
 *   4. 5xx response → skip (we only cache successful and stable errors)
 *   5. Bot UA → skip (don't cache bot-shaped variants for humans)
 *   - Bypass cookie present → skip (already not reading either)
 *   - 0-TTL CacheRule → skip
 *   - content-length: 0 on a 200 → skip. Empty 200 bodies are almost
 *     always either an aborted upstream stream or a misbehaving origin;
 *     caching them poisons the URL for the rule's TTL (up to 4 hours)
 *     and is invisible to operators since CF still reports HIT.
 *     Observed in production after a redeploy/purge race condition.
 */
export function canWriteToCache(request: Request, response: Response, rule: CacheRule): boolean {
  if (!canReadFromCache(request, rule)) return false;
  if (response.status >= 500) return false;
  if (response.headers.getSetCookie().length > 0) return false;
  const ua = request.headers.get("user-agent") ?? "";
  if (BOT_UA_RE.test(ua)) return false;
  if (response.status === 200) {
    const contentLength = response.headers.get("content-length");
    if (contentLength === "0") return false;
  }
  return true;
}

/**
 * Compute the TTL to apply to a response, in seconds. Returns 0 when
 * the response should NOT be written to the cache.
 *
 * @param response the post-transform response (status code drives the decision)
 * @param rule the matched CacheRule (null → use spec §9 defaults)
 * @returns TTL in seconds (0 = don't cache)
 * @throws never
 */
export function computeCacheTtl(response: Response, rule: CacheRule | null): number {
  // §9 status-driven defaults override any config TTL for these classes.
  if (response.status >= 500) return 0;
  if (response.status >= 300 && response.status < 400) return REDIRECT_CACHE_TTL_SECONDS;
  if (response.status >= 400 && response.status < 500) return FOUR_XX_CACHE_TTL_SECONDS;
  // 2xx: respect the rule's ttl, or skip if no rule matched.
  if (rule === null) return 0;
  return rule.ttl_seconds;
}

/**
 * Look up a previously-cached response. Returns null on miss or when
 * the request is ineligible to read.
 *
 * @param request the in-flight Request
 * @param config the resolved ClientConfig
 * @returns the cached Response (cloned for re-use) or null
 * @throws never (cache failures are best-effort)
 */
export async function readCache(
  request: Request,
  config: ClientConfig,
): Promise<{ response: Response; rule: CacheRule } | null> {
  const url = new URL(request.url);
  const rule = matchCacheRule(url.pathname, config.caching);
  if (rule === null) return null;
  if (!canReadFromCache(request, rule)) return null;
  const key = deriveCacheKey(request, rule);
  try {
    const cached = await caches.default.match(key);
    if (!cached) return null;
    return { response: cached, rule };
  } catch {
    return null;
  }
}

/**
 * Store a response in the shared cache when invariants permit.
 * The TTL is encoded as a `Cache-Control: public, max-age=<ttl>`
 * header on the cached copy (the original response is unchanged).
 *
 * Set `Vary: Cookie` when the cache key derivation included cookies
 * so downstream caches understand the per-variant boundary
 * (§9.1 invariant 3).
 *
 * @param request the in-flight Request
 * @param response the post-transform Response (will be cloned)
 * @param config the resolved ClientConfig
 * @returns a Promise that resolves when the write completes
 * @throws never (cache write failures are swallowed)
 */
export async function writeCache(
  request: Request,
  response: Response,
  config: ClientConfig,
): Promise<void> {
  const url = new URL(request.url);
  const rule = matchCacheRule(url.pathname, config.caching);
  const ttl = computeCacheTtl(response, rule);
  if (ttl <= 0) return;

  // For status-default cases (3xx/4xx without a rule) we still write,
  // using a synthetic permissive rule so canWriteToCache and key
  // derivation work uniformly.
  const effectiveRule: CacheRule = rule ?? {
    match: ".*",
    ttl_seconds: ttl,
    cache_key_includes_cookies: [],
    bypass_on_cookie: [],
  };

  if (!canWriteToCache(request, response, effectiveRule)) return;

  const cloned = response.clone();
  const headers = new Headers(cloned.headers);
  headers.set("cache-control", `public, max-age=${ttl}`);
  if (effectiveRule.cache_key_includes_cookies.length > 0) {
    headers.append("vary", "Cookie");
  }
  const cacheable = new Response(cloned.body, {
    status: cloned.status,
    statusText: cloned.statusText,
    headers,
  });

  try {
    const key = deriveCacheKey(request, effectiveRule);
    await caches.default.put(key, cacheable);
  } catch {
    // Best-effort; swallow.
  }
}
