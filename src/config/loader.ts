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
import { ClientConfig } from "./schema.js";
import { assertConfigInvariants } from "./validator.js";

/** TTL for write-through cache entries written by the Worker on D1 fallback. */
const KV_WRITETHROUGH_TTL_SECONDS = 60;

/**
 * Resolve and validate the ClientConfig for a given Host header.
 *
 * @param hostHeader the proxy domain from `request.headers.get("host")`
 * @param env Worker bindings (CONFIG_KV, CONFIG_DB)
 * @param ctx ExecutionContext for `waitUntil` write-through to KV
 * @returns the parsed and invariant-checked ClientConfig
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

  // 2. KV: client_id → config_json
  if (cachedClientId !== null) {
    const cachedConfig = await env.CONFIG_KV.get(`config:${cachedClientId}`);
    if (cachedConfig !== null) {
      return parseAndValidate(cachedConfig);
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

  return validated;
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
