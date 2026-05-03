/**
 * JSON-LD schema injector.
 * Spec: docs/tech-spec.md §4 (`SchemaInjection`) and §6.4 step 5 (escape `</script>`).
 *
 * Each matching rule produces ONE `<script type="application/ld+json"
 * data-edge-seo-rule="<hash>">` block, appended or prepended to `<head>`
 * per `position`. Existing elements with the same marker are stripped
 * first, so the rewriter is idempotent (§12.2).
 *
 * Existing JSON-LD scripts of the same `@type` are NOT deduplicated —
 * the consumer config decides (§6.4 edge case). We only strip our own
 * marker, never origin schema.
 */

import type { SchemaInjection } from "../config/schema.js";
import { escapeScriptClose, stableHash } from "./_utils.js";

/**
 * Attach schema-injection handlers for every rule whose `match` regex
 * matches the in-flight path.
 *
 * @param rewriter the HTMLRewriter being assembled
 * @param path in-flight URL pathname
 * @param rules schema_injections array from the ClientConfig
 * @returns void (mutates rewriter)
 * @throws never (validator rejected non-serializable payloads at config load)
 */
export function attachSchemaInjections(
  rewriter: HTMLRewriter,
  path: string,
  rules: readonly SchemaInjection[],
): void {
  for (const rule of rules) {
    const re = new RegExp(rule.match);
    if (!re.test(path)) continue;

    const hash = stableHash(
      `schema:${rule.match}:${rule.schema_type}:${JSON.stringify(rule.payload)}`,
    );

    // Idempotence: strip our own previously-injected marker.
    rewriter.on(`script[data-edge-seo-rule="${hash}"]`, {
      element(el) {
        el.remove();
      },
    });

    const escapedJson = escapeScriptClose(JSON.stringify(rule.payload));
    const html = `<script type="application/ld+json" data-edge-seo-rule="${hash}">${escapedJson}</script>`;

    rewriter.on("head", {
      element(el) {
        if (rule.position === "head_prepend") {
          el.prepend(html, { html: true });
        } else {
          el.append(html, { html: true });
        }
      },
    });
  }
}
