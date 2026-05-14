/**
 * Phase B — auto-populate a `site_data_sources` row by scraping
 * DataForSEO Google Maps for a (keyword × locations) cross-product.
 *
 * Flow:
 *   1. Operator hits /app/data-sources/new-scrape with keyword +
 *      locations (one per line) + max-per-location.
 *   2. We fetch the Maps SERP for each (keyword, location) in
 *      sequence and flatten into a single `rows` array.
 *   3. Preview page shows the rows; operator picks a name + confirms.
 *   4. Stored as a `dataforseo_business_listings` data source with
 *      `source_config` preserving the scrape params for re-scrape.
 *
 * Re-scrape replaces `rows` + `columns` in place. The data source's
 * existing `id` and any downstream `generated_pages` references stay
 * intact, so the operator can re-render templates against fresh data.
 *
 * Cost: every (keyword × location) costs one DataForSEO task
 * (~$0.003 at current pricing). We surface the call count in the
 * preview so the operator can decide before confirming.
 */

import type { AppEnv, FlashMessage } from "./app.js";
import { esc } from "./app.js";
import type { User } from "./auth.js";
import {
  BUSINESS_LISTING_COLUMNS,
  BUSINESS_LISTING_MAX_DEPTH,
  type BusinessListingRow,
  DataForSeoApiError,
  DataForSeoConfigError,
  fetchBusinessListings,
} from "./dataforseo.js";
import { type SiteDataSourceRow, checkCsrf, flashRedirect } from "./site-templates.js";

const MAX_LOCATIONS_PER_SCRAPE = 25;
const MAX_KEYWORD_LENGTH = 200;
const MAX_LOCATION_LENGTH = 200;

/* ─── Scrape config ─── */

export interface ScrapeConfig {
  keyword: string;
  /** Free-form location names, one per scrape task. */
  locations: string[];
  /** Max businesses per (keyword × location). 1..20. */
  depth: number;
  /** Language code (e.g. "en"). */
  language_code: string;
}

export interface ScrapeFormPrefill {
  name: string;
  keyword: string;
  locations: string;
  depth: number;
  language_code: string;
}

export function defaultScrapeFormPrefill(): ScrapeFormPrefill {
  return {
    name: "",
    keyword: "",
    locations: "",
    depth: 10,
    language_code: "en",
  };
}

/**
 * Validate the scrape config form. Returns the parsed config + name on
 * success, or a flat error list on failure.
 */
export function validateScrapeForm(
  raw: Record<string, string>,
):
  | { ok: true; name: string; config: ScrapeConfig }
  | { ok: false; errors: string[]; prefill: ScrapeFormPrefill } {
  const errors: string[] = [];
  const prefill: ScrapeFormPrefill = {
    name: (raw.name ?? "").trim(),
    keyword: (raw.keyword ?? "").trim(),
    locations: raw.locations ?? "",
    depth: Number.parseInt((raw.depth ?? "10").trim(), 10),
    language_code: (raw.language_code ?? "en").trim(),
  };

  if (!prefill.name) errors.push("name is required");
  if (prefill.name.length > 200) errors.push("name must be ≤ 200 chars");

  if (!prefill.keyword) errors.push("keyword is required");
  if (prefill.keyword.length > MAX_KEYWORD_LENGTH) {
    errors.push(`keyword must be ≤ ${MAX_KEYWORD_LENGTH} chars`);
  }

  const locations = (raw.locations ?? "")
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (locations.length === 0) {
    errors.push("locations: enter at least one location (one per line)");
  } else if (locations.length > MAX_LOCATIONS_PER_SCRAPE) {
    errors.push(`locations: max ${MAX_LOCATIONS_PER_SCRAPE} per scrape (got ${locations.length})`);
  }
  for (const loc of locations) {
    if (loc.length > MAX_LOCATION_LENGTH) {
      errors.push(`location too long (>${MAX_LOCATION_LENGTH} chars): ${loc.slice(0, 40)}…`);
      break;
    }
  }

  const depth = Number.isFinite(prefill.depth) ? prefill.depth : Number.NaN;
  if (!Number.isFinite(depth) || depth < 1 || depth > BUSINESS_LISTING_MAX_DEPTH) {
    errors.push(`depth must be 1..${BUSINESS_LISTING_MAX_DEPTH}`);
  }

  const language = prefill.language_code || "en";
  if (!/^[a-z]{2}$/.test(language)) {
    errors.push("language_code must be a 2-letter ISO code (e.g. en, es)");
  }

  if (errors.length > 0) return { ok: false, errors, prefill };
  return {
    ok: true,
    name: prefill.name,
    config: {
      keyword: prefill.keyword,
      locations,
      depth,
      language_code: language,
    },
  };
}

/* ─── Scrape execution ─── */

export interface ScrapeResult {
  rows: BusinessListingRow[];
  /** Per-location status — surfaced in preview so partial failures are visible. */
  perLocation: Array<{
    location: string;
    rows_returned: number;
    error: string | null;
  }>;
  total_tasks: number;
}

/**
 * Run the scrape sequentially. Sequential not parallel so:
 *   - partial failures don't waste budget (we can abort on auth error)
 *   - operators see progress when we add streaming later
 *   - we stay under DataForSEO rate limits without juggling semaphores
 *
 * On a fatal credentials error we abort the whole scrape and surface
 * the message. On a per-location API error we record it and move on.
 */
export async function runScrape(env: AppEnv, config: ScrapeConfig): Promise<ScrapeResult> {
  const allRows: BusinessListingRow[] = [];
  const perLocation: ScrapeResult["perLocation"] = [];
  for (const location of config.locations) {
    try {
      const rows = await fetchBusinessListings(env, {
        keyword: config.keyword,
        location_name: location,
        language_code: config.language_code,
        depth: config.depth,
      });
      allRows.push(...rows);
      perLocation.push({ location, rows_returned: rows.length, error: null });
    } catch (e) {
      if (e instanceof DataForSeoConfigError) {
        // Credentials / input issue — re-throw so the caller bails out.
        throw e;
      }
      const msg =
        e instanceof DataForSeoApiError
          ? `HTTP ${e.statusCode}: ${e.message}`
          : e instanceof Error
            ? e.message
            : String(e);
      perLocation.push({ location, rows_returned: 0, error: msg });
    }
  }
  return { rows: allRows, perLocation, total_tasks: config.locations.length };
}

/* ─── Persist + re-scrape ─── */

/**
 * Persist a scrape result as a new `site_data_sources` row. Stores the
 * scrape config in `source_config` so we can re-run the same query
 * later from the edit page.
 */
export async function persistScrapeResult(
  env: AppEnv,
  user: User,
  name: string,
  config: ScrapeConfig,
  result: ScrapeResult,
): Promise<number> {
  const columns = JSON.stringify(BUSINESS_LISTING_COLUMNS);
  const rows = JSON.stringify(result.rows);
  const sourceConfig = JSON.stringify(config);
  const r = await env.CONFIG_DB.prepare(
    `INSERT INTO site_data_sources
       (owner_id, name, source_kind, columns, rows, source_config)
     VALUES (?, ?, 'dataforseo_business_listings', ?, ?, ?)
     RETURNING id`,
  )
    .bind(user.id, name, columns, rows, sourceConfig)
    .first<{ id: number }>();
  if (!r) throw new Error("Insert returned no row");
  return r.id;
}

export function parseStoredConfig(json: string | null): ScrapeConfig | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json) as Record<string, unknown>;
    const keyword = typeof parsed.keyword === "string" ? parsed.keyword : "";
    const locations = Array.isArray(parsed.locations)
      ? parsed.locations.filter((s): s is string => typeof s === "string")
      : [];
    const depth = typeof parsed.depth === "number" ? parsed.depth : 10;
    const language_code = typeof parsed.language_code === "string" ? parsed.language_code : "en";
    if (!keyword || locations.length === 0) return null;
    return { keyword, locations, depth, language_code };
  } catch {
    return null;
  }
}

/* ─── UI ─── */

export function renderScrapeForm(opts: {
  prefill: ScrapeFormPrefill;
  errors: string[];
}): string {
  const errBox =
    opts.errors.length > 0 ? `<div class="error-box">${opts.errors.map(esc).join("\n")}</div>` : "";
  const taskCount = opts.prefill.locations.split(/\r?\n/).filter((s) => s.trim().length > 0).length;
  return `<div class="tmpl-page">
    <div class="crumbs"><a href="/app/data-sources">← Data sources</a></div>
    <h1>Scrape Google Maps → data source</h1>
    <p class="subtitle">Searches Google Maps for <code>keyword</code> in each location, then flattens the businesses into a data source. One DataForSEO task per location (≈ \$0.003 each).</p>
    ${errBox}
    <form class="editor" method="POST" action="/app/data-sources/new-scrape/preview">
      <div class="form-section">
        <label for="sc_name">data source name</label>
        <input id="sc_name" name="name" type="text" required value="${esc(opts.prefill.name)}" placeholder="San Diego pool builders — Maps scrape">
      </div>
      <div class="form-section">
        <label for="sc_keyword">keyword</label>
        <input id="sc_keyword" name="keyword" type="text" required value="${esc(opts.prefill.keyword)}" placeholder="pool builders">
      </div>
      <div class="form-section">
        <label for="sc_locations">locations (one per line)</label>
        <textarea id="sc_locations" name="locations" rows="8" required placeholder="San Diego,California,United States&#10;La Jolla,California,United States&#10;Chula Vista,California,United States" style="font-family:var(--mono);font-size:.85rem;width:100%">${esc(opts.prefill.locations)}</textarea>
        <div class="field-hint">DataForSEO geocodes each line. ${taskCount > 0 ? `<strong>${taskCount}</strong> task${taskCount === 1 ? "" : "s"} will run` : 'Format: "City,Region,Country"'}. Max ${MAX_LOCATIONS_PER_SCRAPE}.</div>
      </div>
      <div class="form-section">
        <label for="sc_depth">businesses per location (1–${BUSINESS_LISTING_MAX_DEPTH})</label>
        <input id="sc_depth" name="depth" type="number" min="1" max="${BUSINESS_LISTING_MAX_DEPTH}" required value="${opts.prefill.depth}">
      </div>
      <div class="form-section">
        <label for="sc_lang">language code</label>
        <input id="sc_lang" name="language_code" type="text" required value="${esc(opts.prefill.language_code)}" style="width:6rem" maxlength="2">
      </div>
      <div class="form-actions">
        <button class="btn btn-primary" type="submit">Run scrape →</button>
        <a class="btn" href="/app/data-sources">Cancel</a>
      </div>
    </form>
  </div>`;
}

export function renderScrapePreview(opts: {
  name: string;
  config: ScrapeConfig;
  result: ScrapeResult;
}): string {
  const perLoc = opts.result.perLocation
    .map((p) => {
      const errChip = p.error
        ? `<span class="result-pill result-error" title="${esc(p.error)}">error</span>`
        : `<span class="result-pill result-created">${p.rows_returned}</span>`;
      return `<tr>
        <td class="mono" style="font-size:.85rem">${esc(p.location)}</td>
        <td>${errChip}</td>
        <td style="font-size:.8rem;color:var(--fg-muted)">${esc(p.error ?? "")}</td>
      </tr>`;
    })
    .join("");
  const tbody = opts.result.rows
    .slice(0, 100)
    .map(
      (r) => `<tr>
      <td class="num">${esc(r.position)}</td>
      <td>${esc(r.title)}</td>
      <td style="font-size:.8rem">${esc(r.address)}</td>
      <td>${esc(r.phone)}</td>
      <td>${esc(r.rating)} ${r.rating_count ? `<span style="color:var(--fg-muted);font-size:.78rem">(${esc(r.rating_count)})</span>` : ""}</td>
      <td style="font-size:.78rem;color:var(--fg-muted)">${esc(r.website)}</td>
    </tr>`,
    )
    .join("");
  const more =
    opts.result.rows.length > 100
      ? `<p style="color:var(--fg-muted);font-size:.85rem">… and ${opts.result.rows.length - 100} more rows (full set saves on confirm).</p>`
      : "";

  const configJson = JSON.stringify(opts.config);
  return `<div class="tmpl-page">
    <div class="crumbs"><a href="/app/data-sources/new-scrape">← Scrape config</a></div>
    <h1>Preview — ${esc(opts.name)}</h1>
    <p class="subtitle">Keyword: <code>${esc(opts.config.keyword)}</code> · ${opts.result.total_tasks} task${opts.result.total_tasks === 1 ? "" : "s"} · <strong>${opts.result.rows.length}</strong> business${opts.result.rows.length === 1 ? "" : "es"} returned</p>
    <h3 style="margin-top:1.25rem">Per-location summary</h3>
    <table class="data">
      <thead><tr><th>Location</th><th>Rows</th><th>Error</th></tr></thead>
      <tbody>${perLoc}</tbody>
    </table>
    <h3 style="margin-top:1.25rem">Sample rows ${opts.result.rows.length > 100 ? "(first 100)" : ""}</h3>
    <table class="data">
      <thead><tr><th class="num">#</th><th>Title</th><th>Address</th><th>Phone</th><th>Rating</th><th>Website</th></tr></thead>
      <tbody>${tbody}</tbody>
    </table>
    ${more}
    <form method="POST" action="/app/data-sources/new-scrape/confirm" style="margin-top:1.25rem">
      <input type="hidden" name="name" value="${esc(opts.name)}">
      <input type="hidden" name="config" value='${esc(configJson)}'>
      <input type="hidden" name="rows_json" value='${esc(JSON.stringify(opts.result.rows))}'>
      <div class="form-actions">
        <button class="btn btn-primary" type="submit"${opts.result.rows.length === 0 ? " disabled" : ""}>Save as data source</button>
        <a class="btn" href="/app/data-sources/new-scrape">← Back</a>
      </div>
    </form>
  </div>`;
}

/* ─── POST handlers ─── */

export async function handleScrapePreviewPost(
  request: Request,
  env: AppEnv,
  url: URL,
  _user: User,
): Promise<
  | { response: Response }
  | {
      preview: { name: string; config: ScrapeConfig; result: ScrapeResult };
    }
  | { errors: string[]; prefill: ScrapeFormPrefill }
> {
  const csrf = checkCsrf(request, url);
  if (csrf) return { response: csrf };
  const form = await request.formData();
  const raw: Record<string, string> = {};
  for (const [k, v] of form.entries()) {
    if (typeof v === "string") raw[k] = v;
  }
  const validated = validateScrapeForm(raw);
  if (!validated.ok) return { errors: validated.errors, prefill: validated.prefill };

  let result: ScrapeResult;
  try {
    result = await runScrape(env, validated.config);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      errors: [msg],
      prefill: {
        name: validated.name,
        keyword: validated.config.keyword,
        locations: validated.config.locations.join("\n"),
        depth: validated.config.depth,
        language_code: validated.config.language_code,
      },
    };
  }
  return { preview: { name: validated.name, config: validated.config, result } };
}

export async function handleScrapeConfirmPost(
  request: Request,
  env: AppEnv,
  url: URL,
  user: User,
): Promise<Response> {
  const csrf = checkCsrf(request, url);
  if (csrf) return csrf;
  const form = await request.formData();
  const name = String(form.get("name") ?? "").trim();
  const configRaw = String(form.get("config") ?? "");
  const rowsRaw = String(form.get("rows_json") ?? "");
  if (!name || !configRaw || !rowsRaw) {
    return flashRedirect("/app/data-sources/new-scrape", {
      text: "Missing required fields — start over.",
      kind: "err",
    });
  }
  let config: ScrapeConfig;
  let rows: BusinessListingRow[];
  try {
    config = JSON.parse(configRaw) as ScrapeConfig;
    rows = JSON.parse(rowsRaw) as BusinessListingRow[];
  } catch {
    return flashRedirect("/app/data-sources/new-scrape", {
      text: "Could not parse hidden scrape payload — retry.",
      kind: "err",
    });
  }
  try {
    await persistScrapeResult(env, user, name, config, { rows, perLocation: [], total_tasks: 0 });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const friendly =
      msg.includes("UNIQUE") && msg.includes("name")
        ? `Data source named "${name}" already exists.`
        : `DB error: ${msg}`;
    return flashRedirect("/app/data-sources/new-scrape", { text: friendly, kind: "err" });
  }
  return flashRedirect("/app/data-sources", {
    text: `Saved "${name}" (${rows.length} rows).`,
    kind: "ok",
  } satisfies FlashMessage);
}

export async function handleRescrapePost(
  request: Request,
  env: AppEnv,
  url: URL,
  _user: User,
  ds: SiteDataSourceRow,
): Promise<Response> {
  const csrf = checkCsrf(request, url);
  if (csrf) return csrf;
  if (ds.source_kind !== "dataforseo_business_listings") {
    return flashRedirect(`/app/data-sources/${ds.id}/edit`, {
      text: "Re-scrape only works on Maps-scraped data sources.",
      kind: "err",
    });
  }
  const config = parseStoredConfig(ds.source_config);
  if (!config) {
    return flashRedirect(`/app/data-sources/${ds.id}/edit`, {
      text: "No scrape config stored on this data source.",
      kind: "err",
    });
  }
  let result: ScrapeResult;
  try {
    result = await runScrape(env, config);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return flashRedirect(`/app/data-sources/${ds.id}/edit`, { text: msg, kind: "err" });
  }
  const columns = JSON.stringify(BUSINESS_LISTING_COLUMNS);
  const rows = JSON.stringify(result.rows);
  await env.CONFIG_DB.prepare(
    "UPDATE site_data_sources SET columns=?, rows=?, updated_at=CURRENT_TIMESTAMP WHERE id=?",
  )
    .bind(columns, rows, ds.id)
    .run();
  return flashRedirect(`/app/data-sources/${ds.id}/edit`, {
    text: `Re-scraped (${result.rows.length} rows).`,
    kind: "ok",
  });
}
