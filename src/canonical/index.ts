/**
 * Canonical resolver. Spec: docs/tech-spec.md §6.3.
 *
 * Coverage target: 100% (§12.1).
 *
 * **Critical default behavior** (§6.3, PRD §13 — duplicate-content trap):
 *   - When no canonical rule matches AND the resolved route is `proxy`,
 *     the default is `origin`, NOT `self`. Publishing a proxy URL as
 *     canonical of duplicated source content creates the exact SEO
 *     failure mode the platform is meant to avoid.
 *   - When no canonical rule matches AND the route is `custom_page`,
 *     the default is `self` — custom pages are unique to the proxy.
 *   - When no rule matches AND no route resolves at all, we still
 *     default to `origin` (the safer choice — never canonicalize a
 *     proxy URL for content the proxy doesn't actually own).
 *
 * The HTMLRewriter consumer (src/transform/, M5) reads the returned
 * `CanonicalDecision` and mutates `<link rel="canonical">`, `og:url`,
 * `twitter:url`, and JSON-LD `url`/`@id` fields per the sync flags.
 */

import type { ClientConfig } from "../config/schema.js";
import { resolveRoute } from "../router/route-resolver.js";
import { applyStrategy } from "./strategies.js";

export interface CanonicalDecision {
  strategy: "self" | "origin" | "custom" | "noindex";
  /** null only when `strategy === "noindex"` */
  url: string | null;
  sync_og: boolean;
  sync_twitter: boolean;
  sync_jsonld: boolean;
}

/**
 * Module-level WeakMap so each ClientConfig compiles its canonical
 * regexes at most once per Worker isolate lifetime (compile-once
 * contract from §6.2 applied to canonicals too).
 */
const COMPILED_CACHE = new WeakMap<ClientConfig, RegExp[]>();

function getCompiled(config: ClientConfig): RegExp[] {
  const cached = COMPILED_CACHE.get(config);
  if (cached) return cached;
  const compiled = config.canonicals.map((c) => new RegExp(c.match));
  COMPILED_CACHE.set(config, compiled);
  return compiled;
}

/**
 * Resolve the canonical decision for a given URL against a ClientConfig.
 *
 * @param url the in-flight request URL on the proxy domain
 * @param config the resolved ClientConfig
 * @returns a CanonicalDecision describing what the rewriter should emit
 * @throws never
 */
export function resolveCanonical(url: URL, config: ClientConfig): CanonicalDecision {
  const compiled = getCompiled(config);

  // 1. First-match-wins on canonical rules.
  for (let i = 0; i < config.canonicals.length; i++) {
    const re = compiled[i];
    const rule = config.canonicals[i];
    if (!re || !rule) continue;
    if (!re.test(url.pathname)) continue;
    const resolved = applyStrategy(rule.strategy, url, config.source_domain);
    return {
      strategy: resolved.strategy,
      url: resolved.url,
      sync_og: rule.sync_og_url,
      sync_twitter: rule.sync_twitter_url,
      sync_jsonld: rule.sync_jsonld_url,
    };
  }

  // 2. No rule matched — default depends on the resolved route type.
  const matched = resolveRoute(url.pathname, config);
  if (matched && matched.rule.type === "custom_page") {
    return {
      strategy: "self",
      url: url.toString(),
      sync_og: true,
      sync_twitter: true,
      sync_jsonld: true,
    };
  }

  // proxy route OR no route match at all → default to origin canonical.
  // This is the SEO duplicate-content guardrail from PRD §13.
  const origin = new URL(url.toString());
  origin.hostname = config.source_domain;
  origin.port = "";
  return {
    strategy: "origin",
    url: origin.toString(),
    sync_og: true,
    sync_twitter: true,
    sync_jsonld: true,
  };
}
