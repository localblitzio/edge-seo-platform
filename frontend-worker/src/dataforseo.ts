/**
 * DataForSEO Google organic SERP fetch — used by the Create-from-SERP
 * flow (/app/clients/serp-new) to populate the URL list for a keyword.
 *
 * Uses the live "advanced" endpoint
 * (`/v3/serp/google/organic/live/advanced`) so we get a single
 * synchronous response per query — no task polling. Only `organic`
 * items are returned; ads, knowledge panels, AI overviews, image
 * packs etc. are filtered out.
 *
 * Auth: HTTP basic with `DATAFORSEO_LOGIN` + `DATAFORSEO_PASSWORD`
 * loaded from the operator-managed secret store.
 *
 * Cost: every call charges the operator's DataForSEO account. The
 * caller is responsible for surfacing this to the operator.
 */

import { getSecret } from "../../src/secrets/store.js";
import type { AppEnv } from "./app.js";

const ENDPOINT = "https://api.dataforseo.com/v3/serp/google/organic/live/advanced";
const MAPS_ENDPOINT = "https://api.dataforseo.com/v3/serp/google/maps/live/advanced";

/** Single organic result the caller can offer to the operator. */
export interface SerpResult {
  /** 1-based position in the organic list (NOT global SERP position). */
  position: number;
  /** Page title as DataForSEO returns it. */
  title: string;
  /** Absolute URL from the result. */
  url: string;
  /** Optional snippet/description; may be empty. */
  description: string;
}

export interface SerpQuery {
  keyword: string;
  /** 2-letter country code (e.g. "us", "gb"). DataForSEO accepts ISO codes. */
  location_code: number;
  /** Language code (e.g. "en"). */
  language_code: string;
  /** "desktop" or "mobile". */
  device: "desktop" | "mobile";
  /** How many organic results to ask for. 1–25 in this flow. */
  depth: number;
}

/**
 * Country/location options the SERP form exposes. The codes are
 * DataForSEO's "location_code" integers — see
 * https://docs.dataforseo.com/v3/serp/google/locations/. Limited to a
 * handful of common targets to keep the picker simple.
 */
export const SERP_LOCATIONS = [
  { code: 2840, label: "United States" },
  { code: 2826, label: "United Kingdom" },
  { code: 2036, label: "Australia" },
  { code: 2124, label: "Canada" },
  { code: 2554, label: "New Zealand" },
] as const;

export const SERP_LANGUAGES = [
  { code: "en", label: "English" },
  { code: "es", label: "Spanish" },
  { code: "fr", label: "French" },
  { code: "de", label: "German" },
] as const;

/** Cap on results-per-query — also enforces the upper bound from §6. */
export const SERP_MAX_DEPTH = 25;

export class DataForSeoConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DataForSeoConfigError";
  }
}

export class DataForSeoApiError extends Error {
  constructor(
    message: string,
    /** HTTP status code, or the `status_code` field DataForSEO returns. */
    public readonly statusCode: number,
  ) {
    super(message);
    this.name = "DataForSeoApiError";
  }
}

/**
 * Extract organic results from a DataForSEO `live/advanced` response
 * payload. Pure — pulled out for unit testing without network IO.
 *
 * DataForSEO wraps the results in `tasks[].result[].items[]`, where
 * each item has a `type` field. We keep only `type === "organic"` and
 * renumber them 1..N (so the operator sees a clean ordinal that
 * matches what they checked, regardless of which global SERP positions
 * were ads/PAA/etc).
 *
 * @param payload the parsed JSON response body
 * @returns the organic results, renumbered 1-based, in their original order
 */
export function parseSerpResponse(payload: unknown): SerpResult[] {
  if (typeof payload !== "object" || payload === null) return [];
  const root = payload as Record<string, unknown>;
  const tasks = Array.isArray(root.tasks) ? root.tasks : [];
  const out: SerpResult[] = [];
  for (const task of tasks) {
    if (typeof task !== "object" || task === null) continue;
    const result = (task as Record<string, unknown>).result;
    if (!Array.isArray(result)) continue;
    for (const r of result) {
      if (typeof r !== "object" || r === null) continue;
      const items = (r as Record<string, unknown>).items;
      if (!Array.isArray(items)) continue;
      for (const item of items) {
        if (typeof item !== "object" || item === null) continue;
        const obj = item as Record<string, unknown>;
        if (obj.type !== "organic") continue;
        const url = typeof obj.url === "string" ? obj.url : null;
        if (!url) continue;
        const title = typeof obj.title === "string" ? obj.title : "";
        const description = typeof obj.description === "string" ? obj.description : "";
        out.push({
          position: out.length + 1,
          title,
          url,
          description,
        });
      }
    }
  }
  return out;
}

/**
 * Build the request body for a single live/advanced query.
 *
 * DataForSEO expects an array of tasks even when sending one — we
 * always send one. `depth` controls how many SERP positions to scan;
 * 25 is more than enough for the picker since we filter to organic
 * (a typical first page has ~10 organic + features).
 */
export function buildSerpRequestBody(q: SerpQuery): string {
  // depth needs to be >= the number of organic results we want, with
  // headroom for SERP features that take up positions. Multiply by 4
  // so depth=25 → ask for top 100; this gives DataForSEO enough room
  // to surface 25 organic items on a feature-heavy SERP.
  const depth = Math.max(10, Math.min(SERP_MAX_DEPTH, q.depth) * 4);
  return JSON.stringify([
    {
      keyword: q.keyword,
      location_code: q.location_code,
      language_code: q.language_code,
      device: q.device,
      depth,
    },
  ]);
}

/**
 * Build the HTTP Basic auth header from two-part credentials.
 * Exported for tests; production code uses `fetchSerpResults`.
 */
export function basicAuthHeader(login: string, password: string): string {
  // btoa is available in the Workers runtime.
  return `Basic ${btoa(`${login}:${password}`)}`;
}

/**
 * Fetch SERP results for a single keyword. Throws on missing creds or
 * API failure — caller renders the error to the operator.
 *
 * @param env the worker env (CONFIG_KV + CONFIG_DB used to read secrets)
 * @param q the SERP query
 * @returns parsed organic results, capped to `q.depth`
 * @throws DataForSeoConfigError when credentials aren't configured
 * @throws DataForSeoApiError on non-2xx response or DataForSEO error status_code
 */
export async function fetchSerpResults(env: AppEnv, q: SerpQuery): Promise<SerpResult[]> {
  if (!q.keyword.trim()) throw new DataForSeoConfigError("keyword is empty");
  if (q.depth < 1 || q.depth > SERP_MAX_DEPTH) {
    throw new DataForSeoConfigError(`depth must be 1..${SERP_MAX_DEPTH}`);
  }
  // `getSecret` accepts the shared Env shape — AppEnv overlaps enough
  // for the KV+D1 read path. The cast mirrors how indexing.ts does it.
  const sharedEnv = env as unknown as Parameters<typeof getSecret>[0];
  const [login, password] = await Promise.all([
    getSecret(sharedEnv, "DATAFORSEO_LOGIN"),
    getSecret(sharedEnv, "DATAFORSEO_PASSWORD"),
  ]);
  if (!login || !password) {
    throw new DataForSeoConfigError(
      "DataForSEO credentials are not configured. Set DATAFORSEO_LOGIN and DATAFORSEO_PASSWORD on the Settings → API keys page.",
    );
  }
  const body = buildSerpRequestBody(q);
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: {
      authorization: basicAuthHeader(login, password),
      "content-type": "application/json",
    },
    body,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new DataForSeoApiError(
      `DataForSEO HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ""}`,
      res.status,
    );
  }
  const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (json && typeof json.status_code === "number" && json.status_code >= 40000) {
    const msg = typeof json.status_message === "string" ? json.status_message : "DataForSEO error";
    throw new DataForSeoApiError(`DataForSEO ${json.status_code}: ${msg}`, json.status_code);
  }
  const parsed = parseSerpResponse(json);
  return parsed.slice(0, q.depth);
}

/* ─── Google Maps SERP — business listings ─── */

/**
 * One business pulled from a Maps SERP. All fields are strings so the
 * row can drop straight into a `site_data_sources.rows` entry — the
 * template render engine expects `Record<string, string>` rows. Empty
 * strings stand in for absent fields so column lookups stay consistent.
 */
export interface BusinessListingRow {
  /** 1-based position within the Maps SERP for this (keyword, location). */
  position: string;
  /** Business name. */
  title: string;
  /** Free-form address as DataForSEO returns it. */
  address: string;
  /** City extracted from the address_info block, if available. */
  city: string;
  /** Region / state code. */
  state: string;
  /** ISO country code. */
  country: string;
  /** ZIP / postal code. */
  zip: string;
  /** Phone number (digits + formatting as DataForSEO returns). */
  phone: string;
  /** Website URL of the business, if listed. */
  website: string;
  /** Average rating ("4.7") or "" when unavailable. */
  rating: string;
  /** Number of ratings ("128") or "". */
  rating_count: string;
  /** Comma-joined categories ("Pool Builder, Contractor"). */
  categories: string;
  /** The location/keyword pair this row was scraped under — useful when
   *  one scrape spans multiple cities and the operator templates per row. */
  keyword: string;
  /** Location string the operator typed (e.g. "San Diego, California"). */
  location: string;
}

export interface BusinessListingQuery {
  keyword: string;
  /** Free-form location name DataForSEO can resolve (e.g. "San Diego,California,United States"). */
  location_name: string;
  language_code: string;
  /** Max organic businesses to return per location. 1..20. */
  depth: number;
}

export const BUSINESS_LISTING_MAX_DEPTH = 20;
export const BUSINESS_LISTING_COLUMNS: readonly (keyof BusinessListingRow)[] = [
  "position",
  "title",
  "address",
  "city",
  "state",
  "country",
  "zip",
  "phone",
  "website",
  "rating",
  "rating_count",
  "categories",
  "keyword",
  "location",
];

/**
 * Build the Maps SERP request body. DataForSEO accepts an array of
 * tasks; we always send one. Location is supplied as a free-form name
 * — DataForSEO geocodes it internally (no need to look up location
 * codes the way organic SERP does).
 */
export function buildMapsSerpRequestBody(q: BusinessListingQuery): string {
  const depth = Math.max(1, Math.min(BUSINESS_LISTING_MAX_DEPTH, q.depth));
  return JSON.stringify([
    {
      keyword: q.keyword,
      location_name: q.location_name,
      language_code: q.language_code,
      depth,
    },
  ]);
}

/**
 * Pull organic business rows out of a Maps SERP response. DataForSEO
 * wraps results in `tasks[].result[].items[]` with `type === "maps_search"`.
 *
 * Pure — exercised by unit tests.
 */
export function parseMapsResponse(
  payload: unknown,
  context: { keyword: string; location: string },
): BusinessListingRow[] {
  if (typeof payload !== "object" || payload === null) return [];
  const root = payload as Record<string, unknown>;
  const tasks = Array.isArray(root.tasks) ? root.tasks : [];
  const out: BusinessListingRow[] = [];
  for (const task of tasks) {
    if (typeof task !== "object" || task === null) continue;
    const result = (task as Record<string, unknown>).result;
    if (!Array.isArray(result)) continue;
    for (const r of result) {
      if (typeof r !== "object" || r === null) continue;
      const items = (r as Record<string, unknown>).items;
      if (!Array.isArray(items)) continue;
      for (const item of items) {
        if (typeof item !== "object" || item === null) continue;
        const obj = item as Record<string, unknown>;
        // DataForSEO uses several item types here. The business
        // listings live under `maps_search`.
        if (obj.type !== "maps_search") continue;
        const title = typeof obj.title === "string" ? obj.title : "";
        if (!title) continue;
        const address = typeof obj.address === "string" ? obj.address : "";
        const addressInfo =
          typeof obj.address_info === "object" && obj.address_info !== null
            ? (obj.address_info as Record<string, unknown>)
            : {};
        const city = typeof addressInfo.city === "string" ? addressInfo.city : "";
        const state = typeof addressInfo.region === "string" ? addressInfo.region : "";
        const country =
          typeof addressInfo.country_code === "string" ? addressInfo.country_code : "";
        const zip = typeof addressInfo.zip === "string" ? addressInfo.zip : "";
        const phone = typeof obj.phone === "string" ? obj.phone : "";
        const website = typeof obj.url === "string" ? obj.url : "";
        const ratingObj =
          typeof obj.rating === "object" && obj.rating !== null
            ? (obj.rating as Record<string, unknown>)
            : {};
        const rating =
          typeof ratingObj.value === "number"
            ? ratingObj.value.toString()
            : typeof ratingObj.value === "string"
              ? ratingObj.value
              : "";
        const ratingCount =
          typeof ratingObj.votes_count === "number" ? ratingObj.votes_count.toString() : "";
        const categoryList = Array.isArray(obj.additional_categories)
          ? (obj.additional_categories as unknown[]).filter(
              (c): c is string => typeof c === "string",
            )
          : [];
        const primaryCategory = typeof obj.category === "string" ? obj.category : "";
        const categories = [primaryCategory, ...categoryList]
          .filter((c) => c.length > 0)
          .join(", ");

        out.push({
          position: (out.length + 1).toString(),
          title,
          address,
          city,
          state,
          country,
          zip,
          phone,
          website,
          rating,
          rating_count: ratingCount,
          categories,
          keyword: context.keyword,
          location: context.location,
        });
      }
    }
  }
  return out;
}

/**
 * Fetch business listings for a single (keyword, location). Throws on
 * missing creds or non-2xx API response — caller decides how to surface.
 *
 * @throws DataForSeoConfigError when credentials aren't set or query is empty
 * @throws DataForSeoApiError on transport or DataForSEO error status
 */
export async function fetchBusinessListings(
  env: AppEnv,
  q: BusinessListingQuery,
): Promise<BusinessListingRow[]> {
  if (!q.keyword.trim()) throw new DataForSeoConfigError("keyword is empty");
  if (!q.location_name.trim()) throw new DataForSeoConfigError("location_name is empty");
  if (q.depth < 1 || q.depth > BUSINESS_LISTING_MAX_DEPTH) {
    throw new DataForSeoConfigError(`depth must be 1..${BUSINESS_LISTING_MAX_DEPTH}`);
  }
  const sharedEnv = env as unknown as Parameters<typeof getSecret>[0];
  const [login, password] = await Promise.all([
    getSecret(sharedEnv, "DATAFORSEO_LOGIN"),
    getSecret(sharedEnv, "DATAFORSEO_PASSWORD"),
  ]);
  if (!login || !password) {
    throw new DataForSeoConfigError(
      "DataForSEO credentials are not configured. Set DATAFORSEO_LOGIN and DATAFORSEO_PASSWORD on the Settings → API keys page.",
    );
  }
  const body = buildMapsSerpRequestBody(q);
  const res = await fetch(MAPS_ENDPOINT, {
    method: "POST",
    headers: {
      authorization: basicAuthHeader(login, password),
      "content-type": "application/json",
    },
    body,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new DataForSeoApiError(
      `DataForSEO HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ""}`,
      res.status,
    );
  }
  const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (json && typeof json.status_code === "number" && json.status_code >= 40000) {
    const msg = typeof json.status_message === "string" ? json.status_message : "DataForSEO error";
    throw new DataForSeoApiError(`DataForSEO ${json.status_code}: ${msg}`, json.status_code);
  }
  const parsed = parseMapsResponse(json, { keyword: q.keyword, location: q.location_name });
  return parsed.slice(0, q.depth);
}
