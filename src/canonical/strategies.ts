/**
 * Canonical strategy resolution: `self`, `origin`, `custom`, `noindex`.
 * Spec: docs/tech-spec.md §6.3.
 *
 * Pure functions — no config or routing knowledge. The orchestrator in
 * `index.ts` picks the strategy and supplies the source domain.
 */

import type { CanonicalStrategy } from "../config/schema.js";

export interface ResolvedStrategy {
  strategy: "self" | "origin" | "custom" | "noindex";
  /** null when strategy is "noindex" */
  url: string | null;
}

/**
 * Apply a canonical strategy against the in-flight URL.
 *
 * @param strategy the strategy tuple from a `CanonicalRule` (or a synthetic
 *   default tuple constructed by the orchestrator)
 * @param url the in-flight request URL on the proxy domain
 * @param sourceDomain the source domain from the ClientConfig
 *   (used by the `origin` strategy)
 * @returns a resolved strategy with the canonical URL (or null for noindex)
 * @throws never
 */
export function applyStrategy(
  strategy: CanonicalStrategy,
  url: URL,
  sourceDomain: string,
): ResolvedStrategy {
  switch (strategy.type) {
    case "self":
      return { strategy: "self", url: url.toString() };
    case "origin": {
      // Rewrite hostname to source_domain. Per spec §6.3 we preserve
      // path and query; the port from the proxy URL is dropped because
      // source_domain is conventionally a bare host (origin runs on the
      // standard HTTPS port). Protocol stays as-is.
      const u = new URL(url.toString());
      u.hostname = sourceDomain;
      u.port = "";
      return { strategy: "origin", url: u.toString() };
    }
    case "custom":
      // Custom URL is fully specified by config — Zod's .url() validator
      // already enforces it parses as an absolute URL.
      return { strategy: "custom", url: strategy.url };
    case "noindex":
      return { strategy: "noindex", url: null };
  }
}
