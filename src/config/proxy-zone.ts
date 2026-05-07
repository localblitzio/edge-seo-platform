/**
 * Proxy-zone constants and helpers.
 *
 * The platform owns one or more wildcard zones. Clients without a custom
 * domain are auto-served as `<client_id>.<zone>` on one of these. Each
 * zone has DNS + a Worker route configured once by the operator, so no
 * per-client DNS/cert work is needed for the platform-zone path.
 *
 * Custom domains stay supported as an explicit override (operator points
 * external DNS at the worker, then adds a Worker route per zone).
 *
 * Why this lives in src/config/ rather than admin-worker/: the validator
 * uses the reserved-subdomain stoplist as a load-time invariant, and we
 * keep one place where the zone strings are canonical.
 */

/**
 * All wildcard zones the platform serves on. Each entry must have a
 * matching `*.<zone>/*` Workers Route in `wrangler.toml` and a wildcard
 * DNS A record on the zone (proxied = orange cloud).
 *
 * Order matters for UI defaults: PROXY_ZONES[0] is the default zone.
 * Add new zones to the end of the array — never reorder, since the
 * "default zone" semantics ripple through fixtures and templates.
 */
export const PROXY_ZONES = ["localpage.us.com", "localsite.us.com"] as const;

export type ProxyZone = (typeof PROXY_ZONES)[number];

/**
 * Default proxy zone for auto-derived client subdomains.
 *
 * Convention: `<client_id>.${DEFAULT_PROXY_ZONE}`. The default is the
 * first entry in `PROXY_ZONES` — a UI/template convention only; the
 * worker accepts any registered zone.
 */
export const DEFAULT_PROXY_ZONE: ProxyZone = PROXY_ZONES[0];

/**
 * Returns the matching proxy zone for a domain, or null if it isn't on
 * any registered zone. The check uses a leading dot so `fakelocalpage.us.com`
 * doesn't match `localpage.us.com`.
 *
 * @param proxyDomain the proxy_domain string from a ClientConfig
 * @returns the matching `ProxyZone` if `proxyDomain` ends with `.<zone>`,
 *   otherwise null
 */
export function matchProxyZone(proxyDomain: string): ProxyZone | null {
  for (const zone of PROXY_ZONES) {
    if (proxyDomain.endsWith(`.${zone}`)) return zone;
  }
  return null;
}

/**
 * Returns true if `proxy_domain` is a subdomain of any registered proxy zone.
 */
export function isProxyZoneDomain(proxyDomain: string): boolean {
  return matchProxyZone(proxyDomain) !== null;
}

/**
 * Construct a proxy domain on the default zone for a given `client_id`.
 *
 * Pure string concatenation — caller is responsible for validating that
 * `client_id` is a DNS-safe label (RFC 1035 LDH, ≤63 chars).
 */
export function defaultProxyDomainFor(clientId: string): string {
  return `${clientId}.${DEFAULT_PROXY_ZONE}`;
}

/**
 * Extract the leftmost label(s) from a proxy-zone domain.
 *
 * @param proxyDomain the proxy_domain string
 * @returns the subdomain prefix (e.g. "lantern-crest" for
 *   "lantern-crest.localpage.us.com"), or null if `proxyDomain` is not
 *   on any registered zone, or has no leftmost label.
 *
 * Multi-label prefixes (e.g. "foo.bar.localpage.us.com") return the
 * full prefix — caller can split on "." to get the leftmost label.
 */
export function subdomainOfProxyZone(proxyDomain: string): string | null {
  const zone = matchProxyZone(proxyDomain);
  if (!zone) return null;
  const sub = proxyDomain.slice(0, -(zone.length + 1));
  // A bare zone domain ("localpage.us.com" itself) shouldn't be a valid
  // proxy_domain and would produce an empty string; reject by returning null.
  if (sub.length === 0) return null;
  return sub;
}

/**
 * Reserved subdomain labels — refused as `client_id` for new platform-zone
 * clients to avoid collisions with infrastructure subdomains operators
 * commonly reserve. Lowercase only (matches the tightened client_id regex).
 *
 * Custom-domain clients are NOT subject to this list.
 */
export const RESERVED_SUBDOMAINS: ReadonlySet<string> = new Set([
  "www",
  "api",
  "admin",
  "mail",
  "ftp",
  "smtp",
  "ns",
  "ns1",
  "ns2",
  "app",
  "dev",
  "test",
  "staging",
  "prod",
  "production",
  "edge",
  "cdn",
  "ssl",
  "secure",
  "support",
  "help",
  "blog",
  "docs",
  "status",
  "dashboard",
  "auth",
  "login",
  "logout",
  "static",
  "assets",
  "media",
  "img",
  "images",
]);
