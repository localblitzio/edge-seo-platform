import { describe, expect, it } from "vitest";

import {
  LINK_PROJECT_PLACEMENT_STATUSES,
  LINK_PROJECT_PLACEMENT_STRATEGIES,
  LINK_PROJECT_STATUSES,
  type LinkProjectPlacementRow,
  type LinkProjectRow,
  parseAnchorOptions,
  synthesizePlacement,
  validateLinkProjectInput,
  validateLinkProjectPlacementInput,
} from "../../../frontend-worker/src/link-projects.js";

function makeProject(overrides: Partial<LinkProjectRow> = {}): LinkProjectRow {
  return {
    id: 1,
    owner_id: 1,
    label: "Test project",
    target_url: "https://xyz.com/services",
    anchor_options: JSON.stringify(["our services", "click here"]),
    status: "active",
    notes: null,
    created_at: "2026-05-01T00:00:00Z",
    updated_at: "2026-05-01T00:00:00Z",
    ...overrides,
  };
}

function makePlacement(overrides: Partial<LinkProjectPlacementRow> = {}): LinkProjectPlacementRow {
  return {
    id: 42,
    link_project_id: 1,
    client_id: "acme",
    page_match: "^/.*",
    strategy: "footer",
    anchor_override: null,
    rel_attribute: "noopener",
    status: "active",
    created_at: "2026-05-01T00:00:00Z",
    updated_at: "2026-05-01T00:00:00Z",
    ...overrides,
  };
}

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

const VALID_CLIENTS = new Set(["acme", "lantern-crest", "404-media"]);

describe("validateLinkProjectPlacementInput — happy paths", () => {
  it("accepts a minimal valid submission with sensible defaults", () => {
    const r = validateLinkProjectPlacementInput({ client_id: "acme" }, VALID_CLIENTS);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.client_id).toBe("acme");
      expect(r.value.page_match).toBe("^/.*"); // default = all pages
      expect(r.value.strategy).toBe("footer");
      expect(r.value.anchor_override).toBeNull();
      expect(r.value.rel_attribute).toBe("noopener");
      expect(r.value.status).toBe("active");
    }
  });

  it("respects custom page_match when provided", () => {
    const r = validateLinkProjectPlacementInput(
      { client_id: "acme", page_match: "^/blog/.*" },
      VALID_CLIENTS,
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.page_match).toBe("^/blog/.*");
  });

  it("collapses whitespace in rel_attribute", () => {
    const r = validateLinkProjectPlacementInput(
      { client_id: "acme", rel_attribute: "  noopener   nofollow  " },
      VALID_CLIENTS,
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.rel_attribute).toBe("noopener nofollow");
  });

  it("treats blank anchor_override as null", () => {
    const r = validateLinkProjectPlacementInput(
      { client_id: "acme", anchor_override: "   " },
      VALID_CLIENTS,
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.anchor_override).toBeNull();
  });

  it("preserves a non-blank anchor_override", () => {
    const r = validateLinkProjectPlacementInput(
      { client_id: "acme", anchor_override: "click here" },
      VALID_CLIENTS,
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.anchor_override).toBe("click here");
  });

  it("accepts every strategy value defined in LINK_PROJECT_PLACEMENT_STRATEGIES", () => {
    for (const s of LINK_PROJECT_PLACEMENT_STRATEGIES) {
      const r = validateLinkProjectPlacementInput(
        { client_id: "acme", strategy: s },
        VALID_CLIENTS,
      );
      expect(r.ok).toBe(true);
    }
  });

  it("accepts every status value defined in LINK_PROJECT_PLACEMENT_STATUSES", () => {
    for (const s of LINK_PROJECT_PLACEMENT_STATUSES) {
      const r = validateLinkProjectPlacementInput({ client_id: "acme", status: s }, VALID_CLIENTS);
      expect(r.ok).toBe(true);
    }
  });
});

describe("validateLinkProjectPlacementInput — sad paths", () => {
  it("rejects missing client_id", () => {
    const r = validateLinkProjectPlacementInput({}, VALID_CLIENTS);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => /client_id is required/.test(e))).toBe(true);
  });

  it("rejects malformed client_id (uppercase)", () => {
    const r = validateLinkProjectPlacementInput({ client_id: "ACME" }, VALID_CLIENTS);
    expect(r.ok).toBe(false);
    if (!r.ok)
      expect(r.errors.some((e) => /lowercase letters, digits, or hyphens/.test(e))).toBe(true);
  });

  it("rejects a client_id the user can't see", () => {
    const r = validateLinkProjectPlacementInput(
      { client_id: "someone-elses-client" },
      VALID_CLIENTS,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => /not found or not visible/.test(e))).toBe(true);
  });

  it("rejects an invalid regex in page_match", () => {
    const r = validateLinkProjectPlacementInput(
      { client_id: "acme", page_match: "(unclosed" },
      VALID_CLIENTS,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => /not a valid regex/.test(e))).toBe(true);
  });

  it("rejects an unknown strategy", () => {
    const r = validateLinkProjectPlacementInput(
      { client_id: "acme", strategy: "header" },
      VALID_CLIENTS,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => /strategy/.test(e))).toBe(true);
  });

  it("rejects an unknown status", () => {
    const r = validateLinkProjectPlacementInput(
      { client_id: "acme", status: "draft" },
      VALID_CLIENTS,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => /status/.test(e))).toBe(true);
  });

  it("rejects an over-long anchor_override", () => {
    const r = validateLinkProjectPlacementInput(
      { client_id: "acme", anchor_override: "a".repeat(201) },
      VALID_CLIENTS,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => /anchor_override/.test(e))).toBe(true);
  });

  it("rejects an over-long rel_attribute", () => {
    const r = validateLinkProjectPlacementInput(
      { client_id: "acme", rel_attribute: "a".repeat(101) },
      VALID_CLIENTS,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => /rel_attribute/.test(e))).toBe(true);
  });

  it("rejects an over-long page_match", () => {
    const r = validateLinkProjectPlacementInput(
      { client_id: "acme", page_match: `^/${"a".repeat(513)}$` },
      VALID_CLIENTS,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => /page_match/.test(e))).toBe(true);
  });
});

describe("synthesizePlacement", () => {
  it("returns a body-append rule with the project's first anchor", () => {
    const project = makeProject();
    const placement = makePlacement();
    const rule = synthesizePlacement(placement, project);
    expect(rule).not.toBeNull();
    if (!rule) return;
    expect(rule.match).toBe("^/.*");
    expect(rule.selector).toBe("body");
    expect(rule.position).toBe("append");
    expect(rule.html).toContain("our services");
    expect(rule.html).toContain('href="https://xyz.com/services"');
    expect(rule.html).toContain('rel="noopener"');
    expect(rule.html).toContain('data-lp-placement="42"');
  });

  it("uses anchor_override when set, ignoring project anchors", () => {
    const project = makeProject();
    const placement = makePlacement({ anchor_override: "buy widgets" });
    const rule = synthesizePlacement(placement, project);
    expect(rule).not.toBeNull();
    if (!rule) return;
    expect(rule.html).toContain("buy widgets");
    expect(rule.html).not.toContain("our services");
  });

  it("falls back to target_url as anchor when project has no anchors and no override", () => {
    const project = makeProject({ anchor_options: "[]" });
    const placement = makePlacement({ anchor_override: null });
    const rule = synthesizePlacement(placement, project);
    expect(rule).not.toBeNull();
    if (!rule) return;
    expect(rule.html).toContain("https://xyz.com/services");
  });

  it("HTML-escapes anchor text, target_url, and rel_attribute", () => {
    const project = makeProject({
      target_url: "https://x.com/?q=a&b=c",
      anchor_options: JSON.stringify(['<script>alert("x")</script>']),
    });
    const placement = makePlacement({ rel_attribute: 'noopener "danger"' });
    const rule = synthesizePlacement(placement, project);
    expect(rule).not.toBeNull();
    if (!rule) return;
    expect(rule.html).not.toContain("<script>");
    expect(rule.html).toContain("&lt;script&gt;");
    expect(rule.html).toContain("&amp;");
    expect(rule.html).toContain("&quot;danger&quot;");
  });

  it("propagates the placement's page_match into the synthesized rule", () => {
    const project = makeProject();
    const placement = makePlacement({ page_match: "^/blog/.*" });
    const rule = synthesizePlacement(placement, project);
    expect(rule?.match).toBe("^/blog/.*");
  });

  it("returns null for an unknown strategy (future-proofing)", () => {
    const project = makeProject();
    // Force an unknown strategy via cast — the current type system
    // doesn't allow this directly, but data could be hand-edited or
    // future migrations could introduce strategies before code knows
    // about them. The null return makes the caller skip the rule
    // gracefully instead of producing malformed HTML.
    const placement = {
      ...makePlacement(),
      strategy: "header" as unknown as LinkProjectPlacementRow["strategy"],
    };
    expect(synthesizePlacement(placement, project)).toBeNull();
  });
});
