import { describe, expect, it } from "vitest";

import {
  type EmbedRow,
  applyEmbedToConfig,
  buildEmbedContentInjection,
  parseSelectedIndexers,
  validateEmbedInput,
} from "../../../frontend-worker/src/embeds.js";

function fakeEmbed(overrides: Partial<EmbedRow> = {}): EmbedRow {
  return {
    id: 42,
    owner_id: 1,
    name: "Mountain View Maps",
    kind: "google_maps_embed",
    html: '<iframe src="https://www.google.com/maps/embed?pb=abc"></iframe>',
    default_position: "bottom",
    business_id: null,
    business_kind: null,
    created_at: "2026-05-13",
    updated_at: "2026-05-13",
    ...overrides,
  };
}

describe("validateEmbedInput", () => {
  it("accepts a minimal valid iframe embed", () => {
    const r = validateEmbedInput({
      name: "Test",
      kind: "iframe",
      html: '<iframe src="https://example.com"></iframe>',
      default_position: "bottom",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.name).toBe("Test");
      expect(r.value.kind).toBe("iframe");
      expect(r.value.default_position).toBe("bottom");
    }
  });

  it("accepts a Google Maps embed with valid maps src", () => {
    const r = validateEmbedInput({
      name: "Maps",
      kind: "google_maps_embed",
      html: '<iframe src="https://www.google.com/maps/embed?pb=abc"></iframe>',
    });
    expect(r.ok).toBe(true);
  });

  it("rejects google_maps_embed with non-maps src", () => {
    const r = validateEmbedInput({
      name: "Wrong",
      kind: "google_maps_embed",
      html: '<iframe src="https://example.com"></iframe>',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => /google_maps_embed/.test(e))).toBe(true);
  });

  it("rejects html without an iframe tag", () => {
    const r = validateEmbedInput({
      name: "No iframe",
      kind: "iframe",
      html: "<div>not an iframe</div>",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => /iframe/.test(e))).toBe(true);
  });

  it("rejects missing name", () => {
    const r = validateEmbedInput({
      kind: "iframe",
      html: '<iframe src="https://example.com"></iframe>',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => /name is required/.test(e))).toBe(true);
  });

  it("rejects unknown kind", () => {
    const r = validateEmbedInput({
      name: "x",
      kind: "youtube",
      html: '<iframe src="https://x.com"></iframe>',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.some((e) => /kind must be one of/.test(e))).toBe(true);
  });

  it("defaults position to bottom when not provided", () => {
    const r = validateEmbedInput({
      name: "x",
      kind: "iframe",
      html: '<iframe src="https://x.com"></iframe>',
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.default_position).toBe("bottom");
  });
});

describe("buildEmbedContentInjection", () => {
  it("uses 'middle' selector for middle position", () => {
    const rule = buildEmbedContentInjection(fakeEmbed(), "middle");
    expect(rule.match).toBe("^/.*");
    expect(rule.selector).toBe("main > p:nth-of-type(2)");
    expect(rule.position).toBe("after");
  });

  it("uses 'main append' for bottom position", () => {
    const rule = buildEmbedContentInjection(fakeEmbed(), "bottom");
    expect(rule.selector).toBe("main");
    expect(rule.position).toBe("append");
  });

  it("wraps html with the embed:<id> marker for idempotency", () => {
    const rule = buildEmbedContentInjection(fakeEmbed({ id: 42 }), "bottom");
    expect(typeof rule.html).toBe("string");
    expect(rule.html as string).toContain('data-edge-seo-rule="embed:42"');
    expect(rule.html as string).toContain("google.com/maps/embed");
  });

  it('escapes name in marker (strips <, >, ")', () => {
    const rule = buildEmbedContentInjection(fakeEmbed({ name: 'Evil"<x>' }), "bottom");
    expect(rule.html as string).toContain('data-edge-seo-embed-name="Evilx"');
  });
});

describe("applyEmbedToConfig", () => {
  function emptyConfig(): Record<string, unknown> {
    return {
      content_injections: [],
      canonicals: [],
      indexation: [],
    };
  }

  it("appends a content_injection for the embed", () => {
    const cfg = emptyConfig();
    applyEmbedToConfig(cfg, fakeEmbed({ id: 7 }), "bottom");
    expect(Array.isArray(cfg.content_injections)).toBe(true);
    const injs = cfg.content_injections as Array<Record<string, unknown>>;
    expect(injs).toHaveLength(1);
    expect(injs[0]?.html as string).toContain('data-edge-seo-rule="embed:7"');
  });

  it("is idempotent — re-applying replaces the existing rule for the same embed", () => {
    const cfg = emptyConfig();
    applyEmbedToConfig(cfg, fakeEmbed({ id: 7 }), "bottom");
    applyEmbedToConfig(cfg, fakeEmbed({ id: 7 }), "middle");
    const injs = cfg.content_injections as Array<Record<string, unknown>>;
    expect(injs).toHaveLength(1);
    expect(injs[0]?.position).toBe("after"); // middle position
  });

  it("preserves content_injections from other embeds", () => {
    const cfg: Record<string, unknown> = {
      content_injections: [
        {
          match: "^/.*",
          selector: "main",
          position: "append",
          html: '<div data-edge-seo-rule="embed:99">other</div>',
        },
      ],
      canonicals: [],
      indexation: [],
    };
    applyEmbedToConfig(cfg, fakeEmbed({ id: 7 }), "bottom");
    const injs = cfg.content_injections as Array<Record<string, unknown>>;
    expect(injs).toHaveLength(2);
    const ids = injs.map((r) => r.html as string);
    expect(ids.some((h) => h.includes("embed:99"))).toBe(true);
    expect(ids.some((h) => h.includes("embed:7"))).toBe(true);
  });

  it("upserts a wildcard canonical=self rule", () => {
    const cfg = emptyConfig();
    applyEmbedToConfig(cfg, fakeEmbed(), "bottom");
    const canons = cfg.canonicals as Array<Record<string, unknown>>;
    expect(canons).toHaveLength(1);
    expect(canons[0]?.match).toBe("^/.*");
    expect((canons[0]?.strategy as Record<string, unknown>).type).toBe("self");
  });

  it("replaces a pre-existing wildcard canonical rule (not stacking)", () => {
    const cfg: Record<string, unknown> = {
      content_injections: [],
      canonicals: [
        {
          match: "^/.*",
          strategy: { type: "origin" },
          sync_og_url: true,
          sync_twitter_url: true,
          sync_jsonld_url: true,
        },
      ],
      indexation: [],
    };
    applyEmbedToConfig(cfg, fakeEmbed(), "bottom");
    const canons = cfg.canonicals as Array<Record<string, unknown>>;
    expect(canons).toHaveLength(1);
    expect((canons[0]?.strategy as Record<string, unknown>).type).toBe("self");
  });

  it("upserts a wildcard indexation=index,follow rule", () => {
    const cfg = emptyConfig();
    applyEmbedToConfig(cfg, fakeEmbed(), "bottom");
    const idx = cfg.indexation as Array<Record<string, unknown>>;
    expect(idx).toHaveLength(1);
    expect(idx[0]?.match).toBe("^/.*");
    expect(idx[0]?.robots).toBe("index,follow");
  });

  it("replaces a pre-existing wildcard noindex rule", () => {
    const cfg: Record<string, unknown> = {
      content_injections: [],
      canonicals: [],
      indexation: [{ match: "^/.*", robots: "noindex,follow", additional_directives: [] }],
    };
    applyEmbedToConfig(cfg, fakeEmbed(), "bottom");
    const idx = cfg.indexation as Array<Record<string, unknown>>;
    expect(idx).toHaveLength(1);
    expect(idx[0]?.robots).toBe("index,follow");
  });

  it("preserves non-wildcard canonical and indexation rules", () => {
    const cfg: Record<string, unknown> = {
      content_injections: [],
      canonicals: [
        {
          match: "^/special",
          strategy: { type: "noindex" },
          sync_og_url: true,
          sync_twitter_url: true,
          sync_jsonld_url: true,
        },
      ],
      indexation: [{ match: "^/private", robots: "noindex,nofollow", additional_directives: [] }],
    };
    applyEmbedToConfig(cfg, fakeEmbed(), "bottom");
    const canons = cfg.canonicals as Array<Record<string, unknown>>;
    const idx = cfg.indexation as Array<Record<string, unknown>>;
    // Old specific rules survive, new wildcard rules added
    expect(canons).toHaveLength(2);
    expect(idx).toHaveLength(2);
    expect(canons.some((r) => r.match === "^/special")).toBe(true);
    expect(idx.some((r) => r.match === "^/private")).toBe(true);
  });
});

describe("parseSelectedIndexers", () => {
  it("returns slot keys for every indexer_* field with value=1", () => {
    const r = parseSelectedIndexers({
      indexer_INDEXNOW_KEY: "1",
      indexer_OMEGA_INDEXER_KEY: "1",
      indexer_SINBYTE_API_KEY: "0",
      cluster_id: "5",
      position: "bottom",
    });
    expect(r).toContain("INDEXNOW_KEY");
    expect(r).toContain("OMEGA_INDEXER_KEY");
    expect(r).not.toContain("SINBYTE_API_KEY");
    expect(r).not.toContain("cluster_id");
  });

  it("returns [] when no indexer is selected", () => {
    expect(parseSelectedIndexers({ cluster_id: "5" })).toEqual([]);
  });

  it("ignores non-1 values", () => {
    expect(parseSelectedIndexers({ indexer_INDEXNOW_KEY: "true" })).toEqual([]);
    expect(parseSelectedIndexers({ indexer_INDEXNOW_KEY: "" })).toEqual([]);
  });
});
