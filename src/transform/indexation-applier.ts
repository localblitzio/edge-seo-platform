/**
 * Indexation applier — sets `<meta name="robots">` on HTML responses
 * per the first matching `IndexationRule`.
 * Spec: docs/tech-spec.md §4 (`IndexationRule`), §7.6 (PRD), §5 step 9.
 *
 * The X-Robots-Tag header for non-HTML responses is applied at the
 * header-transform stage in M6 / `src/indexation/`.
 *
 * Note: when the canonical applier emits a `noindex` meta (because the
 * canonical strategy is `noindex`), it carries a different marker
 * (`canonical-noindex`) than this applier's (`indexation`). They can
 * coexist in head; the more restrictive directive wins at the search
 * engine, which is correct behavior for our SEO guardrails.
 */

import type { IndexationRule } from "../config/schema.js";
import { escapeAttr } from "./_utils.js";

/**
 * Attach an indexation handler if any rule matches the in-flight path.
 * First-match-wins.
 *
 * @param rewriter the HTMLRewriter being assembled
 * @param path in-flight URL pathname
 * @param rules indexation array from the ClientConfig
 * @returns void (mutates rewriter)
 * @throws never
 */
export function attachIndexation(
  rewriter: HTMLRewriter,
  path: string,
  rules: readonly IndexationRule[],
): void {
  let matched: IndexationRule | null = null;
  for (const rule of rules) {
    const re = new RegExp(rule.match);
    if (re.test(path)) {
      matched = rule;
      break;
    }
  }
  if (!matched) return;

  const directives =
    matched.additional_directives.length > 0
      ? `${matched.robots},${matched.additional_directives.join(",")}`
      : matched.robots;

  // Strip pre-existing robots meta (origin's or our own previous run).
  rewriter.on('meta[name="robots"]', {
    element(el) {
      // Skip our `canonical-noindex` marker so the canonical applier
      // and indexation applier don't fight when both emit a robots tag.
      if (el.getAttribute("data-edge-seo-rule") === "canonical-noindex") return;
      el.remove();
    },
  });

  rewriter.on("head", {
    element(el) {
      el.append(
        `<meta name="robots" content="${escapeAttr(directives)}" data-edge-seo-rule="indexation">`,
        { html: true },
      );
    },
  });
}
