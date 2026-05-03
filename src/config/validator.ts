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
  return config;
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
  // immediately followed by another quantifier (`+`, `*`, `?`, or `{n,}`).
  if (/\([^)]*[+*][^)]*\)\s*[+*?{]/.test(pattern)) {
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
