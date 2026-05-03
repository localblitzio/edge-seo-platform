/**
 * Content injector — inserts arbitrary HTML before/after/prepend/append/replace
 * relative to a CSS selector.
 * Spec: docs/tech-spec.md §4 (`ContentInjectRule`) and §6.4 step 3 (idempotence).
 *
 * Idempotence: every injected fragment carries a stable
 * `data-edge-seo-rule="<hash>"` marker. Before injecting we strip any
 * existing element matching that marker, so running the rewriter twice
 * on the same input yields identical output (§12.2 idempotence test).
 */

import type { ContentInjectRule } from "../config/schema.js";
import { injectMarker, stableHash } from "./_utils.js";

/**
 * Attach content-injection handlers for every rule whose `match` regex
 * matches the in-flight path.
 *
 * @param rewriter the HTMLRewriter being assembled
 * @param path in-flight URL pathname
 * @param rules content_injections array from the ClientConfig
 * @returns void (mutates rewriter)
 * @throws never
 */
export function attachContentInjections(
  rewriter: HTMLRewriter,
  path: string,
  rules: readonly ContentInjectRule[],
): void {
  for (const rule of rules) {
    const re = new RegExp(rule.match);
    if (!re.test(path)) continue;

    const hash = stableHash(`content:${rule.match}:${rule.selector}:${rule.position}:${rule.html}`);

    // Idempotence: strip pre-existing markers from a previous run.
    rewriter.on(`[data-edge-seo-rule="${hash}"]`, {
      element(el) {
        el.remove();
      },
    });

    const html = injectMarker(rule.html, hash);

    rewriter.on(rule.selector, {
      element(el) {
        switch (rule.position) {
          case "before":
            el.before(html, { html: true });
            return;
          case "after":
            el.after(html, { html: true });
            return;
          case "prepend":
            el.prepend(html, { html: true });
            return;
          case "append":
            el.append(html, { html: true });
            return;
          case "replace":
            el.replace(html, { html: true });
            return;
        }
      },
    });
  }
}
