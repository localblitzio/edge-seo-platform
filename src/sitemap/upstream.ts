/**
 * Upstream sitemap ingestion.
 *
 * When a proxy site has `ingest_upstream_sitemap: true`, we fetch the
 * origin's `/sitemap.xml` (or the operator-overridden URL), parse it,
 * rewrite every URL's host from origin → proxy domain, and merge the
 * result into our sitemap response.
 *
 * Why: a wildcard-routed proxy site that just forwards `^/.*` to an
 * upstream Webflow/HubSpot/Shopify has no per-page rules, so its
 * `/sitemap.xml` would be empty — search engines have nothing to
 * crawl. Most SaaS CMSes auto-generate sitemaps; this hooks into
 * theirs.
 *
 * Cached in KV under `upstream_sitemap:<client_id>` for 1h. Cache is
 * refreshed lazily on next request after expiry; on upstream failure
 * we keep returning the (now-stale) cached value rather than 5xx-ing
 * the sitemap response.
 *
 * Sitemap-index files (`<sitemapindex>` pointing to multiple child
 * sitemaps) are followed one level deep — we fetch up to 50 child
 * sitemaps and union their URLs. Deeper nesting isn't supported.
 */

import type { ExecutionContext, KVNamespace } from "@cloudflare/workers-types";

import type { ClientConfig } from "../config/schema.js";

const KV_TTL_SECONDS = 60 * 60; // 1h
const MAX_SITEMAP_INDEX_CHILDREN = 50;
const MAX_URLS_PER_SITEMAP = 50_000;
const FETCH_TIMEOUT_MS = 15_000;

interface CachedEntry {
  urls: string[];
  fetched_at: number;
}

/**
 * Resolve the upstream sitemap URL for a given config. Uses the
 * operator override when set; otherwise defaults to
 * `https://${source_domain}/sitemap.xml`.
 */
export function resolveUpstreamSitemapUrl(config: ClientConfig): string {
  return config.upstream_sitemap_url ?? `https://${config.source_domain}/sitemap.xml`;
}

/**
 * Extract every `<loc>...</loc>` value from a sitemap XML body.
 *
 * Regex-based — Cloudflare Workers don't ship DOMParser, and a
 * proper XML parser is overkill for the very narrow shape we accept
 * (sitemaps.org urlset / sitemapindex). Handles nested whitespace
 * and common namespace prefixes; ignores anything outside `<loc>`.
 */
export function extractLocs(xml: string): string[] {
  const out: string[] = [];
  // Match <loc> ... </loc> non-greedy. Allow optional namespace
  // prefix (e.g. `<ns:loc>`) and surrounding whitespace inside the tag.
  const pattern = /<\s*(?:[a-zA-Z][\w-]*:)?loc\s*>([^<]+)<\s*\/\s*(?:[a-zA-Z][\w-]*:)?loc\s*>/g;
  let m: RegExpExecArray | null;
  // biome-ignore lint/suspicious/noAssignInExpressions: standard regex iteration
  while ((m = pattern.exec(xml)) !== null) {
    const url = m[1]?.trim();
    if (url && url.length > 0) out.push(url);
    if (out.length >= MAX_URLS_PER_SITEMAP) break;
  }
  return out;
}

/**
 * True when the XML body is a sitemap index (multiple child sitemaps)
 * rather than a flat urlset. Determined by which root element appears
 * first — sitemaps.org spec says a single root.
 */
export function isSitemapIndex(xml: string): boolean {
  const urlsetIdx = xml.search(/<\s*(?:[a-zA-Z][\w-]*:)?urlset\b/);
  const indexIdx = xml.search(/<\s*(?:[a-zA-Z][\w-]*:)?sitemapindex\b/);
  if (indexIdx === -1) return false;
  if (urlsetIdx === -1) return true;
  return indexIdx < urlsetIdx;
}

/**
 * Rewrite a URL's host from the source domain to the proxy domain.
 * Returns null when the URL doesn't belong to the source domain
 * (defensive — upstreams sometimes mix in third-party URLs and we
 * shouldn't claim those as ours).
 *
 * Subdomain match: `www.source.com` and `source.com` both rewrite to
 * the proxy domain. `cdn.source.com` does NOT rewrite (it's a
 * different host) — those URLs are dropped.
 */
export function rewriteHost(
  rawUrl: string,
  sourceDomain: string,
  proxyDomain: string,
): string | null {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return null;
  }
  // Allow `source.com` and `www.source.com`; reject other subdomains.
  const lower = parsed.hostname.toLowerCase();
  const sourceLower = sourceDomain.toLowerCase();
  if (lower !== sourceLower && lower !== `www.${sourceLower}`) return null;
  parsed.hostname = proxyDomain;
  parsed.protocol = "https:";
  parsed.port = "";
  return parsed.toString();
}

/**
 * Fetch + parse a single sitemap URL. Resolves to the URL list, or
 * null on any failure (network error, non-2xx, malformed body).
 *
 * `signal` cancels the fetch after FETCH_TIMEOUT_MS so a slow
 * upstream doesn't pin a Worker isolate.
 */
async function fetchSitemap(url: string): Promise<string | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const resp = await fetch(url, {
      method: "GET",
      headers: { accept: "application/xml, text/xml, */*" },
      signal: controller.signal,
    });
    if (resp.status !== 200) {
      console.warn(`upstream-sitemap: ${url} returned HTTP ${resp.status}`);
      return null;
    }
    return await resp.text();
  } catch (e) {
    console.warn(`upstream-sitemap: fetch failed for ${url}`, e);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Recursive fetch + parse + host-rewrite. Returns the deduped, sorted
 * URL list keyed to the proxy domain. Returns null on outright
 * failure so the caller can decide whether to fall back to stale
 * cache.
 */
export async function fetchAndRewriteUpstream(config: ClientConfig): Promise<string[] | null> {
  const rootUrl = resolveUpstreamSitemapUrl(config);
  const rootXml = await fetchSitemap(rootUrl);
  if (rootXml === null) return null;

  let allLocs: string[];
  if (isSitemapIndex(rootXml)) {
    const childSitemaps = extractLocs(rootXml).slice(0, MAX_SITEMAP_INDEX_CHILDREN);
    // Fetch children in parallel — upstreams typically host all
    // sub-sitemaps on the same CDN, so concurrency is fine.
    const childResults = await Promise.all(childSitemaps.map(fetchSitemap));
    allLocs = [];
    for (const childXml of childResults) {
      if (childXml === null) continue;
      // Children may themselves be sitemapindex (some Shopify setups
      // do this) — we DON'T recurse further, both to cap depth and
      // because sitemaps.org doesn't endorse deeper nesting.
      if (isSitemapIndex(childXml)) continue;
      const childLocs = extractLocs(childXml);
      for (const loc of childLocs) {
        allLocs.push(loc);
        if (allLocs.length >= MAX_URLS_PER_SITEMAP) break;
      }
      if (allLocs.length >= MAX_URLS_PER_SITEMAP) break;
    }
  } else {
    allLocs = extractLocs(rootXml);
  }

  // Rewrite host + drop foreign URLs + dedupe.
  const rewritten = new Set<string>();
  for (const loc of allLocs) {
    const rewrittenUrl = rewriteHost(loc, config.source_domain, config.proxy_domain);
    if (rewrittenUrl) rewritten.add(rewrittenUrl);
  }
  return Array.from(rewritten).sort();
}

interface UpstreamEnv {
  CONFIG_KV: KVNamespace;
}

/**
 * KV-cached read of the upstream URL list. Returns the cached value
 * when fresh; refreshes on cache miss; returns stale-on-failure.
 *
 * `ctx` is an ExecutionContext for `waitUntil` so the refresh
 * doesn't extend the Worker request lifetime when we serve stale.
 */
export async function getUpstreamSitemapUrls(
  config: ClientConfig,
  env: UpstreamEnv,
  ctx: ExecutionContext,
): Promise<string[]> {
  const kvKey = `upstream_sitemap:${config.client_id}`;
  const cachedRaw = await env.CONFIG_KV.get(kvKey);
  let cached: CachedEntry | null = null;
  if (cachedRaw !== null) {
    try {
      cached = JSON.parse(cachedRaw) as CachedEntry;
    } catch {
      cached = null;
    }
  }

  // Fresh cache hit — return immediately. (KV TTL handles eviction;
  // when KV returns the value, it's still within TTL.)
  if (cached !== null) {
    return cached.urls;
  }

  // No cache → fetch synchronously.
  const fresh = await fetchAndRewriteUpstream(config);
  if (fresh === null) {
    // Fetch failed AND no cache to fall back to — return empty list,
    // which means the sitemap.xml just shows operator-pinned URLs.
    return [];
  }

  // Cache the fresh result. Use `waitUntil` so the put doesn't block
  // the response.
  const entry: CachedEntry = { urls: fresh, fetched_at: Date.now() };
  ctx.waitUntil(env.CONFIG_KV.put(kvKey, JSON.stringify(entry), { expirationTtl: KV_TTL_SECONDS }));
  return fresh;
}
