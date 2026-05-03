import { describe, expect, it } from "vitest";

import type { StaticRedirect } from "../config/schema.js";
import { buildStaticMap, resolveStatic } from "./static-map.js";

function rule(overrides: Partial<StaticRedirect> & { from: string; to: string }): StaticRedirect {
  return {
    status: "301",
    preserve_query: true,
    ...overrides,
  };
}

describe("static-map — buildStaticMap", () => {
  it("indexes by `from` for O(1) lookup", () => {
    const map = buildStaticMap([rule({ from: "/a", to: "/x" }), rule({ from: "/b", to: "/y" })]);
    expect(map.byPath.get("/a")?.rule.to).toBe("/x");
    expect(map.byPath.get("/b")?.rule.to).toBe("/y");
    expect(map.byPath.get("/missing")).toBeUndefined();
  });
});

describe("static-map — resolveStatic", () => {
  it("returns null when path is not in the map", () => {
    const map = buildStaticMap([rule({ from: "/old", to: "/new" })]);
    expect(resolveStatic("/missing", "", map)).toBeNull();
  });

  it("returns a 301 by default with the rule index", () => {
    const map = buildStaticMap([rule({ from: "/old", to: "/new" })]);
    const out = resolveStatic("/old", "", map);
    expect(out).toEqual({
      matched: true,
      destination: "/new",
      status: 301,
      source_layer: "static",
      source_index: 0,
    });
  });

  it("converts the status string enum to a numeric code", () => {
    const map = buildStaticMap([
      rule({ from: "/old", to: "/new", status: "302" }),
      rule({ from: "/gone", to: "/", status: "410" }),
    ]);
    expect(resolveStatic("/old", "", map)?.status).toBe(302);
    expect(resolveStatic("/gone", "", map)?.status).toBe(410);
  });

  it("preserves query when preserve_query is true and destination has no query", () => {
    const map = buildStaticMap([rule({ from: "/old", to: "/new" })]);
    const out = resolveStatic("/old", "?ref=newsletter", map);
    expect(out?.destination).toBe("/new?ref=newsletter");
  });

  it("does NOT append search when destination already has a query string", () => {
    const map = buildStaticMap([rule({ from: "/old", to: "/new?utm=keep" })]);
    const out = resolveStatic("/old", "?ref=newsletter", map);
    expect(out?.destination).toBe("/new?utm=keep");
  });

  it("does NOT append when preserve_query is false", () => {
    const map = buildStaticMap([rule({ from: "/old", to: "/new", preserve_query: false })]);
    const out = resolveStatic("/old", "?ref=newsletter", map);
    expect(out?.destination).toBe("/new");
  });

  it("handles an empty search string", () => {
    const map = buildStaticMap([rule({ from: "/old", to: "/new" })]);
    expect(resolveStatic("/old", "", map)?.destination).toBe("/new");
  });

  it("follows a chain up to MAX_HOPS, returning the chain's final destination", () => {
    const map = buildStaticMap([
      rule({ from: "/a", to: "/b" }),
      rule({ from: "/b", to: "/c" }),
      rule({ from: "/c", to: "/d" }),
    ]);
    const out = resolveStatic("/a", "", map);
    expect(out?.destination).toBe("/d");
    expect(out?.source_index).toBe(0);
  });

  it("uses the FIRST rule's status code on a chain", () => {
    const map = buildStaticMap([
      rule({ from: "/a", to: "/b", status: "302" }),
      rule({ from: "/b", to: "/c", status: "301" }),
    ]);
    expect(resolveStatic("/a", "", map)?.status).toBe(302);
  });

  it("returns 508 with destination='/' on chain overflow (4-hop chain)", () => {
    const map = buildStaticMap([
      rule({ from: "/a", to: "/b" }),
      rule({ from: "/b", to: "/c" }),
      rule({ from: "/c", to: "/d" }),
      rule({ from: "/d", to: "/e" }),
    ]);
    const out = resolveStatic("/a", "", map);
    expect(out).toEqual({
      matched: true,
      destination: "/",
      status: 508,
      source_layer: "static",
      source_index: 0,
    });
  });

  it("returns 508 on a tight cycle A→B→A", () => {
    const map = buildStaticMap([rule({ from: "/a", to: "/b" }), rule({ from: "/b", to: "/a" })]);
    expect(resolveStatic("/a", "", map)?.status).toBe(508);
  });
});
