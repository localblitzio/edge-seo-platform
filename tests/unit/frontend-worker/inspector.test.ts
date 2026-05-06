import { describe, expect, it } from "vitest";

import { looksGenerated } from "../../../frontend-worker/src/inspector.js";

describe("looksGenerated", () => {
  it("flags IDs with embedded hex hashes", () => {
    expect(looksGenerated("vbid-9e859d8e-ylldheqp")).toBe(true);
    expect(looksGenerated("comp-l8wsmf5d")).toBe(true); // caught by prefix
    expect(looksGenerated("w-node-_b3a9f12c")).toBe(true);
    expect(looksGenerated("css-1abc234d")).toBe(true);
  });

  it("flags known site-builder / framework prefixes", () => {
    expect(looksGenerated("vbid-anything")).toBe(true);
    expect(looksGenerated("comp-anything")).toBe(true);
    expect(looksGenerated("w-node-anything")).toBe(true);
    expect(looksGenerated("mantine-anything")).toBe(true);
    expect(looksGenerated("radix-anything")).toBe(true);
    expect(looksGenerated("chakra-anything")).toBe(true);
  });

  it("accepts human-authored IDs without long hex tokens", () => {
    expect(looksGenerated("hero-title")).toBe(false);
    expect(looksGenerated("main-nav")).toBe(false);
    expect(looksGenerated("about-us")).toBe(false);
    expect(looksGenerated("header-2024")).toBe(false); // 4 hex chars, under threshold
    expect(looksGenerated("section-3")).toBe(false);
    expect(looksGenerated("entry-title")).toBe(false);
  });

  it("matches case-insensitively", () => {
    expect(looksGenerated("VBID-anything")).toBe(true);
    expect(looksGenerated("Comp-Anything")).toBe(true);
  });

  it("flags long pure-hex ID (UUID-ish)", () => {
    expect(looksGenerated("9e859d8e1234567890abcdef")).toBe(true);
  });

  it("flags 6+ consecutive hex chars even with no recognized prefix", () => {
    // a,b,c,1,2,3 are all hex chars in a row → flagged.
    expect(looksGenerated("abc123")).toBe(true);
    expect(looksGenerated("abcdef-12345")).toBe(true);
  });

  it("does NOT flag IDs with under 6 consecutive hex chars", () => {
    expect(looksGenerated("ab12-cd34")).toBe(false); // 4 + 4 hex, separated by hyphen
  });
});
