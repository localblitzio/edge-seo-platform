/**
 * Page inspector — fetches a path on a client's source domain and
 * extracts its structural elements (h1-h6, p) so the UI can let the
 * operator click "Override this" and pre-fill a text_rewrites rule.
 *
 * Why fetch from SOURCE rather than via the proxy worker:
 *   - The operator is choosing what to override. Showing them the
 *     ALREADY-rewritten version (from the proxy) is confusing — they
 *     wouldn't see the actual element they want to change because
 *     it's already been replaced.
 *   - Source is also cheaper (no proxy hop) and unaffected by KV
 *     caching, so "Fetch" always shows fresh content.
 *
 * Selector strategy (best-effort, picks the cleanest available):
 *   1. `#id` — if the element has an id, use it (always unique).
 *   2. `tag.class` — if the tag has a class that's unique among
 *      siblings of the same tag, use it.
 *   3. `tag` alone — if there's only one element of this tag on the
 *      page.
 *   4. `tag:nth-of-type(N)` — fallback for "the 3rd h2 on the page".
 *
 * Returned selectors are starting points the operator can edit before
 * saving — the structure of origin pages can change, so an exact
 * `nth-of-type` match is brittle. The UI shows the selector as the
 * pre-fill value but leaves it editable.
 */

export interface InspectedElement {
  /** HTML tag in lowercase (`h1`, `p`, etc.) */
  tag: string;
  /** Element's id attribute, if any. */
  id: string | null;
  /** Element's class list (split on whitespace), empty if no class attr. */
  classes: string[];
  /**
   * The element's accumulated text content, normalized (whitespace
   * collapsed, leading/trailing trim, capped at 500 chars). Empty if
   * the element had no text nodes.
   */
  text: string;
  /** Computed CSS selector — see selector strategy in module header. */
  selector: string;
}

export interface InspectResult {
  /** The URL we fetched. */
  url: string;
  /** Status code returned by the source. */
  status: number;
  /** Extracted elements, in document order. */
  elements: InspectedElement[];
}

/** Tags we expose for override. Add buttons / images / nav as future expansion. */
const INSPECTED_TAGS = ["h1", "h2", "h3", "h4", "h5", "h6", "p"] as const;
type InspectedTag = (typeof INSPECTED_TAGS)[number];

/**
 * Fetch a path on the source domain and return its structural elements.
 *
 * @param sourceBase the origin URL prefix (no trailing slash), e.g. `https://example.com`
 * @param path the path to fetch (must start with `/`)
 * @returns the inspect result, or throws on network/parse failure
 */
export async function inspectSourcePage(sourceBase: string, path: string): Promise<InspectResult> {
  const cleanPath = path.startsWith("/") ? path : `/${path}`;
  const url = sourceBase.replace(/\/+$/, "") + cleanPath;

  const resp = await fetch(url, {
    headers: {
      "user-agent": "Edge-SEO-Platform-Inspector/1.0 (page-element-picker)",
      accept: "text/html,application/xhtml+xml",
    },
    redirect: "follow",
  });

  if (!resp.ok) {
    return { url, status: resp.status, elements: [] };
  }

  const ct = (resp.headers.get("content-type") ?? "").toLowerCase();
  if (!ct.includes("text/html") && !ct.includes("application/xhtml")) {
    // Not HTML — return empty elements with the status so the UI can
    // tell the operator "this URL didn't return HTML".
    return { url, status: resp.status, elements: [] };
  }

  const elements = await extractElements(resp);
  return { url, status: resp.status, elements };
}

/**
 * Walk the document via HTMLRewriter and collect interesting elements.
 *
 * Each handler closure tracks the most recently-opened element of its
 * tag in a private `currentIdx`, so text nodes inside that element get
 * appended to the right place in the global elements list. This works
 * for non-nested cases (the common case for h1/h2/p) and degrades
 * sensibly for nested cases (text appends to whichever was opened last).
 */
async function extractElements(response: Response): Promise<InspectedElement[]> {
  const elements: InspectedElement[] = [];

  function makeHandler(tag: InspectedTag): {
    element: (el: Element) => void;
    text: (chunk: Text) => void;
  } {
    let currentIdx = -1;
    return {
      element(el) {
        const id = el.getAttribute("id");
        const cls = el.getAttribute("class");
        const classes = cls ? cls.split(/\s+/).filter(Boolean) : [];
        elements.push({
          tag,
          id: id ?? null,
          classes,
          text: "",
          selector: "", // filled in computeSelectors() below
        });
        currentIdx = elements.length - 1;
      },
      text(chunk) {
        if (currentIdx >= 0) {
          const target = elements[currentIdx];
          if (target) target.text += chunk.text;
        }
      },
    };
  }

  const rewriter = new HTMLRewriter();
  for (const tag of INSPECTED_TAGS) {
    rewriter.on(tag, makeHandler(tag));
  }
  // Drain the response — we don't care about the output, just the side
  // effect of the handlers populating `elements`.
  await rewriter.transform(response).text();

  // Normalize text + compute selectors per tag.
  computeSelectors(elements);
  for (const el of elements) {
    el.text = el.text.replace(/\s+/g, " ").trim().slice(0, 500);
  }
  return elements;
}

/**
 * Assign a `selector` to each element. Strategy summarized in module
 * header. Mutates `elements` in place.
 */
function computeSelectors(elements: InspectedElement[]): void {
  // Group by tag so we can decide nth-of-type / class-uniqueness.
  const byTag: Record<string, InspectedElement[]> = {};
  for (const el of elements) {
    if (!byTag[el.tag]) byTag[el.tag] = [];
    byTag[el.tag]?.push(el);
  }

  for (const [tag, group] of Object.entries(byTag)) {
    group.forEach((el, idx) => {
      // 1. ID — preferred, but only if it looks human-authored.
      //    Site builders (Wix Studio, Editor X, Webflow, etc.) emit
      //    auto-generated IDs like `vbid-9e859d8e-ylldheqp`, `comp-...`,
      //    `w-node-...`, `mantine-...`. These IDs are technically
      //    unique but they're brittle (regenerated on republish) and
      //    don't read semantically. Fall through to tag/class
      //    strategies for a saner default.
      if (el.id && !looksGenerated(el.id)) {
        el.selector = `#${cssEscape(el.id)}`;
        return;
      }
      // 2. tag.class — if any class is unique to this element among
      //    same-tag siblings, use the first such class.
      if (el.classes.length > 0) {
        const uniqueClass = el.classes.find((c) => {
          return group.filter((other) => other.classes.includes(c)).length === 1;
        });
        if (uniqueClass) {
          el.selector = `${tag}.${cssEscape(uniqueClass)}`;
          return;
        }
      }
      // 3. tag alone — if there's only one element of this tag.
      if (group.length === 1) {
        el.selector = tag;
        return;
      }
      // 4. tag:nth-of-type(N) fallback. CSS nth-of-type is 1-indexed
      //    and counts among element siblings of the same type within
      //    the same parent — but here we don't track parents, so this
      //    is a global "Nth h2 on the page" approximation. Brittle if
      //    the source DOM changes; operator can edit before saving.
      el.selector = `${tag}:nth-of-type(${idx + 1})`;
    });
  }
}

/**
 * Detect IDs emitted by site builders (Wix Studio, Editor X, Webflow,
 * Mantine, Radix UI, CSS-in-JS, etc.) that are unique but brittle —
 * regenerated on every republish, opaque to humans, and not stable
 * targets for text_rewrites.
 *
 * Heuristics, in order of weight:
 *   - Known prefixes: `vbid-`, `comp-`, `w-node-`, `mantine-`,
 *     `radix-`, `css-`, `chakra-`, `headlessui-`, `aria-`, `react-`.
 *   - Embedded hex hash: any 6+ consecutive hex chars (`9e859d8e`).
 *   - Embedded alpha-numeric token of 8+ chars that isn't a real word
 *     (caught loosely by the hex rule for most builder IDs).
 *
 * Conservative on the false-positive side: a hand-written ID like
 * `header-2024` would survive the hex check (only 4 hex digits in a
 * row) and not trip any prefix rule.
 *
 * @param id the element's id attribute value
 * @returns true if the ID looks builder-generated
 */
export function looksGenerated(id: string): boolean {
  const lower = id.toLowerCase();
  // Known builder/framework prefixes.
  if (/^(vbid|comp|w-node|mantine|radix|css|chakra|headlessui|react|aria)[-_]/.test(lower)) {
    return true;
  }
  // Any 6+ consecutive hex chars almost always means hash/uuid fragment.
  if (/[0-9a-f]{6,}/.test(lower)) return true;
  return false;
}

/**
 * Minimal CSS identifier escape — handles the common cases (digits at
 * start, special chars). Not a full implementation of CSS.escape but
 * fine for ID and class names that contain word chars + hyphens.
 */
function cssEscape(s: string): string {
  // Escape characters that have special meaning in CSS selectors.
  // \\W is "non-word" (anything not [A-Za-z0-9_]) plus we also need to
  // handle a leading digit (CSS doesn't allow ident starting with digit).
  let out = s.replace(/([!"#$%&'()*+,./:;<=>?@\[\\\]^`{|}~])/g, "\\$1");
  if (/^\d/.test(out)) out = `\\3${out.charAt(0)} ${out.slice(1)}`;
  return out;
}
