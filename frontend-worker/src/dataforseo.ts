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
// Google reviews is task-based (no synchronous "live" endpoint), so we
// POST to task_post and then poll task_get/advanced/{id} until the
// task settles. `advanced` variant returns the full review items
// (text + author + rating + date + owner_answer); the `regular`
// variant only returns a summary.
const REVIEWS_TASK_POST_URL =
  "https://api.dataforseo.com/v3/business_data/google/reviews/task_post";
const REVIEWS_TASK_GET_URL =
  "https://api.dataforseo.com/v3/business_data/google/reviews/task_get/advanced/";
/** Max time we spend polling task_get before giving up. */
const REVIEWS_POLL_MAX_MS = 180_000;
/** Per-attempt waits in ms — gentle backoff with a longer first wait
 *  because DataForSEO often returns 40401 "Task Not Found" for ~30s
 *  after task_post while their fleet propagates the new task. */
const REVIEWS_POLL_WAITS = [15_000, 10_000, 10_000, 10_000, 12_000, 15_000, 20_000, 25_000, 30_000];
/** Treat 40401 as "task not yet ingested" for this window after post. */
const REVIEWS_TRANSIENT_404_WINDOW_MS = 60_000;

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
  /* ─── Phase B.3 enrichment fields (same call, just parse more) ─── */
  /** Google CID — stable Maps identifier. Enables Maps deep links + place_id-keyed reviews scrape later. */
  place_id: string;
  /** Latitude as decimal string ("32.7157"). Unlocks per-business map embeds. */
  latitude: string;
  /** Longitude as decimal string. */
  longitude: string;
  /** JSON-serialized weekly hours: `{"monday":"9-17","tuesday":"9-17",...}` or `"24/7"` or `""`. */
  hours_json: string;
  /** Price level marker: "$", "$$", "$$$", "$$$$", or "". */
  price_level: string;
  /** Short Google-supplied description ("snippet") or "". */
  description: string;
  /** Single hero photo URL or "". */
  main_image_url: string;
  /** JSON-serialized string[] of additional photo URLs (up to 10). */
  photos_json: string;
  /** JSON-serialized `Record<string, boolean>` of attributes (wheelchair_accessible, wifi, etc.). */
  attributes_json: string;
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
  "place_id",
  "latitude",
  "longitude",
  "hours_json",
  "price_level",
  "description",
  "main_image_url",
  "photos_json",
  "attributes_json",
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
 * Collapse DataForSEO's `work_time` block (variable shape) into a
 * stable JSON string keyed by lowercased weekday name. Examples of
 * the input shapes we see:
 *
 *   {"work_hours": {"timetable": {"monday": [{ "open": {hour: 9}, "close": {hour: 17}}], ...}}}
 *   {"work_hours": "24/7"}
 *   null / missing
 *
 * Returns "" when nothing usable was present, "24/7" for always-open,
 * or a JSON object string `{"monday":"9:00-17:00",...}` for the
 * timetable variant. Pure — exercised by unit tests.
 */
export function normalizeHours(input: unknown): string {
  if (input == null) return "";
  // String form — usually "24/7" or "closed"
  if (typeof input === "string") {
    const s = input.trim().toLowerCase();
    if (s.length === 0) return "";
    if (s === "24/7" || s === "open 24 hours") return "24/7";
    return s;
  }
  if (typeof input !== "object") return "";
  const obj = input as Record<string, unknown>;

  // Some responses wrap as `{ work_hours: { timetable: { ... } } }`
  const wh = obj.work_hours;
  if (typeof wh === "string") {
    const s = wh.trim().toLowerCase();
    return s === "24/7" || s === "open 24 hours" ? "24/7" : s;
  }
  const timetableObj =
    typeof wh === "object" &&
    wh !== null &&
    typeof (wh as Record<string, unknown>).timetable === "object"
      ? ((wh as Record<string, unknown>).timetable as Record<string, unknown>)
      : typeof obj.timetable === "object" && obj.timetable !== null
        ? (obj.timetable as Record<string, unknown>)
        : null;
  if (!timetableObj) return "";

  const days = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
  const out: Record<string, string> = {};
  for (const day of days) {
    const slots = timetableObj[day];
    if (!Array.isArray(slots) || slots.length === 0) {
      out[day] = "closed";
      continue;
    }
    const ranges = slots
      .map((slot) => {
        if (typeof slot !== "object" || slot === null) return "";
        const slotObj = slot as Record<string, unknown>;
        const open = formatClock(slotObj.open);
        const close = formatClock(slotObj.close);
        return open && close ? `${open}-${close}` : "";
      })
      .filter((s) => s.length > 0);
    out[day] = ranges.length > 0 ? ranges.join(", ") : "closed";
  }
  return JSON.stringify(out);
}

function formatClock(input: unknown): string {
  if (typeof input !== "object" || input === null) return "";
  const obj = input as Record<string, unknown>;
  const hour = typeof obj.hour === "number" ? obj.hour : null;
  const minute = typeof obj.minute === "number" ? obj.minute : 0;
  if (hour === null) return "";
  return `${hour.toString().padStart(2, "0")}:${minute.toString().padStart(2, "0")}`;
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

        /* ─── B.3 enrichment fields ─── */
        // place_id — Google CID. Available as `cid` (string) on Maps items;
        // some responses use `place_id` directly. Either form works downstream.
        const placeId =
          typeof obj.place_id === "string"
            ? obj.place_id
            : typeof obj.cid === "string"
              ? obj.cid
              : "";
        const latitude =
          typeof obj.latitude === "number"
            ? obj.latitude.toString()
            : typeof obj.latitude === "string"
              ? obj.latitude
              : "";
        const longitude =
          typeof obj.longitude === "number"
            ? obj.longitude.toString()
            : typeof obj.longitude === "string"
              ? obj.longitude
              : "";
        const hoursJson = normalizeHours(obj.work_time);
        const priceLevel = typeof obj.price_level === "string" ? obj.price_level : "";
        // DataForSEO's Maps response uses `snippet` for the short blurb on
        // some items, `description` on others. Take whichever is present.
        const description =
          typeof obj.snippet === "string"
            ? obj.snippet
            : typeof obj.description === "string"
              ? obj.description
              : "";
        const mainImage =
          typeof obj.main_image === "string"
            ? obj.main_image
            : typeof obj.logo === "string"
              ? obj.logo
              : "";
        const photoList = Array.isArray(obj.photos)
          ? (obj.photos as unknown[])
              .map((p) => {
                if (typeof p === "string") return p;
                if (typeof p === "object" && p !== null) {
                  const url = (p as Record<string, unknown>).url;
                  return typeof url === "string" ? url : "";
                }
                return "";
              })
              .filter((u) => u.length > 0)
              .slice(0, 10)
          : [];
        const attributesObj: Record<string, boolean> = {};
        if (typeof obj.attributes === "object" && obj.attributes !== null) {
          for (const [k, v] of Object.entries(obj.attributes as Record<string, unknown>)) {
            if (typeof v === "boolean") attributesObj[k] = v;
            else if (typeof v === "string") attributesObj[k] = v === "true" || v === "yes";
          }
        }

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
          place_id: placeId,
          latitude,
          longitude,
          hours_json: hoursJson,
          price_level: priceLevel,
          description,
          main_image_url: mainImage,
          photos_json: photoList.length > 0 ? JSON.stringify(photoList) : "",
          attributes_json:
            Object.keys(attributesObj).length > 0 ? JSON.stringify(attributesObj) : "",
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
  // DataForSEO returns top-level 20000 (success) even when an individual
  // task fails to resolve (e.g. unknown `location_name`). Surface that
  // per-task status so the caller can show a useful per-location error
  // instead of silently returning 0 rows.
  const taskErr = firstTaskError(json);
  if (taskErr) throw new DataForSeoApiError(taskErr.message, taskErr.code);

  const parsed = parseMapsResponse(json, { keyword: q.keyword, location: q.location_name });
  return parsed.slice(0, q.depth);
}

/**
 * Walk the task list and return the first task whose `status_code` is in
 * the error range (>= 40000) — DataForSEO uses these for things like
 * "location_name not resolved" (40501) and quota errors.
 */
function firstTaskError(
  json: Record<string, unknown> | null,
): { code: number; message: string } | null {
  if (!json) return null;
  const tasks = Array.isArray(json.tasks) ? json.tasks : [];
  for (const t of tasks) {
    if (typeof t !== "object" || t === null) continue;
    const obj = t as Record<string, unknown>;
    const code = typeof obj.status_code === "number" ? obj.status_code : 0;
    if (code >= 40000) {
      const msg = typeof obj.status_message === "string" ? obj.status_message : "task failed";
      return { code, message: `task ${code}: ${msg}` };
    }
  }
  return null;
}

/* ─── Reviews scrape (B.6) ─── */

export interface ReviewItem {
  /** Free-form review text. */
  text: string;
  /** Numeric rating ("5") or "" if missing. */
  rating: string;
  /** Reviewer display name. */
  author: string;
  /** ISO date string or DataForSEO's raw timestamp; consumed by templates as-is. */
  date: string;
  /** Owner's response, if any. */
  owner_response: string;
}

export const REVIEWS_MAX_DEPTH = 10;

/**
 * Build a reviews request body. DataForSEO requires either `place_id`
 * or (location + keyword) — we always pass place_id from the parent
 * Maps scrape, which is much more reliable.
 */
export function buildReviewsRequestBody(
  placeId: string,
  depth: number,
  languageCode: string,
): string {
  const d = Math.max(1, Math.min(REVIEWS_MAX_DEPTH, depth));
  return JSON.stringify([
    {
      place_id: placeId,
      depth: d,
      language_code: languageCode,
      sort_by: "newest",
    },
  ]);
}

/**
 * Pull review items out of a DataForSEO reviews response. Each item in
 * `tasks[0].result[0].items[]` has `type === "google_reviews_search"`.
 *
 * Pure — exercised by unit tests.
 */
export function parseReviewsResponse(payload: unknown): ReviewItem[] {
  if (typeof payload !== "object" || payload === null) return [];
  const root = payload as Record<string, unknown>;
  const tasks = Array.isArray(root.tasks) ? root.tasks : [];
  const out: ReviewItem[] = [];
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
        // DataForSEO sends the type as `google_reviews_search` in v3
        if (obj.type !== "google_reviews_search" && obj.type !== "review") continue;
        const text =
          typeof obj.review_text === "string"
            ? obj.review_text
            : typeof obj.text === "string"
              ? obj.text
              : "";
        if (!text) continue;
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
        const profileObj =
          typeof obj.profile === "object" && obj.profile !== null
            ? (obj.profile as Record<string, unknown>)
            : {};
        const author =
          typeof obj.author_name === "string"
            ? obj.author_name
            : typeof profileObj.name === "string"
              ? profileObj.name
              : "";
        const date =
          typeof obj.timestamp === "string"
            ? obj.timestamp
            : typeof obj.date === "string"
              ? obj.date
              : typeof obj.review_text_lang === "string"
                ? ""
                : "";
        const ownerObj =
          typeof obj.owner_answer === "object" && obj.owner_answer !== null
            ? (obj.owner_answer as Record<string, unknown>)
            : null;
        const ownerResponse =
          typeof obj.owner_response === "string"
            ? obj.owner_response
            : ownerObj && typeof ownerObj.text === "string"
              ? ownerObj.text
              : "";
        out.push({ text, rating, author, date, owner_response: ownerResponse });
      }
    }
  }
  return out;
}

/**
 * Fetch reviews for one business by place_id. DataForSEO's reviews
 * endpoint is task-based (no synchronous variant), so this:
 *
 *   1. POSTs to task_post with the place_id query
 *   2. Polls task_get/{id} with a gentle backoff
 *   3. Returns parsed reviews when the task settles
 *
 * Max wall time ~60s. Throws on credential issues, transport errors,
 * task-level DataForSEO errors, or timeout. Callers (the per-row
 * reviews job and the per-Business reviews job) handle the thrown
 * error by writing terminal status to the DB.
 */
export async function fetchReviews(
  env: AppEnv,
  placeId: string,
  depth = 5,
  languageCode = "en",
): Promise<ReviewItem[]> {
  if (!placeId.trim()) throw new DataForSeoConfigError("place_id is empty");
  const sharedEnv = env as unknown as Parameters<typeof getSecret>[0];
  const [login, password] = await Promise.all([
    getSecret(sharedEnv, "DATAFORSEO_LOGIN"),
    getSecret(sharedEnv, "DATAFORSEO_PASSWORD"),
  ]);
  if (!login || !password) {
    throw new DataForSeoConfigError("DataForSEO credentials are not configured.");
  }
  const authHeader = basicAuthHeader(login, password);

  // Step 1 — POST the task.
  const postRes = await fetch(REVIEWS_TASK_POST_URL, {
    method: "POST",
    headers: { authorization: authHeader, "content-type": "application/json" },
    body: buildReviewsRequestBody(placeId, depth, languageCode),
  });
  if (!postRes.ok) {
    const text = await postRes.text().catch(() => "");
    throw new DataForSeoApiError(
      `DataForSEO task_post HTTP ${postRes.status}${text ? `: ${text.slice(0, 200)}` : ""}`,
      postRes.status,
    );
  }
  const postJson = (await postRes.json().catch(() => null)) as Record<string, unknown> | null;
  if (postJson && typeof postJson.status_code === "number" && postJson.status_code >= 40000) {
    const msg =
      typeof postJson.status_message === "string" ? postJson.status_message : "DataForSEO error";
    throw new DataForSeoApiError(
      `DataForSEO ${postJson.status_code}: ${msg}`,
      postJson.status_code,
    );
  }
  const taskId = extractTaskId(postJson);
  if (!taskId) {
    throw new DataForSeoApiError("DataForSEO task_post returned no task id", 500);
  }

  // Step 2 — poll task_get with a small backoff schedule. Most reviews
  // tasks settle in 10-30s.
  const startedAt = Date.now();
  for (const wait of REVIEWS_POLL_WAITS) {
    if (Date.now() - startedAt > REVIEWS_POLL_MAX_MS) break;
    await sleep(wait);
    const getRes = await fetch(`${REVIEWS_TASK_GET_URL}${encodeURIComponent(taskId)}`, {
      method: "GET",
      headers: { authorization: authHeader },
    });
    if (!getRes.ok) {
      // Transient errors get retried by the loop. Only bubble up
      // sustained failures via the timeout error below.
      continue;
    }
    const getJson = (await getRes.json().catch(() => null)) as Record<string, unknown> | null;
    if (!getJson) continue;
    const top = typeof getJson.status_code === "number" ? getJson.status_code : 0;
    if (top >= 40000) {
      const msg =
        typeof getJson.status_message === "string" ? getJson.status_message : "task error";
      throw new DataForSeoApiError(`DataForSEO ${top}: ${msg}`, top);
    }
    const taskState = inspectTaskState(getJson);
    if (taskState === "in_progress") continue;
    if (taskState === "error") {
      // 40401 ("Task Not Found") right after task_post is a known
      // DataForSEO propagation artifact — their backend takes up to
      // ~60s to make the task visible to task_get. Keep polling
      // during that window before treating it as terminal.
      const taskErr = firstTaskError(getJson);
      const elapsed = Date.now() - startedAt;
      if (taskErr && taskErr.code === 40401 && elapsed < REVIEWS_TRANSIENT_404_WINDOW_MS) {
        continue;
      }
      if (taskErr) throw new DataForSeoApiError(taskErr.message, taskErr.code);
      throw new DataForSeoApiError("DataForSEO task settled with an unknown error", 500);
    }
    // done
    return parseReviewsResponse(getJson).slice(0, depth);
  }
  throw new DataForSeoApiError(
    `DataForSEO reviews task ${taskId} didn't complete within ${Math.round(REVIEWS_POLL_MAX_MS / 1000)}s`,
    504,
  );
}

function extractTaskId(json: Record<string, unknown> | null): string | null {
  if (!json) return null;
  const tasks = Array.isArray(json.tasks) ? json.tasks : [];
  for (const t of tasks) {
    if (typeof t !== "object" || t === null) continue;
    const id = (t as Record<string, unknown>).id;
    if (typeof id === "string" && id.length > 0) return id;
  }
  return null;
}

/**
 * task_get returns one of three meaningful states:
 *   - in_progress: status_code 40602 ("Task In Queue") or 40601
 *   - error:       status_code >= 40000 (excluding 40601/40602)
 *   - done:        status_code 20000 with `result` populated
 *
 * We treat any task with `status_code === 20000` and a non-null
 * `result` as done. Anything still queued returns "in_progress" so the
 * caller keeps polling.
 */
function inspectTaskState(json: Record<string, unknown> | null): "done" | "in_progress" | "error" {
  if (!json) return "in_progress";
  const tasks = Array.isArray(json.tasks) ? json.tasks : [];
  for (const t of tasks) {
    if (typeof t !== "object" || t === null) continue;
    const obj = t as Record<string, unknown>;
    const code = typeof obj.status_code === "number" ? obj.status_code : 0;
    if (code === 40602 || code === 40601) return "in_progress";
    if (code >= 40000) return "error";
    if (code === 20000) {
      if (obj.result === null) return "in_progress";
      return "done";
    }
  }
  return "in_progress";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
