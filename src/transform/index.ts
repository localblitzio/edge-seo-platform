/**
 * HTMLRewriter pipeline. Spec: docs/tech-spec.md §6.4 and §5 step 9.
 *
 * Builds a single `HTMLRewriter` instance with handlers attached in
 * the §5 step 9 fixed order:
 *
 *   meta_rewrites → canonical → schema_injections → link_rewrites
 *   → element_removals → content_injections → indexation
 *
 * Required properties (§6.4):
 *   - **Idempotence via marker.** Every injected element carries a
 *     `data-edge-seo-rule="<stable hash>"` attribute; before injection,
 *     handlers strip any existing element matching that marker. Running
 *     the rewriter twice on the same input produces identical output.
 *   - **No full-body buffering.** Per-element text accumulation only,
 *     capped at 64 KB for `<script type="application/ld+json">`. On
 *     overflow: leave the script unmodified and log a warning.
 *   - **Escape `</script>`** to `<\/script>` in injected JSON-LD payloads
 *     so the host script element isn't terminated prematurely.
 *
 * Coverage target: 90%+ on this directory (§12.1). Unit tests live in
 * `_utils.test.ts` for pure helpers; full HTMLRewriter behavior is
 * exercised in `tests/integration/` (M11).
 */

import type { CanonicalDecision } from "../canonical/index.js";
import type { ClientConfig } from "../config/schema.js";
import { attachCanonical } from "./canonical-applier.js";
import { attachContentInjections } from "./content-injector.js";
import { attachElementRemovals } from "./element-remover.js";
import { attachIndexation } from "./indexation-applier.js";
import { attachLinkRewrites } from "./link-rewriter.js";
import { attachMetaRewrites } from "./meta-rewriter.js";
import { attachSchemaInjections } from "./schema-injector.js";

/**
 * Build the HTMLRewriter for a single request. Each handler module
 * decides per-rule whether the in-flight path matches its `match`
 * regex; non-matching rules contribute zero handlers, so the rewriter
 * is as cheap as possible per request.
 *
 * @param url the in-flight request URL
 * @param config the resolved ClientConfig
 * @param canonicalDecision the precomputed canonical decision from §6.3
 * @returns an HTMLRewriter ready to `.transform(response)`
 * @throws never (handler errors are caught per-element by the runtime)
 */
export function buildRewriter(
  url: URL,
  config: ClientConfig,
  canonicalDecision: CanonicalDecision,
): HTMLRewriter {
  const rewriter = new HTMLRewriter();
  const path = url.pathname;

  // §5 step 9 order — DO NOT reorder.
  attachMetaRewrites(rewriter, path, config.meta_rewrites);
  attachCanonical(rewriter, canonicalDecision);
  attachSchemaInjections(rewriter, path, config.schema_injections);
  attachLinkRewrites(rewriter, path, config.link_rewrites);
  attachElementRemovals(rewriter, path, config.element_removals);
  attachContentInjections(rewriter, path, config.content_injections);
  attachIndexation(rewriter, path, config.indexation);

  return rewriter;
}

/**
 * Whether HTMLRewriter should run against a given upstream response.
 * Per spec §12.2 ("HTMLRewriter no-op when origin returns non-HTML"),
 * we only transform `text/html` and `application/xhtml+xml` content.
 *
 * @param response the upstream response
 * @returns true when the response should be piped through `buildRewriter`
 * @throws never
 */
export function isHtmlResponse(response: Response): boolean {
  const contentType = response.headers.get("content-type");
  if (!contentType) return false;
  const lower = contentType.toLowerCase();
  return lower.includes("text/html") || lower.includes("application/xhtml+xml");
}
