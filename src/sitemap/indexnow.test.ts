import { describe, expect, it } from "vitest";

import {
  buildSubmissions,
  extractKeyFromVerificationPath,
  isIndexNowVerificationPath,
} from "./indexnow.js";

describe("buildSubmissions", () => {
  it("builds a single body for a small URL list", () => {
    const subs = buildSubmissions("acme.com", "abc123", [
      "https://acme.com/page1",
      "https://acme.com/page2",
    ]);
    expect(subs).toHaveLength(1);
    expect(subs[0]).toEqual({
      host: "acme.com",
      key: "abc123",
      keyLocation: "https://acme.com/abc123.txt",
      urlList: ["https://acme.com/page1", "https://acme.com/page2"],
    });
  });

  it("returns [] when the URL list is empty", () => {
    expect(buildSubmissions("acme.com", "abc123", [])).toEqual([]);
  });

  it("returns [] when the key is empty (unbound secret)", () => {
    expect(buildSubmissions("acme.com", "", ["https://acme.com/page1"])).toEqual([]);
  });

  it("chunks URL lists over 10,000 into multiple submissions", () => {
    const urls = Array.from({ length: 25_000 }, (_, i) => `https://acme.com/p${i}`);
    const subs = buildSubmissions("acme.com", "abc123", urls);
    expect(subs).toHaveLength(3); // 10000 + 10000 + 5000
    expect(subs[0]?.urlList).toHaveLength(10_000);
    expect(subs[1]?.urlList).toHaveLength(10_000);
    expect(subs[2]?.urlList).toHaveLength(5_000);
  });

  it("preserves URL order across chunks", () => {
    const urls = Array.from({ length: 12_000 }, (_, i) => `https://acme.com/p${i}`);
    const subs = buildSubmissions("acme.com", "abc123", urls);
    expect(subs[0]?.urlList[0]).toBe("https://acme.com/p0");
    expect(subs[0]?.urlList[9_999]).toBe("https://acme.com/p9999");
    expect(subs[1]?.urlList[0]).toBe("https://acme.com/p10000");
    expect(subs[1]?.urlList[1_999]).toBe("https://acme.com/p11999");
  });

  it("computes keyLocation from host + key", () => {
    expect(buildSubmissions("a.b.c", "xyz", ["https://a.b.c/x"])[0]?.keyLocation).toBe(
      "https://a.b.c/xyz.txt",
    );
  });
});

describe("isIndexNowVerificationPath", () => {
  it("matches /<key>.txt for typical key shapes", () => {
    expect(isIndexNowVerificationPath("/abc123.txt")).toBe(true);
    expect(isIndexNowVerificationPath("/A1B2C3-D4E5.txt")).toBe(true);
    expect(isIndexNowVerificationPath("/0123456789abcdef0123456789abcdef.txt")).toBe(true);
  });

  it("rejects paths without the .txt extension", () => {
    expect(isIndexNowVerificationPath("/abc123")).toBe(false);
    expect(isIndexNowVerificationPath("/abc123.html")).toBe(false);
    expect(isIndexNowVerificationPath("/abc123.txt.bak")).toBe(false);
  });

  it("rejects paths with subdirectories", () => {
    expect(isIndexNowVerificationPath("/sub/abc123.txt")).toBe(false);
    expect(isIndexNowVerificationPath("/abc/def.txt")).toBe(false);
  });

  it("rejects paths with non-key characters in the key segment", () => {
    expect(isIndexNowVerificationPath("/abc.123.txt")).toBe(false);
    expect(isIndexNowVerificationPath("/abc%20.txt")).toBe(false);
    expect(isIndexNowVerificationPath("/abc 123.txt")).toBe(false);
  });

  it("rejects empty key segment", () => {
    expect(isIndexNowVerificationPath("/.txt")).toBe(false);
  });

  it("rejects the bare /sitemap.xml or other non-IndexNow paths", () => {
    expect(isIndexNowVerificationPath("/sitemap.xml")).toBe(false);
    expect(isIndexNowVerificationPath("/")).toBe(false);
    expect(isIndexNowVerificationPath("/about")).toBe(false);
  });
});

describe("extractKeyFromVerificationPath", () => {
  it("returns the key segment from a valid path", () => {
    expect(extractKeyFromVerificationPath("/abc123.txt")).toBe("abc123");
    expect(extractKeyFromVerificationPath("/A1B2C3-D4E5.txt")).toBe("A1B2C3-D4E5");
  });

  it("returns null for paths that don't match the verification shape", () => {
    expect(extractKeyFromVerificationPath("/abc123")).toBeNull();
    expect(extractKeyFromVerificationPath("/sub/abc.txt")).toBeNull();
    expect(extractKeyFromVerificationPath("/.txt")).toBeNull();
  });
});
