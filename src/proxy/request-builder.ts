/**
 * Build the outbound request for an origin fetch.
 * Spec: docs/tech-spec.md §6.5 steps 1–7.
 *
 * Handles header construction (Host rewrite, X-Forwarded-*, cf-* scrub,
 * Accept-Encoding) and the *header-only* origin auth modes:
 *   - `none`        no auth headers added
 *   - `header_token` reads the named secret from `env`, sets the named header
 *   - `aop`         no per-request work — Authenticated Origin Pulls is
 *                   configured at the zone level and is honored by the
 *                   subsequent global `fetch`
 *
 * The `mtls` mode is NOT handled here because it requires dispatching to a
 * different Fetcher (the Workers mTLS binding). That's `fetchFromOrigin`'s
 * concern in `index.ts` — see §6.5 step 7 mtls bullet.
 */

import type { OriginAuth } from "../config/schema.js";
import type { Env } from "../env.js";

export interface BuildOriginRequestArgs {
  request: Request;
  url: URL;
  origin: string;
  stripPrefix?: string | undefined;
  originAuth: OriginAuth;
  env: Env;
}

/**
 * Build the upstream Request for an origin fetch.
 *
 * @param args inputs (see {@link BuildOriginRequestArgs})
 * @returns a Request ready to pass to global `fetch` (or the mTLS
 *   binding's `.fetch` for `origin_auth.type === "mtls"`)
 * @throws Error if `header_token` references a missing secret in env
 */
export function buildOriginRequest(args: BuildOriginRequestArgs): Request {
  const { request, url, origin, stripPrefix, originAuth, env } = args;
  const originUrl = new URL(origin);

  let path = url.pathname;
  if (stripPrefix && path.startsWith(stripPrefix)) {
    path = path.slice(stripPrefix.length) || "/";
  }
  const targetUrl = new URL(`${path}${url.search}`, originUrl);

  const headers = new Headers(request.headers);

  // Rewrite Host to the origin's hostname.
  headers.set("host", originUrl.host);

  // Forwarded headers (§6.5 steps 3–5).
  const cfIp = request.headers.get("cf-connecting-ip");
  if (cfIp) headers.set("x-forwarded-for", cfIp);
  headers.set("x-forwarded-proto", "https");
  headers.set("x-forwarded-host", url.hostname);

  // Disable upstream compression so HTMLRewriter (M5, §6.4) sees
  // decoded HTML. Cloudflare's HTMLRewriter does NOT decompress; if we
  // let origins return brotli/gzip we'd feed compressed bytes to the
  // parser. Trade-off: lose origin compression for non-HTML routes too.
  // The full M10 cache layer can revisit this and conditionally request
  // compressed bytes for routes whose response we know is non-HTML.
  headers.set("accept-encoding", "identity");

  // Strip Cloudflare-private headers (§6.5 step 6) — they should not
  // leak to origin. We keep CF-Connecting-IP only long enough to
  // populate X-Forwarded-For above.
  for (const name of Array.from(headers.keys())) {
    if (name.toLowerCase().startsWith("cf-")) {
      headers.delete(name);
    }
  }

  // Apply header-based origin auth (§6.5 step 7); mTLS is dispatched
  // separately by `fetchFromOrigin`.
  applyOriginAuth(headers, originAuth, env);

  return new Request(targetUrl.toString(), {
    method: request.method,
    headers,
    body: request.body,
    redirect: "manual",
  });
}

function applyOriginAuth(headers: Headers, auth: OriginAuth, env: Env): void {
  switch (auth.type) {
    case "none":
      return;
    case "aop":
      // Authenticated Origin Pulls is configured at the zone level.
      // No per-request work — the subsequent fetch presents Cloudflare's
      // client cert to the origin automatically.
      return;
    case "header_token": {
      const secret = (env as unknown as Record<string, string | undefined>)[auth.secret_name];
      if (!secret) {
        throw new Error(`origin_auth.header_token references missing secret '${auth.secret_name}'`);
      }
      headers.set(auth.header, secret);
      return;
    }
    case "mtls":
      // mTLS dispatch happens in fetchFromOrigin (different Fetcher),
      // not here. No header to add.
      return;
  }
}
