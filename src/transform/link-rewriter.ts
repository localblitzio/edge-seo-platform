/**
 * Link rewriter — modifies `href` on `<a>` and `<link>` elements
 * whose href matches `match_pattern`, on pages whose path matches.
 * Spec: docs/tech-spec.md §4 (`LinkRewriteRule`).
 */

import type { LinkRewriteRule } from "../config/schema.js";

/**
 * Attach link-rewrite handlers for every rule whose `match` regex
 * matches the in-flight path.
 *
 * @param rewriter the HTMLRewriter being assembled
 * @param path in-flight URL pathname
 * @param rules link_rewrites array from the ClientConfig
 * @returns void (mutates rewriter)
 * @throws never
 */
export function attachLinkRewrites(
  rewriter: HTMLRewriter,
  path: string,
  rules: readonly LinkRewriteRule[],
): void {
  for (const rule of rules) {
    const pathRe = new RegExp(rule.match);
    if (!pathRe.test(path)) continue;
    const hrefRe = new RegExp(rule.match_pattern);
    rewriter.on("a[href], link[href]", {
      element(el) {
        const href = el.getAttribute("href");
        if (href === null) return;
        if (!hrefRe.test(href)) return;
        el.setAttribute("href", href.replace(hrefRe, rule.replacement));
      },
    });
  }
}
