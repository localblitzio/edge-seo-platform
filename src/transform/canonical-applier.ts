/**
 * Canonical applier — translates the M4 `CanonicalDecision` into HTML
 * mutations on the streaming response.
 * Spec: docs/tech-spec.md §6.3 (rewriter-consumer rules) and §5 step 9.
 *
 * For self / origin / custom strategies:
 *   - Strip ALL existing `<link rel="canonical">` (origin's and ours).
 *   - Append a new `<link rel="canonical" href="<decision.url>"
 *     data-edge-seo-rule="canonical">` to `<head>`.
 *   - If sync_og:        replace `<meta property="og:url">` content.
 *   - If sync_twitter:   replace `<meta name="twitter:url">` content.
 *   - If sync_jsonld:    parse `<script type="application/ld+json">`,
 *                        update top-level `url` and `@id`, re-emit.
 *
 * For noindex strategy:
 *   - Strip ALL existing `<link rel="canonical">`.
 *   - Append `<meta name="robots" content="noindex"
 *     data-edge-seo-rule="canonical-noindex">` to `<head>`.
 *
 * JSON-LD text accumulation honors the §6.4 step 5 contract:
 *   - 64 KB cap per element; on overflow, leave the script unmodified
 *     and emit a `console.warn`. The accumulated buffer is replayed on
 *     `lastInTextNode` so the script content survives intact.
 */

import type { CanonicalDecision } from "../canonical/index.js";
import { escapeAttr, mutateJsonLdCanonical } from "./_utils.js";

const JSON_LD_MAX_BYTES = 64 * 1024;

/**
 * Attach canonical-related handlers to a rewriter.
 *
 * @param rewriter the HTMLRewriter being assembled
 * @param decision the M4-resolved canonical decision
 * @returns void (mutates rewriter)
 * @throws never (handler exceptions are swallowed per-element by the runtime)
 */
export function attachCanonical(rewriter: HTMLRewriter, decision: CanonicalDecision): void {
  // 1. Always strip existing canonical links — origin's and any prior ours.
  rewriter.on('link[rel="canonical"]', {
    element(el) {
      el.remove();
    },
  });
  // Strip prior noindex markers to keep injection idempotent.
  rewriter.on('meta[data-edge-seo-rule="canonical-noindex"]', {
    element(el) {
      el.remove();
    },
  });

  // 2. Inject the new canonical (or noindex meta).
  if (decision.strategy === "noindex") {
    rewriter.on("head", {
      element(el) {
        el.append('<meta name="robots" content="noindex" data-edge-seo-rule="canonical-noindex">', {
          html: true,
        });
      },
    });
    return;
  }

  if (decision.url === null) return;
  const canonicalUrl = decision.url;

  rewriter.on("head", {
    element(el) {
      el.append(
        `<link rel="canonical" href="${escapeAttr(canonicalUrl)}" data-edge-seo-rule="canonical">`,
        { html: true },
      );
    },
  });

  // 3. Sync og:url / twitter:url.
  if (decision.sync_og) {
    rewriter.on('meta[property="og:url"]', {
      element(el) {
        el.setAttribute("content", canonicalUrl);
      },
    });
  }
  if (decision.sync_twitter) {
    rewriter.on('meta[name="twitter:url"]', {
      element(el) {
        el.setAttribute("content", canonicalUrl);
      },
    });
  }

  // 4. Sync JSON-LD url / @id with text-accumulation + 64KB cap.
  if (decision.sync_jsonld) {
    attachJsonLdSync(rewriter, canonicalUrl);
  }
}

interface JsonLdState {
  buffer: string;
  overflow: boolean;
}

function attachJsonLdSync(rewriter: HTMLRewriter, canonicalUrl: string): void {
  // Per-element state, reset in the element() callback for each script.
  const state: JsonLdState = { buffer: "", overflow: false };

  rewriter.on('script[type="application/ld+json"]', {
    element() {
      state.buffer = "";
      state.overflow = false;
    },
    text(text) {
      // If we've already overflowed, just let chunks pass through —
      // `state.buffer` was replayed onto the stream when we tipped over.
      if (state.overflow) {
        if (text.lastInTextNode) {
          state.buffer = "";
          state.overflow = false;
        }
        return;
      }

      if (state.buffer.length + text.text.length > JSON_LD_MAX_BYTES) {
        state.overflow = true;
        console.warn(
          `[edge-seo] JSON-LD payload exceeded ${JSON_LD_MAX_BYTES}B; canonical sync skipped`,
        );
        // Replay accumulated bytes plus this chunk — we previously
        // text.remove()'d earlier chunks, so we need to put the
        // original content back in the stream.
        text.replace(state.buffer + text.text);
        state.buffer = "";
        return;
      }

      state.buffer += text.text;

      if (text.lastInTextNode) {
        try {
          const parsed = JSON.parse(state.buffer);
          mutateJsonLdCanonical(parsed, canonicalUrl);
          text.replace(JSON.stringify(parsed));
        } catch {
          // Parse failed — emit the original accumulated content unchanged.
          text.replace(state.buffer);
        }
        state.buffer = "";
      } else {
        // Hold this chunk back; we'll emit on lastInTextNode.
        text.remove();
      }
    },
  });
}
