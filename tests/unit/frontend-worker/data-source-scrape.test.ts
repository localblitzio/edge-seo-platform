import { describe, expect, it } from "vitest";

import {
  STUCK_HEARTBEAT_MS,
  isStuck,
  parseStoredConfig,
  validateScrapeForm,
} from "../../../frontend-worker/src/data-source-scrape.js";
import {
  buildMapsSerpRequestBody,
  normalizeHours,
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

  it("extracts B.3 enrichment fields: place_id, lat/lng, hours, price, description, photos, attributes", () => {
    const payload = {
      tasks: [
        {
          result: [
            {
              items: [
                {
                  type: "maps_search",
                  title: "Aqua Pro Pools",
                  address: "123 Main St",
                  address_info: { city: "San Diego", region: "California", country_code: "US" },
                  place_id: "ChIJrTLr-GyuEmsRBfy61i59si0",
                  latitude: 32.7157,
                  longitude: -117.1611,
                  price_level: "$$",
                  snippet: "Top-rated pool builder in San Diego.",
                  main_image: "https://example.com/main.jpg",
                  photos: ["https://example.com/p1.jpg", { url: "https://example.com/p2.jpg" }],
                  attributes: { wheelchair_accessible: true, wifi: "yes", outdoor_seating: false },
                  work_time: {
                    work_hours: {
                      timetable: {
                        monday: [{ open: { hour: 9, minute: 0 }, close: { hour: 17, minute: 0 } }],
                        tuesday: [
                          { open: { hour: 9, minute: 30 }, close: { hour: 17, minute: 0 } },
                        ],
                        sunday: [],
                      },
                    },
                  },
                  category: "Pool Builder",
                },
              ],
            },
          ],
        },
      ],
    };
    const rows = parseMapsResponse(payload, ctx);
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.place_id).toBe("ChIJrTLr-GyuEmsRBfy61i59si0");
    expect(row.latitude).toBe("32.7157");
    expect(row.longitude).toBe("-117.1611");
    expect(row.price_level).toBe("$$");
    expect(row.description).toBe("Top-rated pool builder in San Diego.");
    expect(row.main_image_url).toBe("https://example.com/main.jpg");
    const photos = JSON.parse(row.photos_json) as string[];
    expect(photos).toEqual(["https://example.com/p1.jpg", "https://example.com/p2.jpg"]);
    const attrs = JSON.parse(row.attributes_json) as Record<string, boolean>;
    expect(attrs).toEqual({ wheelchair_accessible: true, wifi: true, outdoor_seating: false });
    const hours = JSON.parse(row.hours_json) as Record<string, string>;
    expect(hours.monday).toBe("09:00-17:00");
    expect(hours.tuesday).toBe("09:30-17:00");
    expect(hours.sunday).toBe("closed");
  });

  it("defaults enrichment fields to empty strings when absent", () => {
    const payload = {
      tasks: [{ result: [{ items: [{ type: "maps_search", title: "Plain Co" }] }] }],
    };
    const rows = parseMapsResponse(payload, ctx);
    expect(rows[0]).toMatchObject({
      place_id: "",
      latitude: "",
      longitude: "",
      hours_json: "",
      price_level: "",
      description: "",
      main_image_url: "",
      photos_json: "",
      attributes_json: "",
    });
  });

  it("returns empty when result is null (DataForSEO returns this for unresolved locations)", () => {
    // Top-level OK, but the task itself failed: status_code >= 40000.
    // parseMapsResponse just sees no items and returns []. The caller
    // (fetchBusinessListings) is responsible for surfacing the task error.
    const payload = {
      tasks: [
        {
          status_code: 40501,
          status_message: "location_name not found in DataForSEO Google database",
          result: null,
        },
      ],
    };
    expect(parseMapsResponse(payload, ctx)).toEqual([]);
  });
});

describe("normalizeHours", () => {
  it("returns '' for null / empty input", () => {
    expect(normalizeHours(null)).toBe("");
    expect(normalizeHours("")).toBe("");
    expect(normalizeHours({})).toBe("");
  });

  it("collapses 24/7 strings", () => {
    expect(normalizeHours("24/7")).toBe("24/7");
    expect(normalizeHours("Open 24 hours")).toBe("24/7");
    expect(normalizeHours({ work_hours: "24/7" })).toBe("24/7");
  });

  it("converts a per-day timetable into a JSON map", () => {
    const result = normalizeHours({
      work_hours: {
        timetable: {
          monday: [{ open: { hour: 9, minute: 0 }, close: { hour: 17, minute: 30 } }],
          friday: [],
        },
      },
    });
    const parsed = JSON.parse(result) as Record<string, string>;
    expect(parsed.monday).toBe("09:00-17:30");
    expect(parsed.friday).toBe("closed");
    expect(parsed.sunday).toBe("closed");
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

describe("isStuck", () => {
  const now = Date.UTC(2026, 4, 14, 12, 0, 0); // 2026-05-14T12:00:00Z

  it("returns false for non-running statuses", () => {
    expect(isStuck("done", "2026-05-14T11:00:00Z", now)).toBe(false);
    expect(isStuck("error", "2026-05-14T11:00:00Z", now)).toBe(false);
    expect(isStuck("none", null, now)).toBe(false);
  });

  it("returns false when heartbeat is fresh", () => {
    const fresh = new Date(now - 30_000).toISOString(); // 30s ago
    expect(isStuck("running", fresh, now)).toBe(false);
  });

  it("returns true when heartbeat is older than the stuck threshold", () => {
    const stale = new Date(now - (STUCK_HEARTBEAT_MS + 5_000)).toISOString();
    expect(isStuck("running", stale, now)).toBe(true);
  });

  it("returns false when heartbeat is null (job hasn't started writing yet)", () => {
    expect(isStuck("running", null, now)).toBe(false);
  });
});
