import { describe, expect, it } from "vitest";

import {
  parseStoredConfig,
  validateScrapeForm,
} from "../../../frontend-worker/src/data-source-scrape.js";
import {
  buildMapsSerpRequestBody,
  parseMapsResponse,
} from "../../../frontend-worker/src/dataforseo.js";

describe("buildMapsSerpRequestBody", () => {
  it("emits a single-task array with the right fields", () => {
    const body = buildMapsSerpRequestBody({
      keyword: "pool builders",
      location_name: "San Diego,California,United States",
      language_code: "en",
      depth: 10,
    });
    const parsed = JSON.parse(body) as Array<Record<string, unknown>>;
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.keyword).toBe("pool builders");
    expect(parsed[0]?.location_name).toBe("San Diego,California,United States");
    expect(parsed[0]?.depth).toBe(10);
  });

  it("clamps depth to [1, 20]", () => {
    const tooHigh = JSON.parse(
      buildMapsSerpRequestBody({
        keyword: "x",
        location_name: "Y",
        language_code: "en",
        depth: 100,
      }),
    ) as Array<Record<string, unknown>>;
    expect(tooHigh[0]?.depth).toBe(20);

    const tooLow = JSON.parse(
      buildMapsSerpRequestBody({
        keyword: "x",
        location_name: "Y",
        language_code: "en",
        depth: -5,
      }),
    ) as Array<Record<string, unknown>>;
    expect(tooLow[0]?.depth).toBe(1);
  });
});

describe("parseMapsResponse", () => {
  const ctx = { keyword: "pool builders", location: "San Diego" };

  it("extracts maps_search items into normalized rows", () => {
    const payload = {
      tasks: [
        {
          result: [
            {
              items: [
                {
                  type: "maps_search",
                  title: "Aqua Pro Pools",
                  address: "123 Main St, San Diego, CA 92101",
                  address_info: {
                    city: "San Diego",
                    region: "California",
                    country_code: "US",
                    zip: "92101",
                  },
                  phone: "619-555-0100",
                  url: "https://aquapropools.example",
                  rating: { value: 4.7, votes_count: 128 },
                  category: "Swimming Pool Contractor",
                  additional_categories: ["Pool Builder"],
                },
                {
                  type: "maps_search",
                  title: "Splash Builders",
                  address: "200 Elm Ave, La Jolla, CA",
                  phone: "858-555-0200",
                  url: "https://splash.example",
                  rating: { value: 4.5 },
                  category: "Pool Builder",
                },
              ],
            },
          ],
        },
      ],
    };
    const rows = parseMapsResponse(payload, ctx);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      position: "1",
      title: "Aqua Pro Pools",
      city: "San Diego",
      state: "California",
      country: "US",
      zip: "92101",
      phone: "619-555-0100",
      website: "https://aquapropools.example",
      rating: "4.7",
      rating_count: "128",
      categories: "Swimming Pool Contractor, Pool Builder",
      keyword: "pool builders",
      location: "San Diego",
    });
    expect(rows[1]?.rating_count).toBe("");
    expect(rows[1]?.position).toBe("2");
  });

  it("skips items that aren't type=maps_search", () => {
    const payload = {
      tasks: [
        {
          result: [
            {
              items: [
                { type: "ad", title: "skip me" },
                { type: "maps_search", title: "Keep me" },
                { type: "knowledge_panel", title: "skip me too" },
              ],
            },
          ],
        },
      ],
    };
    const rows = parseMapsResponse(payload, ctx);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.title).toBe("Keep me");
  });

  it("returns empty for malformed payloads", () => {
    expect(parseMapsResponse(null, ctx)).toEqual([]);
    expect(parseMapsResponse({}, ctx)).toEqual([]);
    expect(parseMapsResponse({ tasks: "not-an-array" }, ctx)).toEqual([]);
  });

  it("drops items without a title", () => {
    const payload = {
      tasks: [
        { result: [{ items: [{ type: "maps_search", title: "" }, { type: "maps_search" }] }] },
      ],
    };
    expect(parseMapsResponse(payload, ctx)).toEqual([]);
  });
});

describe("validateScrapeForm", () => {
  const happy = {
    name: "Pool builders San Diego",
    keyword: "pool builders",
    locations: "San Diego,California,US\nLa Jolla,California,US",
    depth: "10",
    language_code: "en",
  };

  it("accepts a valid form", () => {
    const r = validateScrapeForm(happy);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.config.locations).toEqual(["San Diego,California,US", "La Jolla,California,US"]);
      expect(r.config.depth).toBe(10);
    }
  });

  it("requires keyword + name + at least one location", () => {
    const r = validateScrapeForm({ ...happy, keyword: "" });
    expect(r.ok).toBe(false);
    const r2 = validateScrapeForm({ ...happy, name: "" });
    expect(r2.ok).toBe(false);
    const r3 = validateScrapeForm({ ...happy, locations: "   \n   " });
    expect(r3.ok).toBe(false);
  });

  it("rejects depth out of bounds", () => {
    const r = validateScrapeForm({ ...happy, depth: "100" });
    expect(r.ok).toBe(false);
    const r2 = validateScrapeForm({ ...happy, depth: "0" });
    expect(r2.ok).toBe(false);
  });

  it("rejects non-2-letter language codes", () => {
    const r = validateScrapeForm({ ...happy, language_code: "eng" });
    expect(r.ok).toBe(false);
  });

  it("caps locations at 25", () => {
    const tooMany = Array.from({ length: 30 }, (_, i) => `City${i}`).join("\n");
    const r = validateScrapeForm({ ...happy, locations: tooMany });
    expect(r.ok).toBe(false);
  });
});

describe("parseStoredConfig", () => {
  it("round-trips a valid config", () => {
    const cfg = parseStoredConfig(
      JSON.stringify({ keyword: "k", locations: ["San Diego"], depth: 5, language_code: "en" }),
    );
    expect(cfg).toEqual({ keyword: "k", locations: ["San Diego"], depth: 5, language_code: "en" });
  });

  it("returns null on null/missing/invalid JSON", () => {
    expect(parseStoredConfig(null)).toBeNull();
    expect(parseStoredConfig("not json")).toBeNull();
    expect(parseStoredConfig(JSON.stringify({}))).toBeNull();
    expect(parseStoredConfig(JSON.stringify({ keyword: "" }))).toBeNull();
    expect(parseStoredConfig(JSON.stringify({ keyword: "x", locations: [] }))).toBeNull();
  });
});
