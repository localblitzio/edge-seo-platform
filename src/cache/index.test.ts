import { describe, expect, it } from "vitest";

import type { CacheRule } from "../config/schema.js";
import {
  canReadFromCache,
  canWriteToCache,
  computeCacheTtl,
  deriveCacheKey,
  matchCacheRule,
} from "./index.js";

function rule(overrides: Partial<CacheRule> = {}): CacheRule {
  return {
    match: "^/.*",
    ttl_seconds: 3600,
    cache_key_includes_cookies: [],
    bypass_on_cookie: [],
    ...overrides,
  };
}

function makeRequest(headers: Record<string, string> = {}, method = "GET"): Request {
  return new Request("https://example.com/blog/post-1?x=1", { method, headers });
}

describe("matchCacheRule", () => {
  it("returns the first matching rule (array order)", () => {
    const r1 = rule({ match: "^/blog/post-1$", ttl_seconds: 60 });
    const r2 = rule({ match: "^/blog/.*", ttl_seconds: 3600 });
    expect(matchCacheRule("/blog/post-1", [r1, r2])).toBe(r1);
  });

  it("returns null when no rule matches", () => {
    expect(matchCacheRule("/api/x", [rule({ match: "^/blog/" })])).toBeNull();
  });

  it("returns null on empty rule list", () => {
    expect(matchCacheRule("/anything", [])).toBeNull();
  });
});

describe("deriveCacheKey", () => {
  it("returns the request URL when no cookie keying is configured", () => {
    const req = makeRequest();
    const key = deriveCacheKey(req, rule());
    expect(key.url).toBe("https://example.com/blog/post-1?x=1");
  });

  it("appends cookie values as __cookie_<name> query params", () => {
    const req = makeRequest({ Cookie: "ab=A; sid=xyz" });
    const key = deriveCacheKey(req, rule({ cache_key_includes_cookies: ["ab"] }));
    expect(new URL(key.url).searchParams.get("__cookie_ab")).toBe("A");
  });

  it("only appends cookies that are present", () => {
    const req = makeRequest({ Cookie: "other=1" });
    const key = deriveCacheKey(req, rule({ cache_key_includes_cookies: ["ab"] }));
    expect(new URL(key.url).searchParams.has("__cookie_ab")).toBe(false);
  });
});

describe("canReadFromCache", () => {
  it("allows GET without auth/bypass cookies", () => {
    expect(canReadFromCache(makeRequest(), rule())).toBe(true);
  });

  it("allows HEAD", () => {
    expect(canReadFromCache(makeRequest({}, "HEAD"), rule())).toBe(true);
  });

  it("rejects POST", () => {
    expect(canReadFromCache(makeRequest({}, "POST"), rule())).toBe(false);
  });

  it("rejects when Authorization header is present (§9.1 invariant 1)", () => {
    expect(canReadFromCache(makeRequest({ Authorization: "Bearer x" }), rule())).toBe(false);
  });

  it("rejects when a bypass_on_cookie cookie is set", () => {
    const req = makeRequest({ Cookie: "logged_in=1" });
    expect(canReadFromCache(req, rule({ bypass_on_cookie: ["logged_in"] }))).toBe(false);
  });

  it("allows when bypass cookies are configured but not present", () => {
    const req = makeRequest({ Cookie: "other=1" });
    expect(canReadFromCache(req, rule({ bypass_on_cookie: ["logged_in"] }))).toBe(true);
  });
});

describe("canWriteToCache (§9.1 invariants)", () => {
  it("allows a normal 200 response from a normal GET", () => {
    const req = makeRequest();
    const res = new Response("ok", { status: 200 });
    expect(canWriteToCache(req, res, rule())).toBe(true);
  });

  it("rejects when invariant 1 (Authorization) disqualifies the request", () => {
    const req = makeRequest({ Authorization: "Bearer x" });
    expect(canWriteToCache(req, new Response("ok"), rule())).toBe(false);
  });

  it("rejects when invariant 2 (Set-Cookie) disqualifies the response", () => {
    const req = makeRequest();
    const res = new Response("ok", { status: 200 });
    res.headers.append("set-cookie", "session=abc; Path=/");
    expect(canWriteToCache(req, res, rule())).toBe(false);
  });

  it("rejects when invariant 4 (5xx) disqualifies the response", () => {
    const req = makeRequest();
    expect(canWriteToCache(req, new Response("err", { status: 502 }), rule())).toBe(false);
  });

  it("rejects when invariant 5 (bot UA) disqualifies the request", () => {
    const req = makeRequest({ "User-Agent": "Mozilla/5.0 (compatible; Googlebot/2.1)" });
    expect(canWriteToCache(req, new Response("ok"), rule())).toBe(false);
  });

  it("rejects bingbot, ClaudeBot, GPTBot too", () => {
    for (const ua of ["bingbot/2.0", "ClaudeBot/1.0", "Mozilla/5.0 GPTBot/1.0"]) {
      const req = makeRequest({ "User-Agent": ua });
      expect(canWriteToCache(req, new Response("ok"), rule())).toBe(false);
    }
  });
});

describe("computeCacheTtl (§9 status defaults)", () => {
  it("5xx → 0 (never cache)", () => {
    expect(computeCacheTtl(new Response("e", { status: 500 }), rule())).toBe(0);
    expect(computeCacheTtl(new Response("e", { status: 503 }), rule())).toBe(0);
  });

  it("3xx → 5 minutes", () => {
    const r = new Response(null, { status: 301, headers: { Location: "/x" } });
    expect(computeCacheTtl(r, null)).toBe(300);
    expect(
      computeCacheTtl(new Response(null, { status: 308, headers: { Location: "/x" } }), rule()),
    ).toBe(300);
  });

  it("4xx → 60 seconds", () => {
    expect(computeCacheTtl(new Response("nf", { status: 404 }), null)).toBe(60);
    expect(computeCacheTtl(new Response("g", { status: 410 }), null)).toBe(60);
  });

  it("2xx → use the matched rule's ttl_seconds", () => {
    expect(computeCacheTtl(new Response("ok"), rule({ ttl_seconds: 1800 }))).toBe(1800);
  });

  it("2xx with no matched rule → 0 (no cache)", () => {
    expect(computeCacheTtl(new Response("ok"), null)).toBe(0);
  });
});
