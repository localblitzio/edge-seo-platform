import { describe, expect, it } from "vitest";

import {
  LINK_PROJECT_STATUSES,
  parseAnchorOptions,
  validateLinkProjectInput,
} from "../../../frontend-worker/src/link-projects.js";

describe("parseAnchorOptions", () => {
  it("returns the parsed array for a JSON-encoded string list", () => {
    expect(parseAnchorOptions('["one","two","three"]')).toEqual(["one", "two", "three"]);
  });

  it("returns [] for an empty array literal", () => {
    expect(parseAnchorOptions("[]")).toEqual([]);
  });

  it("returns [] on JSON parse error (defensive — D1 hand-edits)", () => {
    expect(parseAnchorOptions("not json")).toEqual([]);
  });

  it("returns [] when the parsed value is not an array", () => {
    expect(parseAnchorOptions('{"foo":"bar"}')).toEqual([]);
  });

  it("filters non-string entries silently (resilience over strictness)", () => {
    expect(parseAnchorOptions('["ok",42,null,"also-ok"]')).toEqual(["ok", "also-ok"]);
  });
});

describe("validateLinkProjectInput — happy paths", () => {
  it("accepts a minimal valid submission with default status=draft", () => {
    const r = validateLinkProjectInput({
      label: "Push xyz.com",
      target_url: "https://xyz.com/services",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.label).toBe("Push xyz.com");
      expect(r.value.target_url).toBe("https://xyz.com/services");
      expect(r.value.anchor_options).toEqual([]);
      expect(r.value.status).toBe("draft");
      expect(r.value.notes).toBeNull();
    }
  });

  it("trims label and notes", () => {
    const r = validateLinkProjectInput({
      label: "  My push  ",
      target_url: "https://xyz.com",
      notes: "  some notes  ",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.label).toBe("My push");
      expect(r.value.notes).toBe("some notes");
    }
  });

  it("splits anchor_options on newlines and drops blanks", () => {
    const r = validateLinkProjectInput({
      label: "L",
      target_url: "https://x.com",
      anchor_options: "one\n  two  \n\n three\n",
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.anchor_options).toEqual(["one", "two", "three"]);
  });

  it("also splits anchor_options on commas (paste-from-spreadsheet)", () => {
    const r = validateLinkProjectInput({
      label: "L",
      target_url: "https://x.com",
      anchor_options: "alpha, beta,gamma",
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.anchor_options).toEqual(["alpha", "beta", "gamma"]);
  });

  it("accepts every status value defined in LINK_PROJECT_STATUSES", () => {
    for (const s of LINK_PROJECT_STATUSES) {
      const r = validateLinkProjectInput({
        label: "L",
        target_url: "https://x.com",
        status: s,
      });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value.status).toBe(s);
    }
  });
});

describe("validateLinkProjectInput — sad paths", () => {
  it("rejects missing label", () => {
    const r = validateLinkProjectInput({ target_url: "https://x.com" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => /label is required/.test(e))).toBe(true);
  });

  it("rejects missing target_url", () => {
    const r = validateLinkProjectInput({ label: "L" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => /target_url is required/.test(e))).toBe(true);
  });

  it("rejects non-http(s) target_url protocols", () => {
    const r = validateLinkProjectInput({
      label: "L",
      target_url: "javascript:alert(1)",
    });
    expect(r.ok).toBe(false);
    if (!r.ok)
      // Accept either the protocol-specific or the parse-error message;
      // either lands the user on the same fix.
      expect(r.errors.some((e) => /target_url/.test(e))).toBe(true);
  });

  it("rejects an unparseable target_url", () => {
    const r = validateLinkProjectInput({ label: "L", target_url: "not a url" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => /target_url/.test(e))).toBe(true);
  });

  it("rejects an unknown status value", () => {
    const r = validateLinkProjectInput({
      label: "L",
      target_url: "https://x.com",
      status: "bogus",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => /status/.test(e))).toBe(true);
  });

  it("rejects more than 10 anchor options", () => {
    const eleven = Array.from({ length: 11 }, (_, i) => `a${i}`).join("\n");
    const r = validateLinkProjectInput({
      label: "L",
      target_url: "https://x.com",
      anchor_options: eleven,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => /at most 10/.test(e))).toBe(true);
  });

  it("rejects an over-long anchor option", () => {
    const longAnchor = "a".repeat(201);
    const r = validateLinkProjectInput({
      label: "L",
      target_url: "https://x.com",
      anchor_options: longAnchor,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => /200 chars/.test(e))).toBe(true);
  });

  it("rejects an over-long label", () => {
    const r = validateLinkProjectInput({
      label: "a".repeat(201),
      target_url: "https://x.com",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => /label/.test(e))).toBe(true);
  });
});
