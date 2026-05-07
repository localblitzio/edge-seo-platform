/**
 * Config loader. Spec: docs/tech-spec.md §6.1.
 *
 * KV-first, D1 fallback with write-through (60s TTL). Returns a parsed,
 * invariant-checked `ClientConfig` or throws.
 *
 * Performance budget: 5ms p99 on KV cache hit, 50ms p99 on D1 fallback (§11).
 *
 * The Worker loader does NOT perform admin-side cleanup. On revocation
 * (status flip to `paused`/`terminated`), the admin pipeline is responsible
 * for deleting these KV keys and issuing a Cloudflare cache purge:
 *   - `domain:${proxy_domain}`
 *   - `config:${client_id}`
 *   - `redirects:${client_id}`
 *   - `placements:${client_id}`
 *
 * Link-project placements (Slice 2B) are stored at `placements:${client_id}`
 * as a JSON envelope of pre-synthesized ContentInjectRule entries. The
 * loader reads this in parallel with the main config and appends the
 * entries to `config.content_injections`. Operator-defined rules are
 * preserved and run first; placement rules run after.
 *
 * On any validation failure, the loader throws ConfigValidationError. The
 * Worker continues serving the previously cached config (whatever is in
 * KV) until a valid replacement is written through. Per spec §7: "On any
 * divergence between admin-time and load-time validation, alert and refuse
 * to populate KV."
 */

import type { ExecutionContext } from "@cloudflare/workers-types";

import type { Env } from "../env.js";
import { ConfigNotFoundError, ConfigValidationError } from "../lib/errors.js";
import { ClientConfig, type ContentInjectRule } from "./schema.js";
import { assertConfigInvariants } from "./validator.js";

/** TTL for write-through cache entries written by the Worker on D1 fallback. */
const KV_WRITETHROUGH_TTL_SECONDS = 60;

/**
 * Resolve and validate the ClientConfig for a given Host header.
 *
 * @param hostHeader the proxy domain from `request.headers.get("host")`
 * @param env Worker bindings (CONFIG_KV, CONFIG_DB)
 * @param ctx ExecutionContext for `waitUntil` write-through to KV
 * @returns the parsed and invariant-checked ClientConfig with link-project
 *   placements (if any) merged into `content_injections`
 * @throws ConfigNotFoundError if no client maps to the given host
 * @throws ConfigValidationError if the stored config fails Zod or invariants
 */
export async function loadConfig(
  hostHeader: string,
  env: Env,
  ctx: ExecutionContext,
): Promise<ClientConfig> {
  // 1. KV: domain → client_id
  const cachedClientId = await env.CONFIG_KV.get(`domain:${hostHeader}`);

  // 2. KV: client_id → config_json (and placements:client_id in parallel).
  if (cachedClientId !== null) {
    const [cachedConfig, placementsRaw] = await Promise.all([
      env.CONFIG_KV.get(`config:${cachedClientId}`),
      env.CONFIG_KV.get(`placements:${cachedClientId}`),
    ]);
    if (cachedConfig !== null) {
      return mergePlacements(parseAndValidate(cachedConfig), placementsRaw);
    }
  }

  // 3. D1 fallback (single query that returns both client_id and config_json).
  const row = await env.CONFIG_DB.prepare(
    "SELECT client_id, config_json FROM clients WHERE proxy_domain = ?",
  )
    .bind(hostHeader)
    .first<{ client_id: string; config_json: string }>();

  if (row === null) {
    throw new ConfigNotFoundError(`No client mapped to host: ${hostHeader}`);
  }

  // Validate BEFORE writing through, so KV never caches an invalid config.
  const validated = parseAndValidate(row.config_json);

  // 4. Write-through to KV (best-effort, non-blocking).
  ctx.waitUntil(
    Promise.all([
      env.CONFIG_KV.put(`domain:${hostHeader}`, row.client_id, {
        expirationTtl: KV_WRITETHROUGH_TTL_SECONDS,
      }),
      env.CONFIG_KV.put(`config:${row.client_id}`, row.config_json, {
        expirationTtl: KV_WRITETHROUGH_TTL_SECONDS,
      }),
    ]),
  );

  // On D1 fallback we still want placements merged. Read from KV
  // directly — placements are written by the admin pipeline, never
  // backfilled from D1 here, so a cache miss just means "no placements
  // for this client" which is the correct merge result.
  const placementsRaw = await env.CONFIG_KV.get(`placements:${row.client_id}`);
  return mergePlacements(validated, placementsRaw);
}

/**
 * Merge link-project placements into the given config's
 * `content_injections` list. Operator-defined rules run first; placement
 * rules run after, so an operator's rule that targets the same selector
 * wins on order-dependent semantics (later append still works since
 * HTMLRewriter applies rules in attach order).
 *
 * Defensive: swallow JSON parse / shape errors. A malformed placements
 * entry must NOT break HTML serving — we'd rather quietly skip the
 * link injection than 500 the request. The admin write path validates
 * before writing, so corruption only happens via direct KV edits.
 */
function mergePlacements(config: ClientConfig, placementsRaw: string | null): ClientConfig {
  if (placementsRaw === null) return config;
  let envelope: { content_injections?: unknown };
  try {
    envelope = JSON.parse(placementsRaw);
  } catch (e) {
    console.warn("loader: placements JSON parse failed, skipping merge", e);
    return config;
  }
  const synth = envelope.content_injections;
  if (!Array.isArray(synth) || synth.length === 0) return config;
  // Shape-check each entry against ContentInjectRule before merging —
  // a corrupt entry would fail in the rewriter at request time (worse
  // than skipping silently here).
  const valid: ContentInjectRule[] = [];
  for (const item of synth) {
    if (
      typeof item !== "object" ||
      item === null ||
      typeof (item as Record<string, unknown>).match !== "string" ||
      typeof (item as Record<string, unknown>).selector !== "string" ||
      typeof (item as Record<string, unknown>).position !== "string" ||
      typeof (item as Record<string, unknown>).html !== "string"
    ) {
      continue;
    }
    valid.push(item as ContentInjectRule);
  }
  if (valid.length === 0) return config;
  return { ...config, content_injections: [...config.content_injections, ...valid] };
}

/**
 * Parse a stored config JSON string and apply Zod + load-time invariants.
 *
 * @param json the stored config JSON
 * @returns a parsed, invariant-checked ClientConfig
 * @throws ConfigValidationError on JSON parse failure, Zod failure, or invariant failure
 */
function parseAndValidate(json: string): ClientConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (e) {
    throw new ConfigValidationError("stored config is not valid JSON", e);
  }

  const parsed = ClientConfig.safeParse(raw);
  if (!parsed.success) {
    throw new ConfigValidationError("config failed Zod validation", parsed.error);
  }

  return assertConfigInvariants(parsed.data);
}
