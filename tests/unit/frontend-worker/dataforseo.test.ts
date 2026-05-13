import { describe, expect, it } from "vitest";

import {
  SERP_LANGUAGES,
  SERP_LOCATIONS,
  SERP_MAX_DEPTH,
  basicAuthHeader,
  buildSerpRequestBody,
  parseSerpResponse,
} from "../../../frontend-worker/src/dataforseo.js";

describe("parseSerpResponse", () => {
  it("returns [] for an empty payload", () => {
    expect(parseSerpResponse({})).toEqual([]);
    expect(parseSerpResponse(null)).toEqual([]);
    expect(parseSerpResponse(undefined)).toEqual([]);
  });

  it("extracts organic items from tasks[].result[].items[]", () => {
    const payload = {
      tasks: [
        {
          result: [
            {
              items: [
                {
                  type: "organic",
                  url: "https://acme.com",
                  title: "Acme",
                  description: "Acme is cool",
                },
                { type: "paid", url: "https://ad.example", title: "Ad", description: "buy" },
                {
                  type: "organic",
                  url: "https://second.example",
                  title: "Second",
                  description: "",
                },
              ],
            },
          ],
        },
      ],
    };
    const out = parseSerpResponse(payload);
    expect(out).toEqual([
      { position: 1, url: "https://acme.com", title: "Acme", description: "Acme is cool" },
      { position: 2, url: "https://second.example", title: "Second", description: "" },
    ]);
  });

  it("filters out items without a url", () => {
    const out = parseSerpResponse({
      tasks: [{ result: [{ items: [{ type: "organic", url: null }] }] }],
    });
    expect(out).toEqual([]);
  });

  it("renumbers positions 1..N (organic-only)", () => {
    const out = parseSerpResponse({
      tasks: [
        {
          result: [
            {
              items: [
                { type: "people_also_ask", url: "https://paa.example" },
                { type: "organic", url: "https://a.com", title: "A" },
                { type: "knowledge_panel" },
                { type: "organic", url: "https://b.com", title: "B" },
              ],
            },
          ],
        },
      ],
    });
    expect(out.map((r) => r.position)).toEqual([1, 2]);
  });

  it("survives missing optional fields", () => {
    const out = parseSerpResponse({
      tasks: [{ result: [{ items: [{ type: "organic", url: "https://x.com" }] }] }],
    });
    expect(out).toEqual([{ position: 1, url: "https://x.com", title: "", description: "" }]);
  });
});

describe("buildSerpRequestBody", () => {
  it("serializes a single-element task array", () => {
    const body = buildSerpRequestBody({
      keyword: "best widgets",
      location_code: 2840,
      language_code: "en",
      device: "desktop",
      depth: 10,
    });
    const parsed = JSON.parse(body);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].keyword).toBe("best widgets");
    expect(parsed[0].location_code).toBe(2840);
    expect(parsed[0].language_code).toBe("en");
    expect(parsed[0].device).toBe("desktop");
    // depth is multiplied to give DataForSEO headroom for SERP features
    expect(parsed[0].depth).toBeGreaterThanOrEqual(10);
  });

  it("multiplies depth by 4 with a floor of 10", () => {
    const body = JSON.parse(
      buildSerpRequestBody({
        keyword: "x",
        location_code: 2840,
        language_code: "en",
        device: "desktop",
        depth: 1,
      }),
    );
    // depth=1 → 1*4 = 4 → floored to 10
    expect(body[0].depth).toBe(10);
  });

  it("caps depth at SERP_MAX_DEPTH*4", () => {
    const body = JSON.parse(
      buildSerpRequestBody({
        keyword: "x",
        location_code: 2840,
        language_code: "en",
        device: "desktop",
        depth: 9999,
      }),
    );
    expect(body[0].depth).toBeLessThanOrEqual(SERP_MAX_DEPTH * 4);
  });
});

describe("basicAuthHeader", () => {
  it("produces a valid HTTP Basic header", () => {
    const h = basicAuthHeader("user@example.com", "pwd");
    expect(h.startsWith("Basic ")).toBe(true);
    const decoded = atob(h.slice("Basic ".length));
    expect(decoded).toBe("user@example.com:pwd");
  });
});

describe("constants", () => {
  it("SERP_MAX_DEPTH is 25", () => {
    expect(SERP_MAX_DEPTH).toBe(25);
  });

  it("exposes at least the US/UK locations", () => {
    const codes = SERP_LOCATIONS.map((l) => l.code);
    expect(codes).toContain(2840);
    expect(codes).toContain(2826);
  });

  it("exposes english as a language", () => {
    expect(SERP_LANGUAGES.some((l) => l.code === "en")).toBe(true);
  });
});
