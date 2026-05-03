import { describe, expect, it } from "vitest";

import type { ConditionalRedirect } from "../config/schema.js";
import {
  compileConditional,
  detectDevice,
  evaluateCondition,
  getCookieValue,
  resolveConditional,
} from "./conditional.js";

function makeRequest(
  init: { headers?: Record<string, string>; cf?: Record<string, unknown> } = {},
): Request {
  const reqInit: RequestInit = {};
  if (init.headers) reqInit.headers = init.headers;
  const req = new Request("https://example.com/", reqInit);
  if (init.cf) {
    Object.assign(req, { cf: init.cf });
  }
  return req;
}

function rule(overrides: Partial<ConditionalRedirect>): ConditionalRedirect {
  return {
    match: "^/.*$",
    conditions: [],
    to: "/redirected",
    status: "302",
    ...overrides,
  };
}

describe("detectDevice", () => {
  it("returns 'desktop' for null/empty UA", () => {
    expect(detectDevice(null)).toBe("desktop");
    expect(detectDevice("")).toBe("desktop");
  });

  it("classifies iPad as tablet", () => {
    expect(detectDevice("Mozilla/5.0 (iPad; CPU OS 17_0)")).toBe("tablet");
  });

  it("classifies tablet UA as tablet", () => {
    expect(detectDevice("Mozilla/5.0 (Linux; Tablet; Android 13)")).toBe("tablet");
  });

  it("classifies iPhone as mobile", () => {
    expect(detectDevice("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)")).toBe("mobile");
  });

  it("classifies Android Mobi as mobile", () => {
    expect(detectDevice("Mozilla/5.0 (Linux; Android 13) Mobile Safari")).toBe("mobile");
  });

  it("classifies plain desktop UA as desktop", () => {
    expect(detectDevice("Mozilla/5.0 (Windows NT 10.0) Chrome/120.0")).toBe("desktop");
  });
});

describe("getCookieValue", () => {
  it("returns null for empty/null header", () => {
    expect(getCookieValue(null, "session")).toBeNull();
    expect(getCookieValue("", "session")).toBeNull();
  });

  it("extracts a single cookie value", () => {
    expect(getCookieValue("session=abc123", "session")).toBe("abc123");
  });

  it("extracts a cookie among many", () => {
    expect(getCookieValue("a=1; session=abc; b=2", "session")).toBe("abc");
  });

  it("returns null when the cookie is missing", () => {
    expect(getCookieValue("a=1; b=2", "missing")).toBeNull();
  });

  it("preserves equals signs in the cookie value", () => {
    expect(getCookieValue("token=eyJhbGc=.payload=.sig=", "token")).toBe("eyJhbGc=.payload=.sig=");
  });

  it("ignores malformed cookie segments without an equals", () => {
    expect(getCookieValue("malformed; session=abc", "session")).toBe("abc");
  });
});

describe("evaluateCondition", () => {
  const url = new URL("https://example.com/x?utm=y");

  it("geo_country: matches when cf.country is in the list", () => {
    const req = makeRequest({ cf: { country: "US" } });
    expect(evaluateCondition({ type: "geo_country", in: ["US", "CA"] }, req, url)).toBe(true);
    expect(evaluateCondition({ type: "geo_country", in: ["GB"] }, req, url)).toBe(false);
  });

  it("geo_country: false when cf is absent", () => {
    const req = makeRequest();
    expect(evaluateCondition({ type: "geo_country", in: ["US"] }, req, url)).toBe(false);
  });

  it("device: matches when UA classifier matches", () => {
    const mobile = makeRequest({ headers: { "User-Agent": "iPhone Mobile" } });
    const desktop = makeRequest({ headers: { "User-Agent": "Chrome/120" } });
    expect(evaluateCondition({ type: "device", is: "mobile" }, mobile, url)).toBe(true);
    expect(evaluateCondition({ type: "device", is: "mobile" }, desktop, url)).toBe(false);
    expect(evaluateCondition({ type: "device", is: "desktop" }, desktop, url)).toBe(true);
  });

  it("cookie: equals match", () => {
    const req = makeRequest({ headers: { Cookie: "ab_variant=B" } });
    expect(evaluateCondition({ type: "cookie", name: "ab_variant", equals: "B" }, req, url)).toBe(
      true,
    );
    expect(evaluateCondition({ type: "cookie", name: "ab_variant", equals: "A" }, req, url)).toBe(
      false,
    );
  });

  it("cookie: exists=true succeeds when present, fails when absent", () => {
    const present = makeRequest({ headers: { Cookie: "session=abc" } });
    const absent = makeRequest();
    expect(evaluateCondition({ type: "cookie", name: "session", exists: true }, present, url)).toBe(
      true,
    );
    expect(evaluateCondition({ type: "cookie", name: "session", exists: true }, absent, url)).toBe(
      false,
    );
  });

  it("cookie: exists=false succeeds when absent", () => {
    const absent = makeRequest();
    expect(evaluateCondition({ type: "cookie", name: "session", exists: false }, absent, url)).toBe(
      true,
    );
  });

  it("cookie: presence-only when neither flag set", () => {
    const req = makeRequest({ headers: { Cookie: "session=abc" } });
    expect(evaluateCondition({ type: "cookie", name: "session" }, req, url)).toBe(true);
    expect(evaluateCondition({ type: "cookie", name: "missing" }, req, url)).toBe(false);
  });

  it("query_param: equals match", () => {
    const url2 = new URL("https://example.com/x?source=ppc");
    const req = makeRequest();
    expect(
      evaluateCondition({ type: "query_param", name: "source", equals: "ppc" }, req, url2),
    ).toBe(true);
    expect(
      evaluateCondition({ type: "query_param", name: "source", equals: "organic" }, req, url2),
    ).toBe(false);
  });

  it("query_param: exists flag", () => {
    const url2 = new URL("https://example.com/x?gclid=abc");
    const req = makeRequest();
    expect(evaluateCondition({ type: "query_param", name: "gclid", exists: true }, req, url2)).toBe(
      true,
    );
    expect(
      evaluateCondition({ type: "query_param", name: "gclid", exists: false }, req, url2),
    ).toBe(false);
    expect(
      evaluateCondition({ type: "query_param", name: "missing", exists: false }, req, url2),
    ).toBe(true);
  });

  it("query_param: presence-only when neither flag set", () => {
    const url2 = new URL("https://example.com/x?utm=y");
    const req = makeRequest();
    expect(evaluateCondition({ type: "query_param", name: "utm" }, req, url2)).toBe(true);
    expect(evaluateCondition({ type: "query_param", name: "missing" }, req, url2)).toBe(false);
  });

  it("referrer: substring match on the Referer header", () => {
    const req = makeRequest({ headers: { Referer: "https://google.com/search?q=x" } });
    expect(evaluateCondition({ type: "referrer", contains: "google.com" }, req, url)).toBe(true);
    expect(evaluateCondition({ type: "referrer", contains: "bing.com" }, req, url)).toBe(false);
  });

  it("referrer: false when Referer header is absent", () => {
    const req = makeRequest();
    expect(evaluateCondition({ type: "referrer", contains: "google" }, req, url)).toBe(false);
  });
});

describe("resolveConditional", () => {
  it("returns null when no rule matches the path", () => {
    const list = compileConditional([rule({ match: "^/lp/.*$" })]);
    const url = new URL("https://example.com/blog/post");
    expect(resolveConditional(url, makeRequest(), list)).toBeNull();
  });

  it("matches first rule whose path AND all conditions pass", () => {
    const list = compileConditional([
      rule({
        match: "^/$",
        conditions: [{ type: "geo_country", in: ["US"] }],
        to: "/us",
        status: "302",
      }),
      rule({
        match: "^/$",
        conditions: [{ type: "geo_country", in: ["GB"] }],
        to: "/uk",
        status: "302",
      }),
    ]);
    const url = new URL("https://example.com/");
    const out = resolveConditional(url, makeRequest({ cf: { country: "GB" } }), list);
    expect(out).toEqual({
      matched: true,
      destination: "/uk",
      status: 302,
      source_layer: "conditional",
      source_index: 1,
    });
  });

  it("requires ALL conditions to pass (AND)", () => {
    const list = compileConditional([
      rule({
        match: "^/$",
        conditions: [
          { type: "geo_country", in: ["US"] },
          { type: "device", is: "mobile" },
        ],
        to: "/us-mobile",
      }),
    ]);
    const url = new URL("https://example.com/");
    expect(
      resolveConditional(
        url,
        makeRequest({ cf: { country: "US" }, headers: { "User-Agent": "Chrome/120" } }),
        list,
      ),
    ).toBeNull();
    expect(
      resolveConditional(
        url,
        makeRequest({
          cf: { country: "US" },
          headers: { "User-Agent": "iPhone Mobile" },
        }),
        list,
      )?.destination,
    ).toBe("/us-mobile");
  });

  it("returns null when a path matches but no conditions pass", () => {
    const list = compileConditional([
      rule({
        match: "^/$",
        conditions: [{ type: "geo_country", in: ["US"] }],
        to: "/us",
      }),
    ]);
    expect(
      resolveConditional(
        new URL("https://example.com/"),
        makeRequest({ cf: { country: "GB" } }),
        list,
      ),
    ).toBeNull();
  });
});
