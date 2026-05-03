/**
 * Custom-page renderer. Spec: docs/tech-spec.md §6.6.
 *
 * Storage key per spec §6.6:
 *   `${route.custom_page_key ?? ""}${url.pathname}`
 *
 * R2 lookup: object at exactly that key. The R2 body is materialized
 * as text so the Cloudflare-typed `ReadableStream` (from R2) doesn't
 * collide with the global Response constructor's expected
 * `ReadableStream<Uint8Array>`. Custom pages are typically small
 * (under a few hundred KB); for larger payloads a future iteration
 * can stream via a structural cast or DecompressionStream pipeline.
 *
 * KV fallback: key `page:${storageKey}` so custom-page content
 * doesn't collide with `domain:` / `config:` / `redirects:` keys.
 *
 * On R2 hit, `etag` (httpEtag) and `Last-Modified` (uploaded date)
 * pass through to the response so the HTMLRewriter pipeline downstream
 * — and any future cache layer (M10) — can see fresh validators.
 */

import type { RouteRule } from "../config/schema.js";
import type { Env } from "../env.js";
import { buildHtmlResponse, buildNotFoundResponse } from "./renderer.js";

/**
 * Render a custom page from R2/KV by route key.
 *
 * @param url the in-flight URL
 * @param route the resolved route rule (must be `type: "custom_page"`)
 * @param env Worker bindings (CONTENT_R2, CONFIG_KV)
 * @returns an HTML response, or 404 if no content found
 * @throws never
 */
export async function renderCustomPage(url: URL, route: RouteRule, env: Env): Promise<Response> {
  if (route.type !== "custom_page") {
    return new Response("not a custom_page route", { status: 500 });
  }

  const storageKey = `${route.custom_page_key ?? ""}${url.pathname}`;

  // R2 first.
  const r2Object = await env.CONTENT_R2.get(storageKey);
  if (r2Object !== null) {
    const body = await r2Object.text();
    return buildHtmlResponse(body, r2Object.httpEtag, r2Object.uploaded);
  }

  // KV fallback.
  const kvContent = await env.CONFIG_KV.get(`page:${storageKey}`);
  if (kvContent !== null) {
    return buildHtmlResponse(kvContent);
  }

  return buildNotFoundResponse();
}
