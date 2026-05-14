/**
 * Per-path indexing diagnostics.
 *
 * Companion to `generator.ts` — instead of emitting a filtered URL
 * list, this module emits a row per candidate path with the *verdict*
 * (will it appear in the sitemap?) and, when it won't, the *reason*.
 *
 * The Indexing admin page uses this to render a table showing every
 * URL the operator has touched + every seed path, with the rule
 * source, canonical strategy, indexation directive, and a clear
 * "include / exclude because ..." for each.
 *
 * Pure / synchronous — no network calls. Operators get a fast
 * "what's going to happen" diagnostic without waiting for an upstream
 * fetch. A future "Refresh" button can layer live HTTP probes on top
 * of these rows.
 */

import type { ClientConfig } from "../config/schema.js";

import { deriveLiteralPath } from "./generator.js";

/**
 * Where did this path come from? Drives the "Source" column in the
 * UI. `seed_paths` is operator-declared; everything else is derived
 * from a per-page config rule.
 */
export type PathSource =
  | "seed_paths"
  | "routing"
  | "text_rewrites"
  | "meta_rewrites"
  | "canonicals"
  | "schema_injections"
  | "content_injections"
  | "element_removals";

/**
 * Why isn't this path going to be indexed? Discriminator drives the
 * red/amber pill in the UI; `detail` carries the matched rule for
 * tooltip display.
 */
export type ExclusionReason =
  | { kind: "canonical_origin"; detail: string }
  | { kind: "canonical_external"; detail: string }
  | { kind: "noindex"; detail: string }
  | { kind: "redirect_source"; detail: string };

export type Verdict = { kind: "include" } | { kind: "exclude"; reason: ExclusionReason };

export interface PathDiagnostic {
  /** Absolute path (`/about`). */
  path: string;
  /** Full URL on the proxy domain. */
  url: string;
  /** Where the path was derived from. Multiple sources possible — we
   *  pick a stable priority order: seed_paths > routing > everything else. */
  sources: PathSource[];
  /** Canonical strategy that applies to this path (resolved or default). */
  canonical: "self" | "origin" | "noindex" | "custom";
  /** When canonical resolves to `custom`, the destination URL. */
  canonicalCustomUrl: string | null;
  /** Whether canonical was explicitly matched by a rule (vs. fallthrough default). */
  canonicalMatched: boolean;
  /** Indexation directive (`index`/`noindex`/...) applicable to this path, or null. */
  robots: string | null;
  /** True when this path appears in `redirects.static[].from`. */
  redirectSource: boolean;
  /** Final verdict: include in sitemap + indexer pings, or exclude. */
  verdict: Verdict;
}

/**
 * First-match canonical lookup, mirroring the proxy-runtime resolver
 * and the sitemap generator's filter so all three agree.
 *
 * Returns the matched rule's strategy plus the rule's `match` regex
 * so the UI can show *which* rule blocked the path.
 */
function canonicalForPath(
  path: string,
  config: ClientConfig,
): {
  strategy: "self" | "origin" | "noindex" | "custom";
  customUrl: string | null;
  match: string;
} | null {
  for (const rule of config.canonicals) {
    try {
      const re = new RegExp(rule.match);
      if (!re.test(path)) continue;
      return {
        strategy: rule.strategy.type,
        customUrl: rule.strategy.type === "custom" ? rule.strategy.url : null,
        match: rule.match,
      };
    } catch {
      /* admin-time validator rejected unsafe regex; ignore here */
    }
  }
  return null;
}

/**
 * SEO-default canonical for proxy routes is `origin`; custom_page
 * routes default to `self` (PRD §6.3). When no routing rule matches,
 * we conservatively assume `origin`.
 */
function defaultCanonical(path: string, config: ClientConfig): "self" | "origin" {
  for (const rule of config.routing) {
    try {
      const re = new RegExp(rule.match);
      if (!re.test(path)) continue;
      return rule.type === "custom_page" ? "self" : "origin";
    } catch {
      /* ignore */
    }
  }
  return "origin";
}

/**
 * Look up the indexation `robots` directive matching `path`, or null
 * if no rule matches.
 */
function indexationForPath(path: string, config: ClientConfig): string | null {
  for (const rule of config.indexation) {
    try {
      const re = new RegExp(rule.match);
      if (re.test(path)) return rule.robots;
    } catch {
      /* ignore */
    }
  }
  return null;
}

/**
 * Collect every candidate path the config touches plus seed_paths,
 * tagged with where each one was derived from. Deduplicated; sources
 * are merged so `/about` declared in both `routing[]` and
 * `seed_paths` shows up once with both sources.
 */
function collectAllCandidates(
  config: ClientConfig,
): Array<{ path: string; sources: PathSource[] }> {
  const map = new Map<string, Set<PathSource>>();
  const eat = (matchOrPath: string, source: PathSource, isLiteralPath = false): void => {
    const literal = isLiteralPath ? matchOrPath : deriveLiteralPath(matchOrPath);
    if (!literal) return;
    const existing = map.get(literal);
    if (existing) {
      existing.add(source);
    } else {
      map.set(literal, new Set([source]));
    }
  };
  for (const r of config.routing) eat(r.match, "routing");
  for (const r of config.text_rewrites) eat(r.match, "text_rewrites");
  for (const r of config.meta_rewrites) eat(r.match, "meta_rewrites");
  for (const r of config.canonicals) eat(r.match, "canonicals");
  for (const r of config.schema_injections) eat(r.match, "schema_injections");
  for (const r of config.content_injections) eat(r.match, "content_injections");
  for (const r of config.element_removals) eat(r.match, "element_removals");
  for (const p of config.seed_paths) eat(p, "seed_paths", true);

  // Implicit homepage: every site gets `/` as a candidate, sourced
  // as a seed_path. Falls through the same eligibility checks
  // (noindex / redirect_source / explicit canonical) as any other
  // seed — operator can still exclude the homepage by adding the
  // right rule, but the indexing page will show it (so the row
  // exists to Probe / Check indexed / Make indexable).
  if (!map.has("/")) eat("/", "seed_paths", true);

  // Stable source priority for UI display: seed_paths first, then
  // routing, then the rest in declaration order.
  const priority: PathSource[] = [
    "seed_paths",
    "routing",
    "text_rewrites",
    "meta_rewrites",
    "canonicals",
    "schema_injections",
    "content_injections",
    "element_removals",
  ];
  return Array.from(map.entries())
    .map(([path, sources]) => ({
      path,
      sources: priority.filter((p) => sources.has(p)),
    }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Compute per-path diagnostics for every candidate path in this
 * config. Returns one row per unique path, sorted lexicographically.
 *
 * Verdict mirrors the sitemap generator's filter logic exactly:
 *   - `seed_paths` bypass the canonical filter (operator
 *     declaration). Other sources require canonical=self.
 *   - All paths respect noindex + redirect-source (active blockers).
 */
export function computePathDiagnostics(config: ClientConfig): PathDiagnostic[] {
  const candidates = collectAllCandidates(config);
  const out: PathDiagnostic[] = [];
  for (const { path, sources } of candidates) {
    const canonRule = canonicalForPath(path, config);
    const canonical = canonRule?.strategy ?? defaultCanonical(path, config);
    const canonicalCustomUrl = canonRule?.customUrl ?? null;
    const canonicalMatched = canonRule !== null;

    const robots = indexationForPath(path, config);
    const redirectSource = config.redirects.static.some((r) => r.from === path);
    const isSeed = sources.includes("seed_paths");

    // seed_paths only override the *default* canonical=origin
    // (i.e. no rule matched). An EXPLICIT canonicals[] rule wins
    // regardless of seed status — operator wrote both, the more
    // specific signal (the canonical rule) takes priority since
    // advertising a URL that says "I'm canonical of XYZ elsewhere"
    // gives engines a contradictory signal.
    const seedOverridesCanonical = isSeed && !canonicalMatched;

    let verdict: Verdict;
    if (robots && /\bnoindex\b/i.test(robots)) {
      verdict = { kind: "exclude", reason: { kind: "noindex", detail: robots } };
    } else if (redirectSource) {
      verdict = {
        kind: "exclude",
        reason: { kind: "redirect_source", detail: "Path appears in redirects.static[].from" },
      };
    } else if (canonical === "noindex") {
      verdict = {
        kind: "exclude",
        reason: { kind: "noindex", detail: "Canonical strategy = noindex" },
      };
    } else if (canonical === "origin" && !seedOverridesCanonical) {
      verdict = {
        kind: "exclude",
        reason: {
          kind: "canonical_origin",
          detail: canonicalMatched
            ? "Canonical points to origin (this site isn't authoritative)"
            : "Default canonical for proxy routes = origin (no `canonicals[]` rule matched)",
        },
      };
    } else if (canonical === "custom") {
      verdict = {
        kind: "exclude",
        reason: {
          kind: "canonical_external",
          detail: canonicalCustomUrl
            ? `Canonical points to ${canonicalCustomUrl}`
            : "Canonical points to a custom external URL",
        },
      };
    } else {
      // canonical=self, or seed_paths overrides the default-origin fallthrough.
      verdict = { kind: "include" };
    }

    out.push({
      path,
      url: `https://${config.proxy_domain}${path}`,
      sources,
      canonical,
      canonicalCustomUrl,
      canonicalMatched,
      robots,
      redirectSource,
      verdict,
    });
  }
  return out;
}
