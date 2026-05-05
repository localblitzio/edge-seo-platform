import { describe, expect, it } from "vitest";

import { checkCsrf, flashRedirect, fnvHash, readFlash } from "../../../admin-worker/src/helpers.js";

describe("fnvHash", () => {
  it("produces a deterministic 8-character lowercase hex digest", () => {
    expect(fnvHash("hello")).toMatch(/^[0-9a-f]{8}$/);
  });

  it("is stable for the same input", () => {
    expect(fnvHash("a-config-blob")).toBe(fnvHash("a-config-blob"));
  });

  it("produces different hashes for different inputs", () => {
    expect(fnvHash("a")).not.toBe(fnvHash("b"));
  });

  it("handles the empty string", () => {
    expect(fnvHash("")).toMatch(/^[0-9a-f]{8}$/);
  });

  it("handles unicode input without throwing", () => {
    expect(fnvHash("café — über")).toMatch(/^[0-9a-f]{8}$/);
  });

  it("changes when one byte differs", () => {
    const a = fnvHash('{"client_id":"x","status":"active"}');
    const b = fnvHash('{"client_id":"x","status":"paused"}');
    expect(a).not.toBe(b);
  });
});

describe("checkCsrf", () => {
  const url = new URL("https://admin.example/clients/foo/edit");

  function reqWith(headers: Record<string, string>): Request {
    return new Request(url.toString(), { method: "POST", headers });
  }

  it("passes when Origin matches", () => {
    expect(checkCsrf(reqWith({ origin: "https://admin.example" }), url)).toBeNull();
  });

  it("rejects when Origin mismatches", async () => {
    const r = checkCsrf(reqWith({ origin: "https://evil.example" }), url);
    expect(r).not.toBeNull();
    expect(r?.status).toBe(403);
  });

  it("falls back to Referer when Origin is missing", () => {
    expect(checkCsrf(reqWith({ referer: "https://admin.example/clients" }), url)).toBeNull();
  });

  it("rejects when Referer host mismatches", () => {
    const r = checkCsrf(reqWith({ referer: "https://evil.example/x" }), url);
    expect(r?.status).toBe(403);
  });

  it("rejects when Referer is malformed", () => {
    const r = checkCsrf(reqWith({ referer: "not a url" }), url);
    expect(r?.status).toBe(403);
  });

  it("rejects when neither Origin nor Referer is present", () => {
    const r = checkCsrf(reqWith({}), url);
    expect(r?.status).toBe(403);
  });

  it("rejects when Origin protocol differs (http vs https) via Referer fallback", () => {
    // No Origin header; Referer with wrong protocol must be rejected.
    const r = checkCsrf(reqWith({ referer: "http://admin.example/clients" }), url);
    expect(r?.status).toBe(403);
  });
});

describe("flashRedirect / readFlash", () => {
  it("emits a 303 with location carrying flash params", () => {
    const r = flashRedirect("/clients/foo", { text: "Saved.", kind: "ok" });
    expect(r.status).toBe(303);
    const loc = r.headers.get("location") ?? "";
    expect(loc).toContain("/clients/foo");
    expect(loc).toContain("flash=Saved.");
    expect(loc).toContain("flash_kind=ok");
  });

  it("readFlash returns null when no flash params", () => {
    expect(readFlash(new URL("https://admin.example/clients/foo"))).toBeNull();
  });

  it("round-trips through flashRedirect → URL → readFlash", () => {
    const r = flashRedirect("/clients/foo", { text: "Hello world", kind: "warn" });
    const loc = r.headers.get("location") ?? "";
    const parsed = readFlash(new URL(loc, "https://admin.example"));
    expect(parsed).toEqual({ text: "Hello world", kind: "warn" });
  });

  it("defaults to ok when flash_kind is missing or invalid", () => {
    const u = new URL("https://admin.example/x?flash=hi");
    expect(readFlash(u)).toEqual({ text: "hi", kind: "ok" });
    const u2 = new URL("https://admin.example/x?flash=hi&flash_kind=bogus");
    expect(readFlash(u2)).toEqual({ text: "hi", kind: "ok" });
  });

  it("escapes special characters in flash text via URL encoding", () => {
    const r = flashRedirect("/x", { text: "a & b = c", kind: "err" });
    const loc = r.headers.get("location") ?? "";
    const parsed = readFlash(new URL(loc, "https://admin.example"));
    expect(parsed?.text).toBe("a & b = c");
  });
});
