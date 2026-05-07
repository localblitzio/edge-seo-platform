import { describe, expect, it } from "vitest";

import {
  CLUSTER_STATUSES,
  CLUSTER_TYPES,
  type ClusterRow,
  MAX_CLUSTER_MEMBERS,
  MIN_CLUSTER_MEMBERS,
  synthesizeClusterCrossLink,
  validateClusterInput,
  validateMemberList,
} from "../../../frontend-worker/src/clusters.js";

function makeCluster(overrides: Partial<ClusterRow> = {}): ClusterRow {
  return {
    id: 1,
    owner_id: 1,
    type: "topical",
    label: "Plumbing",
    description: null,
    status: "active",
    cross_link_enabled: 1,
    created_at: "2026-05-01T00:00:00Z",
    updated_at: "2026-05-01T00:00:00Z",
    ...overrides,
  };
}

const VALID_SITES = new Set(["acme", "lantern-crest", "404-media", "rfengineer"]);

describe("validateClusterInput — happy paths", () => {
  it("accepts a minimal topical cluster with sensible defaults", () => {
    const r = validateClusterInput({ type: "topical", label: "Plumbing" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.type).toBe("topical");
      expect(r.value.label).toBe("Plumbing");
      expect(r.value.description).toBeNull();
      expect(r.value.status).toBe("active");
    }
  });

  it("accepts a geo cluster with description", () => {
    const r = validateClusterInput({
      type: "geo",
      label: "San Diego, CA",
      description: "  All sites serving the SD metro area  ",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.type).toBe("geo");
      expect(r.value.label).toBe("San Diego, CA");
      expect(r.value.description).toBe("All sites serving the SD metro area");
    }
  });

  it("trims label whitespace", () => {
    const r = validateClusterInput({ type: "topical", label: "  Plumbing  " });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.label).toBe("Plumbing");
  });

  it("treats blank description as null", () => {
    const r = validateClusterInput({ type: "topical", label: "X", description: "   " });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.description).toBeNull();
  });

  it("accepts every type defined in CLUSTER_TYPES", () => {
    for (const t of CLUSTER_TYPES) {
      const r = validateClusterInput({ type: t, label: "L" });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value.type).toBe(t);
    }
  });

  it("accepts every status defined in CLUSTER_STATUSES", () => {
    for (const s of CLUSTER_STATUSES) {
      const r = validateClusterInput({ type: "topical", label: "L", status: s });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value.status).toBe(s);
    }
  });
});

describe("validateClusterInput — sad paths", () => {
  it("rejects missing type", () => {
    const r = validateClusterInput({ label: "X" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => /type is required/.test(e))).toBe(true);
  });

  it("rejects unknown type", () => {
    const r = validateClusterInput({ type: "industry", label: "X" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => /type must be one of/.test(e))).toBe(true);
  });

  it("rejects missing label with type-specific hint", () => {
    const topical = validateClusterInput({ type: "topical" });
    expect(topical.ok).toBe(false);
    if (!topical.ok) expect(topical.errors.some((e) => /Plumbing/.test(e))).toBe(true);
    const geo = validateClusterInput({ type: "geo" });
    expect(geo.ok).toBe(false);
    if (!geo.ok) expect(geo.errors.some((e) => /San Diego/.test(e))).toBe(true);
  });

  it("rejects unknown status", () => {
    const r = validateClusterInput({ type: "topical", label: "L", status: "draft" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => /status must be one of/.test(e))).toBe(true);
  });

  it("rejects an over-long label", () => {
    const r = validateClusterInput({ type: "topical", label: "a".repeat(201) });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => /label/.test(e))).toBe(true);
  });

  it("rejects an over-long description", () => {
    const r = validateClusterInput({
      type: "topical",
      label: "L",
      description: "a".repeat(4001),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => /description/.test(e))).toBe(true);
  });
});

describe("validateMemberList — happy paths", () => {
  it("accepts a list of valid site IDs", () => {
    const r = validateMemberList(["acme", "lantern-crest"], VALID_SITES);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual(["acme", "lantern-crest"]);
  });

  it("dedupes duplicates in the input", () => {
    const r = validateMemberList(["acme", "acme", "lantern-crest", "acme"], VALID_SITES);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual(["acme", "lantern-crest"]);
  });

  it("filters out site IDs the operator can't see", () => {
    const r = validateMemberList(["acme", "someone-elses-site", "404-media"], VALID_SITES);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual(["acme", "404-media"]);
  });

  it("filters out malformed site IDs (uppercase, spaces, etc.)", () => {
    const r = validateMemberList(["acme", "BAD", "rf engineer", "404-media"], VALID_SITES);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual(["acme", "404-media"]);
  });

  it("accepts at the upper cap (25)", () => {
    const ids = Array.from({ length: MAX_CLUSTER_MEMBERS }, (_, i) => `site-${i}`);
    const validIds = new Set(ids);
    const r = validateMemberList(ids, validIds);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toHaveLength(MAX_CLUSTER_MEMBERS);
  });

  it("accepts exactly the lower cap (1)", () => {
    const r = validateMemberList(["acme"], VALID_SITES);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toHaveLength(MIN_CLUSTER_MEMBERS);
  });
});

describe("validateMemberList — sad paths", () => {
  it("rejects an empty list", () => {
    const r = validateMemberList([], VALID_SITES);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => /at least 1 site/i.test(e))).toBe(true);
  });

  it("rejects a list where every site is invisible (becomes empty)", () => {
    const r = validateMemberList(["unknown-1", "unknown-2"], VALID_SITES);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => /at least 1 site/i.test(e))).toBe(true);
  });

  it("rejects when over the 25-site cap", () => {
    const ids = Array.from({ length: MAX_CLUSTER_MEMBERS + 1 }, (_, i) => `site-${i}`);
    const validIds = new Set(ids);
    const r = validateMemberList(ids, validIds);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => /cap is 25/.test(e))).toBe(true);
  });
});

describe("validateClusterInput — cross_link_enabled (Slice C)", () => {
  it("defaults cross_link_enabled to 0 when the checkbox isn't submitted", () => {
    const r = validateClusterInput({ type: "topical", label: "L" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.cross_link_enabled).toBe(0);
  });

  it("returns 1 when the checkbox value is '1'", () => {
    const r = validateClusterInput({
      type: "topical",
      label: "L",
      cross_link_enabled: "1",
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.cross_link_enabled).toBe(1);
  });

  it("returns 1 when the value is 'on' (some browsers send this)", () => {
    const r = validateClusterInput({
      type: "topical",
      label: "L",
      cross_link_enabled: "on",
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.cross_link_enabled).toBe(1);
  });

  it("returns 0 for any other string (e.g. '0', 'false', 'no')", () => {
    for (const v of ["0", "false", "no", ""]) {
      const r = validateClusterInput({
        type: "topical",
        label: "L",
        cross_link_enabled: v,
      });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value.cross_link_enabled).toBe(0);
    }
  });
});

describe("synthesizeClusterCrossLink (Slice C)", () => {
  const baseCluster = makeCluster();

  it("returns a body+append rule with one <li> per sibling", () => {
    const rule = synthesizeClusterCrossLink(baseCluster, "acme", [
      { client_id: "foo", proxy_domain: "foo.example.com" },
      { client_id: "bar", proxy_domain: "bar.example.com" },
    ]);
    expect(rule).not.toBeNull();
    if (!rule) return;
    expect(rule.match).toBe("^/.*");
    expect(rule.selector).toBe("body");
    expect(rule.position).toBe("append");
    expect(rule.html).toContain("foo.example.com");
    expect(rule.html).toContain("bar.example.com");
    expect(rule.html).toContain('href="https://foo.example.com/"');
    expect(rule.html).toContain('href="https://bar.example.com/"');
    expect(rule.html).toContain('rel="noopener"');
    expect(rule.html).toContain('data-cluster-related="1"');
  });

  it("returns null when the cluster has no siblings (1-member cluster)", () => {
    expect(synthesizeClusterCrossLink(baseCluster, "acme", [])).toBeNull();
  });

  it("includes the cluster label as section heading", () => {
    const cluster = makeCluster({ label: "San Diego, CA" });
    const rule = synthesizeClusterCrossLink(cluster, "acme", [
      { client_id: "foo", proxy_domain: "foo.example.com" },
    ]);
    expect(rule?.html).toContain("Related sites — San Diego, CA");
  });

  it("HTML-escapes proxy_domain (defensive — though valid hostnames don't need it)", () => {
    // Pathological but tests the path. Real proxy_domains can't contain
    // special HTML characters (DNS rejects them), but the synthesizer
    // shouldn't trust that.
    const rule = synthesizeClusterCrossLink(baseCluster, "acme", [
      { client_id: "x", proxy_domain: 'evil"--><script>x</script>' },
    ]);
    expect(rule?.html).not.toContain("<script>x</script>");
    expect(rule?.html).toContain("&lt;script&gt;");
  });

  it("HTML-escapes the cluster label", () => {
    const cluster = makeCluster({ label: "<script>alert(1)</script>" });
    const rule = synthesizeClusterCrossLink(cluster, "acme", [
      { client_id: "foo", proxy_domain: "foo.example.com" },
    ]);
    expect(rule?.html).not.toContain("<script>alert");
    expect(rule?.html).toContain("&lt;script&gt;");
  });
});
