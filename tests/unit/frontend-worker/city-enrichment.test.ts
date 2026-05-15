import { describe, expect, it } from "vitest";

import {
  extractFoundedYear,
  extractPopulation,
  trimToParagraph,
} from "../../../frontend-worker/src/city-enrichment.js";

describe("trimToParagraph", () => {
  it("returns text up to the first blank line", () => {
    const out = trimToParagraph("First paragraph.\n\nSecond paragraph.");
    expect(out).toBe("First paragraph.");
  });

  it("caps at a sentence boundary past 600 chars when no blank line", () => {
    // Needs to be > 800 chars overall so it doesn't fall into the
    // short-return branch. 850 A's + " END. ..." has its first `.` past 600 at the END.
    const long = `${"A".repeat(850)} END. More stuff here.`;
    const out = trimToParagraph(long);
    expect(out.endsWith("END.")).toBe(true);
    expect(out.length).toBeLessThan(long.length);
  });

  it("returns whole string when ≤ 800 chars and no blank line", () => {
    const short = "Just a single sentence about Carmel.";
    expect(trimToParagraph(short)).toBe(short);
  });
});

describe("extractPopulation", () => {
  it("pulls the largest comma-formatted number after 'population'", () => {
    expect(
      extractPopulation(
        "San Diego is a city in California. At the 2020 census the population was 1,386,932.",
      ),
    ).toBe(1386932);
  });

  it("handles 'population of N'", () => {
    expect(extractPopulation("Carmel has a population of 99,757 residents.")).toBe(99757);
  });

  it("returns null when no population mentioned", () => {
    expect(extractPopulation("A historic seaside town with Spanish architecture.")).toBeNull();
  });
});

describe("extractFoundedYear", () => {
  it("captures 'founded in YYYY'", () => {
    expect(extractFoundedYear("Indianapolis was founded in 1820.")).toBe(1820);
  });

  it("captures 'incorporated YYYY'", () => {
    expect(extractFoundedYear("The city was incorporated 1850.")).toBe(1850);
  });

  it("ignores years outside the [1500, current] range", () => {
    expect(extractFoundedYear("Founded in 999.")).toBeNull();
  });

  it("returns null when not present", () => {
    expect(extractFoundedYear("A coastal city in Southern California.")).toBeNull();
  });
});
