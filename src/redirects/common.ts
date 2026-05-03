/**
 * Shared types and constants for the redirect layer.
 * Spec: docs/tech-spec.md §6.2.
 *
 * All three sub-resolvers (static-map, pattern-matcher, conditional)
 * return values shaped as `RedirectMatched | null`. The orchestrator in
 * `index.ts` lifts `null` to `NoRedirect` and short-circuits on the
 * first match across layers.
 */

import type { RedirectStatusCode } from "../config/schema.js";

/** Maximum chained-hops within a single layer before returning 508 (§6.2). */
export const MAX_HOPS = 3;

export interface RedirectMatched {
  matched: true;
  destination: string;
  status: 301 | 302 | 307 | 308 | 410 | 508;
  source_layer: "static" | "pattern" | "conditional";
  /** Index of the rule in the layer array that initiated the chain. */
  source_index: number;
}

export interface NoRedirect {
  matched: false;
}

export type RedirectResult = RedirectMatched | NoRedirect;

const STATUS_NUM: Record<string, 301 | 302 | 307 | 308 | 410> = {
  "301": 301,
  "302": 302,
  "307": 307,
  "308": 308,
  "410": 410,
};

/**
 * Convert a Zod-parsed RedirectStatusCode (string enum) to the numeric
 * status code used in `RedirectMatched.status`.
 *
 * @param status the status string from a redirect rule
 * @returns the numeric status code
 * @throws never (Zod has already validated the enum)
 */
export function statusFromString(
  status: ReturnType<typeof RedirectStatusCode.parse>,
): 301 | 302 | 307 | 308 | 410 {
  return STATUS_NUM[status] ?? 301;
}

/**
 * Build a 508-loop-overflow result for the given layer.
 *
 * @param layer the layer the loop was detected in
 * @param sourceIndex index of the rule that initiated the chain
 * @returns a RedirectMatched with status 508 and destination "/"
 */
export function loopOverflow(
  layer: RedirectMatched["source_layer"],
  sourceIndex: number,
): RedirectMatched {
  return {
    matched: true,
    destination: "/",
    status: 508,
    source_layer: layer,
    source_index: sourceIndex,
  };
}
