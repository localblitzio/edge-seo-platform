/**
 * Pattern (regex) redirect matcher.
 * Spec: docs/tech-spec.md §6.2.
 *
 * Compile-once contract: regexes are pre-compiled by `compilePatterns`
 * and stored alongside the rule list. The same compile-once contract
 * applies to every regex-bearing field across the Worker — canonicals,
 * link rewrites, element removals, content injections, meta rewrites,
 * indexation, conditionals.
 *
 * Loop guard: chains within the pattern layer follow up to `MAX_HOPS`,
 * with cycle detection via a "destination equals current path"
 * fixed-point check plus the standard hop counter. The status code
 * returned is taken from the FIRST matching rule.
 */

import type { PatternRedirect } from "../config/schema.js";
import { MAX_HOPS, type RedirectMatched, loopOverflow, statusFromString } from "./common.js";

export interface CompiledPatterns {
  rules: readonly PatternRedirect[];
  compiled: readonly RegExp[];
}

/**
 * Pre-compile pattern regexes once per config load.
 * Config-side regex safety (nested-quantifier ReDoS, length cap) is
 * enforced by config/validator.ts before this is called.
 *
 * @param patterns the pattern-redirect array from a ClientConfig
 * @returns compiled patterns ready for `resolvePattern`
 * @throws never (validator already rejected unparseable patterns)
 */
export function compilePatterns(patterns: readonly PatternRedirect[]): CompiledPatterns {
  return {
    rules: patterns,
    compiled: patterns.map((p) => new RegExp(p.pattern)),
  };
}

interface MatchHit {
  index: number;
  destination: string;
  status: PatternRedirect["status"];
}

function findFirstMatch(path: string, list: CompiledPatterns): MatchHit | null {
  for (let i = 0; i < list.rules.length; i++) {
    const re = list.compiled[i];
    const rule = list.rules[i];
    if (!re || !rule) continue;
    if (re.test(path)) {
      return {
        index: i,
        destination: path.replace(re, rule.replacement),
        status: rule.status,
      };
    }
  }
  return null;
}

/**
 * Resolve a pattern redirect, following same-layer chains up to MAX_HOPS.
 *
 * @param path the URL pathname to test
 * @param list compiled pattern list from `compilePatterns`
 * @returns a RedirectMatched on hit, or null on miss
 * @throws never
 */
export function resolvePattern(path: string, list: CompiledPatterns): RedirectMatched | null {
  let firstIndex = -1;
  let firstStatus: PatternRedirect["status"] = "301";
  let currentPath = path;
  let hops = 0;

  while (true) {
    const m = findFirstMatch(currentPath, list);
    if (!m) break;

    // Fixed-point check: rule matches but destination equals input.
    // Treat as no progress and return the (now-stable) destination.
    if (m.destination === currentPath) {
      if (firstIndex === -1) {
        firstIndex = m.index;
        firstStatus = m.status;
      }
      break;
    }

    if (firstIndex === -1) {
      firstIndex = m.index;
      firstStatus = m.status;
    }
    currentPath = m.destination;
    hops++;
    if (hops > MAX_HOPS) {
      return loopOverflow("pattern", firstIndex);
    }
  }

  if (firstIndex === -1) return null;

  return {
    matched: true,
    destination: currentPath,
    status: statusFromString(firstStatus),
    source_layer: "pattern",
    source_index: firstIndex,
  };
}
