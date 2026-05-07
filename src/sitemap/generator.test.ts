import { describe, expect, it } from "vitest";

import { validLanternCrestConfig } from "../../tests/fixtures/configs/index.js";
import { ClientConfig } from "../config/schema.js";
import {
  collectSitemapUrls,
  deriveLiteralPath,
  generateSitemapXml,
  isPathSitemapEligible,
} from "./generator.js";

function configWith(mut: (cfg: Record<string, unknown>) => void): ClientConfig {
  const cfg = validLanternCrestConfig() as Record<string, unknown>;
  mut(cfg);
  return ClientConfig.parse(cfg);
}

describe("deriveLiteralPath", () => {
  it("extracts a clean literal from `^/about$`", () => {
    expect(deriveLiteralPath("^/about$")).toBe("/about");
  });

  it("strips the optional-trailing-slash form `^/path/?$`", () => {
    expect(deriveLiteralPath("^/blog/post-1/?$")).toBe("/blog/post-1");
  });

  it("un-escapes regex specials in the inner path", () => {
    expect(deriveLiteralPath("^/path\\.with\\.dots$")).toBe("/path.with.dots");
  });

  it("returns null for wildcard patterns", () => {
    expect(deriveLiteralPath("^/blog/.*")).toBeNull();
    expect(deriveLiteralPath("^/products/[a-z]+$")).toBeNull();
    expect(deriveLiteralPath("^/.*")).toBeNull();
  });

  it("returns null when missing anchors", () => {
    expect(deriveLiteralPath("/about")).toBeNull();
    expect(deriveLiteralPath("^/about")).toBeNull();
    expect(deriveLiteralPath("/about$")).toBeNull();
  });

  it("returns null for empty inner", () => {
    expect(deriveLiteralPath("^$")).toBeNull();
  });

  it("returns null when path doesn't start with /", () => {
    expect(deriveLiteralPath("^about$")).toBeNull();
  });
});

describe("isPathSitemapEligible", () => {
  it("includes a path with no canonical rule when the route default is self (custom_page)", () => {
    const config = configWith((cfg) => {
      (cfg.routing as Array<Record<string, unknown>>) = [
        { match: "^/welcome$", type: "custom_page", custom_page_key: "" },
      ];
      (cfg.canonicals as Array<Record<string, unknown>>) = [];
    });
    expect(isPathSitemapEligible("/welcome", config)).toBe(true);
  });

  it("excludes a path on a proxy route when no canonical rule applies (default = origin)", () => {
    const config = configWith((cfg) => {
      // Lantern Crest default routing is proxy. Default canonical strategy
      // for proxy routes is `origin` per §6.3 — the proxy isn't authoritative.
      (cfg.canonicals as Array<Record<string, unknown>>) = [];
    });
    expect(isPathSitemapEligible("/blog/post-1", config)).toBe(false);
  });

  it("includes a path with a canonicals[] rule that says self", () => {
    const config = configWith((cfg) => {
      (cfg.canonicals as Array<Record<string, unknown>>) = [
        { match: "^/blog/.*", strategy: { type: "self" } },
      ];
    });
    expect(isPathSitemapEligible("/blog/post-1", config)).toBe(true);
  });

  it("excludes a path with a canonicals[] rule that says noindex/origin/custom", () => {
    for (const strategyType of ["origin", "noindex", "custom"]) {
      const config = configWith((cfg) => {
        (cfg.canonicals as Array<Record<string, unknown>>) = [
          {
            match: "^/blog/.*",
            strategy:
              strategyType === "custom"
                ? { type: "custom", url: "https://example.com/canon" }
                : { type: strategyType },
          },
        ];
      });
      expect(isPathSitemapEligible("/blog/post-1", config)).toBe(false);
    }
  });

  it("excludes a path matched by an indexation rule with noindex", () => {
    const config = configWith((cfg) => {
      (cfg.routing as Array<Record<string, unknown>>) = [
        { match: "^/welcome$", type: "custom_page", custom_page_key: "" },
      ];
      (cfg.indexation as Array<Record<string, unknown>>) = [
        { match: "^/welcome$", robots: "noindex,follow", additional_directives: [] },
      ];
    });
    expect(isPathSitemapEligible("/welcome", config)).toBe(false);
  });

  it("excludes a path that's listed in redirects.static[].from", () => {
    const config = configWith((cfg) => {
      (cfg.routing as Array<Record<string, unknown>>) = [
        { match: "^/welcome$", type: "custom_page", custom_page_key: "" },
      ];
      (cfg.redirects as Record<string, Array<Record<string, unknown>>>).static = [
        { from: "/welcome", to: "/welcome-new", status: "301" },
      ];
    });
    expect(isPathSitemapEligible("/welcome", config)).toBe(false);
  });
});

describe("collectSitemapUrls", () => {
  it("returns an empty list when no rules pin a literal path", () => {
    const config = configWith(() => {});
    // Lantern Crest fixture only has wildcard `^/.*` rules.
    expect(collectSitemapUrls(config)).toEqual([]);
  });

  it("collects literal paths across routing + per-page-rule sections", () => {
    const config = configWith((cfg) => {
      (cfg.routing as Array<Record<string, unknown>>) = [
        { match: "^/about$", type: "custom_page", custom_page_key: "" },
        { match: "^/contact$", type: "custom_page", custom_page_key: "" },
      ];
      // /services has a text rewrite but isn't a custom_page route.
      // For it to appear in the sitemap, the operator must have set
      // a self-canonical (otherwise it falls into the default-origin
      // fallback and gets filtered out — which is correct: a path
      // with no route isn't reachable).
      (cfg.text_rewrites as Array<Record<string, unknown>>) = [
        { match: "^/services$", selector: "h1", content: "Services" },
      ];
      (cfg.canonicals as Array<Record<string, unknown>>) = [
        { match: "^/services$", strategy: { type: "self" } },
      ];
    });
    expect(collectSitemapUrls(config)).toEqual([
      "https://lanterncrest.com/about",
      "https://lanterncrest.com/contact",
      "https://lanterncrest.com/services",
    ]);
  });

  it("dedupes the same path appearing in multiple sections", () => {
    const config = configWith((cfg) => {
      (cfg.routing as Array<Record<string, unknown>>) = [
        { match: "^/about$", type: "custom_page", custom_page_key: "" },
      ];
      (cfg.text_rewrites as Array<Record<string, unknown>>) = [
        { match: "^/about$", selector: "h1", content: "About us" },
      ];
      (cfg.meta_rewrites as Array<Record<string, unknown>>) = [
        { match: "^/about$", tag: "title", value: "About — Site" },
      ];
      (cfg.canonicals as Array<Record<string, unknown>>) = [];
    });
    expect(collectSitemapUrls(config)).toEqual(["https://lanterncrest.com/about"]);
  });

  it("returns paths sorted lexicographically", () => {
    const config = configWith((cfg) => {
      (cfg.routing as Array<Record<string, unknown>>) = [
        { match: "^/zebra$", type: "custom_page", custom_page_key: "" },
        { match: "^/apple$", type: "custom_page", custom_page_key: "" },
        { match: "^/mango$", type: "custom_page", custom_page_key: "" },
      ];
      (cfg.canonicals as Array<Record<string, unknown>>) = [];
    });
    expect(collectSitemapUrls(config)).toEqual([
      "https://lanterncrest.com/apple",
      "https://lanterncrest.com/mango",
      "https://lanterncrest.com/zebra",
    ]);
  });

  it("filters out wildcard-match rules", () => {
    const config = configWith((cfg) => {
      (cfg.routing as Array<Record<string, unknown>>) = [
        { match: "^/$", type: "custom_page", custom_page_key: "" },
        {
          match: "^/blog/.*",
          type: "proxy",
          origin: "https://blog.example",
          origin_auth: { type: "none" },
        },
      ];
      (cfg.canonicals as Array<Record<string, unknown>>) = [
        { match: "^/$", strategy: { type: "self" } },
      ];
    });
    expect(collectSitemapUrls(config)).toEqual(["https://lanterncrest.com/"]);
  });

  it("includes operator seed_paths even when no canonical rule matches (bypasses default-origin filter)", () => {
    const config = configWith((cfg) => {
      // Wildcard-only routing — default canonical for proxy routes is `origin`.
      // Without seed_paths, sitemap would be empty.
      cfg.seed_paths = ["/about", "/services/seo", "/contact"];
    });
    expect(collectSitemapUrls(config)).toEqual([
      "https://lanterncrest.com/about",
      "https://lanterncrest.com/contact",
      "https://lanterncrest.com/services/seo",
    ]);
  });

  it("dedupes seed_paths against literal-rule paths", () => {
    const config = configWith((cfg) => {
      (cfg.routing as Array<Record<string, unknown>>) = [
        { match: "^/about$", type: "custom_page", custom_page_key: "" },
      ];
      cfg.seed_paths = ["/about", "/extra"];
    });
    expect(collectSitemapUrls(config)).toEqual([
      "https://lanterncrest.com/about",
      "https://lanterncrest.com/extra",
    ]);
  });

  it("respects noindex on seed_paths (active blocker overrides operator declaration)", () => {
    const config = configWith((cfg) => {
      cfg.seed_paths = ["/keep", "/private"];
      (cfg.indexation as Array<Record<string, unknown>>) = [
        { match: "^/private$", robots: "noindex,follow", additional_directives: [] },
      ];
    });
    expect(collectSitemapUrls(config)).toEqual(["https://lanterncrest.com/keep"]);
  });

  it("respects redirect-source on seed_paths (the path redirects away)", () => {
    const config = configWith((cfg) => {
      cfg.seed_paths = ["/old", "/new"];
      (cfg.redirects as Record<string, Array<Record<string, unknown>>>).static = [
        { from: "/old", to: "/new", status: "301" },
      ];
    });
    expect(collectSitemapUrls(config)).toEqual(["https://lanterncrest.com/new"]);
  });
});

describe("generateSitemapXml", () => {
  it("emits valid XML with the urlset wrapper", () => {
    const config = configWith((cfg) => {
      (cfg.routing as Array<Record<string, unknown>>) = [
        { match: "^/$", type: "custom_page", custom_page_key: "" },
        { match: "^/about$", type: "custom_page", custom_page_key: "" },
      ];
      (cfg.canonicals as Array<Record<string, unknown>>) = [];
    });
    const xml = generateSitemapXml(config);
    expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>');
    expect(xml).toContain('<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">');
    expect(xml).toContain("<loc>https://lanterncrest.com/</loc>");
    expect(xml).toContain("<loc>https://lanterncrest.com/about</loc>");
    expect(xml).toContain("</urlset>");
  });

  it("emits an empty urlset when no eligible paths exist", () => {
    const config = configWith(() => {});
    const xml = generateSitemapXml(config);
    expect(xml).toContain("<urlset");
    expect(xml).toContain("</urlset>");
    expect(xml).not.toContain("<url>");
  });

  it("XML-escapes ampersands in URLs (defensive — paths shouldn't have them, but)", () => {
    const config = configWith((cfg) => {
      (cfg.routing as Array<Record<string, unknown>>) = [
        // Need a literal `&` in the path for the test — not realistic but exercises the escape path.
        { match: "^/path\\&q$", type: "custom_page", custom_page_key: "" },
      ];
      (cfg.canonicals as Array<Record<string, unknown>>) = [];
    });
    const xml = generateSitemapXml(config);
    expect(xml).toContain("&amp;");
    expect(xml).not.toMatch(/<loc>[^<]*&[^a]/); // raw & not followed by amp/lt/etc
  });
});
