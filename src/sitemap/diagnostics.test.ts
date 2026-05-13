import { describe, expect, it } from "vitest";

import { validLanternCrestConfig } from "../../tests/fixtures/configs/index.js";
import { ClientConfig } from "../config/schema.js";

import { computePathDiagnostics } from "./diagnostics.js";

function configWith(mut: (cfg: Record<string, unknown>) => void): ClientConfig {
  const cfg = validLanternCrestConfig() as Record<string, unknown>;
  mut(cfg);
  return ClientConfig.parse(cfg);
}

describe("computePathDiagnostics", () => {
  it("returns just the implicit homepage row when no rules pin a literal path and no seed_paths", () => {
    // Behavior changed: every site gets an implicit `/` candidate
    // (sourced as seed_paths) so the indexing page always has at
    // least one row to interact with. Pre-change this returned [].
    const config = configWith(() => {});
    const diag = computePathDiagnostics(config);
    expect(diag).toHaveLength(1);
    expect(diag[0]?.path).toBe("/");
    expect(diag[0]?.sources).toEqual(["seed_paths"]);
  });

  it("includes seed_paths with verdict=include even when default canonical = origin", () => {
    const config = configWith((cfg) => {
      cfg.seed_paths = ["/about"];
    });
    const diag = computePathDiagnostics(config);
    // Two rows now: /about (operator seed) + / (implicit homepage seed).
    expect(diag).toHaveLength(2);
    const about = diag.find((r) => r.path === "/about");
    if (!about) throw new Error("no /about row");
    expect(about.url).toBe("https://lanterncrest.com/about");
    expect(about.sources).toEqual(["seed_paths"]);
    expect(about.canonical).toBe("origin");
    expect(about.verdict.kind).toBe("include");
    // Homepage is also present and also includes (implicit seed semantics).
    const home = diag.find((r) => r.path === "/");
    if (!home) throw new Error("no / row");
    expect(home.verdict.kind).toBe("include");
  });

  it("merges sources when a path appears in multiple sections", () => {
    const config = configWith((cfg) => {
      (cfg.routing as Array<Record<string, unknown>>) = [
        { match: "^/about$", type: "custom_page", custom_page_key: "" },
      ];
      (cfg.text_rewrites as Array<Record<string, unknown>>) = [
        { match: "^/about$", selector: "h1", content: "About" },
      ];
      cfg.seed_paths = ["/about"];
    });
    const diag = computePathDiagnostics(config);
    const about = diag.find((r) => r.path === "/about");
    if (!about) throw new Error("no /about row");
    expect(about.sources).toEqual(["seed_paths", "routing", "text_rewrites"]);
  });

  it("excludes proxy-route paths with default canonical=origin (not seed)", () => {
    const config = configWith((cfg) => {
      // /about derived from a text_rewrite — NOT seed_paths. Default
      // routing for Lantern Crest is wildcard proxy → canonical defaults to origin.
      (cfg.text_rewrites as Array<Record<string, unknown>>) = [
        { match: "^/about$", selector: "h1", content: "About" },
      ];
    });
    const diag = computePathDiagnostics(config);
    const about = diag.find((r) => r.path === "/about");
    if (!about) throw new Error("no /about row");
    expect(about.verdict.kind).toBe("exclude");
    if (about.verdict.kind !== "exclude") throw new Error("wrong kind");
    expect(about.verdict.reason.kind).toBe("canonical_origin");
  });

  it("includes a path with canonicals[] rule explicitly setting strategy=self", () => {
    const config = configWith((cfg) => {
      (cfg.text_rewrites as Array<Record<string, unknown>>) = [
        { match: "^/services$", selector: "h1", content: "Services" },
      ];
      (cfg.canonicals as Array<Record<string, unknown>>) = [
        { match: "^/services$", strategy: { type: "self" } },
      ];
    });
    const diag = computePathDiagnostics(config);
    const services = diag.find((r) => r.path === "/services");
    if (!services) throw new Error("no /services row");
    expect(services.canonical).toBe("self");
    expect(services.canonicalMatched).toBe(true);
    expect(services.verdict.kind).toBe("include");
  });

  it("excludes paths with canonicals[] strategy=custom (and shows the custom URL)", () => {
    const config = configWith((cfg) => {
      cfg.seed_paths = ["/about"];
      (cfg.canonicals as Array<Record<string, unknown>>) = [
        {
          match: "^/about$",
          strategy: { type: "custom", url: "https://canonical.example.com/about" },
        },
      ];
    });
    const diag = computePathDiagnostics(config);
    const about = diag.find((r) => r.path === "/about");
    if (!about) throw new Error("no /about row");
    expect(about.canonical).toBe("custom");
    expect(about.canonicalCustomUrl).toBe("https://canonical.example.com/about");
    // seed_paths bypasses the *origin* canonical filter, but a *custom*
    // canonical is an explicit "this URL is canonical elsewhere" — we honour it.
    expect(about.verdict.kind).toBe("exclude");
    if (about.verdict.kind !== "exclude") throw new Error("wrong kind");
    expect(about.verdict.reason.kind).toBe("canonical_external");
  });

  it("excludes paths with indexation noindex (regardless of canonical)", () => {
    const config = configWith((cfg) => {
      cfg.seed_paths = ["/about"];
      (cfg.indexation as Array<Record<string, unknown>>) = [
        { match: "^/about$", robots: "noindex,follow", additional_directives: [] },
      ];
    });
    const diag = computePathDiagnostics(config);
    const about = diag.find((r) => r.path === "/about");
    if (!about) throw new Error("no /about row");
    expect(about.robots).toBe("noindex,follow");
    expect(about.verdict.kind).toBe("exclude");
    if (about.verdict.kind !== "exclude") throw new Error("wrong kind");
    expect(about.verdict.reason.kind).toBe("noindex");
  });

  it("excludes paths matched by redirects.static[].from", () => {
    const config = configWith((cfg) => {
      cfg.seed_paths = ["/old", "/new"];
      (cfg.redirects as Record<string, Array<Record<string, unknown>>>).static = [
        { from: "/old", to: "/new", status: "301" },
      ];
    });
    const diag = computePathDiagnostics(config);
    const old = diag.find((r) => r.path === "/old");
    if (!old) throw new Error("no /old row");
    expect(old.redirectSource).toBe(true);
    expect(old.verdict.kind).toBe("exclude");
    if (old.verdict.kind !== "exclude") throw new Error("wrong kind");
    expect(old.verdict.reason.kind).toBe("redirect_source");
  });

  it("returns rows sorted lexicographically by path", () => {
    const config = configWith((cfg) => {
      cfg.seed_paths = ["/zebra", "/apple", "/mango"];
    });
    const diag = computePathDiagnostics(config);
    // `/` is the implicit homepage candidate, sorts before any /letter path.
    expect(diag.map((r) => r.path)).toEqual(["/", "/apple", "/mango", "/zebra"]);
  });

  it("agrees with collectSitemapUrls on which paths appear (verdict=include set is identical)", async () => {
    const { collectSitemapUrls } = await import("./generator.js");
    const config = configWith((cfg) => {
      (cfg.routing as Array<Record<string, unknown>>) = [
        { match: "^/about$", type: "custom_page", custom_page_key: "" },
        { match: "^/contact$", type: "custom_page", custom_page_key: "" },
      ];
      cfg.seed_paths = ["/services", "/blocked"];
      (cfg.indexation as Array<Record<string, unknown>>) = [
        { match: "^/blocked$", robots: "noindex,follow", additional_directives: [] },
      ];
    });
    const sitemapUrls = new Set(collectSitemapUrls(config));
    const diagInclude = new Set(
      computePathDiagnostics(config)
        .filter((r) => r.verdict.kind === "include")
        .map((r) => r.url),
    );
    expect(diagInclude).toEqual(sitemapUrls);
  });
});
