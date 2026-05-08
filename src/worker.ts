/**
 * Worker entry point.
 * Spec: docs/tech-spec.md §5 (request lifecycle) and §8 (error handling).
 *
 * STATUS: M10 wire-up — full §5 pipeline in order. The HTMLRewriter
 * pipeline (§5 step 9) runs on HTML responses; the response cache
 * (§5 step 11, §9, §9.1) does early lookup between steps 1 and 3 and
 * post-transform write at the end.
 *
 * The pipeline is otherwise faithful to the spec ordering and error
 * mapping (§8): config load, authorization check (410 on
 * paused/terminated/expired), redirect resolution (static → pattern →
 * conditional), route resolution (proxy or custom_page), header
 * transforms (security + cookie domain rewrite), structured logging,
 * unsampled metrics counters.
 */

import type { ExecutionContext } from "@cloudflare/workers-types";

import { applyAudienceAction, classifyAudience, matchAudienceRule } from "./audience/index.js";
import { readCache, writeCache } from "./cache/index.js";
import { resolveCanonical } from "./canonical/index.js";
import { loadConfig } from "./config/loader.js";
import type { ClientConfig } from "./config/schema.js";
import { renderCustomPage } from "./custom-pages/index.js";
import type { Env } from "./env.js";
import { applyXRobotsTag } from "./indexation/index.js";
import {
  ConfigNotFoundError,
  ConfigValidationError,
  OriginFetchError,
  RedirectLoopError,
} from "./lib/errors.js";
import {
  applySecurityHeaders,
  rewriteCookieDomain,
  rewriteRedirectLocation,
} from "./lib/headers.js";
import { recordBotHit } from "./observability/bot-hits.js";
import { type LogEntry, classifyUserAgent, logRequest } from "./observability/logger.js";
import { emitRequestCounter } from "./observability/metrics.js";
import { fetchFromOrigin } from "./proxy/index.js";
import { resolveRedirect } from "./redirects/index.js";
import { resolveRoute } from "./router/route-resolver.js";
import { getSecret } from "./secrets/store.js";
import { generateSitemapXml, generateSitemapXmlWithUpstream } from "./sitemap/generator.js";
import { extractKeyFromVerificationPath, isIndexNowVerificationPath } from "./sitemap/indexnow.js";
import { buildRewriter, isHtmlResponse } from "./transform/index.js";

interface RequestContext {
  request: Request;
  url: URL;
  hostHeader: string;
  startTime: number;
  client_id: string;
  pipeline_stage: LogEntry["pipeline_stage"];
  cache_status: LogEntry["cache_status"];
  origin_status: number | null;
  origin_duration_ms: number | null;
  redirect_destination: string | null;
  canonical_url: string | null;
  canonical_strategy: string | null;
  errors: string[];
  /** Resolved ClientConfig — null until §5 step 1 succeeds. */
  config: ClientConfig | null;
}

const handler: ExportedHandler<Env> = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const hostHeader = request.headers.get("host") ?? "";

    const rctx: RequestContext = {
      request,
      url,
      hostHeader,
      startTime: Date.now(),
      client_id: "unknown",
      pipeline_stage: "404",
      cache_status: "skip", // cache layer not yet implemented (M10)
      origin_status: null,
      origin_duration_ms: null,
      redirect_destination: null,
      canonical_url: null,
      canonical_strategy: null,
      errors: [],
      config: null,
    };

    let response: Response;
    try {
      response = await runPipeline(rctx, env, ctx);
    } catch (e) {
      response = mapError(e, rctx);
    }

    response = applySecurityHeaders(response);

    // §5 step 11: post-transform cache write. The decision is gated by
    // §9.1 cache-safety invariants inside `writeCache` (Authorization,
    // Set-Cookie, 5xx, bot UAs all bypass). Best-effort, non-blocking;
    // any error is swallowed at the boundary so a failing cache write
    // can never leak an unhandled rejection across requests.
    if (rctx.config !== null && rctx.cache_status !== "hit") {
      ctx.waitUntil(writeCache(request, response.clone(), rctx.config).catch(() => undefined));
    }

    finalize(rctx, response, env, ctx);

    return response;
  },
};

export default handler;

async function runPipeline(
  rctx: RequestContext,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  // §5 step 1: resolve config.
  const config = await loadConfig(rctx.hostHeader, env, ctx);
  rctx.client_id = config.client_id;
  rctx.config = config;

  // §5 step 2: authorization status & expiry.
  const authResult = checkAuthorization(config);
  if (authResult) {
    rctx.pipeline_stage = "404"; // not really 404, but no other enum value fits paused/terminated; logger ok
    return authResult;
  }

  // Special-case routes the worker owns and serves directly without
  // running the redirect/proxy pipeline:
  //
  //   GET /sitemap.xml         → generate from this client's config
  //   GET /<INDEXNOW_KEY>.txt  → IndexNow verification file
  //
  // These run BEFORE redirects so the sitemap can't be redirected
  // away by the operator's static/pattern rules, and BEFORE caching
  // because they're cheap to generate per request and the response
  // headers can drive their own freshness.
  const sitemapResponse = await maybeServeSitemapOrIndexNow(rctx, config, env, ctx);
  if (sitemapResponse) return sitemapResponse;

  // Audience-aware steering — fires BEFORE the regular redirect /
  // route resolution pipeline so rules like "redirect humans to the
  // money site, let bots see the original" or "block AI training
  // crawlers" win over normal routing. First-match-wins; non-matching
  // requests fall through to the regular pipeline.
  const audience = classifyAudience(rctx.request.headers.get("user-agent"));
  const audienceMatch = matchAudienceRule(rctx.url.pathname, audience, config);
  if (audienceMatch) {
    rctx.pipeline_stage =
      audienceMatch.action.type === "custom_page" ? "custom_page" : "redirect_static";
    if (audienceMatch.action.type === "redirect") {
      rctx.redirect_destination = audienceMatch.action.url;
    }
    return applyAudienceAction(audienceMatch.action, rctx.url, config, env);
  }

  // §5 step 11 (early lookup): on HTML cache hit short-circuit
  // steps 3-10. Per §9.1 invariants, the lookup is gated on
  // Authorization, bypass cookies, and method.
  const cacheHit = await readCache(rctx.request, config);
  if (cacheHit) {
    rctx.cache_status = "hit";
    return cacheHit.response;
  }

  // §5 steps 3–5: redirect resolution.
  const redirect = resolveRedirect(rctx.url, rctx.request, config);
  if (redirect.matched) {
    rctx.pipeline_stage = `redirect_${redirect.source_layer}` as LogEntry["pipeline_stage"];
    rctx.redirect_destination = redirect.destination;
    if (redirect.status === 508) {
      throw new RedirectLoopError("redirect loop");
    }
    if (redirect.status === 410) {
      return new Response("Gone", {
        status: 410,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    }
    return new Response(null, {
      status: redirect.status,
      headers: { Location: redirect.destination },
    });
  }

  // §5 step 6: route resolution.
  const matched = resolveRoute(rctx.url.pathname, config);
  if (!matched) {
    rctx.pipeline_stage = "404";
    return new Response("Not Found", {
      status: 404,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }

  // §6.3: resolve the canonical decision now so it's logged for every
  // served request (proxy or custom_page). The HTMLRewriter pipeline in
  // M5 will apply the decision to the response body; for now we just
  // surface it for observability.
  const canonical = resolveCanonical(rctx.url, config);
  rctx.canonical_url = canonical.url;
  rctx.canonical_strategy = canonical.strategy;

  // §5 step 7: fetch upstream (proxy or custom_page).
  let response: Response;
  if (matched.rule.type === "proxy") {
    rctx.pipeline_stage = "proxy";
    const t0 = Date.now();
    const upstream = await fetchFromOrigin({
      request: rctx.request,
      url: rctx.url,
      route: matched.rule,
      config,
      env,
    });
    rctx.origin_duration_ms = Date.now() - t0;
    rctx.origin_status = upstream.status;

    // §5 step 8 / §9 invariant 4: on origin 5xx, serve a previously
    // cached version when available, else return 503. The cache layer
    // is M10; until that lands, we have no cached fallback to hand
    // back, so we always return 503 on upstream 5xx and surface the
    // origin status in the log entry for observability.
    if (upstream.status >= 500) {
      rctx.errors.push(`origin returned ${upstream.status}`);
      response = new Response("Upstream unavailable", {
        status: 503,
        headers: { "content-type": "text/plain; charset=utf-8" },
      });
    } else {
      // In-place mode: customer's public host == origin host, so no
      // cookie-domain or Location-host rewriting is needed (or correct
      // — rewriting would be a no-op at best, a corruption at worst).
      // Subdomain-proxy mode: rewrite both so cookies stay on the proxy
      // domain and origin-issued absolute redirects stay sticky.
      if (config.mode === "in_place") {
        response = upstream;
      } else {
        response = rewriteResponseCookies(upstream, matched.rule, config);
        response = rewriteResponseLocation(response, matched.rule, config);
      }
    }
  } else {
    rctx.pipeline_stage = "custom_page";
    response = await renderCustomPage(rctx.url, matched.rule, env);
  }

  // §5 step 9: HTMLRewriter pipeline — only for HTML responses (§12.2).
  if (isHtmlResponse(response)) {
    const rewriter = buildRewriter(rctx.url, config, canonical);
    response = rewriter.transform(response);
    // The upstream may have set Content-Length; HTMLRewriter rewrites
    // the body so the byte count is no longer accurate. Drop it and let
    // the runtime use chunked transfer encoding.
    const headers = new Headers(response.headers);
    headers.delete("content-length");
    response = new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  } else {
    // PRD §7.6 / M6: non-HTML resources get `X-Robots-Tag` instead of
    // a `<meta name="robots">`. The HTML branch above already injected
    // the meta via the M5 indexation-applier.
    response = applyXRobotsTag(response, rctx.url.pathname, config.indexation);
  }

  return response;
}

function checkAuthorization(config: ClientConfig): Response | null {
  if (config.status !== "active") {
    return new Response("Service unavailable", {
      status: 410,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }
  if (
    config.authorization.expires_at !== null &&
    Date.parse(config.authorization.expires_at) <= Date.now()
  ) {
    return new Response("Authorization expired", {
      status: 410,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }
  return null;
}

function rewriteResponseCookies(
  response: Response,
  route: import("./config/schema.js").RouteRule,
  config: ClientConfig,
): Response {
  const origin = route.origin ?? `https://${config.source_domain}`;
  const originHost = safeHostname(origin) ?? config.source_domain;
  return rewriteCookieDomain(response, originHost, config.proxy_domain);
}

/**
 * Rewrite the upstream Location header so that an origin-host redirect
 * (e.g. WordPress's trailing-slash 301 to `https://source.com/path/`)
 * lands on the proxy domain instead of bouncing the user off the proxy.
 */
function rewriteResponseLocation(
  response: Response,
  route: import("./config/schema.js").RouteRule,
  config: ClientConfig,
): Response {
  const origin = route.origin ?? `https://${config.source_domain}`;
  const originHost = safeHostname(origin) ?? config.source_domain;
  return rewriteRedirectLocation(response, originHost, config.proxy_domain);
}

function safeHostname(origin: string): string | null {
  try {
    return new URL(origin).hostname;
  } catch {
    return null;
  }
}

function mapError(e: unknown, rctx: RequestContext): Response {
  if (e instanceof ConfigNotFoundError) {
    return new Response("Not configured", {
      status: 502,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }
  if (e instanceof ConfigValidationError) {
    rctx.errors.push(`config validation: ${e.message}`);
    return new Response("Configuration error", {
      status: 500,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }
  if (e instanceof OriginFetchError) {
    rctx.errors.push(`origin fetch: ${e.origin}`);
    return new Response("Upstream unavailable", {
      status: 503,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }
  if (e instanceof RedirectLoopError) {
    return new Response("Redirect loop", {
      status: 508,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  }
  rctx.errors.push((e as Error).message ?? String(e));
  return new Response("Internal error", {
    status: 500,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

function classifyContentType(contentType: string | null): string {
  if (!contentType) return "other";
  const normalized = contentType.toLowerCase();
  if (normalized.includes("text/html")) return "html";
  if (normalized.includes("application/json")) return "json";
  if (normalized.includes("text/css")) return "css";
  if (normalized.includes("javascript")) return "js";
  if (normalized.startsWith("image/")) return "image";
  if (normalized.startsWith("font/") || normalized.includes("/font-")) return "font";
  return "other";
}

function finalize(rctx: RequestContext, response: Response, env: Env, ctx: ExecutionContext): void {
  const duration_ms = Date.now() - rctx.startTime;
  const userAgent = rctx.request.headers.get("user-agent");
  const userAgentClass = classifyUserAgent(userAgent);

  // Record per-(client × bot family × hour) hit counts for the Bot
  // activity dashboard. Fire-and-forget so the D1 write doesn't add
  // latency. recordBotHit is itself a no-op for human traffic.
  if (rctx.client_id) {
    ctx.waitUntil(recordBotHit(env.CONFIG_DB, rctx.client_id, userAgent));
  }

  logRequest({
    timestamp: new Date(rctx.startTime).toISOString(),
    client_id: rctx.client_id,
    proxy_domain: rctx.hostHeader,
    request_url: rctx.request.url,
    request_method: rctx.request.method,
    request_path: rctx.url.pathname,
    user_agent_class: userAgentClass,
    status: response.status,
    origin_status: rctx.origin_status,
    pipeline_stage: rctx.pipeline_stage,
    redirect_destination: rctx.redirect_destination,
    canonical_url: rctx.canonical_url,
    canonical_strategy: rctx.canonical_strategy,
    cache_status: rctx.cache_status,
    duration_ms,
    origin_duration_ms: rctx.origin_duration_ms,
    errors: rctx.errors,
  });

  emitRequestCounter(env, {
    client_id: rctx.client_id,
    status: response.status,
    cache_status: rctx.cache_status,
    pipeline_stage: rctx.pipeline_stage,
    worker_duration_ms: duration_ms,
    origin_duration_ms: rctx.origin_duration_ms,
    bytes_out: 0,
    content_type_class: classifyContentType(response.headers.get("content-type")),
  });
}

/**
 * Special-case route handlers that run after auth and before redirects:
 *   - GET /sitemap.xml          → generated from the client's ClientConfig
 *   - GET /<INDEXNOW_KEY>.txt   → returns the bound INDEXNOW_KEY as plain text
 *
 * Returns a Response when the request matched one of these; null
 * otherwise (so the regular pipeline proceeds).
 *
 * Both are GET-only — anything else (POST/PUT/DELETE/etc) falls through
 * to the regular pipeline and 405s on whatever route handler picks it
 * up. HEAD is treated as GET (returns headers without body, per the
 * runtime's standard HEAD/GET behavior on Response objects).
 */
async function maybeServeSitemapOrIndexNow(
  rctx: RequestContext,
  config: ClientConfig,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response | null> {
  const method = rctx.request.method.toUpperCase();
  if (method !== "GET" && method !== "HEAD") return null;
  const path = rctx.url.pathname;

  if (path === "/sitemap.xml") {
    // Use the upstream-merging variant when the operator has opted in;
    // otherwise stick with the cheap operator-only generator.
    const xml = config.ingest_upstream_sitemap
      ? await generateSitemapXmlWithUpstream(config, env, ctx)
      : generateSitemapXml(config);
    rctx.pipeline_stage = "custom_page";
    return new Response(xml, {
      status: 200,
      headers: {
        "content-type": "application/xml; charset=utf-8",
        // Sitemaps are operator-edit-driven; cache for an hour at the
        // edge. Manual cache purge fires on every config save so a real
        // change still propagates within seconds.
        "cache-control": "public, max-age=3600",
      },
    });
  }

  if (isIndexNowVerificationPath(path)) {
    const key = await getSecret(env, "INDEXNOW_KEY");
    if (!key) return null; // No key bound — let the request fall through (404 from origin or 200 if origin serves it).
    const requested = extractKeyFromVerificationPath(path);
    if (requested !== key) return null; // Different key — not our verification file; let it through.
    rctx.pipeline_stage = "custom_page";
    return new Response(key, {
      status: 200,
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "public, max-age=86400",
      },
    });
  }

  return null;
}
