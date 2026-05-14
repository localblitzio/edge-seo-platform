import { describe, expect, it } from "vitest";

import type { IndexationCheckRow } from "../../../frontend-worker/src/indexation-check.js";
import {
  type SiteRollup,
  applySiteFilters,
  platformStatsFromSites,
  statusForCheck,
} from "../../../frontend-worker/src/indexation-overview.js";

function fakeSite(overrides: Partial<SiteRollup> = {}): SiteRollup {
  return {
    client_id: "acme-com",
    proxy_domain: "acme-com.localpage.us.com",
    status: "active",
    cluster_labels: [],
    url_count: 10,
    indexed_count: 0,
    not_indexed_count: 0,
    unknown_count: 0,
    unchecked_count: 10,
    latest_check_at: null,
    has_embed: false,
    ...overrides,
  };
}

function fakeCheck(overrides: Partial<IndexationCheckRow> = {}): IndexationCheckRow {
  return {
    id: 1,
    client_id: "acme-com",
    url: "https://acme.com/",
    indexed: 1,
    evidence_json: null,
    checked_at: "2026-05-13 12:00:00",
    checked_by_email: "ops@example.com",
    ...overrides,
  };
}

describe("statusForCheck", () => {
  it("returns 'unchecked' for undefined", () => {
    expect(statusForCheck(undefined)).toBe("unchecked");
  });

  it("returns 'indexed' for indexed=1", () => {
    expect(statusForCheck(fakeCheck({ indexed: 1 }))).toBe("indexed");
  });

  it("returns 'not_indexed' for indexed=0", () => {
    expect(statusForCheck(fakeCheck({ indexed: 0 }))).toBe("not_indexed");
  });

  it("returns 'unknown' for indexed=null", () => {
    expect(statusForCheck(fakeCheck({ indexed: null }))).toBe("unknown");
  });
});

describe("platformStatsFromSites", () => {
  it("returns zeros for empty input", () => {
    expect(platformStatsFromSites([])).toEqual({
      site_count: 0,
      url_count: 0,
      indexed_count: 0,
      not_indexed_count: 0,
      unknown_count: 0,
      unchecked_count: 0,
    });
  });

  it("sums per-site counts", () => {
    const r = platformStatsFromSites([
      fakeSite({
        url_count: 10,
        indexed_count: 3,
        not_indexed_count: 4,
        unknown_count: 1,
        unchecked_count: 2,
      }),
      fakeSite({
        client_id: "otherco-net",
        url_count: 5,
        indexed_count: 2,
        not_indexed_count: 0,
        unknown_count: 0,
        unchecked_count: 3,
      }),
    ]);
    expect(r).toEqual({
      site_count: 2,
      url_count: 15,
      indexed_count: 5,
      not_indexed_count: 4,
      unknown_count: 1,
      unchecked_count: 5,
    });
  });
});

describe("applySiteFilters", () => {
  const now = Date.parse("2026-05-13T12:00:00Z");
  // Fixture URL counts: indexed + not_indexed + unknown + unchecked
  // must equal url_count for a coherent rollup. fakeSite() defaults
  // every count to 0 (overrides win), so each fixture sets the four
  // bucket counts explicitly.
  const sites: SiteRollup[] = [
    fakeSite({
      client_id: "acme-indexed",
      url_count: 10,
      indexed_count: 5,
      not_indexed_count: 0,
      unknown_count: 0,
      unchecked_count: 5,
      latest_check_at: "2026-05-13T11:00:00Z", // 1h ago
    }),
    fakeSite({
      client_id: "stale-co",
      url_count: 10,
      indexed_count: 0,
      not_indexed_count: 10,
      unknown_count: 0,
      unchecked_count: 0,
      latest_check_at: "2026-04-01T00:00:00Z", // >40d ago
    }),
    fakeSite({
      client_id: "never-checked",
      url_count: 8,
      indexed_count: 0,
      not_indexed_count: 0,
      unknown_count: 0,
      unchecked_count: 8,
      latest_check_at: null,
    }),
    fakeSite({
      client_id: "all-unknown",
      url_count: 6,
      indexed_count: 0,
      not_indexed_count: 0,
      unknown_count: 6,
      unchecked_count: 0,
      latest_check_at: "2026-05-13T06:00:00Z", // 6h ago (< 24h)
    }),
  ];

  it("returns all sites when no filters set", () => {
    expect(applySiteFilters(sites, {}, now)).toHaveLength(4);
  });

  it("filters by status=indexed (sites with >0 indexed URLs)", () => {
    const r = applySiteFilters(sites, { status: "indexed" }, now);
    expect(r.map((s) => s.client_id)).toEqual(["acme-indexed"]);
  });

  it("filters by status=not_indexed", () => {
    const r = applySiteFilters(sites, { status: "not_indexed" }, now);
    expect(r.map((s) => s.client_id)).toEqual(["stale-co"]);
  });

  it("filters by status=unchecked (any unchecked URLs)", () => {
    const r = applySiteFilters(sites, { status: "unchecked" }, now);
    expect(r.map((s) => s.client_id).sort()).toEqual(["acme-indexed", "never-checked"]);
  });

  it("filters by status=unknown", () => {
    const r = applySiteFilters(sites, { status: "unknown" }, now);
    expect(r.map((s) => s.client_id)).toEqual(["all-unknown"]);
  });

  it("filters by search across client_id + proxy_domain (case insensitive)", () => {
    const r = applySiteFilters(sites, { search: "STALE" }, now);
    expect(r.map((s) => s.client_id)).toEqual(["stale-co"]);
  });

  it("last_check_age=lt_24h includes sites checked < 24h ago", () => {
    const r = applySiteFilters(sites, { last_check_age: "lt_24h" }, now);
    expect(r.map((s) => s.client_id).sort()).toEqual(["acme-indexed", "all-unknown"]);
  });

  it("last_check_age=gt_7d includes stale sites + never-checked", () => {
    const r = applySiteFilters(sites, { last_check_age: "gt_7d" }, now);
    expect(r.map((s) => s.client_id).sort()).toEqual(["never-checked", "stale-co"]);
  });

  it("last_check_age=never includes only sites with no check at all", () => {
    const r = applySiteFilters(sites, { last_check_age: "never" }, now);
    expect(r.map((s) => s.client_id)).toEqual(["never-checked"]);
  });

  it("combines filters (status + age)", () => {
    const r = applySiteFilters(sites, { status: "indexed", last_check_age: "lt_24h" }, now);
    expect(r.map((s) => s.client_id)).toEqual(["acme-indexed"]);
  });
});
