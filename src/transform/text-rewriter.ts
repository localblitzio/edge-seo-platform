/**
 * Text rewriter — replaces the inner content of elements matching a CSS
 * selector on pages whose path matches `match`. Operator-friendly
 * alternative to `content_injections` with `position=replace` for the
 * common case of "change the H1 text" without rewriting the element's
 * attributes/classes/structure.
 *
 * Spec: docs/tech-spec.md §5 step 9 — slot between `meta_rewrites` and
 * `element_removals` so removals override rewrites (a rule that removes
 * an element wins over a rule that rewrites its text), and so meta
 * rewrites (head-only) don't compete with body rewrites.
 *
 * Modes:
 *   - `text` (default): `setInnerContent(content, { html: false })`.
 *     `<`, `>`, `&` are entity-encoded by HTMLRewriter so the rewritten
 *     text can never inject markup, even if the operator types HTML
 *     into the content field.
 *   - `html`: `setInnerContent(content, { html: true })`. Operator
 *     opts in to raw HTML (e.g. to wrap a span around part of the
 *     replacement). Caller is responsible for the HTML being safe.
 */

import type { TextRewriteRule } from "../config/schema.js";

/**
 * Attach text-rewrite handlers for every rule whose `match` regex
 * matches the in-flight path. Idempotent: re-running on the same
 * input produces the same output (HTMLRewriter overwrites content
 * deterministically).
 *
 * @param rewriter the HTMLRewriter being assembled
 * @param path in-flight URL pathname
 * @param rules text_rewrites array from the ClientConfig
 * @returns void (mutates rewriter)
 * @throws never
 */
export function attachTextRewrites(
  rewriter: HTMLRewriter,
  path: string,
  rules: readonly TextRewriteRule[],
): void {
  for (const rule of rules) {
    const re = new RegExp(rule.match);
    if (!re.test(path)) continue;
    const html = rule.mode === "html";
    rewriter.on(rule.selector, {
      element(el) {
        el.setInnerContent(rule.content, { html });
      },
    });
  }
}
