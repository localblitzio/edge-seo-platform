import { describe, expect, it } from "vitest";

import { validLanternCrestConfig } from "../../tests/fixtures/configs/index.js";
import { ClientConfig } from "../config/schema.js";
import { resolveCanonical } from "./index.js";

function configWith(mut: (cfg: Record<string, unknown>) => void): ClientConfig {
  const cfg = validLanternCrestConfig() as Record<string, unknown>;
  mut(cfg);
  return ClientConfig.parse(cfg);
}

describe("resolveCanonical — first-match-wins", () => {
  it("returns self canonical when first matching rule says self", () => {
    const config = configWith((cfg) => {
      (cfg.canonicals as Array<Record<string, unknown>>) = [
        { match: "^/blog/.*", strategy: { type: "self" } },
      ];
    });
    const out = resolveCanonical(new URL("https://lanterncrest.com/blog/post-1?ref=x"), config);
    expect(out).toEqual({
      strategy: "self",
      url: "https://lanterncrest.com/blog/post-1",
      sync_og: true,
      sync_twitter: true,
      sync_jsonld: true,
    });
  });

  it("returns origin canonical when rule says origin", () => {
    const config = configWith((cfg) => {
      (cfg.canonicals as Array<Record<string, unknown>>) = [
        { match: "^/blog/.*", strategy: { type: "origin" } },
      ];
    });
    const out = resolveCanonical(new URL("https://lanterncrest.com/blog/post-1?ref=x"), config);
    expect(out.strategy).toBe("origin");
    expect(out.url).toBe("https://blog.lanterncrest.com/blog/post-1");
  });

  it("returns custom canonical with the configured URL", () => {
    const config = configWith((cfg) => {
      (cfg.canonicals as Array<Record<string, unknown>>) = [
        {
          match: "^/blog/.*",
          strategy: { type: "custom", url: "https://canonical.example/x" },
        },
      ];
    });
    const out = resolveCanonical(new URL("https://lanterncrest.com/blog/p"), config);
    expect(out.strategy).toBe("custom");
    expect(out.url).toBe("https://canonical.example/x");
  });

  it("returns noindex with null url", () => {
    const config = configWith((cfg) => {
      (cfg.canonicals as Array<Record<string, unknown>>) = [
        { match: "^/blog/.*", strategy: { type: "noindex" } },
      ];
    });
    const out = resolveCanonical(new URL("https://lanterncrest.com/blog/p"), config);
    expect(out.strategy).toBe("noindex");
    expect(out.url).toBeNull();
  });

  it("first match wins on overlap (array order)", () => {
    const config = configWith((cfg) => {
      (cfg.canonicals as Array<Record<string, unknown>>) = [
        { match: "^/blog/.*", strategy: { type: "self" } },
        { match: "^/blog/post-1$", strategy: { type: "noindex" } },
      ];
    });
    const out = resolveCanonical(new URL("https://lanterncrest.com/blog/post-1"), config);
    expect(out.strategy).toBe("self");
  });

  it("non-matching rules are skipped, later rule still wins", () => {
    const config = configWith((cfg) => {
      (cfg.canonicals as Array<Record<string, unknown>>) = [
        { match: "^/never$", strategy: { type: "noindex" } },
        { match: "^/blog/.*", strategy: { type: "self" } },
      ];
    });
    const out = resolveCanonical(new URL("https://lanterncrest.com/blog/post-1"), config);
    expect(out.strategy).toBe("self");
  });

  it("propagates sync_og / sync_twitter / sync_jsonld flags from the rule", () => {
    const config = configWith((cfg) => {
      (cfg.canonicals as Array<Record<string, unknown>>) = [
        {
          match: "^/blog/.*",
          strategy: { type: "self" },
          sync_og_url: false,
          sync_twitter_url: false,
          sync_jsonld_url: false,
        },
      ];
    });
    const out = resolveCanonical(new URL("https://lanterncrest.com/blog/post-1"), config);
    expect(out.sync_og).toBe(false);
    expect(out.sync_twitter).toBe(false);
    expect(out.sync_jsonld).toBe(false);
  });
});

describe("resolveCanonical — defaults when no rule matches (§6.3 SEO guardrail)", () => {
  it("proxy route default is `origin`, NOT `self` (PRD §13 duplicate-content trap)", () => {
    const config = configWith((cfg) => {
      // Lantern Crest fixture's first route is a proxy on /blog
      (cfg.canonicals as Array<Record<string, unknown>>) = [];
    });
    const out = resolveCanonical(new URL("https://lanterncrest.com/blog/post-1?ref=x"), config);
    expect(out.strategy).toBe("origin");
    expect(out.url).toBe("https://blog.lanterncrest.com/blog/post-1?ref=x");
    expect(out.sync_og).toBe(true);
    expect(out.sync_twitter).toBe(true);
    expect(out.sync_jsonld).toBe(true);
  });

  it("custom_page route default is `self` (custom pages are unique to the proxy)", () => {
    const config = configWith((cfg) => {
      (cfg.canonicals as Array<Record<string, unknown>>) = [];
      (cfg.routing as Array<Record<string, unknown>>) = [
        { match: "^/welcome$", type: "custom_page", custom_page_key: "" },
      ];
    });
    const out = resolveCanonical(new URL("https://lanterncrest.com/welcome"), config);
    expect(out.strategy).toBe("self");
    expect(out.url).toBe("https://lanterncrest.com/welcome");
  });

  it("no route matches at all → defaults to origin (safer fallback)", () => {
    const config = configWith((cfg) => {
      (cfg.canonicals as Array<Record<string, unknown>>) = [];
      (cfg.routing as Array<Record<string, unknown>>) = [
        { match: "^/specific$", type: "proxy", origin: "https://x.example" },
      ];
    });
    const out = resolveCanonical(new URL("https://lanterncrest.com/something-else"), config);
    expect(out.strategy).toBe("origin");
    expect(out.url).toContain("blog.lanterncrest.com");
  });

  it("WeakMap cache returns identical decisions across repeated calls", () => {
    const config = configWith((cfg) => {
      (cfg.canonicals as Array<Record<string, unknown>>) = [
        { match: "^/blog/.*", strategy: { type: "self" } },
      ];
    });
    const url = new URL("https://lanterncrest.com/blog/post-1");
    expect(resolveCanonical(url, config)).toEqual(resolveCanonical(url, config));
  });
});
