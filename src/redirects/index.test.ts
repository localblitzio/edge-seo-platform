import { describe, expect, it } from "vitest";

import { validLanternCrestConfig } from "../../tests/fixtures/configs/index.js";
import { ClientConfig } from "../config/schema.js";
import { resolveRedirect } from "./index.js";

function configWith(mut: (cfg: Record<string, unknown>) => void): ClientConfig {
  const cfg = validLanternCrestConfig() as Record<string, unknown>;
  mut(cfg);
  return ClientConfig.parse(cfg);
}

const baseRequest = new Request("https://lanterncrest.com/");

describe("resolveRedirect — orchestration", () => {
  it("returns { matched: false } when no layer matches", () => {
    const config = configWith((cfg) => {
      (cfg.redirects as Record<string, unknown>) = {
        static: [],
        patterns: [],
        conditional: [],
      };
    });
    const out = resolveRedirect(new URL("https://lanterncrest.com/no-match"), baseRequest, config);
    expect(out).toEqual({ matched: false });
  });

  it("static layer wins over pattern when both could match", () => {
    const config = configWith((cfg) => {
      (cfg.redirects as Record<string, unknown>) = {
        static: [{ from: "/abc", to: "/static-dest" }],
        patterns: [{ pattern: "^/abc$", replacement: "/pattern-dest" }],
        conditional: [],
      };
    });
    const out = resolveRedirect(new URL("https://lanterncrest.com/abc"), baseRequest, config);
    if (!out.matched) throw new Error("expected match");
    expect(out.source_layer).toBe("static");
    expect(out.destination).toBe("/static-dest");
  });

  it("pattern layer wins over conditional when both could match", () => {
    const config = configWith((cfg) => {
      (cfg.redirects as Record<string, unknown>) = {
        static: [],
        patterns: [{ pattern: "^/x$", replacement: "/pattern-dest" }],
        conditional: [
          {
            match: "^/x$",
            conditions: [],
            to: "/conditional-dest",
            status: "302",
          },
        ],
      };
    });
    const out = resolveRedirect(new URL("https://lanterncrest.com/x"), baseRequest, config);
    if (!out.matched) throw new Error("expected match");
    expect(out.source_layer).toBe("pattern");
    expect(out.destination).toBe("/pattern-dest");
  });

  it("falls through to conditional when static and pattern miss", () => {
    const config = configWith((cfg) => {
      (cfg.redirects as Record<string, unknown>) = {
        static: [],
        patterns: [],
        conditional: [
          {
            match: "^/$",
            conditions: [],
            to: "/conditional-dest",
            status: "302",
          },
        ],
      };
    });
    const out = resolveRedirect(new URL("https://lanterncrest.com/"), baseRequest, config);
    if (!out.matched) throw new Error("expected match");
    expect(out.source_layer).toBe("conditional");
    expect(out.destination).toBe("/conditional-dest");
  });

  it("does NOT re-evaluate the destination across layers (cross-layer non-re-eval)", () => {
    // Pattern rewrites /old-post → /post-1; a static rule for /post-1 → /static-final
    // exists, but per spec §6.2 the destination is NOT walked back through static.
    const config = configWith((cfg) => {
      (cfg.redirects as Record<string, unknown>) = {
        static: [{ from: "/post-1", to: "/static-final" }],
        patterns: [{ pattern: "^/old-post$", replacement: "/post-1" }],
        conditional: [],
      };
    });
    const out = resolveRedirect(new URL("https://lanterncrest.com/old-post"), baseRequest, config);
    if (!out.matched) throw new Error("expected match");
    expect(out.source_layer).toBe("pattern");
    expect(out.destination).toBe("/post-1"); // not /static-final
  });

  it("compiles regexes once per ClientConfig (WeakMap cache)", () => {
    // We can't directly observe the cache, but we can verify identical
    // results across repeated calls and that the second call works
    // even without invariants throwing.
    const config = configWith((cfg) => {
      (cfg.redirects as Record<string, unknown>) = {
        static: [],
        patterns: [{ pattern: "^/posts/(\\d+)$", replacement: "/blog/$1" }],
        conditional: [],
      };
    });
    const url = new URL("https://lanterncrest.com/posts/42");
    const a = resolveRedirect(url, baseRequest, config);
    const b = resolveRedirect(url, baseRequest, config);
    expect(a).toEqual(b);
  });

  it("uses request.cf for geo conditions", () => {
    const config = configWith((cfg) => {
      (cfg.redirects as Record<string, unknown>) = {
        static: [],
        patterns: [],
        conditional: [
          {
            match: "^/$",
            conditions: [{ type: "geo_country", in: ["DE"] }],
            to: "/de",
            status: "302",
          },
        ],
      };
    });
    const req = new Request("https://lanterncrest.com/");
    Object.assign(req, { cf: { country: "DE" } });
    const out = resolveRedirect(new URL("https://lanterncrest.com/"), req, config);
    if (!out.matched) throw new Error("expected match");
    expect(out.destination).toBe("/de");
  });
});
