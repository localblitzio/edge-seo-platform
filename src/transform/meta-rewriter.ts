/**
 * Meta-tag rewriter — title, description, robots, og:*, twitter:*.
 * Spec: docs/tech-spec.md §4 (`MetaRewriteRule`) and §5 step 9.
 *
 * Runs BEFORE the canonical applier so that any `og:url` / `twitter:url`
 * the canonical applier wants to sync isn't overwritten by a later
 * meta_rewrite (canonical wins).
 */

import type { MetaRewriteRule } from "../config/schema.js";

const SELECTOR_FOR_TAG: Record<
  MetaRewriteRule["tag"],
  { selector: string; mode: "title" | "content" }
> = {
  title: { selector: "title", mode: "title" },
  description: { selector: 'meta[name="description"]', mode: "content" },
  robots: { selector: 'meta[name="robots"]', mode: "content" },
  "og:title": { selector: 'meta[property="og:title"]', mode: "content" },
  "og:description": { selector: 'meta[property="og:description"]', mode: "content" },
  "og:image": { selector: 'meta[property="og:image"]', mode: "content" },
  "og:type": { selector: 'meta[property="og:type"]', mode: "content" },
  "og:site_name": { selector: 'meta[property="og:site_name"]', mode: "content" },
  "twitter:card": { selector: 'meta[name="twitter:card"]', mode: "content" },
  "twitter:title": { selector: 'meta[name="twitter:title"]', mode: "content" },
  "twitter:description": { selector: 'meta[name="twitter:description"]', mode: "content" },
  "twitter:image": { selector: 'meta[name="twitter:image"]', mode: "content" },
};

/**
 * Attach meta-rewrite handlers for every rule whose `match` regex
 * matches the in-flight path. Tags that don't already exist on the page
 * are NOT created — strict reading of "rewrite" in §4.
 *
 * @param rewriter the HTMLRewriter being assembled
 * @param path in-flight URL pathname
 * @param rules meta_rewrites array from the ClientConfig
 * @returns void (mutates rewriter)
 * @throws never
 */
export function attachMetaRewrites(
  rewriter: HTMLRewriter,
  path: string,
  rules: readonly MetaRewriteRule[],
): void {
  for (const rule of rules) {
    const re = new RegExp(rule.match);
    if (!re.test(path)) continue;
    const target = SELECTOR_FOR_TAG[rule.tag];
    if (target.mode === "title") {
      rewriter.on(target.selector, {
        element(el) {
          el.setInnerContent(rule.value);
        },
      });
    } else {
      rewriter.on(target.selector, {
        element(el) {
          el.setAttribute("content", rule.value);
        },
      });
    }
  }
}
