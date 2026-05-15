/**
 * Phase B.7 — city enrichment from free public sources (Wikipedia).
 *
 * For each unique (city, region, country) in a data source's rows,
 * fetch the Wikipedia REST API summary, parse out:
 *   - description (first paragraph extract)
 *   - population (regex from `extract`/`extract_html` if visible)
 *   - founded_year (regex)
 *   - wiki_url
 *
 * Cache for 30 days in the `city_facts` table. Then write a
 * `city_description` field into each row of the data source so
 * templates can use {{city_description}} immediately.
 *
 * Free to operators: Wikipedia REST API has no API key requirement
 * and a generous polite-use limit (we serialize requests anyway).
 *
 * MUST NOT throw — errors per-city are swallowed and the row is
 * left without the enrichment. Operator can re-run anytime.
 */

import type { AppEnv } from "./app.js";
import type { User } from "./auth.js";
import { type SiteDataSourceRow, checkCsrf, flashRedirect } from "./site-templates.js";

const WIKI_BASE = "https://en.wikipedia.org/api/rest_v1/page/summary/";
const CACHE_TTL_DAYS = 30;
const USER_AGENT = "edge-seo-platform/1.0 (https://edgeseo.app; simon@localblitzmarketing.com)";

export interface CityFactsRow {
  id: number;
  city: string;
  region: string;
  country: string;
  description: string;
  population: number | null;
  founded_year: number | null;
  wiki_url: string;
  fetched_at: string;
}

export interface CityKey {
  city: string;
  region: string;
  country: string;
}

/**
 * Look up cached facts for a city key. Returns null when missing or
 * stale (past TTL).
 */
export async function loadCityFacts(env: AppEnv, key: CityKey): Promise<CityFactsRow | null> {
  const r = await env.CONFIG_DB.prepare(
    `SELECT * FROM city_facts
     WHERE city = ? AND region = ? AND country = ?`,
  )
    .bind(key.city, key.region, key.country)
    .first<CityFactsRow>();
  if (!r) return null;
  if (isStale(r.fetched_at)) return null;
  return r;
}

function isStale(fetchedAt: string): boolean {
  const t = Date.parse(fetchedAt);
  if (!Number.isFinite(t)) return true;
  return Date.now() - t > CACHE_TTL_DAYS * 24 * 60 * 60 * 1000;
}

/**
 * Fetch the Wikipedia summary for a city + cache. Returns the cached
 * row on hit, or a freshly-fetched row. Swallows fetch errors and
 * returns null for those cities (operator sees blank description).
 */
export async function fetchAndCacheCityFacts(
  env: AppEnv,
  key: CityKey,
): Promise<CityFactsRow | null> {
  const cached = await loadCityFacts(env, key);
  if (cached) return cached;

  // Wikipedia accepts the page title as path. "San Diego" works
  // directly; "Carmel,_Indiana" needs the comma-state form to
  // disambiguate. Try city-only first, then disambiguated form.
  const titles = [
    key.city.replace(/\s+/g, "_"),
    `${key.city.replace(/\s+/g, "_")},_${key.region.replace(/\s+/g, "_")}`,
  ];

  let summary: WikiSummary | null = null;
  for (const t of titles) {
    summary = await fetchWikiSummary(t);
    if (summary?.extract && summary.extract.length > 50) break;
  }
  if (!summary) return null;

  const facts: Omit<CityFactsRow, "id" | "fetched_at"> = {
    city: key.city,
    region: key.region,
    country: key.country,
    description: trimToParagraph(summary.extract ?? ""),
    population: extractPopulation(summary.extract ?? ""),
    founded_year: extractFoundedYear(summary.extract ?? ""),
    wiki_url: summary.content_urls?.desktop?.page ?? "",
  };

  await env.CONFIG_DB.prepare(
    `INSERT INTO city_facts (city, region, country, description, population, founded_year, wiki_url)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(city, region, country) DO UPDATE SET
       description = excluded.description,
       population = excluded.population,
       founded_year = excluded.founded_year,
       wiki_url = excluded.wiki_url,
       fetched_at = CURRENT_TIMESTAMP`,
  )
    .bind(
      facts.city,
      facts.region,
      facts.country,
      facts.description,
      facts.population,
      facts.founded_year,
      facts.wiki_url,
    )
    .run();

  return loadCityFacts(env, key);
}

interface WikiSummary {
  extract?: string;
  extract_html?: string;
  content_urls?: { desktop?: { page?: string } };
}

async function fetchWikiSummary(title: string): Promise<WikiSummary | null> {
  try {
    const url = `${WIKI_BASE}${encodeURIComponent(title)}`;
    const res = await fetch(url, {
      headers: { "user-agent": USER_AGENT, accept: "application/json" },
    });
    if (!res.ok) return null;
    return (await res.json()) as WikiSummary;
  } catch {
    return null;
  }
}

/**
 * Wikipedia summaries are typically 2-4 paragraphs. We want the first
 * one for SEO blurb purposes.
 */
export function trimToParagraph(extract: string): string {
  const trimmed = extract.trim();
  // Wikipedia returns this with literal "\n\n" — first para ends at
  // the first blank line or first sentence end past ~400 chars.
  const idx = trimmed.indexOf("\n\n");
  if (idx > 0) return trimmed.slice(0, idx).trim();
  // No paragraph break — cap at ~800 chars at a sentence boundary.
  if (trimmed.length <= 800) return trimmed;
  const dotIdx = trimmed.indexOf(".", 600);
  return (dotIdx > 0 ? trimmed.slice(0, dotIdx + 1) : trimmed.slice(0, 800)).trim();
}

/**
 * Extract a population number from a city extract. Wikipedia
 * extracts use phrases like "a population of 1,386,932" or
 * "population was 96,830". Best-effort — returns null on miss.
 *
 * Pure — exercised by unit tests.
 */
export function extractPopulation(extract: string): number | null {
  // Grab the largest of the "population (was|of|reached) <number>"
  // matches — handles "population in 2020 was X" / "X residents".
  const re = /population[^.]{0,60}?([\d,]{4,12})/gi;
  let m = re.exec(extract);
  let max = 0;
  while (m) {
    const n = Number.parseInt((m[1] ?? "").replace(/,/g, ""), 10);
    if (Number.isFinite(n) && n > max) max = n;
    m = re.exec(extract);
  }
  return max > 0 ? max : null;
}

/**
 * Extract a "founded in <year>" or "incorporated in <year>" year.
 * Pure — exercised by unit tests.
 */
export function extractFoundedYear(extract: string): number | null {
  const patterns = [
    /(?:founded|incorporated|established)\s+(?:in\s+)?(\d{4})/i,
    /chartered\s+(?:in\s+)?(\d{4})/i,
  ];
  for (const re of patterns) {
    const m = re.exec(extract);
    if (m) {
      const y = Number.parseInt(m[1] ?? "", 10);
      if (Number.isFinite(y) && y > 1500 && y <= new Date().getFullYear()) return y;
    }
  }
  return null;
}

/* ─── Bulk enrichment job ─── */

/**
 * For every unique (city, state, country) in the rows, fetch+cache
 * city facts and stamp the data into each row as scalar fields
 * (`city_description`, `city_population`, `city_founded_year`).
 *
 * Run via `ctx.waitUntil` — must not throw. On per-city errors we
 * just skip that city.
 */
export async function runCityEnrichmentJob(env: AppEnv, dataSourceId: number): Promise<void> {
  try {
    const ds = await env.CONFIG_DB.prepare(
      "SELECT rows, columns FROM site_data_sources WHERE id = ?",
    )
      .bind(dataSourceId)
      .first<{ rows: string; columns: string }>();
    if (!ds) return;
    let rows: Array<Record<string, string>>;
    try {
      rows = JSON.parse(ds.rows);
    } catch {
      return;
    }

    // De-dupe city keys so we hit Wikipedia once per (city, region, country).
    const keys = new Map<string, CityKey>();
    for (const row of rows) {
      const city = (row.city ?? "").trim();
      const region = (row.state ?? row.region ?? "").trim();
      const country = (row.country ?? "").trim() || "United States";
      if (!city) continue;
      const k = `${city}|${region}|${country}`;
      if (!keys.has(k)) keys.set(k, { city, region, country });
    }

    const factsByKey = new Map<string, CityFactsRow | null>();
    for (const [k, key] of keys.entries()) {
      const facts = await fetchAndCacheCityFacts(env, key);
      factsByKey.set(k, facts);
    }

    // Stamp into rows.
    for (const row of rows) {
      const city = (row.city ?? "").trim();
      if (!city) continue;
      const region = (row.state ?? row.region ?? "").trim();
      const country = (row.country ?? "").trim() || "United States";
      const facts = factsByKey.get(`${city}|${region}|${country}`);
      if (!facts) continue;
      row.city_description = facts.description;
      row.city_population = facts.population != null ? facts.population.toString() : "";
      row.city_founded_year = facts.founded_year != null ? facts.founded_year.toString() : "";
      row.city_wiki_url = facts.wiki_url;
    }

    // Update columns to advertise the new fields.
    let cols: string[];
    try {
      cols = JSON.parse(ds.columns);
    } catch {
      cols = [];
    }
    const colSet = new Set([
      ...cols,
      "city_description",
      "city_population",
      "city_founded_year",
      "city_wiki_url",
    ]);

    await env.CONFIG_DB.prepare(
      `UPDATE site_data_sources
         SET rows = ?,
             columns = ?,
             updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
    )
      .bind(JSON.stringify(rows), JSON.stringify(Array.from(colSet)), dataSourceId)
      .run();
  } catch {
    // best-effort
  }
}

/* ─── POST handler ─── */

export async function handleCityEnrichmentPost(
  request: Request,
  _env: AppEnv,
  url: URL,
  _user: User,
  ds: SiteDataSourceRow,
): Promise<{ redirect: Response; job?: { dataSourceId: number } }> {
  const csrf = checkCsrf(request, url);
  if (csrf) return { redirect: csrf };

  let rows: Array<Record<string, string>>;
  try {
    rows = JSON.parse(ds.rows);
  } catch {
    return {
      redirect: flashRedirect(`/app/data-sources/${ds.id}/edit`, {
        text: "Data source rows are invalid JSON.",
        kind: "err",
      }),
    };
  }

  const uniqueCities = new Set<string>();
  for (const row of rows) {
    if (row.city && row.city.trim().length > 0) {
      uniqueCities.add(
        `${row.city.trim()}|${(row.state ?? "").trim()}|${(row.country ?? "").trim()}`,
      );
    }
  }
  if (uniqueCities.size === 0) {
    return {
      redirect: flashRedirect(`/app/data-sources/${ds.id}/edit`, {
        text: "No `city` field in any row — enrichment needs a `city` column.",
        kind: "warn",
      }),
    };
  }

  return {
    redirect: flashRedirect(`/app/data-sources/${ds.id}/edit`, {
      text: `City enrichment started — ${uniqueCities.size} unique cit${uniqueCities.size === 1 ? "y" : "ies"} (free, ~1 min).`,
      kind: "ok",
    }),
    job: { dataSourceId: ds.id },
  };
}
