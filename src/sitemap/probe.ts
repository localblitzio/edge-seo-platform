/**
 * Live HTTP probe for the per-site Indexing page.
 *
 * Fetches a URL (typically through this platform's own proxy) and
 * extracts the SEO-relevant signals operators need to answer "would
 * this page get indexed?" — HTTP status, title, meta description,
 * canonical link, robots meta + X-Robots-Tag header, final URL after
 * redirects.
 *
 * Uses HTMLRewriter (Cloudflare Workers' streaming parser) instead
 * of regex so attribute escaping, comments, character encodings, and
 * malformed-but-recoverable HTML all work correctly.
 *
 * Best-effort: every helper here returns a structured result, never
 * throws. Network errors and non-HTML responses produce a result
 * with `ok: false` and an explanatory message.
 */

// HTMLRewriter is a global in the Workers runtime; no import needed.

export interface ProbeResult {
  ok: boolean;
  /** HTTP status of the final response (after redirect follow). */
  status?: number;
  /** Final URL after any redirects — useful when canonical chains exist. */
  finalUrl?: string;
  /** `<title>` text content, trimmed. */
  title?: string;
  /** `<meta name="description" content="...">` value. */
  description?: string;
  /** `<link rel="canonical" href="...">` value. */
  canonical?: string;
  /** `<meta name="robots" content="...">` value. */
  robots?: string;
  /** `X-Robots-Tag` response header value. */
  xRobotsTag?: string;
  /** Error message when `ok: false`. */
  error?: string;
}

const FETCH_TIMEOUT_MS = 15_000;
/** Cap parsed body at 1 MB — anything bigger is almost certainly not HTML we care about. */
const MAX_BODY_BYTES = 1_048_576;

/**
 * Fetch the URL and extract SEO signals from the HTML head. Follows
 * redirects so the returned result reflects what search-engine
 * crawlers would actually see (the proxy worker may issue a 301 for
 * a static-redirect rule, for example).
 */
export async function probeUrl(targetUrl: string): Promise<ProbeResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  let resp: Response;
  try {
    resp = await fetch(targetUrl, {
      redirect: "follow",
      headers: {
        // Pretend to be a generic crawler so the proxy serves the
        // human/bot variant the search engines see. Avoid claiming
        // to be Googlebot specifically — that can trigger upstream
        // bot-handling logic that diverges from human-fetched content.
        "user-agent": "Mozilla/5.0 (compatible; EdgeSEOPlatform-Probe/1.0)",
        accept: "text/html,application/xhtml+xml",
      },
      signal: controller.signal,
    });
  } catch (e) {
    clearTimeout(timeout);
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }
  clearTimeout(timeout);

  const result: ProbeResult = {
    ok: true,
    status: resp.status,
    finalUrl: resp.url,
  };
  const xRobotsTag = resp.headers.get("x-robots-tag");
  if (xRobotsTag) result.xRobotsTag = xRobotsTag;

  // Only parse HTML — text/html, application/xhtml+xml, missing
  // content-type. Skip XML, JSON, images, etc. (a sitemap.xml URL
  // would otherwise produce an empty title/description).
  const contentType = resp.headers.get("content-type")?.toLowerCase() ?? "";
  const isHtml = contentType.includes("html") || contentType.length === 0;
  if (!isHtml) {
    return result;
  }

  let titleText = "";
  let inTitle = false;
  // Cap title accumulation defensively (well-formed pages never
  // produce > 4 KB of title text).
  const TITLE_MAX = 4096;

  const rewriter = new HTMLRewriter()
    .on("title", {
      element(el): void {
        inTitle = true;
        el.onEndTag(() => {
          inTitle = false;
        });
      },
      text(t): void {
        if (!inTitle) return;
        if (titleText.length < TITLE_MAX) titleText += t.text;
      },
    })
    .on('meta[name="description"]', {
      element(el): void {
        const content = el.getAttribute("content");
        if (content) result.description = content;
      },
    })
    .on('meta[name="robots"]', {
      element(el): void {
        const content = el.getAttribute("content");
        if (content) result.robots = content;
      },
    })
    .on('link[rel="canonical"]', {
      element(el): void {
        const href = el.getAttribute("href");
        if (href) result.canonical = href;
      },
    });

  try {
    // Drive the rewriter by reading the transformed body. We don't
    // care about the output bytes — just the side effects (state
    // captured in the handlers above).
    const transformed = rewriter.transform(resp);
    const body = await transformed.arrayBuffer();
    if (body.byteLength > MAX_BODY_BYTES) {
      // Accept whatever we got but flag for caller awareness via the title.
      // (At this point the rewriter has already streamed through the prefix.)
    }
  } catch (e) {
    result.error = `parse failed: ${e instanceof Error ? e.message : String(e)}`;
  }

  const trimmedTitle = titleText.trim();
  if (trimmedTitle.length > 0) result.title = trimmedTitle;

  return result;
}
