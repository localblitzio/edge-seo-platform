import { describe, expect, it } from "vitest";

import {
  MAX_BULK_BATCH_SIZE,
  buildBulkClientConfigJson,
  deriveClientIdFromHostname,
  hostnameFromUrl,
  parseSourceUrls,
  resolveBatchClientIds,
  resolveOne,
  validateBulkFormSettings,
} from "../../../frontend-worker/src/bulk-clients.js";

describe("parseSourceUrls", () => {
  it("splits on newlines, trims, drops blanks", () => {
    expect(
      parseSourceUrls(`
        https://acme.com
          https://otherco.net

        https://thirdsite.io
      `),
    ).toEqual(["https://acme.com", "https://otherco.net", "https://thirdsite.io"]);
  });

  it("prepends https:// when scheme is missing", () => {
    expect(parseSourceUrls("acme.com\nhttp://foo.io\nhttps://bar.org")).toEqual([
      "https://acme.com",
      "http://foo.io",
      "https://bar.org",
    ]);
  });

  it("returns [] for empty input", () => {
    expect(parseSourceUrls("")).toEqual([]);
    expect(parseSourceUrls("   \n  \n  ")).toEqual([]);
  });

  it("preserves CRLF line endings (paste from Windows)", () => {
    expect(parseSourceUrls("acme.com\r\notherco.net\r\n")).toEqual([
      "https://acme.com",
      "https://otherco.net",
    ]);
  });
});

describe("hostnameFromUrl", () => {
  it("extracts hostname from a https URL", () => {
    expect(hostnameFromUrl("https://acme.com/path?q=1")).toBe("acme.com");
  });

  it("lowercases the hostname", () => {
    expect(hostnameFromUrl("https://ACME.com/")).toBe("acme.com");
  });

  it("returns null for non-http(s) protocols", () => {
    expect(hostnameFromUrl("ftp://acme.com/")).toBeNull();
    expect(hostnameFromUrl("javascript:alert(1)")).toBeNull();
  });

  it("returns null for unparseable strings", () => {
    expect(hostnameFromUrl("not a url")).toBeNull();
    expect(hostnameFromUrl("")).toBeNull();
  });

  it("preserves www. prefix in the hostname (we strip in client_id derivation, not source_domain)", () => {
    expect(hostnameFromUrl("https://www.acme.com/")).toBe("www.acme.com");
  });
});

describe("deriveClientIdFromHostname", () => {
  it("strips a leading www., hyphenates dots, lowercases", () => {
    expect(deriveClientIdFromHostname("www.acme.com")).toBe("acme-com");
    expect(deriveClientIdFromHostname("ACME.com")).toBe("acme-com");
  });

  it("hyphenates multi-label hostnames", () => {
    expect(deriveClientIdFromHostname("acme.co.uk")).toBe("acme-co-uk");
    expect(deriveClientIdFromHostname("foo.bar.baz.com")).toBe("foo-bar-baz-com");
  });

  it("preserves existing hyphens in labels", () => {
    expect(deriveClientIdFromHostname("bar-foo.com")).toBe("bar-foo-com");
  });

  it("collapses consecutive non-alphanumerics into single hyphens", () => {
    expect(deriveClientIdFromHostname("a..b...c.com")).toBe("a-b-c-com");
  });

  it("trims leading/trailing hyphens", () => {
    // synthetic — wouldn't appear in real DNS but defensively handled
    expect(deriveClientIdFromHostname(".acme.com.")).toBe("acme-com");
  });

  it("appends -site when the derived id is a reserved infrastructure name", () => {
    // Pasted "https://www.com" → strip www → "com" — would collide
    // with the RESERVED_SUBDOMAINS check at proxy_domain validation
    // time. Suffix avoids the collision.
    expect(deriveClientIdFromHostname("www.com")).toBe("com"); // "com" isn't reserved
    expect(deriveClientIdFromHostname("admin.localhost")).toBe("admin-localhost"); // multi-label, not reserved alone
    // Single-label reserved name (synthetic but tests the path):
    expect(deriveClientIdFromHostname("api")).toBe("api-site");
    expect(deriveClientIdFromHostname("admin")).toBe("admin-site");
  });

  it("returns 'site' for hostname that strips to nothing", () => {
    expect(deriveClientIdFromHostname("...")).toBe("site");
  });

  it("trims to 63 chars (DNS label limit)", () => {
    const long = `${"a".repeat(70)}.com`;
    const result = deriveClientIdFromHostname(long);
    expect(result.length).toBeLessThanOrEqual(63);
  });
});

describe("resolveOne", () => {
  it("returns the original id when not taken", () => {
    expect(resolveOne("acme-com", new Set())).toEqual({
      id: "acme-com",
      was_renamed: false,
    });
  });

  it("appends -2 on first conflict", () => {
    expect(resolveOne("acme-com", new Set(["acme-com"]))).toEqual({
      id: "acme-com-2",
      was_renamed: true,
    });
  });

  it("walks up the suffix until unique", () => {
    expect(resolveOne("acme-com", new Set(["acme-com", "acme-com-2", "acme-com-3"]))).toEqual({
      id: "acme-com-4",
      was_renamed: true,
    });
  });
});

describe("resolveBatchClientIds", () => {
  it("returns derived IDs when no conflicts", () => {
    const r = resolveBatchClientIds(["acme.com", "otherco.net"], new Set());
    expect(r.client_ids).toEqual(["acme-com", "otherco-net"]);
    expect(r.renamed).toEqual([false, false]);
  });

  it("avoids collisions with existing clients", () => {
    const r = resolveBatchClientIds(["acme.com"], new Set(["acme-com", "acme-com-2"]));
    expect(r.client_ids).toEqual(["acme-com-3"]);
    expect(r.renamed).toEqual([true]);
  });

  it("avoids collisions WITHIN the batch (later rows see earlier rows)", () => {
    // Both hostnames derive to the same id ("acme-com")
    const r = resolveBatchClientIds(["acme.com", "www.acme.com"], new Set());
    expect(r.client_ids).toEqual(["acme-com", "acme-com-2"]);
    expect(r.renamed).toEqual([false, true]);
  });

  it("handles a long run of duplicates", () => {
    const r = resolveBatchClientIds(["acme.com", "acme.com", "acme.com", "acme.com"], new Set());
    expect(r.client_ids).toEqual(["acme-com", "acme-com-2", "acme-com-3", "acme-com-4"]);
    expect(r.renamed).toEqual([false, true, true, true]);
  });
});

describe("validateBulkFormSettings — happy paths", () => {
  it("accepts a minimal valid submission", () => {
    const r = validateBulkFormSettings({
      zone: "localpage.us.com",
      attested_by_email: "ops@example.com",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.zone).toBe("localpage.us.com");
      expect(r.value.attested_by_email).toBe("ops@example.com");
      expect(r.value.scope).toBe("full_site");
      expect(r.value.cluster_id).toBeNull();
      expect(r.value.status).toBe("active");
    }
  });

  it("accepts the secondary zone", () => {
    const r = validateBulkFormSettings({
      zone: "localsite.us.com",
      attested_by_email: "x@y.com",
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.zone).toBe("localsite.us.com");
  });

  it("accepts a cluster_id", () => {
    const r = validateBulkFormSettings({
      zone: "localpage.us.com",
      attested_by_email: "x@y.com",
      cluster_id: "42",
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.cluster_id).toBe(42);
  });

  it("treats empty/zero cluster_id as null", () => {
    for (const v of ["", "0"]) {
      const r = validateBulkFormSettings({
        zone: "localpage.us.com",
        attested_by_email: "x@y.com",
        cluster_id: v,
      });
      expect(r.ok).toBe(true);
      if (r.ok) expect(r.value.cluster_id).toBeNull();
    }
  });

  it("defaults attested_ip to 0.0.0.0 when blank", () => {
    const r = validateBulkFormSettings({
      zone: "localpage.us.com",
      attested_by_email: "x@y.com",
      attested_ip: "",
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.attested_ip).toBe("0.0.0.0");
  });
});

describe("validateBulkFormSettings — sad paths", () => {
  it("rejects missing zone", () => {
    const r = validateBulkFormSettings({ attested_by_email: "x@y.com" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => /zone is required/.test(e))).toBe(true);
  });

  it("rejects unknown zone", () => {
    const r = validateBulkFormSettings({
      zone: "evilzone.com",
      attested_by_email: "x@y.com",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => /zone must be one of/.test(e))).toBe(true);
  });

  it("rejects missing attested_by_email", () => {
    const r = validateBulkFormSettings({ zone: "localpage.us.com" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => /attested_by_email is required/.test(e))).toBe(true);
  });

  it("rejects malformed email", () => {
    const r = validateBulkFormSettings({
      zone: "localpage.us.com",
      attested_by_email: "not-an-email",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => /email/.test(e))).toBe(true);
  });

  it("rejects unknown scope", () => {
    const r = validateBulkFormSettings({
      zone: "localpage.us.com",
      attested_by_email: "x@y.com",
      scope: "everything",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => /scope must be one of/.test(e))).toBe(true);
  });

  it("rejects unknown status", () => {
    const r = validateBulkFormSettings({
      zone: "localpage.us.com",
      attested_by_email: "x@y.com",
      status: "draft",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => /status must be/.test(e))).toBe(true);
  });

  it("rejects bogus cluster_id", () => {
    const r = validateBulkFormSettings({
      zone: "localpage.us.com",
      attested_by_email: "x@y.com",
      cluster_id: "not-a-number",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => /cluster_id/.test(e))).toBe(true);
  });
});

describe("buildBulkClientConfigJson", () => {
  const settings = {
    zone: "localpage.us.com" as const,
    attested_by_email: "ops@example.com",
    attested_ip: "1.2.3.4",
    scope: "full_site" as const,
    cluster_id: null,
    status: "active" as const,
  };
  const row = {
    source_url: "https://acme.com",
    source_domain: "acme.com",
    client_id: "acme-com",
    renamed_from_collision: false,
    include: true,
    proxy_domain: "acme-com.localpage.us.com",
    error: null,
  };

  it("produces a valid ClientConfig JSON shape", () => {
    const json = buildBulkClientConfigJson(row, settings, "2026-05-07T00:00:00Z");
    const cfg = JSON.parse(json);
    expect(cfg.client_id).toBe("acme-com");
    expect(cfg.proxy_domain).toBe("acme-com.localpage.us.com");
    expect(cfg.source_domain).toBe("acme.com");
    expect(cfg.mode).toBe("subdomain_proxy");
    expect(cfg.status).toBe("active");
    expect(cfg.routing[0].origin).toBe("https://acme.com");
    expect(cfg.authorization.attested_by_email).toBe("ops@example.com");
    expect(cfg.authorization.attested_ip).toBe("1.2.3.4");
    expect(cfg.authorization.scope).toBe("full_site");
    expect(cfg.canonicals).toEqual([]);
    expect(cfg.indexation).toEqual([]);
    expect(cfg.caching[0].ttl_seconds).toBe(600);
    expect(cfg.schema_version).toBe(1);
  });

  it("respects the form's status setting", () => {
    const cfg = JSON.parse(
      buildBulkClientConfigJson(row, { ...settings, status: "paused" }, "2026-05-07T00:00:00Z"),
    );
    expect(cfg.status).toBe("paused");
  });
});

describe("MAX_BULK_BATCH_SIZE", () => {
  it("is 100", () => {
    expect(MAX_BULK_BATCH_SIZE).toBe(100);
  });
});
