/**
 * Element remover — drops elements matching a CSS selector on pages
 * whose path matches `match`.
 * Spec: docs/tech-spec.md §4 (`ElementRemoveRule`).
 */

import type { ElementRemoveRule } from "../config/schema.js";

/**
 * Attach element-removal handlers for every rule whose `match` regex
 * matches the in-flight path.
 *
 * @param rewriter the HTMLRewriter being assembled
 * @param path in-flight URL pathname
 * @param rules element_removals array from the ClientConfig
 * @returns void (mutates rewriter)
 * @throws never
 */
export function attachElementRemovals(
  rewriter: HTMLRewriter,
  path: string,
  rules: readonly ElementRemoveRule[],
): void {
  for (const rule of rules) {
    const re = new RegExp(rule.match);
    if (!re.test(path)) continue;
    rewriter.on(rule.selector, {
      element(el) {
        el.remove();
      },
    });
  }
}
