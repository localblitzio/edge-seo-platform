import { afterEach, describe, expect, it, vi } from "vitest";

import { validLanternCrestConfig } from "../../tests/fixtures/configs/index.js";
import { ClientConfig } from "../config/schema.js";

import {
  extractLocs,
  fetchAndRewriteUpstream,
  isSitemapIndex,
  resolveUpstreamSitemapUrl,
  rewriteHost,
} from "./upstream.js";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

function configWith(mut: (cfg: Record<string, unknown>) => void): ClientConfig {
  const cfg = validLanternCrestConfig() as Record<string, unknown>;
  mut(cfg);
  return ClientConfig.parse(cfg);
}

describe("resolveUpstreamSitemapUrl", () => {
  it("uses the operator override when set", () => {
    const cfg = configWith((c) => {
      c.upstream_sitemap_url = "https://custom.example.com/sitemap_main.xml";
    });
    expect(resolveUpstreamSitemapUrl(cfg)).toBe("https://custom.example.com/sitemap_main.xml");
  });

  it("defaults to https://${source_domain}/sitemap.xml when unset", () => {
    const cfg = configWith(() => {});
    expect(resolveUpstreamSitemapUrl(cfg)).toBe(`https://${cfg.source_domain}/sitemap.xml`);
  });
});

describe("extractLocs", () => {
  it("extracts URLs from a basic urlset", () => {
    const xml = `<?xml version="1.0"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url><loc>https://example.com/page1</loc></url>
  <url><loc>https://example.com/page2</loc></url>
</urlset>`;
    expect(extractLocs(xml)).toEqual(["https://example.com/page1", "https://example.com/page2"]);
  });

  it("handles namespace prefixes (`<ns:loc>`)", () => {
    const xml = "<urlset><url><ns:loc>https://a.com/x</ns:loc></url></urlset>";
    expect(extractLocs(xml)).toEqual(["https://a.com/x"]);
  });

  it("trims surrounding whitespace inside <loc>", () => {
    const xml = "<urlset><url><loc>  https://a.com/x  </loc></url></urlset>";
    expect(extractLocs(xml)).toEqual(["https://a.com/x"]);
  });

  it("ignores empty <loc> tags", () => {
    const xml = "<urlset><url><loc></loc></url><url><loc>https://a.com/x</loc></url></urlset>";
    expect(extractLocs(xml)).toEqual(["https://a.com/x"]);
  });

  it("handles whitespace inside the tag (`<loc >`)", () => {
    const xml = "<urlset><url><loc >https://a.com/x</ loc></url></urlset>";
    expect(extractLocs(xml)).toEqual(["https://a.com/x"]);
  });

  it("extracts from a sitemap index too", () => {
    const xml = `<sitemapindex>
      <sitemap><loc>https://a.com/sitemap-1.xml</loc></sitemap>
      <sitemap><loc>https://a.com/sitemap-2.xml</loc></sitemap>
    </sitemapindex>`;
    expect(extractLocs(xml)).toEqual([
      "https://a.com/sitemap-1.xml",
      "https://a.com/sitemap-2.xml",
    ]);
  });

  it("returns empty list for non-sitemap XML", () => {
    expect(extractLocs("<rss><channel></channel></rss>")).toEqual([]);
  });
});

describe("isSitemapIndex", () => {
  it("returns true for a <sitemapindex> root", () => {
    const xml = "<sitemapindex><sitemap><loc>https://a.com/s.xml</loc></sitemap></sitemapindex>";
    expect(isSitemapIndex(xml)).toBe(true);
  });

  it("returns false for a <urlset> root", () => {
    const xml = "<urlset><url><loc>https://a.com/x</loc></url></urlset>";
    expect(isSitemapIndex(xml)).toBe(false);
  });

  it("handles namespace prefixes", () => {
    expect(isSitemapIndex("<sm:sitemapindex></sm:sitemapindex>")).toBe(true);
  });

  it("returns false when neither root element appears", () => {
    expect(isSitemapIndex("<rss></rss>")).toBe(false);
  });
});

describe("rewriteHost", () => {
  it("rewrites the host of a URL on the source domain", () => {
    expect(rewriteHost("https://source.com/about", "source.com", "proxy.com")).toBe(
      "https://proxy.com/about",
    );
  });

  it("rewrites www.<source> to the proxy domain", () => {
    expect(rewriteHost("https://www.source.com/about", "source.com", "proxy.com")).toBe(
      "https://proxy.com/about",
    );
  });

  it("preserves the path and query string", () => {
    expect(rewriteHost("https://source.com/blog/p1?utm=x&y=1", "source.com", "proxy.com")).toBe(
      "https://proxy.com/blog/p1?utm=x&y=1",
    );
  });

  it("forces https:// scheme", () => {
    expect(rewriteHost("http://source.com/about", "source.com", "proxy.com")).toBe(
      "https://proxy.com/about",
    );
  });

  it("strips a non-default port", () => {
    expect(rewriteHost("https://source.com:8080/about", "source.com", "proxy.com")).toBe(
      "https://proxy.com/about",
    );
  });

  it("returns null for URLs on a different host (foreign URL)", () => {
    expect(rewriteHost("https://other.com/x", "source.com", "proxy.com")).toBeNull();
    expect(rewriteHost("https://cdn.source.com/x", "source.com", "proxy.com")).toBeNull();
  });

  it("returns null for malformed URLs", () => {
    expect(rewriteHost("not a url", "source.com", "proxy.com")).toBeNull();
    expect(rewriteHost("/just-a-path", "source.com", "proxy.com")).toBeNull();
  });
});

describe("fetchAndRewriteUpstream", () => {
  it("returns rewritten URLs from a urlset", async () => {
    const cfg = configWith((c) => {
      c.source_domain = "source.example.com";
      c.proxy_domain = "lanterncrest.com";
    });
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        `<?xml version="1.0"?>
<urlset>
  <url><loc>https://source.example.com/about</loc></url>
  <url><loc>https://source.example.com/contact</loc></url>
  <url><loc>https://www.source.example.com/team</loc></url>
  <url><loc>https://other.com/external</loc></url>
</urlset>`,
        { status: 200 },
      ),
    ) as unknown as typeof fetch;
    const urls = await fetchAndRewriteUpstream(cfg);
    expect(urls).toEqual([
      "https://lanterncrest.com/about",
      "https://lanterncrest.com/contact",
      "https://lanterncrest.com/team",
    ]);
  });

  it("follows a sitemap index one level deep", async () => {
    const cfg = configWith((c) => {
      c.source_domain = "src.com";
      c.proxy_domain = "prx.com";
    });
    const fetchMock = vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("sitemap.xml")) {
        return new Response(
          `<sitemapindex>
            <sitemap><loc>https://src.com/sitemap-pages.xml</loc></sitemap>
            <sitemap><loc>https://src.com/sitemap-posts.xml</loc></sitemap>
          </sitemapindex>`,
          { status: 200 },
        );
      }
      if (url.endsWith("sitemap-pages.xml")) {
        return new Response(
          "<urlset><url><loc>https://src.com/p1</loc></url><url><loc>https://src.com/p2</loc></url></urlset>",
          { status: 200 },
        );
      }
      if (url.endsWith("sitemap-posts.xml")) {
        return new Response("<urlset><url><loc>https://src.com/blog/post-a</loc></url></urlset>", {
          status: 200,
        });
      }
      return new Response("", { status: 404 });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const urls = await fetchAndRewriteUpstream(cfg);
    expect(urls).toEqual([
      "https://prx.com/blog/post-a",
      "https://prx.com/p1",
      "https://prx.com/p2",
    ]);
    // 1 root + 2 children
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("does NOT recurse beyond one level", async () => {
    const cfg = configWith((c) => {
      c.source_domain = "src.com";
      c.proxy_domain = "prx.com";
    });
    const fetchMock = vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("sitemap.xml")) {
        return new Response(
          "<sitemapindex><sitemap><loc>https://src.com/level2-index.xml</loc></sitemap></sitemapindex>",
          { status: 200 },
        );
      }
      // The level-2 file is also a sitemapindex — should be skipped.
      if (url.endsWith("level2-index.xml")) {
        return new Response(
          "<sitemapindex><sitemap><loc>https://src.com/leaf.xml</loc></sitemap></sitemapindex>",
          { status: 200 },
        );
      }
      // The leaf should never be fetched.
      return new Response(
        "<urlset><url><loc>https://src.com/should-not-appear</loc></url></urlset>",
        { status: 200 },
      );
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const urls = await fetchAndRewriteUpstream(cfg);
    expect(urls).toEqual([]); // level-2 sitemapindex skipped, no leaf URLs collected
    expect(fetchMock).toHaveBeenCalledTimes(2); // root + level-2 only
  });

  it("returns null on root fetch failure", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(new Response("", { status: 500 })) as unknown as typeof fetch;
    const cfg = configWith(() => {});
    expect(await fetchAndRewriteUpstream(cfg)).toBeNull();
  });

  it("returns null on network error", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("ENOTFOUND")) as unknown as typeof fetch;
    const cfg = configWith(() => {});
    expect(await fetchAndRewriteUpstream(cfg)).toBeNull();
  });

  it("returns empty list when upstream has no URLs on the source domain", async () => {
    const cfg = configWith((c) => {
      c.source_domain = "src.com";
      c.proxy_domain = "prx.com";
    });
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        new Response("<urlset><url><loc>https://other.com/x</loc></url></urlset>", { status: 200 }),
      ) as unknown as typeof fetch;
    expect(await fetchAndRewriteUpstream(cfg)).toEqual([]);
  });

  it("dedupes URLs that appear multiple times in the upstream", async () => {
    const cfg = configWith((c) => {
      c.source_domain = "src.com";
      c.proxy_domain = "prx.com";
    });
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        `<urlset>
          <url><loc>https://src.com/about</loc></url>
          <url><loc>https://www.src.com/about</loc></url>
          <url><loc>https://src.com/about</loc></url>
        </urlset>`,
        { status: 200 },
      ),
    ) as unknown as typeof fetch;
    expect(await fetchAndRewriteUpstream(cfg)).toEqual(["https://prx.com/about"]);
  });
});
