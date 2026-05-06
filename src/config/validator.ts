/**
 * Load-time invariants applied AFTER `ClientConfig.parse(...)`.
 * Spec: docs/tech-spec.md §4 ("Additional load-time invariants").
 *
 * Implements:
 * 1. `redirects.static[].from` uniqueness within a config.
 * 2. ≤1000 inline `redirects.static[]`; overflow must move to a separate
 *    KV key (`redirects:${client_id}`) at admin time.
 * 3. Regex linter on every user-supplied regex field (`pattern`, `match`,
 *    `match_pattern`, `match_action`): no nested quantifiers, ≤512 chars,
 *    must compile.
 * 4. JSON-LD payload `JSON.stringify` round-trip — fail on cycles or
 *    non-serializable values (function/symbol/bigint/undefined/non-finite).
 *
 * On any invariant failure, throw `ConfigValidationError`. The Worker
 * loader continues serving the previously cached config (§6.1, §7).
 */

import { ConfigValidationError } from "../lib/errors.js";
import { RESERVED_SUBDOMAINS, subdomainOfDefaultZone } from "./proxy-zone.js";
import type { ClientConfig } from "./schema.js";

const MAX_INLINE_STATIC_REDIRECTS = 1000;
const MAX_REGEX_LENGTH = 512;

/**
 * Apply load-time invariants beyond the raw Zod parse.
 *
 * @param config a Zod-parsed ClientConfig
 * @returns the same config (passthrough) on success
 * @throws ConfigValidationError on any invariant failure
 */
export function assertConfigInvariants(config: ClientConfig): ClientConfig {
  assertStaticRedirectInvariants(config);
  assertRegexInvariants(config);
  assertJsonLdSerializability(config);
  assertReservedSubdomain(config);
  assertInPlaceModeInvariants(config);
  return config;
}

/**
 * In-place mode loop-guard. Two cases:
 *
 *   1. **No `resolve_override`** (simple): the proxy fetch goes to
 *      `route.origin` URL directly. That URL's host MUST NOT equal
 *      `proxy_domain` — otherwise every fetch hits this same Workers
 *      Route, infinite recursion until the runtime aborts.
 *
 *   2. **With `resolve_override`** (managed-host case): the worker
 *      fetches `route.origin` URL but resolves IPs via the override
 *      hostname. This is the right pattern when the origin server's
 *      TLS cert + vhost are bound to the customer's public domain
 *      (typical with managed WP hosts on a single IP). In this case
 *      `origin` host CAN equal `proxy_domain` (in fact it usually
 *      will), but the override hostname MUST differ from
 *      `proxy_domain` — otherwise the override resolves to the
 *      Workers Route's IP and we still loop.
 *
 * Subdomain-proxy mode skips both checks.
 */
function assertInPlaceModeInvariants(config: ClientConfig): void {
  if (config.mode !== "in_place") return;
  const proxyHostLower = config.proxy_domain.toLowerCase();
  config.routing.forEach((rule, i) => {
    if (rule.type !== "proxy") return;
    if (!rule.origin) {
      throw new ConfigValidationError(
        `routing[${i}].origin is required when mode="in_place" — there's no implicit origin in this mode`,
      );
    }
    let originHost: string;
    try {
      originHost = new URL(rule.origin).hostname.toLowerCase();
    } catch {
      throw new ConfigValidationError(`routing[${i}].origin is not a valid URL: ${rule.origin}`);
    }
    if (rule.resolve_override) {
      // Override path: origin URL host can equal proxy_domain, but the
      // override hostname must not.
      if (rule.resolve_override.toLowerCase() === proxyHostLower) {
        throw new ConfigValidationError(
          `routing[${i}].resolve_override (${rule.resolve_override}) equals proxy_domain (${proxyHostLower}); in_place mode would loop. Use a separate hostname like origin.${proxyHostLower}.`,
        );
      }
      return;
    }
    if (originHost === proxyHostLower) {
      throw new ConfigValidationError(
        `routing[${i}].origin host (${originHost}) equals proxy_domain (${proxyHostLower}); in_place mode would loop. Either use a separate origin URL, or set routing[${i}].resolve_override to a non-overlapping hostname like origin.${proxyHostLower}.`,
      );
    }
  });
}

/**
 * If `proxy_domain` is on the default zone (`<sub>.${DEFAULT_PROXY_ZONE}`),
 * the leftmost subdomain label must not collide with a reserved
 * infrastructure name (www, api, admin, etc. — see `RESERVED_SUBDOMAINS`).
 *
 * Custom domains are NOT checked here — operators choosing their own domain
 * are responsible for any subdomain collisions on that zone.
 */
function assertReservedSubdomain(config: ClientConfig): void {
  const sub = subdomainOfDefaultZone(config.proxy_domain);
  if (sub === null) return;
  // Take the leftmost label only; multi-level subdomains (e.g.
  // "foo.bar.localpage.us.com") only check "foo".
  const leftmost = sub.split(".")[0] ?? "";
  if (RESERVED_SUBDOMAINS.has(leftmost)) {
    throw new ConfigValidationError(
      `proxy_domain leftmost subdomain "${leftmost}" is reserved on the default zone`,
    );
  }
}

function assertStaticRedirectInvariants(config: ClientConfig): void {
  const statics = config.redirects.static;

  if (statics.length > MAX_INLINE_STATIC_REDIRECTS) {
    throw new ConfigValidationError(
      `redirects.static has ${statics.length} entries; inline cap is ${MAX_INLINE_STATIC_REDIRECTS}. ` +
        `Move overflow to KV key 'redirects:${config.client_id}' at admin time.`,
    );
  }

  const seen = new Set<string>();
  for (const entry of statics) {
    if (seen.has(entry.from)) {
      throw new ConfigValidationError(`redirects.static contains duplicate 'from': ${entry.from}`);
    }
    seen.add(entry.from);
  }
}

interface RegexField {
  /** dotted path for error messages */
  path: string;
  /** the regex source string */
  pattern: string;
}

function collectRegexFields(config: ClientConfig): RegexField[] {
  const out: RegexField[] = [];
  config.routing.forEach((r, i) => out.push({ path: `routing[${i}].match`, pattern: r.match }));
  config.redirects.patterns.forEach((r, i) =>
    out.push({ path: `redirects.patterns[${i}].pattern`, pattern: r.pattern }),
  );
  config.redirects.conditional.forEach((r, i) =>
    out.push({ path: `redirects.conditional[${i}].match`, pattern: r.match }),
  );
  config.canonicals.forEach((r, i) =>
    out.push({ path: `canonicals[${i}].match`, pattern: r.match }),
  );
  config.schema_injections.forEach((r, i) =>
    out.push({ path: `schema_injections[${i}].match`, pattern: r.match }),
  );
  config.link_rewrites.forEach((r, i) => {
    out.push({ path: `link_rewrites[${i}].match`, pattern: r.match });
    out.push({ path: `link_rewrites[${i}].match_pattern`, pattern: r.match_pattern });
  });
  config.element_removals.forEach((r, i) =>
    out.push({ path: `element_removals[${i}].match`, pattern: r.match }),
  );
  config.content_injections.forEach((r, i) =>
    out.push({ path: `content_injections[${i}].match`, pattern: r.match }),
  );
  config.text_rewrites.forEach((r, i) =>
    out.push({ path: `text_rewrites[${i}].match`, pattern: r.match }),
  );
  config.meta_rewrites.forEach((r, i) =>
    out.push({ path: `meta_rewrites[${i}].match`, pattern: r.match }),
  );
  config.indexation.forEach((r, i) =>
    out.push({ path: `indexation[${i}].match`, pattern: r.match }),
  );
  config.caching.forEach((r, i) => out.push({ path: `caching[${i}].match`, pattern: r.match }));
  config.forms.forEach((r, i) =>
    out.push({ path: `forms[${i}].match_action`, pattern: r.match_action }),
  );
  return out;
}

function assertRegexInvariants(config: ClientConfig): void {
  for (const { path, pattern } of collectRegexFields(config)) {
    const reason = checkRegexSafety(pattern);
    if (reason) {
      throw new ConfigValidationError(`${path}: ${reason} (pattern: ${truncate(pattern)})`);
    }
  }
}

/**
 * Heuristic safety check on a regex source string.
 *
 * Detects the canonical ReDoS shape — a quantified group whose body also
 * contains a quantifier — e.g., `(a+)+`, `(a*)*`, `(a+)*`, `(.+)+`,
 * `(?:a+|b)+`. This is not exhaustive (perfect ReDoS detection is
 * undecidable), but it catches the patterns called out in spec §4 and
 * the `(a+)+$` test scenario in §12.2.
 *
 * @param pattern the regex source string
 * @returns null on safe, otherwise a human-readable reason string
 */
export function checkRegexSafety(pattern: string): string | null {
  if (pattern.length > MAX_REGEX_LENGTH) {
    return `pattern exceeds ${MAX_REGEX_LENGTH}-character limit (got ${pattern.length})`;
  }

  // Canonical nested-quantifier shape: a group that contains `+` or `*`,
  // immediately followed by ANOTHER UNBOUNDED quantifier (`+`, `*`, or
  // `{n,}` without an upper bound). The outer quantifier must be
  // unbounded for catastrophic backtracking — `(/.*)?` is bounded (0
  // or 1 reps) and is a common shape in our static-site routing.
  if (/\([^)]*[+*][^)]*\)\s*(?:[+*]|\{\d*,\}(?!\d))/.test(pattern)) {
    return "nested quantifier — potential ReDoS (e.g. `(a+)+`)";
  }

  try {
    new RegExp(pattern);
  } catch (e) {
    return `invalid regex: ${(e as Error).message}`;
  }

  return null;
}

function truncate(s: string): string {
  return s.length > 80 ? `${s.slice(0, 77)}...` : s;
}

function assertJsonLdSerializability(config: ClientConfig): void {
  config.schema_injections.forEach((rule, i) => {
    const path = `schema_injections[${i}].payload`;
    const walkError = walkJsonValue(rule.payload, path, new WeakSet());
    if (walkError) {
      throw new ConfigValidationError(walkError);
    }
  });
}

function walkJsonValue(value: unknown, path: string, seen: WeakSet<object>): string | null {
  if (value === null) return null;

  const t = typeof value;
  if (t === "string" || t === "boolean") return null;
  if (t === "number") {
    return Number.isFinite(value) ? null : `${path}: non-finite number (${String(value)})`;
  }
  if (t === "function") return `${path}: functions are not JSON-serializable`;
  if (t === "symbol") return `${path}: symbols are not JSON-serializable`;
  if (t === "bigint") return `${path}: bigint values are not JSON-serializable`;
  if (t === "undefined") return `${path}: undefined is not JSON-serializable`;

  // typeof === "object" and value !== null
  const obj = value as object;
  if (seen.has(obj)) {
    return `${path}: circular reference`;
  }
  seen.add(obj);
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      const err = walkJsonValue(value[i], `${path}[${i}]`, seen);
      if (err) return err;
    }
    return null;
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const err = walkJsonValue(v, `${path}.${k}`, seen);
    if (err) return err;
  }
  return null;
}
