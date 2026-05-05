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
 * Build a 200 response from arbitrary R2 content. Used for static-site
 * uploads where each file (HTML, CSS, JS, image, font) carries its own
 * content-type stored as R2 httpMetadata at upload time.
 *
 * Falls back to `application/octet-stream` if the upload didn't supply
 * a content-type (defensive — admin form always sets one, but R2
 * objects created out-of-band might not).
 *
 * @param body the file bytes (ArrayBuffer for binary, string for text-y formats)
 * @param contentType the R2-stored content-type, or undefined to use octet-stream
 * @param etag R2 httpEtag
 * @param lastModified R2 uploaded date
 */
export function buildAssetResponse(
  body: ArrayBuffer | string,
  contentType: string | undefined,
  etag?: string | undefined,
  lastModified?: Date | undefined,
): Response {
  const headers = new Headers({
    "content-type": contentType || "application/octet-stream",
  });
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
