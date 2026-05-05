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
import { buildAssetResponse, buildHtmlResponse, buildNotFoundResponse } from "./renderer.js";

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

  const prefix = route.custom_page_key ?? "";
  // Lookup strategy:
  //   1. Primary key: `<prefix><pathname>` verbatim
  //   2. Trailing-slash alt (single-page custom_page tolerance — see PR #35)
  //   3. Index-html fallback for directory-style URLs (`/site/`,
  //      `/site/about/`) → `<prefix><pathname>index.html`. Mirrors how
  //      static hosts (Netlify, Vercel) resolve directories. Static-site
  //      uploads rely on this; single-page custom_page uploads ignore
  //      it because their key always has an extension or terminator.
  const candidates = buildLookupKeys(prefix, url.pathname);

  // R2 first.
  for (const key of candidates) {
    const r2Object = await env.CONTENT_R2.get(key);
    if (r2Object !== null) {
      // Honor the content-type stored at upload time so CSS / JS /
      // images / fonts in a static-site bundle don't all serve as
      // text/html. Single-page uploads (no metadata, or explicit
      // text/html) keep the legacy buildHtmlResponse path so the
      // existing tests and behavior are unchanged.
      const ct = r2Object.httpMetadata?.contentType;
      if (ct && !ct.startsWith("text/html")) {
        const body = await r2Object.arrayBuffer();
        return buildAssetResponse(body, ct, r2Object.httpEtag, r2Object.uploaded);
      }
      const text = await r2Object.text();
      return buildHtmlResponse(text, r2Object.httpEtag, r2Object.uploaded);
    }
  }

  // KV fallback (single-page only — KV-stored pages never had asset variants).
  for (const key of candidates) {
    const kvContent = await env.CONFIG_KV.get(`page:${key}`);
    if (kvContent !== null) {
      return buildHtmlResponse(kvContent);
    }
  }

  return buildNotFoundResponse();
}

/**
 * Build the ordered list of R2 keys to try for a given pathname. Order
 * matters: explicit storage wins over fallbacks, fallbacks degrade
 * from "very close" (slash toggle) to "directory index" (index.html).
 */
function buildLookupKeys(prefix: string, pathname: string): string[] {
  const keys: string[] = [`${prefix}${pathname}`];
  if (pathname !== "/") {
    if (pathname.endsWith("/")) {
      keys.push(`${prefix}${pathname.slice(0, -1)}`);
      keys.push(`${prefix}${pathname}index.html`);
    } else {
      keys.push(`${prefix}${pathname}/`);
      keys.push(`${prefix}${pathname}/index.html`);
    }
  } else {
    keys.push(`${prefix}/index.html`);
  }
  return keys;
}
