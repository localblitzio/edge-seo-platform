/**
 * Static redirect map — exact-path lookup, O(1) via Map.
 * Spec: docs/tech-spec.md §6.2.
 *
 * Inline configs cap at 1000 entries (enforced in config/validator.ts);
 * overflow lives in the separate KV key `redirects:${client_id}` and is
 * lazy-loaded on first resolution attempt per request (§6.1). For now,
 * `resolveStatic` operates on the inline array — KV-backed overflow is
 * loaded into the same array shape by the caller before invocation.
 *
 * The 3-hop loop guard applies WITHIN the static map only — destinations
 * are NOT re-evaluated against the pattern or conditional layers (§6.2).
 */

import type { StaticRedirect } from "../config/schema.js";
import { MAX_HOPS, type RedirectMatched, loopOverflow, statusFromString } from "./common.js";

interface StaticEntry {
  rule: StaticRedirect;
  index: number;
}

export interface StaticMap {
  byPath: Map<string, StaticEntry>;
}

/**
 * Build an O(1) lookup map over a static-redirect array.
 * Uniqueness of `from` is guaranteed by config/validator.ts.
 *
 * @param redirects the static-redirect array from a ClientConfig
 * @returns a path-keyed map for use with `resolveStatic`
 * @throws never
 */
export function buildStaticMap(redirects: readonly StaticRedirect[]): StaticMap {
  const byPath = new Map<string, StaticEntry>();
  redirects.forEach((rule, index) => {
    byPath.set(rule.from, { rule, index });
  });
  return { byPath };
}

/**
 * Resolve an exact-path static redirect, following chains within the
 * same layer up to `MAX_HOPS`. The status code returned is taken from
 * the FIRST matching rule (the one the client originally hit).
 *
 * @param path the URL pathname to look up
 * @param search the URL search string (e.g. "?foo=bar"), used for `preserve_query`
 * @param map the compiled StaticMap
 * @returns a RedirectMatched on hit, or null on miss
 * @throws never
 */
export function resolveStatic(
  path: string,
  search: string,
  map: StaticMap,
): RedirectMatched | null {
  const initialEntry = map.byPath.get(path);
  if (!initialEntry) return null;

  const firstRule = initialEntry.rule;
  const firstIndex = initialEntry.index;

  let currentDestination = firstRule.to;
  let hops = 1;

  while (true) {
    const next = map.byPath.get(currentDestination);
    if (!next) break;
    hops++;
    if (hops > MAX_HOPS) {
      return loopOverflow("static", firstIndex);
    }
    currentDestination = next.rule.to;
  }

  return {
    matched: true,
    destination: firstRule.preserve_query
      ? appendQueryIfMissing(currentDestination, search)
      : currentDestination,
    status: statusFromString(firstRule.status),
    source_layer: "static",
    source_index: firstIndex,
  };
}

function appendQueryIfMissing(destination: string, search: string): string {
  if (!search) return destination;
  if (destination.includes("?")) return destination;
  return `${destination}${search}`;
}
