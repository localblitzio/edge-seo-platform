/**
 * Shared helpers for the HTMLRewriter pipeline.
 * Spec: docs/tech-spec.md §6.4.
 *
 * `stableHash` produces the deterministic 8-character marker used by
 * every injecting handler to make rewriters idempotent: an injected
 * element carries `data-edge-seo-rule="<hash>"` and the same handler
 * strips any pre-existing element with that marker before injecting,
 * so running the rewriter twice on the same input yields identical
 * output (§12.2 idempotence requirement).
 */

/**
 * Deterministic 8-char hex hash of an arbitrary string.
 * FNV-1a 32-bit — not cryptographic; the goal is collision-resistance
 * across rules within a single config, not authenticity.
 *
 * @param input the string to hash (typically rule fields concatenated)
 * @returns 8-character lowercase hex string
 * @throws never
 */
export function stableHash(input: string): string {
  let h = 2166136261;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/**
 * HTML-attribute-safe escape for values we put into rendered tags.
 * Conservative — covers the four characters that can break out of an
 * attribute value enclosed in double quotes.
 *
 * @param value raw string
 * @returns string safe to embed inside `attr="..."`
 * @throws never
 */
export function escapeAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/**
 * Inject a `data-edge-seo-rule="<hash>"` marker into the first opening
 * tag of an HTML fragment, or wrap the fragment in a marked
 * `display:contents` span if no opening tag is found at the start.
 * Used by content-injector and schema-injector for idempotence.
 *
 * @param html user-provided HTML fragment
 * @param hash the rule hash from `stableHash`
 * @returns HTML with marker injected on the outermost element
 * @throws never
 */
export function injectMarker(html: string, hash: string): string {
  const re = /^(\s*<[a-zA-Z][a-zA-Z0-9-]*)\b([^>]*?)(\/?>)([\s\S]*)$/;
  const m = html.match(re);
  if (m) {
    return `${m[1]}${m[2]} data-edge-seo-rule="${hash}"${m[3]}${m[4]}`;
  }
  return `<span data-edge-seo-rule="${hash}" style="display:contents">${html}</span>`;
}

/**
 * Escape `</script>` sequences inside a JSON-LD payload so the resulting
 * `<script>...</script>` block isn't terminated early by the HTML parser.
 *
 * Inside a JSON string the bytes `<\/script>` round-trip identically to
 * `</script>` (the optional `\/` escape) but no longer matches the HTML
 * parser's end-of-script-tag detection.
 *
 * @param json a JSON.stringify output
 * @returns the same JSON with `</script` sequences neutralized
 * @throws never
 */
export function escapeScriptClose(json: string): string {
  return json.replace(/<\/(script)/gi, "<\\/$1");
}

/**
 * Walk a JSON-LD value tree and overwrite top-level `url` and `@id`
 * fields with the canonical URL. Spec §6.3 — only the page's own
 * canonical changes; nested entities (e.g., `publisher.url`) are left
 * untouched because their URLs refer to other entities, not the page.
 *
 * @param node the root JSON-LD value (object, array, or scalar)
 * @param canonicalUrl the new canonical URL
 * @returns the same node with top-level url/@id mutated
 * @throws never
 */
export function mutateJsonLdCanonical(node: unknown, canonicalUrl: string): unknown {
  if (node === null || typeof node !== "object") return node;
  if (Array.isArray(node)) {
    for (const item of node) mutateJsonLdCanonical(item, canonicalUrl);
    return node;
  }
  const obj = node as Record<string, unknown>;
  if ("url" in obj) obj.url = canonicalUrl;
  if ("@id" in obj) obj["@id"] = canonicalUrl;
  return obj;
}
