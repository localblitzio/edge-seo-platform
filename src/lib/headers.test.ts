import { describe, expect, it } from "vitest";

import {
  SECURITY_HEADERS_ADD_IF_MISSING,
  SECURITY_HEADERS_PRESERVE,
  STRIP_RESPONSE_HEADERS,
  applySecurityHeaders,
  rewriteCookieDomain,
  rewriteRedirectLocation,
} from "./headers.js";

describe("header policy constants", () => {
  it("strip list covers the headers named in spec §10", () => {
    expect(STRIP_RESPONSE_HEADERS).toEqual([
      "server",
      "x-powered-by",
      "x-aspnet-version",
      "x-aspnetmvc-version",
    ]);
  });

  it("add-if-missing list includes nosniff and referrer-policy", () => {
    const names = SECURITY_HEADERS_ADD_IF_MISSING.map(([name]) => name);
    expect(names).toContain("x-content-type-options");
    expect(names).toContain("referrer-policy");
  });

  it("preserve list covers CSP, X-Frame-Options, HSTS", () => {
    expect(SECURITY_HEADERS_PRESERVE).toContain("content-security-policy");
    expect(SECURITY_HEADERS_PRESERVE).toContain("x-frame-options");
    expect(SECURITY_HEADERS_PRESERVE).toContain("strict-transport-security");
  });
});

describe("applySecurityHeaders", () => {
  it("strips banned origin headers", () => {
    const upstream = new Response("hi", {
      headers: {
        Server: "nginx/1.21.0",
        "X-Powered-By": "PHP/8.2",
        "X-AspNet-Version": "4.0",
        "X-AspNetMvc-Version": "5.2",
      },
    });
    const out = applySecurityHeaders(upstream);
    expect(out.headers.has("server")).toBe(false);
    expect(out.headers.has("x-powered-by")).toBe(false);
    expect(out.headers.has("x-aspnet-version")).toBe(false);
    expect(out.headers.has("x-aspnetmvc-version")).toBe(false);
  });

  it("adds nosniff and referrer-policy when missing", () => {
    const out = applySecurityHeaders(new Response("hi"));
    expect(out.headers.get("x-content-type-options")).toBe("nosniff");
    expect(out.headers.get("referrer-policy")).toBe("strict-origin-when-cross-origin");
  });

  it("does NOT override an existing X-Content-Type-Options value", () => {
    const upstream = new Response("hi", {
      headers: { "X-Content-Type-Options": "nosniff; report-to=csp" },
    });
    const out = applySecurityHeaders(upstream);
    expect(out.headers.get("x-content-type-options")).toBe("nosniff; report-to=csp");
  });

  it("preserves CSP, X-Frame-Options, and HSTS untouched", () => {
    const upstream = new Response("hi", {
      headers: {
        "Content-Security-Policy": "default-src 'self'",
        "X-Frame-Options": "DENY",
        "Strict-Transport-Security": "max-age=63072000; includeSubDomains; preload",
      },
    });
    const out = applySecurityHeaders(upstream);
    expect(out.headers.get("content-security-policy")).toBe("default-src 'self'");
    expect(out.headers.get("x-frame-options")).toBe("DENY");
    expect(out.headers.get("strict-transport-security")).toBe(
      "max-age=63072000; includeSubDomains; preload",
    );
  });

  it("preserves status, statusText, and body", () => {
    const upstream = new Response("payload", { status: 418, statusText: "I'm a teapot" });
    const out = applySecurityHeaders(upstream);
    expect(out.status).toBe(418);
    expect(out.statusText).toBe("I'm a teapot");
  });
});

describe("rewriteCookieDomain", () => {
  it("returns the same response when there are no Set-Cookie headers", () => {
    const upstream = new Response("hi");
    const out = rewriteCookieDomain(upstream, "blog.example.com", "example.com");
    expect(out).toBe(upstream);
  });

  it("rewrites Domain= on a single Set-Cookie", () => {
    const upstream = new Response("hi", {
      headers: { "Set-Cookie": "session=abc; Domain=blog.example.com; Path=/; Secure" },
    });
    const out = rewriteCookieDomain(upstream, "blog.example.com", "example.com");
    expect(out.headers.getSetCookie()[0]).toBe("session=abc; Domain=example.com; Path=/; Secure");
  });

  it("rewrites Domain= with a leading dot (.blog.example.com)", () => {
    const upstream = new Response("hi", {
      headers: { "Set-Cookie": "session=abc; Domain=.blog.example.com; Path=/" },
    });
    const out = rewriteCookieDomain(upstream, "blog.example.com", "example.com");
    expect(out.headers.getSetCookie()[0]).toBe("session=abc; Domain=example.com; Path=/");
  });

  it("matches Domain= case-insensitively (lowercase domain=)", () => {
    const upstream = new Response("hi", {
      headers: { "Set-Cookie": "session=abc; domain=blog.example.com; Path=/" },
    });
    const out = rewriteCookieDomain(upstream, "blog.example.com", "example.com");
    expect(out.headers.getSetCookie()[0]).toBe("session=abc; domain=example.com; Path=/");
  });

  it("leaves cookies without an explicit Domain= unchanged", () => {
    const upstream = new Response("hi", {
      headers: { "Set-Cookie": "session=abc; Path=/; HttpOnly" },
    });
    const out = rewriteCookieDomain(upstream, "blog.example.com", "example.com");
    expect(out.headers.getSetCookie()[0]).toBe("session=abc; Path=/; HttpOnly");
  });

  it("rewrites multiple Set-Cookie headers independently", () => {
    const upstream = new Response("hi");
    upstream.headers.append("Set-Cookie", "a=1; Domain=blog.example.com; Path=/");
    upstream.headers.append("Set-Cookie", "b=2; Path=/");
    upstream.headers.append("Set-Cookie", "c=3; Domain=blog.example.com; Secure");
    const out = rewriteCookieDomain(upstream, "blog.example.com", "example.com");
    const cookies = out.headers.getSetCookie();
    expect(cookies).toEqual([
      "a=1; Domain=example.com; Path=/",
      "b=2; Path=/",
      "c=3; Domain=example.com; Secure",
    ]);
  });

  it("does not match a longer suffix (mid-host substring guard)", () => {
    const upstream = new Response("hi", {
      headers: {
        "Set-Cookie": "session=abc; Domain=other-blog.example.com.evil.com; Path=/",
      },
    });
    const out = rewriteCookieDomain(upstream, "blog.example.com", "example.com");
    expect(out.headers.getSetCookie()[0]).toBe(
      "session=abc; Domain=other-blog.example.com.evil.com; Path=/",
    );
  });
});

describe("rewriteRedirectLocation", () => {
  it("returns the same response when there is no Location header", () => {
    const upstream = new Response("hi");
    const out = rewriteRedirectLocation(upstream, "source.com", "proxy.com");
    expect(out).toBe(upstream);
  });

  it("rewrites an absolute https Location pointing at the source", () => {
    // Mirrors WordPress's trailing-slash 301: /about-us → /about-us/
    const upstream = new Response(null, {
      status: 301,
      headers: { Location: "https://source.com/about-us/" },
    });
    const out = rewriteRedirectLocation(upstream, "source.com", "proxy.com");
    expect(out.headers.get("location")).toBe("https://proxy.com/about-us/");
    expect(out.status).toBe(301);
  });

  it("rewrites an http (non-TLS) Location and preserves the scheme", () => {
    const upstream = new Response(null, {
      status: 302,
      headers: { Location: "http://source.com/legacy" },
    });
    const out = rewriteRedirectLocation(upstream, "source.com", "proxy.com");
    expect(out.headers.get("location")).toBe("http://proxy.com/legacy");
  });

  it("strips a www. prefix on the source host", () => {
    const upstream = new Response(null, {
      status: 301,
      headers: { Location: "https://www.source.com/page" },
    });
    const out = rewriteRedirectLocation(upstream, "source.com", "proxy.com");
    expect(out.headers.get("location")).toBe("https://proxy.com/page");
  });

  it("rewrites a protocol-relative Location (//source.com/path)", () => {
    const upstream = new Response(null, {
      status: 301,
      headers: { Location: "//source.com/path?q=1" },
    });
    const out = rewriteRedirectLocation(upstream, "source.com", "proxy.com");
    expect(out.headers.get("location")).toBe("//proxy.com/path?q=1");
  });

  it("preserves query and fragment exactly", () => {
    const upstream = new Response(null, {
      status: 302,
      headers: { Location: "https://source.com/p?utm=x&y=1#section-2" },
    });
    const out = rewriteRedirectLocation(upstream, "source.com", "proxy.com");
    expect(out.headers.get("location")).toBe("https://proxy.com/p?utm=x&y=1#section-2");
  });

  it("matches the host case-insensitively", () => {
    const upstream = new Response(null, {
      status: 301,
      headers: { Location: "https://SOURCE.COM/Page" },
    });
    const out = rewriteRedirectLocation(upstream, "source.com", "proxy.com");
    expect(out.headers.get("location")).toBe("https://proxy.com/Page");
  });

  it("leaves a relative Location untouched (no host to rewrite)", () => {
    const upstream = new Response(null, {
      status: 301,
      headers: { Location: "/about-us/" },
    });
    const out = rewriteRedirectLocation(upstream, "source.com", "proxy.com");
    expect(out).toBe(upstream);
    expect(out.headers.get("location")).toBe("/about-us/");
  });

  it("leaves a redirect to a foreign host untouched", () => {
    const upstream = new Response(null, {
      status: 302,
      headers: { Location: "https://partner.example.com/landing" },
    });
    const out = rewriteRedirectLocation(upstream, "source.com", "proxy.com");
    expect(out).toBe(upstream);
    expect(out.headers.get("location")).toBe("https://partner.example.com/landing");
  });

  it("does NOT match a longer suffix (source.com.evil.com)", () => {
    const upstream = new Response(null, {
      status: 302,
      headers: { Location: "https://source.com.evil.com/phish" },
    });
    const out = rewriteRedirectLocation(upstream, "source.com", "proxy.com");
    expect(out.headers.get("location")).toBe("https://source.com.evil.com/phish");
  });

  it("preserves status, statusText, and other headers", () => {
    const upstream = new Response(null, {
      status: 308,
      statusText: "Permanent Redirect",
      headers: {
        Location: "https://source.com/x",
        "Cache-Control": "max-age=3600",
      },
    });
    const out = rewriteRedirectLocation(upstream, "source.com", "proxy.com");
    expect(out.status).toBe(308);
    expect(out.statusText).toBe("Permanent Redirect");
    expect(out.headers.get("cache-control")).toBe("max-age=3600");
  });
});
