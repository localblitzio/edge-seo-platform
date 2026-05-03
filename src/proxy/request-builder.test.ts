import { describe, expect, it } from "vitest";

import type { OriginAuth, RouteRule } from "../config/schema.js";
import type { Env } from "../env.js";
import { buildOriginRequest } from "./request-builder.js";

function makeRequest(
  init: { headers?: Record<string, string>; method?: string; body?: BodyInit | null } = {},
  url = "https://lanterncrest.com/blog/post-1?ref=newsletter",
): Request {
  const reqInit: RequestInit = { method: init.method ?? "GET" };
  if (init.headers) reqInit.headers = init.headers;
  if (init.body !== undefined) reqInit.body = init.body;
  return new Request(url, reqInit);
}

const baseRoute: RouteRule = {
  match: "^/blog",
  type: "proxy",
  origin: "https://blog.lanterncrest.com",
  origin_auth: { type: "none" },
};

function build(overrides: {
  request?: Request;
  origin?: string;
  stripPrefix?: string;
  originAuth?: OriginAuth;
  env?: Record<string, unknown>;
}): Request {
  const request = overrides.request ?? makeRequest();
  return buildOriginRequest({
    request,
    url: new URL(request.url),
    origin: overrides.origin ?? baseRoute.origin ?? "https://x.example",
    stripPrefix: overrides.stripPrefix,
    originAuth: overrides.originAuth ?? { type: "none" },
    env: (overrides.env ?? {}) as unknown as Env,
  });
}

describe("buildOriginRequest — URL construction", () => {
  it("rewrites hostname to origin while preserving path and query", () => {
    const out = build({});
    expect(out.url).toBe("https://blog.lanterncrest.com/blog/post-1?ref=newsletter");
  });

  it("strips the configured prefix from the path before forwarding", () => {
    const out = build({ stripPrefix: "/blog" });
    expect(out.url).toBe("https://blog.lanterncrest.com/post-1?ref=newsletter");
  });

  it("collapses an exact prefix match to '/' instead of empty string", () => {
    const r = makeRequest({}, "https://lanterncrest.com/blog");
    const out = build({ request: r, stripPrefix: "/blog" });
    expect(new URL(out.url).pathname).toBe("/");
  });

  it("leaves the path alone when prefix doesn't match", () => {
    const out = build({ stripPrefix: "/notmatched" });
    expect(out.url).toBe("https://blog.lanterncrest.com/blog/post-1?ref=newsletter");
  });
});

describe("buildOriginRequest — header transformations", () => {
  it("rewrites Host to the origin's hostname", () => {
    const out = build({});
    expect(out.headers.get("host")).toBe("blog.lanterncrest.com");
  });

  it("sets X-Forwarded-For from CF-Connecting-IP and X-Forwarded-Proto/Host", () => {
    const r = makeRequest({
      headers: { "CF-Connecting-IP": "203.0.113.42", Host: "lanterncrest.com" },
    });
    const out = build({ request: r });
    expect(out.headers.get("x-forwarded-for")).toBe("203.0.113.42");
    expect(out.headers.get("x-forwarded-proto")).toBe("https");
    expect(out.headers.get("x-forwarded-host")).toBe("lanterncrest.com");
  });

  it("does not set X-Forwarded-For when CF-Connecting-IP is absent", () => {
    const out = build({});
    expect(out.headers.has("x-forwarded-for")).toBe(false);
  });

  it("strips all cf-* headers (including the connecting-ip we copied)", () => {
    const r = makeRequest({
      headers: {
        "CF-Connecting-IP": "203.0.113.42",
        "CF-IPCountry": "US",
        "CF-Visitor": '{"scheme":"https"}',
        "CF-RAY": "abc123",
      },
    });
    const out = build({ request: r });
    for (const name of ["cf-connecting-ip", "cf-ipcountry", "cf-visitor", "cf-ray"]) {
      expect(out.headers.has(name)).toBe(false);
    }
  });

  it("disables upstream compression with Accept-Encoding: identity", () => {
    const r = makeRequest({ headers: { "Accept-Encoding": "br, gzip" } });
    const out = build({ request: r });
    expect(out.headers.get("accept-encoding")).toBe("identity");
  });
});

describe("buildOriginRequest — origin auth", () => {
  it("none: no auth headers added", () => {
    const out = build({ originAuth: { type: "none" } });
    expect(out.headers.has("authorization")).toBe(false);
  });

  it("aop: no per-request work (zone-level)", () => {
    const out = build({ originAuth: { type: "aop" } });
    // Just ensure we didn't add bogus headers; AOP is invisible at this layer.
    expect(out.headers.has("authorization")).toBe(false);
  });

  it("header_token: reads secret from env and sets the named header", () => {
    const out = build({
      originAuth: { type: "header_token", header: "X-Origin-Token", secret_name: "ORIGIN_SECRET" },
      env: { ORIGIN_SECRET: "shhh" },
    });
    expect(out.headers.get("x-origin-token")).toBe("shhh");
  });

  it("header_token: throws on missing secret in env", () => {
    expect(() =>
      build({
        originAuth: { type: "header_token", header: "X-Origin-Token", secret_name: "MISSING" },
        env: {},
      }),
    ).toThrow(/missing secret 'MISSING'/);
  });

  it("mtls: builds the Request without adding auth headers (dispatch happens in fetchFromOrigin)", () => {
    const out = build({
      originAuth: { type: "mtls", cert_secret_name: "CLIENT_X_MTLS" },
    });
    expect(out.headers.has("authorization")).toBe(false);
    expect(out.url).toBe("https://blog.lanterncrest.com/blog/post-1?ref=newsletter");
  });
});

describe("buildOriginRequest — method and body passthrough", () => {
  it("preserves the request method on body-less requests", () => {
    const r = makeRequest({ method: "DELETE" });
    const out = build({ request: r });
    expect(out.method).toBe("DELETE");
  });

  it("sets redirect: manual so origin redirects don't auto-follow", () => {
    const out = build({});
    expect(out.redirect).toBe("manual");
  });
});
