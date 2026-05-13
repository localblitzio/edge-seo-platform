import { describe, expect, it } from "vitest";

import type { BulkFormSettings } from "../../../frontend-worker/src/bulk-clients.js";
import {
  defaultSerpPrefill,
  serpResultsToPreviewRows,
  validateSerpForm,
} from "../../../frontend-worker/src/serp-new.js";

describe("defaultSerpPrefill", () => {
  it("defaults canonical_mode to self (the SERP-flow intent)", () => {
    expect(defaultSerpPrefill().canonical_mode).toBe("self");
  });

  it("defaults zone_strategy to mixed", () => {
    expect(defaultSerpPrefill().zone_strategy).toBe("mixed");
  });

  it("defaults depth to SERP_MAX_DEPTH (25)", () => {
    expect(defaultSerpPrefill().depth).toBe(25);
  });

  it("defaults bypass_attestation to false (operator must opt in)", () => {
    expect(defaultSerpPrefill().bypass_attestation).toBe(false);
  });
});

describe("validateSerpForm — happy path", () => {
  it("accepts a minimal valid submission", () => {
    const r = validateSerpForm({
      keyword: "best widgets",
      location_code: "2840",
      language_code: "en",
      device: "desktop",
      depth: "10",
      zone: "localpage.us.com",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.query.keyword).toBe("best widgets");
      expect(r.value.query.location_code).toBe(2840);
      expect(r.value.query.depth).toBe(10);
      expect(r.value.settings.zone).toBe("localpage.us.com");
      // SERP flow default is `self`
      expect(r.value.settings.canonical_mode).toBe("self");
    }
  });

  it("accepts bypass_attestation=1", () => {
    const r = validateSerpForm({
      keyword: "x",
      location_code: "2840",
      language_code: "en",
      device: "desktop",
      depth: "5",
      zone: "localpage.us.com",
      bypass_attestation: "1",
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.settings.bypass_attestation).toBe(true);
  });
});

describe("validateSerpForm — sad paths", () => {
  it("rejects missing keyword", () => {
    const r = validateSerpForm({
      location_code: "2840",
      language_code: "en",
      depth: "10",
      zone: "localpage.us.com",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => /keyword/.test(e))).toBe(true);
  });

  it("rejects depth > 25", () => {
    const r = validateSerpForm({
      keyword: "x",
      location_code: "2840",
      language_code: "en",
      depth: "100",
      zone: "localpage.us.com",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => /depth/.test(e))).toBe(true);
  });

  it("rejects unknown location_code", () => {
    const r = validateSerpForm({
      keyword: "x",
      location_code: "99999",
      language_code: "en",
      depth: "5",
      zone: "localpage.us.com",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => /location_code/.test(e))).toBe(true);
  });
});

describe("serpResultsToPreviewRows", () => {
  const settings: BulkFormSettings = {
    zone: "localpage.us.com",
    zone_strategy: "single",
    attested_by_email: "ops@example.com",
    attested_ip: "1.2.3.4",
    scope: "full_site",
    bypass_attestation: false,
    canonical_mode: "self",
    cluster_id: null,
    status: "active",
  };

  it("derives client_ids from result hostnames", () => {
    const rows = serpResultsToPreviewRows(
      [
        { position: 1, url: "https://acme.com/page1", title: "A", description: "" },
        { position: 2, url: "https://otherco.net/blog", title: "B", description: "" },
      ],
      settings,
      new Set(),
    );
    expect(rows[0]?.client_id).toBe("acme-com");
    expect(rows[0]?.source_domain).toBe("acme.com");
    expect(rows[1]?.client_id).toBe("otherco-net");
  });

  it("marks unparseable URLs as errors and unchecks them", () => {
    const rows = serpResultsToPreviewRows(
      [{ position: 1, url: "not a url", title: "", description: "" }],
      settings,
      new Set(),
    );
    expect(rows[0]?.error).not.toBeNull();
    expect(rows[0]?.include).toBe(false);
  });

  it("avoids collisions with existing clients", () => {
    const rows = serpResultsToPreviewRows(
      [{ position: 1, url: "https://acme.com", title: "", description: "" }],
      settings,
      new Set(["acme-com"]),
    );
    expect(rows[0]?.client_id).toBe("acme-com-2");
    expect(rows[0]?.renamed_from_collision).toBe(true);
  });

  it("alternates zones when zone_strategy=mixed", () => {
    const rows = serpResultsToPreviewRows(
      [
        { position: 1, url: "https://a.com", title: "", description: "" },
        { position: 2, url: "https://b.com", title: "", description: "" },
        { position: 3, url: "https://c.com", title: "", description: "" },
      ],
      { ...settings, zone_strategy: "mixed" },
      new Set(),
    );
    expect(rows[0]?.zone).toBe("localpage.us.com");
    expect(rows[1]?.zone).toBe("localsite.us.com");
    expect(rows[2]?.zone).toBe("localpage.us.com");
  });

  it("uses the batch zone for every row when zone_strategy=single", () => {
    const rows = serpResultsToPreviewRows(
      [
        { position: 1, url: "https://a.com", title: "", description: "" },
        { position: 2, url: "https://b.com", title: "", description: "" },
      ],
      { ...settings, zone_strategy: "single", zone: "localsite.us.com" },
      new Set(),
    );
    expect(rows[0]?.zone).toBe("localsite.us.com");
    expect(rows[1]?.zone).toBe("localsite.us.com");
  });

  it("builds proxy_domain as <client_id>.<row.zone>", () => {
    const rows = serpResultsToPreviewRows(
      [{ position: 1, url: "https://acme.com", title: "", description: "" }],
      { ...settings, zone_strategy: "mixed" },
      new Set(),
    );
    expect(rows[0]?.proxy_domain).toBe("acme-com.localpage.us.com");
  });
});
