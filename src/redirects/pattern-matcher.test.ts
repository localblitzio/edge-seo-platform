import { describe, expect, it } from "vitest";

import type { PatternRedirect } from "../config/schema.js";
import { compilePatterns, resolvePattern } from "./pattern-matcher.js";

function rule(
  overrides: Partial<PatternRedirect> & { pattern: string; replacement: string },
): PatternRedirect {
  return { status: "301", ...overrides };
}

describe("pattern-matcher — compilePatterns", () => {
  it("compiles each pattern once", () => {
    const list = compilePatterns([rule({ pattern: "^/posts/(\\d+)$", replacement: "/posts/$1/" })]);
    expect(list.compiled).toHaveLength(1);
    expect(list.compiled[0]?.test("/posts/42")).toBe(true);
  });
});

describe("pattern-matcher — resolvePattern", () => {
  it("returns null on no match", () => {
    const list = compilePatterns([rule({ pattern: "^/posts/(\\d+)$", replacement: "/posts/$1/" })]);
    expect(resolvePattern("/about", list)).toBeNull();
  });

  it("rewrites with backreferences and reports source_index", () => {
    const list = compilePatterns([
      rule({ pattern: "^/about$", replacement: "/about-us" }),
      rule({ pattern: "^/posts/(\\d+)$", replacement: "/posts/$1/" }),
    ]);
    const out = resolvePattern("/posts/42", list);
    expect(out).toEqual({
      matched: true,
      destination: "/posts/42/",
      status: 301,
      source_layer: "pattern",
      source_index: 1,
    });
  });

  it("returns the FIRST matching rule on overlap (array order)", () => {
    const list = compilePatterns([
      rule({ pattern: "^/foo$", replacement: "/bar", status: "302" }),
      rule({ pattern: "^/foo$", replacement: "/baz", status: "301" }),
    ]);
    const out = resolvePattern("/foo", list);
    expect(out?.destination).toBe("/bar");
    expect(out?.source_index).toBe(0);
    expect(out?.status).toBe(302);
  });

  it("collapses chained matches across rules within the layer", () => {
    const list = compilePatterns([
      rule({ pattern: "^/old-(.+)$", replacement: "/intermediate-$1" }),
      rule({ pattern: "^/intermediate-(.+)$", replacement: "/new-$1" }),
    ]);
    const out = resolvePattern("/old-x", list);
    expect(out?.destination).toBe("/new-x");
    expect(out?.source_index).toBe(0);
  });

  it("returns 508 when chain exceeds MAX_HOPS", () => {
    const list = compilePatterns([
      rule({ pattern: "^/a$", replacement: "/b" }),
      rule({ pattern: "^/b$", replacement: "/c" }),
      rule({ pattern: "^/c$", replacement: "/d" }),
      rule({ pattern: "^/d$", replacement: "/e" }),
    ]);
    const out = resolvePattern("/a", list);
    expect(out).toEqual({
      matched: true,
      destination: "/",
      status: 508,
      source_layer: "pattern",
      source_index: 0,
    });
  });

  it("treats a fixed-point match (destination equals input) as stable", () => {
    const list = compilePatterns([
      // Pattern matches but replacement is identical to the input.
      rule({ pattern: "^/.*$", replacement: "$&" }),
    ]);
    const out = resolvePattern("/foo", list);
    expect(out?.destination).toBe("/foo");
    expect(out?.source_index).toBe(0);
    expect(out?.status).toBe(301);
  });

  it("treats fixed-point on a CHAINED hop as stable, not 508", () => {
    const list = compilePatterns([
      rule({ pattern: "^/x$", replacement: "/y" }),
      // /y matches but doesn't change.
      rule({ pattern: "^/y$", replacement: "/y" }),
    ]);
    const out = resolvePattern("/x", list);
    expect(out?.destination).toBe("/y");
    expect(out?.source_index).toBe(0);
  });
});
