import { describe, expect, it } from "vitest";

import { applyStrategy } from "./strategies.js";

describe("applyStrategy", () => {
  const url = new URL("https://lanterncrest.com/blog/post-1?ref=newsletter");
  const sourceDomain = "blog.lanterncrest.com";

  it("self → returns the proxy URL unchanged", () => {
    expect(applyStrategy({ type: "self" }, url, sourceDomain)).toEqual({
      strategy: "self",
      url: "https://lanterncrest.com/blog/post-1?ref=newsletter",
    });
  });

  it("origin → rewrites hostname to source_domain, preserves path/query, drops port", () => {
    const proxyWithPort = new URL("http://localhost:8787/welcome?utm=x");
    expect(applyStrategy({ type: "origin" }, proxyWithPort, "example.com")).toEqual({
      strategy: "origin",
      url: "http://example.com/welcome?utm=x",
    });
  });

  it("origin → preserves protocol on a normal HTTPS proxy URL", () => {
    expect(applyStrategy({ type: "origin" }, url, sourceDomain)).toEqual({
      strategy: "origin",
      url: "https://blog.lanterncrest.com/blog/post-1?ref=newsletter",
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
