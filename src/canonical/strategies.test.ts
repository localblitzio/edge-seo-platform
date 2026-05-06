import { describe, expect, it } from "vitest";

import { applyStrategy } from "./strategies.js";

describe("applyStrategy", () => {
  const url = new URL("https://lanterncrest.com/blog/post-1?ref=newsletter");
  const sourceDomain = "blog.lanterncrest.com";

  it("self → returns the proxy URL with query/hash stripped", () => {
    // Canonical URLs strip query strings: every cache-busted /
    // tracking-paramed URL should canonicalize to the same canonical,
    // not fragment ranking signals across query variants.
    expect(applyStrategy({ type: "self" }, url, sourceDomain)).toEqual({
      strategy: "self",
      url: "https://lanterncrest.com/blog/post-1",
    });
  });

  it("origin → rewrites hostname to source_domain, drops port + query/hash", () => {
    const proxyWithPort = new URL("http://localhost:8787/welcome?utm=x#section");
    expect(applyStrategy({ type: "origin" }, proxyWithPort, "example.com")).toEqual({
      strategy: "origin",
      url: "http://example.com/welcome",
    });
  });

  it("origin → preserves protocol on a normal HTTPS proxy URL, strips query", () => {
    expect(applyStrategy({ type: "origin" }, url, sourceDomain)).toEqual({
      strategy: "origin",
      url: "https://blog.lanterncrest.com/blog/post-1",
    });
  });

  it("custom → returns the configured URL verbatim", () => {
    expect(
      applyStrategy(
        { type: "custom", url: "https://canonical.example/landing" },
        url,
        sourceDomain,
      ),
    ).toEqual({
      strategy: "custom",
      url: "https://canonical.example/landing",
    });
  });

  it("noindex → returns null url", () => {
    expect(applyStrategy({ type: "noindex" }, url, sourceDomain)).toEqual({
      strategy: "noindex",
      url: null,
    });
  });
});
