import { describe, expect, it } from "vitest";

import {
  buildCrossLinks,
  buildPlaceholderSchema,
  extractPlaceholders,
  parseCsv,
  renderPath,
  renderTemplate,
  slugify,
  trigramSimilarity,
  validateTemplateInput,
} from "../../../frontend-worker/src/site-templates.js";

describe("slugify", () => {
  it("lowercases + replaces non-alnum runs with single dash", () => {
    expect(slugify("San Diego")).toBe("san-diego");
    expect(slugify("La  Jolla!! ")).toBe("la-jolla");
    expect(slugify("Foo & Bar")).toBe("foo-bar");
  });

  it("strips leading/trailing dashes", () => {
    expect(slugify("--foo--")).toBe("foo");
    expect(slugify(" - hello - world - ")).toBe("hello-world");
  });

  it("returns empty for non-alnum-only inputs", () => {
    expect(slugify("!!!")).toBe("");
    expect(slugify("")).toBe("");
  });
});

describe("renderTemplate", () => {
  it("substitutes bare {{key}} with HTML-escaping", () => {
    const out = renderTemplate("<h1>{{title}}</h1>", { title: "<script>" });
    expect(out).toBe("<h1>&lt;script&gt;</h1>");
  });

  it("renders {{{key}}} raw (no escape)", () => {
    const out = renderTemplate("<div>{{{raw}}}</div>", { raw: "<b>bold</b>" });
    expect(out).toBe("<div><b>bold</b></div>");
  });

  it("applies helpers like slugify and lowercases inside escaped substitution", () => {
    const out = renderTemplate("/{{slugify city}}", { city: "San Diego" });
    expect(out).toBe("/san-diego");
  });

  it("substitutes empty string for missing keys", () => {
    const out = renderTemplate("<p>{{missing}}</p>", { other: "x" });
    expect(out).toBe("<p></p>");
  });

  it("handles {{#if}} conditional with truthy value", () => {
    const out = renderTemplate("{{#if phone}}<a>{{phone}}</a>{{/if}}", { phone: "555-1234" });
    expect(out).toBe("<a>555-1234</a>");
  });

  it("strips {{#if}} block when key is empty or missing", () => {
    expect(renderTemplate("a{{#if x}}MID{{/if}}b", {})).toBe("ab");
    expect(renderTemplate("a{{#if x}}MID{{/if}}b", { x: "" })).toBe("ab");
    expect(renderTemplate("a{{#if x}}MID{{/if}}b", { x: "   " })).toBe("ab");
  });
});

describe("renderTemplate — {{#each name}} blocks", () => {
  it("iterates an array of objects via extras", () => {
    const out = renderTemplate(
      "<ul>{{#each items}}<li>{{title}}</li>{{/each}}</ul>",
      {},
      { items: [{ title: "A" }, { title: "B" }, { title: "C" }] },
    );
    expect(out).toBe("<ul><li>A</li><li>B</li><li>C</li></ul>");
  });

  it("renders nothing when the array is missing or empty", () => {
    expect(renderTemplate("X{{#each missing}}Y{{/each}}Z", {})).toBe("XZ");
    expect(renderTemplate("X{{#each items}}Y{{/each}}Z", {}, { items: [] })).toBe("XZ");
  });

  it("merges outer row fields into each iteration", () => {
    const out = renderTemplate(
      "{{#each links}}{{city}}/{{slug}} {{/each}}",
      { city: "san-diego" },
      { links: [{ slug: "a" }, { slug: "b" }] },
    );
    expect(out).toBe("san-diego/a san-diego/b ");
  });
});

describe("buildCrossLinks", () => {
  const rows = [
    {
      title: "Aqua Pools",
      city: "San Diego",
      state: "California",
      categories: "Pool Builder",
      latitude: "32.7",
      longitude: "-117.16",
    },
    {
      title: "Splash Co",
      city: "La Jolla",
      state: "California",
      categories: "Pool Builder",
      latitude: "32.85",
      longitude: "-117.27",
    },
    {
      title: "Wave Pools",
      city: "Carlsbad",
      state: "California",
      categories: "Pool Builder",
      latitude: "33.16",
      longitude: "-117.35",
    },
    {
      title: "SD Roofers",
      city: "San Diego",
      state: "California",
      categories: "Roofing Contractor",
      latitude: "32.71",
      longitude: "-117.16",
    },
  ];

  it("returns empty when strategy is 'none' or count is 0", () => {
    expect(
      buildCrossLinks(rows, rows[0]!, "slug-a", "none", 5, "/", "localsitestage.us", 1),
    ).toEqual([]);
    expect(
      buildCrossLinks(rows, rows[0]!, "slug-a", "same_category_nearby_cities", 0, "/", "z", 1),
    ).toEqual([]);
  });

  it("same_category_nearby_cities: picks pool builders in other cities, nearest first", () => {
    const links = buildCrossLinks(
      rows,
      rows[0]!,
      "aqua-pools-t1-r0",
      "same_category_nearby_cities",
      3,
      "/",
      "localsitestage.us",
      1,
    );
    expect(links).toHaveLength(2);
    // La Jolla (~16 km) is closer than Carlsbad (~50 km)
    expect(links[0]?.title).toBe("Splash Co");
    expect(links[1]?.title).toBe("Wave Pools");
    expect(links[0]?.url).toContain("localsitestage.us");
    expect(links[0]?.context).toBe("La Jolla, California");
  });

  it("same_city_other_categories: picks other-category businesses in the same city", () => {
    const links = buildCrossLinks(
      rows,
      rows[0]!,
      "aqua-pools-t1-r0",
      "same_city_other_categories",
      5,
      "/",
      "localsitestage.us",
      1,
    );
    expect(links).toHaveLength(1);
    expect(links[0]?.title).toBe("SD Roofers");
  });

  it("falls back to 'any other row' when the strategy filter is empty", () => {
    // Only one pool builder in the data → same_category_nearby_cities
    // matches nothing → falls back to other-row pool of size > 0.
    const tiny = [rows[0]!, rows[3]!];
    const links = buildCrossLinks(
      tiny,
      tiny[0]!,
      "slug",
      "same_category_nearby_cities",
      5,
      "/",
      "z",
      1,
    );
    expect(links).toHaveLength(1);
    expect(links[0]?.title).toBe("SD Roofers");
  });
});

describe("renderPath", () => {
  it("slugifies each path segment", () => {
    const out = renderPath("/{{city}}-pool-builders", { city: "San Diego" });
    expect(out).toBe("/san-diego-pool-builders");
  });

  it("preserves multi-segment structure", () => {
    const out = renderPath("/{{service}}/{{city}}", { service: "Pool Cleaning", city: "La Jolla" });
    expect(out).toBe("/pool-cleaning/la-jolla");
  });

  it("always returns leading slash", () => {
    expect(renderPath("{{x}}", { x: "foo" })).toBe("/foo");
  });
});

describe("extractPlaceholders + buildPlaceholderSchema", () => {
  it("finds bare placeholders in body usage", () => {
    const out = extractPlaceholders("<h1>{{title}}</h1><p>{{body}}</p>", "body");
    expect(out.map((p) => p.name)).toEqual(["body", "title"]);
    expect(out.every((p) => p.usage === "body")).toBe(true);
  });

  it("marks triple-brace placeholders as raw", () => {
    const out = extractPlaceholders("{{{raw}}} and {{safe}}", "body");
    const raw = out.find((p) => p.name === "raw");
    const safe = out.find((p) => p.name === "safe");
    expect(raw?.raw).toBe(true);
    expect(safe?.raw).toBe(false);
  });

  it("strips helpers and just lists the variable name", () => {
    const out = extractPlaceholders("/{{slugify city}}-pages", "path");
    expect(out.map((p) => p.name)).toEqual(["city"]);
  });

  it("ignores {{#if x}}...{{/if}} closer", () => {
    const out = extractPlaceholders("{{#if phone}}{{phone}}{{/if}}", "body");
    expect(out.map((p) => p.name)).toEqual(["phone"]);
  });

  it("merges body + path with usage=both for shared placeholders", () => {
    const schema = buildPlaceholderSchema("<h1>{{city}}</h1>", "/{{slugify city}}-pages");
    expect(schema.find((p) => p.name === "city")?.usage).toBe("both");
  });
});

describe("parseCsv", () => {
  it("parses simple CSV with header row", () => {
    const out = parseCsv("city,service\nSan Diego,pool builder\nLa Jolla,landscaping");
    expect(out.columns).toEqual(["city", "service"]);
    expect(out.rows).toEqual([
      { city: "San Diego", service: "pool builder" },
      { city: "La Jolla", service: "landscaping" },
    ]);
  });

  it("handles quoted fields with embedded commas", () => {
    const out = parseCsv('a,b\n"foo, bar",baz');
    expect(out.rows).toEqual([{ a: "foo, bar", b: "baz" }]);
  });

  it("handles CRLF line endings", () => {
    const out = parseCsv("a,b\r\n1,2\r\n3,4\r\n");
    expect(out.rows).toEqual([
      { a: "1", b: "2" },
      { a: "3", b: "4" },
    ]);
  });

  it("decodes doubled quotes inside quoted fields", () => {
    const out = parseCsv('label\n"she said ""hi"""');
    expect(out.rows).toEqual([{ label: 'she said "hi"' }]);
  });

  it("returns empty arrays for empty input", () => {
    const out = parseCsv("");
    expect(out.columns).toEqual([]);
    expect(out.rows).toEqual([]);
  });
});

describe("trigramSimilarity", () => {
  it("returns 1 for identical strings", () => {
    expect(trigramSimilarity("hello world", "hello world")).toBe(1);
  });

  it("returns 0 for totally disjoint strings", () => {
    // Short enough that there's no trigram overlap.
    expect(trigramSimilarity("abc", "xyz")).toBeLessThan(0.1);
  });

  it("returns high score for near-duplicate strings (just one word swapped)", () => {
    const a = "Best pool builders in San Diego — call now today";
    const b = "Best pool builders in San Diego — call now tomorrow";
    expect(trigramSimilarity(a, b)).toBeGreaterThan(0.7);
  });

  it("returns moderate score when only city/location varies", () => {
    const a = "Best pool builders in San Diego — call now";
    const b = "Best pool builders in Chula Vista — call now";
    // Same skeleton, different city — should be at least somewhat similar
    expect(trigramSimilarity(a, b)).toBeGreaterThan(0.3);
  });

  it("returns lower score for substantively different strings of similar length", () => {
    const a = "Best pool builders in San Diego — call now";
    const b = "Cheap landscaping services delivered to your door";
    expect(trigramSimilarity(a, b)).toBeLessThan(0.3);
  });
});

describe("validateTemplateInput", () => {
  it("accepts a valid template", () => {
    const r = validateTemplateInput({
      name: "Test",
      kind: "pages_in_client",
      html_template: "<h1>{{city}}</h1>",
      path_pattern: "/{{slugify city}}",
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.name).toBe("Test");
      expect(r.value.kind).toBe("pages_in_client");
    }
  });

  it("rejects template with no placeholders", () => {
    const r = validateTemplateInput({
      name: "Test",
      kind: "pages_in_client",
      html_template: "<h1>Static</h1>",
      path_pattern: "/static",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.some((e) => e.includes("placeholder"))).toBe(true);
    }
  });

  it("rejects invalid kind", () => {
    const r = validateTemplateInput({
      name: "Test",
      kind: "not_a_real_kind",
      html_template: "<h1>{{x}}</h1>",
      path_pattern: "/{{x}}",
    });
    expect(r.ok).toBe(false);
  });

  it("rejects path_pattern without leading slash", () => {
    const r = validateTemplateInput({
      name: "Test",
      kind: "pages_in_client",
      html_template: "<h1>{{x}}</h1>",
      path_pattern: "{{x}}",
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.some((e) => e.includes("/"))).toBe(true);
    }
  });

  it("rejects empty name", () => {
    const r = validateTemplateInput({
      name: "",
      kind: "pages_in_client",
      html_template: "<h1>{{x}}</h1>",
      path_pattern: "/{{x}}",
    });
    expect(r.ok).toBe(false);
  });
});
