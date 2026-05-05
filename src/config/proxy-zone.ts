/**
 * Default proxy-zone constants and helpers.
 *
 * The platform reserves a single "default zone" — clients without a custom
 * domain are auto-served as `<client_id>.<zone>`. The zone is owned by the
 * platform operator (DNS + Worker route configured once), so no per-client
 * DNS/cert work is needed for the default-zone path.
 *
 * Custom domains stay supported as an explicit override (operator points
 * external DNS at the worker, then adds a Worker route per zone).
 *
 * Why this lives in src/config/ rather than admin-worker/: the validator
 * uses the reserved-subdomain stoplist as a load-time invariant, and we
 * keep one place where the zone string is canonical.
 */

/**
 * Default proxy zone for auto-derived client subdomains.
 *
 * Convention: `<client_id>.${DEFAULT_PROXY_ZONE}`. Change this string when
 * the operator wants to migrate to a different default zone (e.g. staging
 * vs production separation). Not env-aware on purpose — each Worker is
 * deployed against one zone, and the zone name lives in the worker's
 * own configuration via `wrangler.toml` routes anyway.
 */
export const DEFAULT_PROXY_ZONE = "localpage.us.com";

/**
 * Returns true if `proxy_domain` is a subdomain of the default zone.
 *
 * @param proxyDomain the proxy_domain string from a ClientConfig
 * @returns true if the host ends with `.${DEFAULT_PROXY_ZONE}`
 */
export function isDefaultProxyZone(proxyDomain: string): boolean {
  return proxyDomain.endsWith(`.${DEFAULT_PROXY_ZONE}`);
}

/**
 * Construct the default proxy domain for a given `client_id`.
 *
 * Pure string concatenation — caller is responsible for validating that
 * `client_id` is a DNS-safe label (RFC 1035 LDH, ≤63 chars).
 */
export function defaultProxyDomainFor(clientId: string): string {
  return `${clientId}.${DEFAULT_PROXY_ZONE}`;
}

/**
 * Extract the leftmost label from a default-zone proxy domain.
 *
 * @param proxyDomain the proxy_domain string
 * @returns the subdomain (e.g. "lantern-crest" for "lantern-crest.localpage.us.com"),
 *   or null if the domain is not on the default zone or has no leftmost label
 */
export function subdomainOfDefaultZone(proxyDomain: string): string | null {
  if (!isDefaultProxyZone(proxyDomain)) return null;
  const sub = proxyDomain.slice(0, -(DEFAULT_PROXY_ZONE.length + 1));
  // A bare zone domain ("localpage.us.com" itself) shouldn't be a valid
  // proxy_domain and would produce an empty string; reject by returning null.
  if (sub.length === 0) return null;
  // Multi-label subdomains (e.g. "foo.bar.localpage.us.com") return the
  // full prefix — caller can decide whether to treat that as one label or
  // dotted. The reserved-subdomain check below only flags the FIRST label,
  // so "foo.bar..." is treated as if its leftmost label is "foo".
  return sub;
}

/**
 * Reserved subdomain labels — refused as `client_id` for new default-zone
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
