/**
 * Redirect resolver — orchestrates the three layers in the §5 step 3-5
 * pipeline order: static → pattern → conditional.
 * Spec: docs/tech-spec.md §6.2 and §5 steps 3–5.
 *
 * Layer evaluation rules (§6.2):
 *   - Each request walks the three layers AT MOST ONCE in fixed order.
 *   - The first match in any layer short-circuits and returns; the
 *     destination URL is NOT re-evaluated against earlier or later layers.
 *   - The 3-hop loop guard applies WITHIN a single layer only — see the
 *     individual sub-resolvers.
 *
 * Coverage target: 100% (§12.1 — high-risk logic).
 */

import type { ClientConfig } from "../config/schema.js";
import { type CompiledConditional, compileConditional, resolveConditional } from "./conditional.js";
import { type CompiledPatterns, compilePatterns, resolvePattern } from "./pattern-matcher.js";
import { type StaticMap, buildStaticMap, resolveStatic } from "./static-map.js";

export type {
  NoRedirect,
  RedirectMatched,
  RedirectResult,
} from "./common.js";

export {
  buildStaticMap,
  resolveStatic,
  compilePatterns,
  resolvePattern,
  compileConditional,
  resolveConditional,
};

import type { RedirectResult } from "./common.js";

/**
 * Module-level WeakMap cache keyed by ClientConfig identity. Each
 * ClientConfig object compiles its regexes at most once per Worker
 * isolate lifetime — meeting spec §6.2's "Compile regex patterns once
 * per config load" requirement without adding a separate compile-then-
 * resolve API on the hot path.
 */
interface CompiledRedirects {
  staticMap: StaticMap;
  patterns: CompiledPatterns;
  conditional: CompiledConditional;
}

const COMPILED_CACHE = new WeakMap<ClientConfig, CompiledRedirects>();

function getCompiled(config: ClientConfig): CompiledRedirects {
  const cached = COMPILED_CACHE.get(config);
  if (cached) return cached;
  const compiled: CompiledRedirects = {
    staticMap: buildStaticMap(config.redirects.static),
    patterns: compilePatterns(config.redirects.patterns),
    conditional: compileConditional(config.redirects.conditional),
  };
  COMPILED_CACHE.set(config, compiled);
  return compiled;
}

/**
 * Resolve whether a request should be redirected, walking the three
 * redirect layers in spec §5 order.
 *
 * @param url the incoming request URL
 * @param request the incoming Request (for cf / headers / cookies)
 * @param config the resolved ClientConfig
 * @returns `{ matched: true, ... }` if any layer matches, else `{ matched: false }`
 * @throws never (loop overflow returns a 508 matched result, not an exception)
 */
export function resolveRedirect(url: URL, request: Request, config: ClientConfig): RedirectResult {
  const compiled = getCompiled(config);

  const staticHit = resolveStatic(url.pathname, url.search, compiled.staticMap);
  if (staticHit) return staticHit;

  const patternHit = resolvePattern(url.pathname, compiled.patterns);
  if (patternHit) return patternHit;

  const conditionalHit = resolveConditional(url, request, compiled.conditional);
  if (conditionalHit) return conditionalHit;

  return { matched: false };
}
