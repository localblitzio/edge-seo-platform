/**
 * Origin fetcher. Spec: docs/tech-spec.md §6.5 and §5 step 7.
 *
 * Dispatches the upstream fetch to either:
 *   - the global `fetch` (for `none`, `aop`, `header_token` auth modes), or
 *   - a Workers mTLS binding's `fetch` (for `mtls` auth, per §6.5 step 7
 *     mtls bullet — the binding is named via `cert_secret_name`).
 *
 * Subrequest cache is disabled (`cf: { cacheTtl: 0, cacheEverything: false }`)
 * because we manage caching at the response layer (§9, §6.5 step 8).
 */

import type { ClientConfig, RouteRule } from "../config/schema.js";
import type { Env } from "../env.js";
import { OriginFetchError } from "../lib/errors.js";
import { buildOriginRequest } from "./request-builder.js";

export interface FetchFromOriginArgs {
  request: Request;
  url: URL;
  route: RouteRule;
  config: ClientConfig;
  env: Env;
}

/** Init for both global fetch and the mTLS binding's fetch. */
const FETCH_INIT = {
  // Subrequest cache disabled — caching happens at the response layer (§9).
  cf: { cacheTtl: 0, cacheEverything: false },
} as const;

/**
 * Fetch the upstream response for a proxied route.
 *
 * @param args inputs (see {@link FetchFromOriginArgs})
 * @returns the raw upstream response (untransformed)
 * @throws OriginFetchError on network/handshake/timeout failure (covers
 *   AOP / mTLS handshake failures per §6.5 step 9)
 */
export async function fetchFromOrigin(args: FetchFromOriginArgs): Promise<Response> {
  const { request, url, route, config, env } = args;

  if (route.type !== "proxy") {
    throw new Error("fetchFromOrigin called on a non-proxy route");
  }

  const origin = route.origin ?? `https://${config.source_domain}`;

  const upstream = buildOriginRequest({
    request,
    url,
    origin,
    stripPrefix: route.strip_prefix,
    originAuth: route.origin_auth,
    env,
  });

  // mTLS routes use the Workers mTLS binding's fetch (§6.5 step 7).
  // The binding is keyed in `env` by the rule's `cert_secret_name`.
  if (route.origin_auth.type === "mtls") {
    const binding = resolveMtlsBinding(env, route.origin_auth.cert_secret_name);
    try {
      return await binding.fetch(upstream, FETCH_INIT);
    } catch (e) {
      throw new OriginFetchError(origin, e);
    }
  }

  try {
    return await fetch(upstream, FETCH_INIT);
  } catch (e) {
    throw new OriginFetchError(origin, e);
  }
}

/**
 * Structural shape we need from the Workers mTLS binding — it exposes a
 * `fetch` method with the same signature as global `fetch`. We avoid
 * importing the `Fetcher` type from `@cloudflare/workers-types` here
 * because it pulls in a Cloudflare-typed Request that conflicts with
 * the DOM Request we're constructing in `request-builder.ts`.
 */
interface MtlsBinding {
  fetch: (request: Request, init?: RequestInit) => Promise<Response>;
}

/**
 * Look up an mTLS binding from the env by name. Throws a clear error
 * when the binding is missing or doesn't expose a `fetch` method —
 * spec §6.5 says "Wrangler binding required in `wrangler.toml`".
 *
 * @param env Worker bindings
 * @param name the `cert_secret_name` from a `RouteRule.origin_auth`
 * @returns the bound mTLS Fetcher
 * @throws OriginFetchError if the binding is missing or invalid
 */
function resolveMtlsBinding(env: Env, name: string): MtlsBinding {
  const candidate = (env as unknown as Record<string, unknown>)[name];
  if (
    !candidate ||
    typeof candidate !== "object" ||
    typeof (candidate as { fetch?: unknown }).fetch !== "function"
  ) {
    throw new OriginFetchError(
      `mtls:${name}`,
      new Error(
        `mTLS binding '${name}' missing or invalid — declare it in wrangler.toml under [[mtls_certificates]]`,
      ),
    );
  }
  return candidate as MtlsBinding;
}
