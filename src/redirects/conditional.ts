/**
 * Conditional redirects — geo, device, cookie, query_param, referrer.
 * Spec: docs/tech-spec.md §4 (`ConditionalRedirect`) and §6.2.
 *
 * One-shot evaluation: first rule whose path-match AND all conditions
 * pass wins. No same-layer chaining (the destination is not re-evaluated
 * against later conditional rules — re-running condition evaluation
 * against a synthetic redirect target doesn't produce meaningful results).
 */

import type { ConditionalRedirect } from "../config/schema.js";
import { type RedirectMatched, statusFromString } from "./common.js";

type Condition = ConditionalRedirect["conditions"][number];

export interface CompiledConditional {
  rules: readonly ConditionalRedirect[];
  compiled: readonly RegExp[];
}

/**
 * Pre-compile path-match regexes once per config load.
 *
 * @param conditional the conditional-redirect array from a ClientConfig
 * @returns compiled regex list ready for `resolveConditional`
 * @throws never
 */
export function compileConditional(
  conditional: readonly ConditionalRedirect[],
): CompiledConditional {
  return {
    rules: conditional,
    compiled: conditional.map((r) => new RegExp(r.match)),
  };
}

/**
 * Cloudflare Workers attaches a `cf` property to incoming requests with
 * geo enrichment fields (country, region, city, etc.). The global Request
 * type does not include this; we narrow via a structural cast.
 */
interface CfProperties {
  country?: string;
}

function getCfCountry(request: Request): string | null {
  const cf = (request as Request & { cf?: CfProperties }).cf;
  return cf?.country ?? null;
}

/**
 * Heuristic device classification from the `User-Agent` header.
 * Cloudflare offers higher-fidelity device detection at the zone level;
 * we apply a simple substring heuristic here so the resolver works in
 * any environment (and is testable without Cloudflare-specific state).
 *
 * @param userAgent the raw `User-Agent` header value, or null
 * @returns one of "mobile" | "tablet" | "desktop"
 * @throws never
 */
export function detectDevice(userAgent: string | null): "mobile" | "tablet" | "desktop" {
  if (!userAgent) return "desktop";
  const ua = userAgent.toLowerCase();
  if (ua.includes("ipad") || ua.includes("tablet")) return "tablet";
  if (ua.includes("mobi") || ua.includes("android") || ua.includes("iphone")) return "mobile";
  return "desktop";
}

/**
 * Parse a single named cookie value out of a Cookie header.
 * Returns null if the cookie isn't present. Equal signs inside the
 * value (e.g. base64-encoded payloads) are preserved.
 *
 * @param header the Cookie header value (may be empty/null)
 * @param name the cookie name to extract
 * @returns the cookie value, or null
 * @throws never
 */
export function getCookieValue(header: string | null, name: string): string | null {
  if (!header) return null;
  const parts = header.split(";");
  for (const part of parts) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    if (key === name) return part.slice(eq + 1).trim();
  }
  return null;
}

/**
 * Evaluate a single condition against a request.
 *
 * @param condition the condition tuple from a ConditionalRedirect
 * @param request the incoming Request (for headers / cf)
 * @param url the parsed URL (for query params)
 * @returns true if the condition holds, false otherwise
 * @throws never
 */
export function evaluateCondition(condition: Condition, request: Request, url: URL): boolean {
  switch (condition.type) {
    case "geo_country": {
      const country = getCfCountry(request);
      return country !== null && condition.in.includes(country);
    }
    case "device": {
      return detectDevice(request.headers.get("user-agent")) === condition.is;
    }
    case "cookie":
      return matchPresenceOrEquals(
        getCookieValue(request.headers.get("cookie"), condition.name),
        condition.exists,
        condition.equals,
      );
    case "query_param":
      return matchPresenceOrEquals(
        url.searchParams.get(condition.name),
        condition.exists,
        condition.equals,
      );
    case "referrer":
      return request.headers.get("referer")?.includes(condition.contains) ?? false;
  }
}

function matchPresenceOrEquals(
  actual: string | null,
  exists: boolean | undefined,
  equals: string | undefined,
): boolean {
  if (exists !== undefined) {
    const present = actual !== null;
    return exists ? present : !present;
  }
  if (equals !== undefined) {
    return actual === equals;
  }
  // Neither flag set: presence-only check.
  return actual !== null;
}

/**
 * Resolve the first conditional redirect rule that matches the path
 * regex AND has all conditions satisfied. No same-layer chaining.
 *
 * @param url the in-flight URL
 * @param request the incoming Request (for headers / cf)
 * @param list compiled conditional list from `compileConditional`
 * @returns a RedirectMatched on hit, or null on miss
 * @throws never
 */
export function resolveConditional(
  url: URL,
  request: Request,
  list: CompiledConditional,
): RedirectMatched | null {
  for (let i = 0; i < list.rules.length; i++) {
    const re = list.compiled[i];
    const rule = list.rules[i];
    if (!re || !rule) continue;
    if (!re.test(url.pathname)) continue;
    const allConditionsMatch = rule.conditions.every((c) => evaluateCondition(c, request, url));
    if (!allConditionsMatch) continue;
    return {
      matched: true,
      destination: rule.to,
      status: statusFromString(rule.status),
      source_layer: "conditional",
      source_index: i,
    };
  }
  return null;
}
