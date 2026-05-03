/**
 * Indexation header — applies `X-Robots-Tag` to non-HTML responses
 * per the matching `IndexationRule`.
 * Spec: PRD §7.6 ("X-Robots-Tag header support for non-HTML resources
 * (PDFs, images)") and tech spec §5 step 10.
 *
 * For HTML responses the M5 indexation-applier already injected a
 * `<meta name="robots">`; this header is the non-HTML equivalent
 * (search engines honor `X-Robots-Tag` on resources where they can't
 * read a meta tag).
 *
 * First-match-wins on the `match` regex, mirroring the M5 applier.
 */

import type { IndexationRule } from "../config/schema.js";

/**
 * Whether a response is HTML (and therefore handled by the M5
 * `<meta name="robots">` injector instead of this header path).
 */
function isHtmlContentType(response: Response): boolean {
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  return contentType.includes("text/html") || contentType.includes("application/xhtml+xml");
}

/**
 * Apply `X-Robots-Tag` to a non-HTML response per the first matching
 * `IndexationRule`. HTML responses are passed through unchanged because
 * the rewriter already emitted a `<meta name="robots">` for them.
 *
 * @param response the post-transform response
 * @param path the in-flight URL pathname (for rule matching)
 * @param rules the indexation array from a ClientConfig
 * @returns a new Response with the header set, or the input unchanged
 *   when the response is HTML or no rule matches
 * @throws never
 */
export function applyXRobotsTag(
  response: Response,
  path: string,
  rules: readonly IndexationRule[],
): Response {
  if (isHtmlContentType(response)) return response;

  let matched: IndexationRule | null = null;
  for (const rule of rules) {
    if (new RegExp(rule.match).test(path)) {
      matched = rule;
      break;
    }
  }
  if (!matched) return response;

  const directives =
    matched.additional_directives.length > 0
      ? `${matched.robots},${matched.additional_directives.join(",")}`
      : matched.robots;

  const headers = new Headers(response.headers);
  headers.set("x-robots-tag", directives);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}
