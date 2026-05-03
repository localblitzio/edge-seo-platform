import { describe, expect, it } from "vitest";

import type { IndexationRule } from "../config/schema.js";
import { applyXRobotsTag } from "./index.js";

function rule(overrides: Partial<IndexationRule> & { match: string }): IndexationRule {
  return {
    robots: "noindex,follow",
    additional_directives: [],
    ...overrides,
  };
}

describe("applyXRobotsTag", () => {
  it("passes HTML responses through unchanged (meta tag handles HTML, M5)", () => {
    const upstream = new Response("<html></html>", {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
    const out = applyXRobotsTag(upstream, "/anything", [rule({ match: "^/" })]);
    expect(out).toBe(upstream);
    expect(out.headers.has("x-robots-tag")).toBe(false);
  });

  it("passes XHTML responses through unchanged", () => {
    const upstream = new Response("<html></html>", {
      headers: { "content-type": "application/xhtml+xml" },
    });
    const out = applyXRobotsTag(upstream, "/anything", [rule({ match: "^/" })]);
    expect(out).toBe(upstream);
  });

  it("sets X-Robots-Tag on a non-HTML response when a rule matches", () => {
    const upstream = new Response("PDF bytes", {
      headers: { "content-type": "application/pdf" },
    });
    const out = applyXRobotsTag(upstream, "/docs/whitepaper.pdf", [
      rule({ match: "^/docs/.*\\.pdf$", robots: "noindex,follow" }),
    ]);
    expect(out.headers.get("x-robots-tag")).toBe("noindex,follow");
  });

  it("joins additional_directives with commas after the base robots directive", () => {
    const upstream = new Response("img bytes", {
      headers: { "content-type": "image/jpeg" },
    });
    const out = applyXRobotsTag(upstream, "/img/x.jpg", [
      rule({
        match: "^/img/",
        robots: "index,follow",
        additional_directives: ["max-image-preview:large", "noarchive"],
      }),
    ]);
    expect(out.headers.get("x-robots-tag")).toBe("index,follow,max-image-preview:large,noarchive");
  });

  it("returns response unchanged when no rule matches the path", () => {
    const upstream = new Response("payload", {
      headers: { "content-type": "application/octet-stream" },
    });
    const out = applyXRobotsTag(upstream, "/no-match", [rule({ match: "^/specific$" })]);
    expect(out).toBe(upstream);
    expect(out.headers.has("x-robots-tag")).toBe(false);
  });

  it("first-match-wins when multiple rules match the path", () => {
    const upstream = new Response("payload", {
      headers: { "content-type": "application/json" },
    });
    const out = applyXRobotsTag(upstream, "/api/data", [
      rule({ match: "^/api/", robots: "noindex,follow" }),
      rule({ match: "^/", robots: "index,follow" }),
    ]);
    expect(out.headers.get("x-robots-tag")).toBe("noindex,follow");
  });

  it("preserves status, statusText, and other headers", () => {
    const upstream = new Response("not found body", {
      status: 404,
      statusText: "Not Found",
      headers: { "content-type": "application/json", "x-trace-id": "abc" },
    });
    const out = applyXRobotsTag(upstream, "/api/missing", [rule({ match: "^/api/" })]);
    expect(out.status).toBe(404);
    expect(out.statusText).toBe("Not Found");
    expect(out.headers.get("x-trace-id")).toBe("abc");
    expect(out.headers.get("x-robots-tag")).toBe("noindex,follow");
  });

  it("treats a missing Content-Type as non-HTML (sets the header)", () => {
    const upstream = new Response("payload");
    upstream.headers.delete("content-type");
    const out = applyXRobotsTag(upstream, "/docs/x", [
      rule({ match: "^/docs/", robots: "noindex,nofollow" }),
    ]);
    expect(out.headers.get("x-robots-tag")).toBe("noindex,nofollow");
  });
});
