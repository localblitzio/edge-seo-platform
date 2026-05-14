import { describe, expect, it } from "vitest";

import {
  buildSiteQueryBody,
  interpretSiteResponse,
} from "../../../frontend-worker/src/indexation-check.js";

describe("buildSiteQueryBody", () => {
  it("wraps the keyword as site:<url>", () => {
    const body = JSON.parse(buildSiteQueryBody("https://acme.com/about"));
    expect(body[0].keyword).toBe("site:https://acme.com/about");
  });

  it("requests depth 10 (enough for site: queries, doesn't waste credits)", () => {
    const body = JSON.parse(buildSiteQueryBody("https://x.com/"));
    expect(body[0].depth).toBe(10);
  });

  it("returns a single-element task array (DataForSEO requires it)", () => {
    const body = JSON.parse(buildSiteQueryBody("https://x.com/"));
    expect(Array.isArray(body)).toBe(true);
    expect(body).toHaveLength(1);
  });
});

describe("interpretSiteResponse", () => {
  it("returns 'not_indexed' when there are 0 organic items", () => {
    const r = interpretSiteResponse(
      { status_code: 20000, tasks: [{ result: [{ items: [] }] }] },
      "https://acme.com/",
    );
    expect(r.status).toBe("not_indexed");
    expect(r.evidence.organic_count).toBe(0);
  });

  it("returns 'indexed' when at least one organic result is present", () => {
    const r = interpretSiteResponse(
      {
        status_code: 20000,
        tasks: [
          {
            result: [
              {
                items: [{ type: "organic", url: "https://acme.com/about" }],
              },
            ],
          },
        ],
      },
      "https://acme.com/",
    );
    expect(r.status).toBe("indexed");
    expect(r.evidence.organic_count).toBe(1);
  });

  it("records exact_match when the queried URL is in the results", () => {
    const r = interpretSiteResponse(
      {
        status_code: 20000,
        tasks: [
          {
            result: [
              {
                items: [
                  { type: "organic", url: "https://acme.com/about" },
                  { type: "organic", url: "https://acme.com/" },
                ],
              },
            ],
          },
        ],
      },
      "https://acme.com/about",
    );
    expect(r.status).toBe("indexed");
    expect(r.evidence.exact_match).toBe("https://acme.com/about");
  });

  it("returns 'indexed' even when no exact match — site is in the index", () => {
    const r = interpretSiteResponse(
      {
        status_code: 20000,
        tasks: [{ result: [{ items: [{ type: "organic", url: "https://acme.com/other" }] }] }],
      },
      "https://acme.com/about",
    );
    expect(r.status).toBe("indexed");
    expect(r.evidence.exact_match).toBeNull();
  });

  it("normalizes trailing slash + case when matching", () => {
    const r = interpretSiteResponse(
      {
        status_code: 20000,
        tasks: [
          {
            result: [{ items: [{ type: "organic", url: "https://ACME.com/About/" }] }],
          },
        ],
      },
      "https://acme.com/about",
    );
    expect(r.status).toBe("indexed");
    expect(r.evidence.exact_match).toBe("https://ACME.com/About/");
  });

  it("returns 'unknown' on null/non-object payload", () => {
    expect(interpretSiteResponse(null, "https://x.com").status).toBe("unknown");
    expect(interpretSiteResponse(undefined, "https://x.com").status).toBe("unknown");
    expect(interpretSiteResponse("string", "https://x.com").status).toBe("unknown");
  });

  it("returns 'unknown' when DataForSEO status_code is an error (>=40000)", () => {
    const r = interpretSiteResponse(
      { status_code: 40100, status_message: "Authentication failed" },
      "https://x.com",
    );
    expect(r.status).toBe("unknown");
    expect(r.evidence.status_code).toBe(40100);
    expect(r.evidence.status_message).toBe("Authentication failed");
  });

  it("filters out non-organic items (ads, PAA, etc)", () => {
    const r = interpretSiteResponse(
      {
        status_code: 20000,
        tasks: [
          {
            result: [
              {
                items: [{ type: "paid", url: "https://ad.example/" }, { type: "people_also_ask" }],
              },
            ],
          },
        ],
      },
      "https://x.com/",
    );
    expect(r.status).toBe("not_indexed");
  });
});
