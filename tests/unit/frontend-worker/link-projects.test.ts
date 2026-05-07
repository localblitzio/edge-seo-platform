import { describe, expect, it } from "vitest";

import {
  LINK_PROJECT_PLACEMENT_POSITIONS,
  LINK_PROJECT_PLACEMENT_STATUSES,
  LINK_PROJECT_PLACEMENT_STRATEGIES,
  LINK_PROJECT_STATUSES,
  type LinkProjectPlacementRow,
  type LinkProjectRow,
  parseAnchorOptions,
  pickAnchor,
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
    // Single anchor by default so synthesizer tests don't depend on
    // the rotation hash. Rotation behavior gets its own tests below.
    anchor_options: JSON.stringify(["our services"]),
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
    target_selector: null,
    position: null,
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
    // selector strategy requires target_selector + position; supply them
    // for every iteration so the test stays simple while exercising the
    // strategy-enum coverage.
    for (const s of LINK_PROJECT_PLACEMENT_STRATEGIES) {
      const r = validateLinkProjectPlacementInput(
        {
          client_id: "acme",
          strategy: s,
          target_selector: "main",
          position: "after",
        },
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

describe("pickAnchor — rotation across project anchor_options", () => {
  it("returns anchor_override verbatim when set", () => {
    const project = makeProject({ anchor_options: JSON.stringify(["a", "b", "c"]) });
    const placement = makePlacement({ anchor_override: "exact text" });
    expect(pickAnchor(placement, project)).toBe("exact text");
  });

  it("returns the only anchor when project has exactly one", () => {
    const project = makeProject({ anchor_options: JSON.stringify(["sole anchor"]) });
    const placement = makePlacement({ anchor_override: null });
    expect(pickAnchor(placement, project)).toBe("sole anchor");
  });

  it("falls back to target_url when project has zero anchors", () => {
    const project = makeProject({ anchor_options: "[]" });
    const placement = makePlacement({ anchor_override: null });
    expect(pickAnchor(placement, project)).toBe(project.target_url);
  });

  it("is deterministic — same (placement, page_match) always picks the same anchor", () => {
    const project = makeProject({ anchor_options: JSON.stringify(["a", "b", "c", "d"]) });
    const placement = makePlacement({ anchor_override: null });
    const calls = Array.from({ length: 10 }, () => pickAnchor(placement, project));
    expect(new Set(calls).size).toBe(1); // all calls return the same anchor
  });

  it("picks one of the project's anchors (within set)", () => {
    const anchors = ["alpha", "beta", "gamma"];
    const project = makeProject({ anchor_options: JSON.stringify(anchors) });
    const placement = makePlacement({ anchor_override: null });
    expect(anchors).toContain(pickAnchor(placement, project));
  });

  it("distributes across anchors as placement.id varies (rotation diversity)", () => {
    // 12 different placement ids feeding into 3 anchors should hit at
    // least 2 distinct anchors. The hash isn't perfectly uniform on
    // tiny inputs, but it should be far from "always picks one".
    const anchors = ["alpha", "beta", "gamma"];
    const project = makeProject({ anchor_options: JSON.stringify(anchors) });
    const seen = new Set<string>();
    for (let id = 1; id <= 12; id++) {
      seen.add(pickAnchor(makePlacement({ id, anchor_override: null }), project));
    }
    expect(seen.size).toBeGreaterThanOrEqual(2);
  });

  it("includes page_match in the hash (different matches → potentially different picks)", () => {
    // Same placement id, different page_match — at least one of these
    // 8 page_match variants should diverge from the first when there
    // are 3 anchors.
    const anchors = ["alpha", "beta", "gamma"];
    const project = makeProject({ anchor_options: JSON.stringify(anchors) });
    const baseId = 7;
    const baseAnchor = pickAnchor(
      makePlacement({ id: baseId, page_match: "^/.*", anchor_override: null }),
      project,
    );
    const matches = [
      "^/$",
      "^/blog/.*",
      "^/about$",
      "^/contact$",
      "^/services/.*",
      "^/products/.*",
      "^/team$",
      "^/x/y/z$",
    ];
    let diverged = false;
    for (const m of matches) {
      const a = pickAnchor(
        makePlacement({ id: baseId, page_match: m, anchor_override: null }),
        project,
      );
      if (a !== baseAnchor) {
        diverged = true;
        break;
      }
    }
    expect(diverged).toBe(true);
  });
});

describe("synthesizePlacement — selector strategy (Slice 3)", () => {
  it("emits the operator's selector + position instead of body+append", () => {
    const project = makeProject();
    const placement = makePlacement({
      strategy: "selector",
      target_selector: "article p:first-of-type",
      position: "after",
    });
    const rule = synthesizePlacement(placement, project);
    expect(rule).not.toBeNull();
    if (!rule) return;
    expect(rule.selector).toBe("article p:first-of-type");
    expect(rule.position).toBe("after");
    expect(rule.html).toContain("our services");
    expect(rule.html).toContain('data-lp-placement="42"');
  });

  it.each(LINK_PROJECT_PLACEMENT_POSITIONS.map((p) => [p]))("supports position=%s", (position) => {
    const project = makeProject();
    const placement = makePlacement({
      strategy: "selector",
      target_selector: "main",
      position,
    });
    const rule = synthesizePlacement(placement, project);
    expect(rule?.position).toBe(position);
  });

  it("returns null when strategy=selector but target_selector is missing (defense-in-depth)", () => {
    const project = makeProject();
    const placement = makePlacement({
      strategy: "selector",
      target_selector: null,
      position: "after",
    });
    expect(synthesizePlacement(placement, project)).toBeNull();
  });

  it("returns null when strategy=selector but position is missing", () => {
    const project = makeProject();
    const placement = makePlacement({
      strategy: "selector",
      target_selector: "main",
      position: null,
    });
    expect(synthesizePlacement(placement, project)).toBeNull();
  });
});

describe("validateLinkProjectPlacementInput — selector strategy (Slice 3)", () => {
  it("requires target_selector when strategy=selector", () => {
    const r = validateLinkProjectPlacementInput(
      { client_id: "acme", strategy: "selector", position: "after" },
      VALID_CLIENTS,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => /target_selector is required/.test(e))).toBe(true);
  });

  it("requires position when strategy=selector", () => {
    const r = validateLinkProjectPlacementInput(
      { client_id: "acme", strategy: "selector", target_selector: "main" },
      VALID_CLIENTS,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => /position is required/.test(e))).toBe(true);
  });

  it("rejects an unknown position value", () => {
    const r = validateLinkProjectPlacementInput(
      {
        client_id: "acme",
        strategy: "selector",
        target_selector: "main",
        position: "middle",
      },
      VALID_CLIENTS,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => /position must be one of/.test(e))).toBe(true);
  });

  it("accepts a valid selector+position combo", () => {
    const r = validateLinkProjectPlacementInput(
      {
        client_id: "acme",
        strategy: "selector",
        target_selector: "article p:first-of-type",
        position: "after",
      },
      VALID_CLIENTS,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.strategy).toBe("selector");
      expect(r.value.target_selector).toBe("article p:first-of-type");
      expect(r.value.position).toBe("after");
    }
  });

  it("ignores selector+position fields when strategy=footer (footer always uses body+append)", () => {
    const r = validateLinkProjectPlacementInput(
      {
        client_id: "acme",
        strategy: "footer",
        target_selector: "main",
        position: "before",
      },
      VALID_CLIENTS,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.target_selector).toBeNull();
      expect(r.value.position).toBeNull();
    }
  });

  it("rejects an over-long target_selector", () => {
    const r = validateLinkProjectPlacementInput(
      {
        client_id: "acme",
        strategy: "selector",
        target_selector: "a".repeat(257),
        position: "after",
      },
      VALID_CLIENTS,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => /target_selector/.test(e))).toBe(true);
  });
});
