import { describe, expect, it } from "vitest";

import {
  SESSION_COOKIE_NAME,
  hashPassword,
  parseSessionCookie,
  randomTokenHex,
  sessionCookieHeader,
  verifyPassword,
} from "../../../frontend-worker/src/auth.js";

describe("hashPassword / verifyPassword", () => {
  it("verifies a correct password round-trip", async () => {
    const hash = await hashPassword("correct horse battery staple");
    expect(await verifyPassword("correct horse battery staple", hash)).toBe(true);
  });

  it("rejects an incorrect password", async () => {
    const hash = await hashPassword("right");
    expect(await verifyPassword("wrong", hash)).toBe(false);
  });

  it("produces a different hash each time (salted)", async () => {
    const a = await hashPassword("same-password");
    const b = await hashPassword("same-password");
    expect(a).not.toBe(b);
    // But both verify the same password
    expect(await verifyPassword("same-password", a)).toBe(true);
    expect(await verifyPassword("same-password", b)).toBe(true);
  });

  it("encodes the iteration count in the hash format", async () => {
    const hash = await hashPassword("x");
    expect(hash).toMatch(/^pbkdf2\$25000\$[0-9a-f]+\$[0-9a-f]+$/);
  });

  it("verifies a hash from a higher-iteration era (forward-compat)", async () => {
    // Simulate a stored hash created when PBKDF2_ITERATIONS was higher
    // (e.g., the original 200k). Verify must still accept it because the
    // iteration count is read from the value, not from the constant.
    // We can't easily construct a 200k hash quickly in a test, so we use
    // 50k — different from current 25k — to prove the read-from-value
    // path works.
    const hash = await hashPassword("x"); // current 25k
    const tampered = hash.replace(/^pbkdf2\$25000/, "pbkdf2$50000");
    // Tampering the iterations breaks verify (different derived bytes),
    // which is the correct behavior — we only verify what was actually
    // computed at that count.
    expect(await verifyPassword("x", tampered)).toBe(false);
  });

  it("returns false (not throws) on a malformed stored hash", async () => {
    expect(await verifyPassword("any", "")).toBe(false);
    expect(await verifyPassword("any", "garbage")).toBe(false);
    expect(await verifyPassword("any", "pbkdf2$abc$xyz")).toBe(false); // missing parts
    expect(await verifyPassword("any", "pbkdf2$0$ff$ff")).toBe(false); // 0 iterations
    expect(await verifyPassword("any", "scrypt$1$ff$ff")).toBe(false); // wrong scheme
    expect(await verifyPassword("any", "pbkdf2$200000$nothex$ff")).toBe(false);
  });

  it("rejects a hash whose iteration parameter is non-numeric", async () => {
    expect(await verifyPassword("any", "pbkdf2$abc$00$ff")).toBe(false);
  });

  it("handles unicode passwords correctly", async () => {
    const hash = await hashPassword("pässwörd-🔐-中文");
    expect(await verifyPassword("pässwörd-🔐-中文", hash)).toBe(true);
    expect(await verifyPassword("pässwörd-🔐", hash)).toBe(false);
  });

  it("treats empty plaintext as a valid (if weak) password", async () => {
    const hash = await hashPassword("");
    expect(await verifyPassword("", hash)).toBe(true);
    expect(await verifyPassword("a", hash)).toBe(false);
  });
});

describe("randomTokenHex", () => {
  it("returns lowercase hex of length bytes*2", () => {
    const t = randomTokenHex(32);
    expect(t).toMatch(/^[0-9a-f]{64}$/);
  });

  it("respects custom byte length", () => {
    expect(randomTokenHex(16)).toMatch(/^[0-9a-f]{32}$/);
    expect(randomTokenHex(8)).toMatch(/^[0-9a-f]{16}$/);
  });

  it("returns a different token on each call (cryptographic random)", () => {
    const tokens = new Set<string>();
    for (let i = 0; i < 100; i++) tokens.add(randomTokenHex(16));
    expect(tokens.size).toBe(100);
  });
});

describe("sessionCookieHeader", () => {
  it("emits HttpOnly, Secure, SameSite=Lax with the configured cookie name", () => {
    const cookie = sessionCookieHeader({
      token: "abc123",
      expiresAt: new Date(Date.now() + 60_000),
    });
    expect(cookie).toContain(`${SESSION_COOKIE_NAME}=abc123`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Path=/");
  });

  it("emits a positive Max-Age for a future expiry", () => {
    const cookie = sessionCookieHeader({
      token: "abc",
      expiresAt: new Date(Date.now() + 3600_000),
    });
    const m = cookie.match(/Max-Age=(\d+)/);
    expect(m).not.toBeNull();
    const maxAge = Number(m?.[1]);
    expect(maxAge).toBeGreaterThan(3500);
    expect(maxAge).toBeLessThanOrEqual(3600);
  });

  it("clamps Max-Age to 0 when expiresAt is in the past", () => {
    const cookie = sessionCookieHeader({
      token: "abc",
      expiresAt: new Date(Date.now() - 60_000),
    });
    expect(cookie).toMatch(/Max-Age=0/);
  });

  it("clears the cookie when token is null", () => {
    const cookie = sessionCookieHeader({ token: null });
    expect(cookie).toContain(`${SESSION_COOKIE_NAME}=;`);
    expect(cookie).toContain("Max-Age=0");
    expect(cookie).toContain("HttpOnly");
  });

  it("respects a custom path", () => {
    const cookie = sessionCookieHeader({
      token: "abc",
      expiresAt: new Date(Date.now() + 60_000),
      path: "/app",
    });
    expect(cookie).toContain("Path=/app");
  });
});

describe("parseSessionCookie", () => {
  function reqWithCookie(cookie: string | null): Request {
    const headers = new Headers();
    if (cookie !== null) headers.set("cookie", cookie);
    return new Request("https://example.com/", { headers });
  }

  it("returns null when no Cookie header is present", () => {
    expect(parseSessionCookie(reqWithCookie(null))).toBeNull();
  });

  it("returns the session token when the named cookie is present", () => {
    expect(parseSessionCookie(reqWithCookie(`${SESSION_COOKIE_NAME}=abc123`))).toBe("abc123");
  });

  it("ignores other cookies and returns the named one", () => {
    expect(
      parseSessionCookie(reqWithCookie(`other=xyz; ${SESSION_COOKIE_NAME}=abc; foo=bar`)),
    ).toBe("abc");
  });

  it("returns null when the named cookie is empty", () => {
    expect(parseSessionCookie(reqWithCookie(`${SESSION_COOKIE_NAME}=`))).toBeNull();
  });

  it("returns null when only other cookies are set", () => {
    expect(parseSessionCookie(reqWithCookie("other=xyz; foo=bar"))).toBeNull();
  });

  it("trims whitespace around the cookie name and value", () => {
    expect(parseSessionCookie(reqWithCookie(`  ${SESSION_COOKIE_NAME}=abc  `))).toBe("abc");
  });
});
