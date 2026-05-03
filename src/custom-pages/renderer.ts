/**
 * Custom-page rendering helpers.
 * Spec: docs/tech-spec.md §6.6.
 *
 * Pure helpers used by `index.ts`. Kept here so `index.ts` can stay
 * focused on the R2-then-KV orchestration.
 */

const HTML_CONTENT_TYPE = "text/html; charset=utf-8";

/**
 * Build a 200 HTML response from a string body, optionally carrying
 * `ETag` / `Last-Modified` headers from R2 object metadata.
 *
 * @param body the page body (typically HTML)
 * @param etag optional R2 etag (httpEtag)
 * @param lastModified optional R2 uploaded date
 * @returns a Response with the standard HTML content-type and any
 *   provided cache-validator headers
 * @throws never
 */
export function buildHtmlResponse(
  body: string,
  etag?: string | undefined,
  lastModified?: Date | undefined,
): Response {
  const headers = new Headers({ "content-type": HTML_CONTENT_TYPE });
  if (etag) headers.set("etag", etag);
  if (lastModified) headers.set("last-modified", lastModified.toUTCString());
  return new Response(body, { status: 200, headers });
}

/**
 * The standard 404 used when neither R2 nor KV has a matching page.
 *
 * @returns a 404 plain-text Response
 * @throws never
 */
export function buildNotFoundResponse(): Response {
  return new Response("Not Found", {
    status: 404,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}
