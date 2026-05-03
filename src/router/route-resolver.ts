/**
 * Resolve the single matching route rule for a URL path.
 * Spec: docs/tech-spec.md §5 step 6 and §4 (`RouteRule`).
 *
 * STATUS: M3-mockup partial. First-match-wins over the routing array
 * with a per-config WeakMap-cached compiled regex list (compile-once
 * contract from §6.2 applied here too).
 */

import type { ClientConfig, RouteRule } from "../config/schema.js";

export interface ResolvedRoute {
  rule: RouteRule;
  index: number;
}

const COMPILED_CACHE = new WeakMap<ClientConfig, RegExp[]>();

function getCompiled(config: ClientConfig): RegExp[] {
  const cached = COMPILED_CACHE.get(config);
  if (cached) return cached;
  const compiled = config.routing.map((r) => new RegExp(r.match));
  COMPILED_CACHE.set(config, compiled);
  return compiled;
}

/**
 * Resolve the first route rule whose `match` regex matches the path.
 *
 * @param path the URL pathname
 * @param config the resolved ClientConfig
 * @returns the matched rule and its index, or null if no rule matches
 * @throws never
 */
export function resolveRoute(path: string, config: ClientConfig): ResolvedRoute | null {
  const compiled = getCompiled(config);
  for (let i = 0; i < config.routing.length; i++) {
    const re = compiled[i];
    const rule = config.routing[i];
    if (!re || !rule) continue;
    if (re.test(path)) return { rule, index: i };
  }
  return null;
}
