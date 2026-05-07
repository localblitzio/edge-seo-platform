/**
 * Per-proxy-domain sitemap generator.
 * Spec: docs/prd.md §7.7.
 *
 * Walks the operator's ClientConfig to enumerate sitemap-eligible URLs:
 *
 *   - `routing[].match` regexes that derive to a literal path
 *   - `text_rewrites[].match`, `meta_rewrites[].match`, `canonicals[].match`,
 *     `schema_injections[].match`, `content_injections[].match`,
 *     `element_removals[].match` — edit rules pinned to a specific path
 *
 * Then filters out:
 *
 *   - Paths whose canonical strategy is anything other than `self` (these
 *     are pointing OUT to a different canonical and shouldn't appear in
 *     this site's sitemap as authoritative URLs)
 *   - Paths matched by an `indexation` rule whose `robots` contains
 *     `noindex` (search engines wouldn't index these anyway)
 *   - The redirect-source paths from `redirects.static[].from` (these
 *     redirect away — listing them would just feed search engines the
 *     redirect chain)
 *
 * Returns an `<urlset>` XML string. The Worker serves this from
 * `/sitemap.xml` on every proxy domain via a special-case route in
 * `src/worker.ts`.
 *
 * Wildcard regexes (`^/blog/.*`) intentionally don't enumerate — we
 * don't have an upstream-crawl mechanism. The sitemap therefore lists
 * the operator-configured paths the worker actively touches; broader
 * coverage is the origin's responsibility (or a future Slice 2 that
 * crawls the source).
 */

import type { ClientConfig } from "../config/schema.js";

/**
 * Heuristic: any pattern with regex repetition or character-class
 * ranges is a wildcard, not a literal-path match. Mirrors the
 * frontend-worker's isWildcardMatch logic so the sitemap and the
 * "Pages with edits" UI agree on what counts as a per-page rule.
 */
function isWildcardMatch(m: string): boolean {
  const stripped = m.replace(/\/\?\$$/, "$");
  return /[*+?]|\[\^/.test(stripped);
}

/**
 * Try to derive a literal path from a regex like `^/about-us$` or
 * `^/about-us/?$`. Returns null when the pattern uses any unescaped
 * regex metacharacter — those are wildcards we can't enumerate.
 *
 * The `^/path/?$` form is what the per-page editor emits so a rule
 * matches both `/path` and `/path/`. We prefer the slash-less form
 * for sitemap output (most search engines treat them as equivalent
 * but listing one is cleaner).
 */
export function deriveLiteralPath(match: string): string | null {
  if (!match.startsWith("^") || !match.endsWith("$")) return null;
  const trailingOptionalSlash = match.endsWith("/?$");
  const inner = trailingOptionalSlash ? match.slice(1, -3) : match.slice(1, -1);
  let out = "";
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i];
    if (c === "\\") {
      // Un-escape: \X → X
      const next = inner[i + 1];
      if (next === undefined) return null;
      out += next;
      i += 1;
      continue;
    }
    // Any unescaped regex special char makes this a non-literal pattern.
    if ("^$.|?*+()[]{}".includes(c ?? "")) return null;
    out += c;
  }
  if (out.length === 0) return null;
  if (!out.startsWith("/")) return null;
  return out;
}

/**
 * Collect every literal path the config touches via per-page rules
 * (routing + text/meta/canonicals/schema/content-injections/element-removals).
 *
 * Doesn't filter — caller applies the canonical/indexation/redirect
 * filters in `generateSitemapXml`.
 */
function collectCandidatePaths(config: ClientConfig): string[] {
  const set = new Set<string>();
  const eat = (match: string): void => {
    if (isWildcardMatch(match)) return;
    const literal = deriveLiteralPath(match);
    if (literal) set.add(literal);
  };
  for (const r of config.routing) eat(r.match);
  for (const r of config.text_rewrites) eat(r.match);
  for (const r of config.meta_rewrites) eat(r.match);
  for (const r of config.canonicals) eat(r.match);
  for (const r of config.schema_injections) eat(r.match);
  for (const r of config.content_injections) eat(r.match);
  for (const r of config.element_removals) eat(r.match);
  return Array.from(set);
}

/**
 * For a given path, find the strongest applicable canonical strategy.
 * First-match-wins (matches the runtime resolver in src/canonical/).
 *
 * Returns null when no rule matches — the proxy default for that path
 * applies (usually `origin` for proxy routes, `self` for custom pages).
 */
function canonicalStrategyForPath(
  path: string,
  config: ClientConfig,
): "self" | "origin" | "custom" | "noindex" | null {
  for (const rule of config.canonicals) {
    try {
      const re = new RegExp(rule.match);
      if (re.test(path)) return rule.strategy.type;
    } catch {
      /* ignore — admin-time validator already rejected unsafe regex */
    }
  }
  return null;
}

/**
 * Returns true when an indexation rule that matches `path` declares
 * `noindex` (with or without `,follow`). Search engines wouldn't index
 * these so we drop them from the sitemap.
 */
function isNoindexed(path: string, config: ClientConfig): boolean {
  for (const rule of config.indexation) {
    try {
      const re = new RegExp(rule.match);
      if (!re.test(path)) continue;
      if (/\bnoindex\b/i.test(rule.robots)) return true;
    } catch {
      /* ignore */
    }
  }
  return false;
}

/**
 * Default canonical strategy for a path when no `canonicals[]` rule
 * matches. Mirrors src/canonical/index.ts §6.3 SEO-defaults: proxy
 * routes default to `origin` (don't compete with source); custom_page
 * routes default to `self`.
 */
function defaultCanonicalStrategy(path: string, config: ClientConfig): "self" | "origin" {
  for (const rule of config.routing) {
    try {
      const re = new RegExp(rule.match);
      if (!re.test(path)) continue;
      return rule.type === "custom_page" ? "self" : "origin";
    } catch {
      /* ignore */
    }
  }
  // No route matches — `origin` is the safer default per §6.3.
  return "origin";
}

/**
 * Returns true when a path should appear in this site's sitemap.
 *
 * Filters (any one excludes):
 *  - canonical strategy != 'self' (this site isn't authoritative for it)
 *  - matched by `indexation` rule with `noindex`
 *  - listed in `redirects.static[].from` (it redirects away)
 */
export function isPathSitemapEligible(path: string, config: ClientConfig): boolean {
  const strategy = canonicalStrategyForPath(path, config) ?? defaultCanonicalStrategy(path, config);
  if (strategy !== "self") return false;
  if (isNoindexed(path, config)) return false;
  for (const r of config.redirects.static) {
    if (r.from === path) return false;
  }
  return true;
}

/** XML-escape per the sitemaps.org spec (apostrophe + the usual four). */
function xmlEscape(value: string): string {
  return value.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      case "'":
        return "&apos;";
      default:
        return c;
    }
  });
}

/**
 * Return the deterministic, deduped, sorted list of full URLs that
 * would appear in this site's sitemap. Used by both `generateSitemapXml`
 * (XML output) and the IndexNow hook (URL-list payload to the
 * IndexNow API).
 */
export function collectSitemapUrls(config: ClientConfig): string[] {
  const candidates = collectCandidatePaths(config);
  const eligible = candidates.filter((p) => isPathSitemapEligible(p, config));

  // seed_paths bypass the *default* canonical=origin (no rule
  // matched), but an EXPLICIT canonicals[] rule still wins. They
  // also respect noindex + redirect-source filters since those are
  // active blockers.
  const seedEligible = config.seed_paths.filter((p) => isPathSeedEligible(p, config));

  // Merge + dedupe so seed_paths that overlap with literal-rule paths
  // don't get double-listed.
  const merged = Array.from(new Set([...eligible, ...seedEligible]));
  // Sort lexicographically so the output is deterministic (test-friendly
  // and easier on operators reading the XML).
  merged.sort();
  const host = config.proxy_domain;
  return merged.map((path) => `https://${host}${path}`);
}

/**
 * Eligibility check for seed_paths. Seed declaration overrides only
 * the *default* canonical=origin (no rule matched). An EXPLICIT
 * canonicals[] rule still wins — operator wrote both, so the more
 * specific signal (the canonical rule) takes priority.
 *
 * Always honours noindex + redirect-source filters (active blockers).
 */
function isPathSeedEligible(path: string, config: ClientConfig): boolean {
  if (isNoindexed(path, config)) return false;
  for (const r of config.redirects.static) {
    if (r.from === path) return false;
  }
  // If an explicit canonical rule applies, defer to its strategy.
  const explicitStrategy = canonicalStrategyForPath(path, config);
  if (explicitStrategy !== null) {
    return explicitStrategy === "self";
  }
  // No explicit rule → seed declaration overrides the default-origin fallthrough.
  return true;
}

/**
 * Build the <urlset> XML string for a given config.
 *
 * @param config the parsed ClientConfig
 * @returns XML body including the `<?xml ?>` prolog and `<urlset>`
 *   wrapper. Caller wraps in a Response with content-type
 *   `application/xml; charset=utf-8`.
 *
 * No `<lastmod>` is emitted — it's optional per sitemaps.org and the
 * KV-stored ClientConfig doesn't carry an edit timestamp (the
 * `clients.updated_at` D1 column does, but pulling it on every
 * sitemap request would add a D1 hop). Search engines fall back to
 * crawl-time freshness comparison when `lastmod` is absent.
 */
export function generateSitemapXml(config: ClientConfig): string {
  const urls = collectSitemapUrls(config);
  const body = urls.map((u) => `  <url><loc>${xmlEscape(u)}</loc></url>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${body}
</urlset>`;
}
