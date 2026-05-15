/**
 * Phase B — auto-populate a `site_data_sources` row by scraping
 * DataForSEO Google Maps for a (keyword × locations) cross-product.
 *
 * v2 (async): scrapes can be long (25 locations × ~3s ≈ 75s). v1 ran
 * the whole batch inline in the POST handler, which blocked the
 * operator's browser and lost the work if they navigated away. v2
 * splits the flow so:
 *
 *   1. POST /new-scrape/start validates + creates the data source row
 *      with `scrape_status='running'`, empty `rows`, and a known
 *      `scrape_progress_total` (= location count). Redirects
 *      immediately to the data source detail page.
 *
 *   2. `ctx.waitUntil(runScrapeJob(...))` runs the actual scrape after
 *      the response is sent. After each location it updates
 *      `scrape_progress_done`, appends rows, and bumps
 *      `scrape_progress_updated_at` as a heartbeat.
 *
 *   3. Detail page meta-refreshes every 2 seconds while
 *      `scrape_status='running'` and renders a progress bar. Operator
 *      can navigate away and come back — state survives in D1.
 *
 *   4. On completion the row is set to `done` (or `error` with a
 *      message). Heartbeat older than 2 minutes while status='running'
 *      is treated as "stuck" — UI offers a retry.
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
  type ReviewItem,
  fetchBusinessListings,
  fetchReviews,
} from "./dataforseo.js";
import { LOCATION_PACKS } from "./location-packs.js";
import { type SiteDataSourceRow, checkCsrf, flashRedirect } from "./site-templates.js";

const MAX_LOCATIONS_PER_SCRAPE = 25;
const MAX_KEYWORD_LENGTH = 200;
const MAX_LOCATION_LENGTH = 200;
/** Older than this while status=running ⇒ treat as stuck. */
export const STUCK_HEARTBEAT_MS = 2 * 60 * 1000;

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

/* ─── Async job execution ─── */

export interface PerLocationStatus {
  location: string;
  rows_returned: number;
  error: string | null;
}

/**
 * Run a scrape job against an EXISTING data source row. Updates the row
 * after each location (rows, progress, heartbeat). Sets terminal status
 * (`done` or `error`) on exit.
 *
 * This is meant to be invoked via `ctx.waitUntil(runScrapeJob(...))` so
 * the operator's POST returns immediately. The function MUST NOT throw
 * — any errors are written into `scrape_error` + `scrape_status='error'`.
 */
export async function runScrapeJob(
  env: AppEnv,
  dataSourceId: number,
  config: ScrapeConfig,
): Promise<void> {
  const allRows: BusinessListingRow[] = [];
  const perLocation: PerLocationStatus[] = [];
  try {
    for (let i = 0; i < config.locations.length; i++) {
      const location = config.locations[i];
      if (!location) continue;
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
          // Credentials / fatal input — abort the whole job.
          await markJobError(env, dataSourceId, e.message);
          return;
        }
        const msg =
          e instanceof DataForSeoApiError
            ? `HTTP ${e.statusCode}: ${e.message}`
            : e instanceof Error
              ? e.message
              : String(e);
        perLocation.push({ location, rows_returned: 0, error: msg });
      }
      // Persist progress after every location so the UI can show the
      // operator how far we've gotten — and so a worker death after
      // this point preserves the partial result.
      await env.CONFIG_DB.prepare(
        `UPDATE site_data_sources
           SET rows = ?,
               scrape_progress_done = ?,
               scrape_per_location = ?,
               scrape_progress_updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now'),
               updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
      )
        .bind(JSON.stringify(allRows), i + 1, JSON.stringify(perLocation), dataSourceId)
        .run();
    }
    // Final flip to `done` happens in a separate statement so
    // intermediate updates don't accidentally mark the job complete
    // mid-loop.
    await env.CONFIG_DB.prepare(
      `UPDATE site_data_sources
         SET scrape_status = 'done',
             scrape_progress_updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now'),
             updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
    )
      .bind(dataSourceId)
      .run();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await markJobError(env, dataSourceId, msg);
  }
}

async function markJobError(env: AppEnv, dataSourceId: number, message: string): Promise<void> {
  try {
    await env.CONFIG_DB.prepare(
      `UPDATE site_data_sources
         SET scrape_status = 'error',
             scrape_error = ?,
             scrape_progress_updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now'),
             updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
    )
      .bind(message, dataSourceId)
      .run();
  } catch {
    // Best-effort — the operator will see "stuck running" via the
    // heartbeat-stale UI path if even the error-write fails.
  }
}

/**
 * Create the data source row + queue the background scrape job.
 * Returns the new id so the route handler can redirect to the detail
 * page. Throws on unique-name conflict so the caller can surface a
 * friendly error.
 */
export async function startScrapeJob(
  env: AppEnv,
  user: User,
  name: string,
  config: ScrapeConfig,
): Promise<number> {
  const r = await env.CONFIG_DB.prepare(
    `INSERT INTO site_data_sources
       (owner_id, name, source_kind, columns, rows, source_config,
        scrape_status, scrape_progress_total, scrape_progress_done,
        scrape_progress_updated_at, scrape_per_location)
     VALUES (?, ?, 'dataforseo_business_listings', ?, '[]', ?,
             'running', ?, 0, strftime('%Y-%m-%dT%H:%M:%SZ','now'), '[]')
     RETURNING id`,
  )
    .bind(
      user.id,
      name,
      JSON.stringify(BUSINESS_LISTING_COLUMNS),
      JSON.stringify(config),
      config.locations.length,
    )
    .first<{ id: number }>();
  if (!r) throw new Error("Insert returned no row");
  return r.id;
}

/**
 * Reset an existing data source for re-scrape: zero progress, switch
 * back to `running`, then return so the caller can `ctx.waitUntil` the
 * job. Used for both re-scrape and stuck-job retry.
 */
export async function resetForRescrape(
  env: AppEnv,
  dataSourceId: number,
  config: ScrapeConfig,
): Promise<void> {
  await env.CONFIG_DB.prepare(
    `UPDATE site_data_sources
       SET scrape_status = 'running',
           scrape_progress_total = ?,
           scrape_progress_done = 0,
           scrape_progress_updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now'),
           scrape_per_location = '[]',
           scrape_error = NULL,
           rows = '[]',
           updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
  )
    .bind(config.locations.length, dataSourceId)
    .run();
}

/**
 * Whether a row with `scrape_status='running'` has gone silent past
 * the stuck threshold. Pure — exercised by unit tests.
 */
export function isStuck(
  status: string,
  progressUpdatedAt: string | null,
  nowMs: number = Date.now(),
): boolean {
  if (status !== "running") return false;
  if (!progressUpdatedAt) return false;
  const t = Date.parse(progressUpdatedAt);
  if (!Number.isFinite(t)) return false;
  return nowMs - t > STUCK_HEARTBEAT_MS;
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
    <p class="subtitle">Each location is one DataForSEO task (≈ \$0.003). The scrape runs in the background — you can navigate away and come back to check progress.</p>
    ${errBox}
    <form class="editor" method="POST" action="/app/data-sources/new-scrape/start">
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
        <div style="display:flex;flex-wrap:wrap;gap:.4rem;margin:.25rem 0 .55rem">
          ${LOCATION_PACKS.map(
            (p) =>
              `<button type="button" class="btn" data-pack="${esc(p.id)}" data-pack-locations="${esc(p.locations.join("\n"))}" style="font-size:.82rem;padding:.3rem .7rem">+ ${esc(p.label)}</button>`,
          ).join("")}
          <button type="button" class="btn" data-pack-clear="1" style="font-size:.82rem;padding:.3rem .7rem;opacity:.8">Clear</button>
        </div>
        <textarea id="sc_locations" name="locations" rows="8" required placeholder="San Diego,California,United States&#10;La Jolla,California,United States&#10;Chula Vista,California,United States" style="font-family:var(--mono);font-size:.85rem;width:100%">${esc(opts.prefill.locations)}</textarea>
        <div class="field-hint">
          <strong>Format:</strong> <code>City,Region,Country</code> — DataForSEO only resolves <em>full</em> region + country names (e.g. <code>California</code>, not <code>CA</code>; <code>United States</code>, not <code>US</code>). Unresolved locations return 0 rows with a per-task error.<br>
          <span id="sc_task_count">${taskCount > 0 ? `<strong>${taskCount}</strong> task${taskCount === 1 ? "" : "s"} will run.` : ""}</span> Max ${MAX_LOCATIONS_PER_SCRAPE}.
        </div>
      </div>
      <script>
        (function(){
          var ta = document.getElementById('sc_locations');
          var counter = document.getElementById('sc_task_count');
          function recount(){
            if (!ta || !counter) return;
            var n = ta.value.split(/\\r?\\n/).filter(function(s){return s.trim().length>0}).length;
            counter.innerHTML = n > 0 ? '<strong>' + n + '</strong> task' + (n===1?'':'s') + ' will run.' : '';
          }
          function appendPack(packLines){
            if (!ta) return;
            var existing = ta.value.split(/\\r?\\n/).map(function(s){return s.trim()}).filter(function(s){return s.length>0});
            var seen = Object.create(null);
            existing.forEach(function(s){ seen[s] = true; });
            packLines.split(/\\r?\\n/).forEach(function(line){
              var t = line.trim();
              if (t && !seen[t]) { existing.push(t); seen[t] = true; }
            });
            ta.value = existing.join('\\n');
            recount();
          }
          document.querySelectorAll('[data-pack]').forEach(function(btn){
            btn.addEventListener('click', function(){
              appendPack(btn.getAttribute('data-pack-locations') || '');
            });
          });
          var clear = document.querySelector('[data-pack-clear]');
          if (clear) clear.addEventListener('click', function(){ if(ta){ ta.value=''; recount(); } });
          if (ta) ta.addEventListener('input', recount);
        })();
      </script>
      <div class="form-section">
        <label for="sc_depth">businesses per location (1–${BUSINESS_LISTING_MAX_DEPTH})</label>
        <input id="sc_depth" name="depth" type="number" min="1" max="${BUSINESS_LISTING_MAX_DEPTH}" required value="${opts.prefill.depth}">
      </div>
      <div class="form-section">
        <label for="sc_lang">language code</label>
        <input id="sc_lang" name="language_code" type="text" required value="${esc(opts.prefill.language_code)}" style="width:6rem" maxlength="2">
      </div>
      <div class="form-actions">
        <button class="btn btn-primary" type="submit">Start scrape →</button>
        <a class="btn" href="/app/data-sources">Cancel</a>
      </div>
    </form>
  </div>`;
}

const PROGRESS_CSS = `
.scrape-progress{background:var(--bg-elevated);border:1px solid var(--border);border-radius:var(--radius);padding:1rem 1.25rem;margin-bottom:1.25rem}
.scrape-progress .bar{position:relative;height:.55rem;background:var(--bg-code);border-radius:9999px;overflow:hidden;margin:.5rem 0 .75rem}
.scrape-progress .bar .fill{position:absolute;inset:0 auto 0 0;background:linear-gradient(90deg,var(--accent),var(--accent-hover));border-radius:9999px;transition:width .4s ease}
.scrape-progress .pct{font-variant-numeric:tabular-nums;color:var(--fg-muted);font-size:.85rem;margin-left:.4rem}
.scrape-progress .running-pulse{display:inline-block;width:.5rem;height:.5rem;background:var(--accent);border-radius:50%;animation:pulse 1.2s infinite;vertical-align:middle;margin-right:.4rem}
@keyframes pulse{0%,100%{opacity:.4}50%{opacity:1}}
.scrape-progress .loc-list{margin-top:.85rem;display:grid;gap:.25rem;font-family:var(--mono);font-size:.78rem}
.scrape-progress .loc-list .loc{display:flex;align-items:center;justify-content:space-between;padding:.3rem .55rem;background:var(--bg);border:1px solid var(--border);border-radius:var(--radius-sm)}
.scrape-progress .loc-list .loc.pending{opacity:.5}
.scrape-progress .loc-list .loc-err{color:var(--red)}
.scrape-progress .scrape-stuck{background:var(--amber-bg);color:var(--amber);border-color:color-mix(in srgb,var(--amber) 30%,transparent)}
`;

/**
 * Render the live scrape-progress block shown on a Maps-scraped data
 * source page while `scrape_status='running'` (or terminal states).
 * Called inside the data source edit page renderer.
 */
export function renderScrapeProgress(opts: {
  ds: SiteDataSourceRow;
  stuck: boolean;
}): string {
  const { ds, stuck } = opts;
  const perLoc = parsePerLocation(ds.scrape_per_location);
  const total = Math.max(1, ds.scrape_progress_total);
  const done = ds.scrape_progress_done;
  const pct = Math.min(100, Math.round((done / total) * 100));
  const config = parseStoredConfig(ds.source_config);
  const locationList = config?.locations ?? [];

  const statusChip = (() => {
    if (ds.scrape_status === "done") {
      return `<span class="result-pill result-created">done</span>`;
    }
    if (ds.scrape_status === "error") {
      return `<span class="result-pill result-error">error</span>`;
    }
    if (stuck) {
      return `<span class="result-pill result-skipped">stuck</span>`;
    }
    if (ds.scrape_status === "running") {
      return `<span class="running-pulse"></span><strong>scraping…</strong>`;
    }
    return "";
  })();

  const locRows = locationList
    .map((loc, i) => {
      const status = perLoc[i];
      if (status) {
        if (status.error) {
          return `<div class="loc loc-err"><span>${esc(loc)}</span><span title="${esc(status.error)}">error</span></div>`;
        }
        return `<div class="loc"><span>${esc(loc)}</span><span>${status.rows_returned} rows</span></div>`;
      }
      return `<div class="loc pending"><span>${esc(loc)}</span><span>pending</span></div>`;
    })
    .join("");

  const errorBlock = ds.scrape_error ? `<div class="error-box">${esc(ds.scrape_error)}</div>` : "";

  const stuckBlock = stuck
    ? `<form method="POST" action="/app/data-sources/${ds.id}/rescrape" style="margin-top:.5rem">
        <div class="scrape-stuck" style="border:1px solid;border-radius:var(--radius);padding:.65rem .9rem;display:flex;align-items:center;justify-content:space-between;gap:.8rem">
          <div>Heartbeat stale (no update for &gt; 2 min). The worker likely died — retry to start fresh.</div>
          <button class="btn btn-primary" type="submit">Retry →</button>
        </div>
      </form>`
    : "";

  return `<style>${PROGRESS_CSS}</style><div class="scrape-progress">
    <div style="display:flex;align-items:center;justify-content:space-between;gap:1rem">
      <div>
        <strong>Scrape progress</strong> ${statusChip}
        <div style="color:var(--fg-muted);font-size:.85rem">${done} / ${ds.scrape_progress_total} location${ds.scrape_progress_total === 1 ? "" : "s"} · ${countRows(ds.rows)} business${countRows(ds.rows) === 1 ? "" : "es"} so far</div>
      </div>
      ${
        ds.scrape_status === "done" || ds.scrape_status === "error"
          ? `<form method="POST" action="/app/data-sources/${ds.id}/rescrape" style="margin:0"><button class="btn" type="submit">Re-scrape →</button></form>`
          : ""
      }
    </div>
    <div class="bar"><div class="fill" style="width:${pct}%"></div></div>
    <div class="pct">${pct}%</div>
    ${errorBlock}
    ${stuckBlock}
    <div class="loc-list">${locRows}</div>
    ${renderReviewsBlock(ds)}
    ${renderCityEnrichmentBlock(ds)}
  </div>`;
}

/**
 * Free Wikipedia-powered city enrichment. Idempotent — re-running
 * just refreshes the cache. Visible only after listings scrape is
 * done (otherwise there's no city data to enrich).
 */
function renderCityEnrichmentBlock(ds: SiteDataSourceRow): string {
  if (ds.source_kind !== "dataforseo_business_listings") return "";
  if (ds.scrape_status !== "done") return "";

  return `<form method="POST" action="/app/data-sources/${ds.id}/enrich-cities" style="margin-top:1rem">
    <div style="background:var(--bg-elevated);border:1px solid var(--border);border-radius:var(--radius);padding:.85rem 1rem;display:flex;align-items:center;justify-content:space-between;gap:.8rem">
      <div>
        <strong>+ Enrich cities (Wikipedia)</strong>
        <div style="color:var(--fg-muted);font-size:.85rem">Adds <code>city_description</code>, <code>city_population</code>, <code>city_founded_year</code> per row. Free, ~1 min for 20 cities. Cached for 30 days.</div>
      </div>
      <button class="btn" type="submit">Enrich cities →</button>
    </div>
  </form>`;
}

/**
 * Reviews-scrape block shown below the listings progress. Only renders
 * for `dataforseo_business_listings` sources, and only once the
 * listings scrape has produced data.
 */
function renderReviewsBlock(ds: SiteDataSourceRow): string {
  if (ds.source_kind !== "dataforseo_business_listings") return "";
  if (ds.scrape_status !== "done") return "";

  const status = ds.reviews_status;
  const rowsCount = countRows(ds.rows);
  // Eligible = rows with a place_id. Without parsing the JSON twice
  // here, we use progress_total when running and rowsCount as a hint.
  const reviewsDone = ds.reviews_progress_done;
  const reviewsTotal = Math.max(1, ds.reviews_progress_total);
  const reviewsPct = Math.min(100, Math.round((reviewsDone / reviewsTotal) * 100));
  const errorBlock = ds.reviews_error
    ? `<div class="error-box" style="margin-top:.5rem">${esc(ds.reviews_error)}</div>`
    : "";

  if (status === "none") {
    return `<form method="POST" action="/app/data-sources/${ds.id}/reviews/start" style="margin-top:1rem">
      <div style="background:var(--bg-elevated);border:1px solid var(--border);border-radius:var(--radius);padding:.85rem 1rem;display:flex;align-items:center;justify-content:space-between;gap:.8rem">
        <div>
          <strong>+ Fetch customer reviews</strong>
          <div style="color:var(--fg-muted);font-size:.85rem">Up to 5 newest reviews per business via DataForSEO Reviews API (~\$0.003 each). ${rowsCount} business${rowsCount === 1 ? "" : "es"} eligible.</div>
        </div>
        <button class="btn btn-primary" type="submit">Start reviews scrape →</button>
      </div>
    </form>`;
  }

  const chip =
    status === "done"
      ? `<span class="result-pill result-created">done</span>`
      : status === "error"
        ? `<span class="result-pill result-error">error</span>`
        : `<span class="running-pulse"></span><strong>fetching reviews…</strong>`;

  return `<div style="margin-top:1rem;padding-top:1rem;border-top:1px dashed var(--border)">
    <div style="display:flex;align-items:center;justify-content:space-between;gap:1rem">
      <div>
        <strong>Reviews scrape</strong> ${chip}
        <div style="color:var(--fg-muted);font-size:.85rem">${reviewsDone} / ${ds.reviews_progress_total} business${ds.reviews_progress_total === 1 ? "" : "es"}</div>
      </div>
      ${
        status === "done" || status === "error"
          ? `<form method="POST" action="/app/data-sources/${ds.id}/reviews/start" style="margin:0"><button class="btn" type="submit">Re-fetch reviews →</button></form>`
          : ""
      }
    </div>
    <div class="bar"><div class="fill" style="width:${reviewsPct}%"></div></div>
    <div class="pct">${reviewsPct}%</div>
    ${errorBlock}
  </div>`;
}

/** Refresh meta tag — emitted only while scrape is live. */
export function scrapeAutoRefreshHeader(ds: SiteDataSourceRow, stuck: boolean): string {
  if (ds.scrape_status === "running" && !stuck) {
    return `<meta http-equiv="refresh" content="2">`;
  }
  if (ds.reviews_status === "running") {
    return `<meta http-equiv="refresh" content="2">`;
  }
  return "";
}

function parsePerLocation(json: string): PerLocationStatus[] {
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? (parsed as PerLocationStatus[]) : [];
  } catch {
    return [];
  }
}

function countRows(json: string): number {
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.length : 0;
  } catch {
    return 0;
  }
}

/* ─── POST handlers ─── */

/**
 * Validate the scrape form, create the data source row in `running`
 * state, and kick off the background job. Returns either a redirect
 * Response (success or CSRF) or rerender data.
 *
 * The caller (route handler in index.ts) is responsible for invoking
 * `ctx.waitUntil(runScrapeJob(...))` after this returns success —
 * we can't call ctx from here since handlers don't get the
 * ExecutionContext.
 */
export interface StartScrapeOutcome {
  redirect?: Response;
  errors?: string[];
  prefill?: ScrapeFormPrefill;
  /** Set on success — caller schedules the job. */
  job?: { dataSourceId: number; config: ScrapeConfig };
}

export async function handleScrapeStartPost(
  request: Request,
  env: AppEnv,
  url: URL,
  user: User,
): Promise<StartScrapeOutcome> {
  const csrf = checkCsrf(request, url);
  if (csrf) return { redirect: csrf };
  const form = await request.formData();
  const raw: Record<string, string> = {};
  for (const [k, v] of form.entries()) {
    if (typeof v === "string") raw[k] = v;
  }
  const validated = validateScrapeForm(raw);
  if (!validated.ok) return { errors: validated.errors, prefill: validated.prefill };

  let dataSourceId: number;
  try {
    dataSourceId = await startScrapeJob(env, user, validated.name, validated.config);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const friendly =
      msg.includes("UNIQUE") && msg.includes("name")
        ? `Data source named "${validated.name}" already exists.`
        : `DB error: ${msg}`;
    return {
      errors: [friendly],
      prefill: {
        name: validated.name,
        keyword: validated.config.keyword,
        locations: validated.config.locations.join("\n"),
        depth: validated.config.depth,
        language_code: validated.config.language_code,
      },
    };
  }
  return {
    redirect: flashRedirect(`/app/data-sources/${dataSourceId}/edit`, {
      text: `Scrape started — ${validated.config.locations.length} task${validated.config.locations.length === 1 ? "" : "s"} queued.`,
      kind: "ok",
    } satisfies FlashMessage),
    job: { dataSourceId, config: validated.config },
  };
}

/**
 * Re-scrape an existing data source — resets progress + returns the
 * config so the route handler can schedule a new background job.
 */
export interface RescrapeOutcome {
  redirect?: Response;
  job?: { dataSourceId: number; config: ScrapeConfig };
}

export async function handleRescrapePost(
  request: Request,
  env: AppEnv,
  url: URL,
  _user: User,
  ds: SiteDataSourceRow,
): Promise<RescrapeOutcome> {
  const csrf = checkCsrf(request, url);
  if (csrf) return { redirect: csrf };
  if (ds.source_kind !== "dataforseo_business_listings") {
    return {
      redirect: flashRedirect(`/app/data-sources/${ds.id}/edit`, {
        text: "Re-scrape only works on Maps-scraped data sources.",
        kind: "err",
      }),
    };
  }
  const config = parseStoredConfig(ds.source_config);
  if (!config) {
    return {
      redirect: flashRedirect(`/app/data-sources/${ds.id}/edit`, {
        text: "No scrape config stored on this data source.",
        kind: "err",
      }),
    };
  }
  await resetForRescrape(env, ds.id, config);
  return {
    redirect: flashRedirect(`/app/data-sources/${ds.id}/edit`, {
      text: "Re-scrape started.",
      kind: "ok",
    }),
    job: { dataSourceId: ds.id, config },
  };
}

/* ─── Reviews job (B.6) ─── */

const REVIEWS_PER_BUSINESS = 5;

/**
 * Run a per-business reviews scrape. For every row with a non-empty
 * `place_id`, fetch up to REVIEWS_PER_BUSINESS reviews and append to
 * that row as `reviews_json` + a `has_reviews` sentinel string.
 *
 * MUST NOT throw — errors go into `reviews_error` + status='error'.
 */
export async function runReviewsJob(env: AppEnv, dataSourceId: number): Promise<void> {
  try {
    const ds = await env.CONFIG_DB.prepare("SELECT rows FROM site_data_sources WHERE id = ?")
      .bind(dataSourceId)
      .first<{ rows: string }>();
    if (!ds) {
      await markReviewsError(env, dataSourceId, "data source not found");
      return;
    }
    let allRows: Array<Record<string, string>>;
    try {
      allRows = JSON.parse(ds.rows) as Array<Record<string, string>>;
    } catch {
      await markReviewsError(env, dataSourceId, "rows JSON is invalid");
      return;
    }
    // Only fetch for rows with a place_id — others would 400 from DFS.
    const eligible = allRows
      .map((row, idx) => ({ row, idx }))
      .filter((e) => (e.row.place_id ?? "").trim().length > 0);

    for (let i = 0; i < eligible.length; i++) {
      const entry = eligible[i];
      if (!entry) continue;
      const placeId = entry.row.place_id ?? "";
      try {
        const reviews = await fetchReviews(env, placeId, REVIEWS_PER_BUSINESS);
        entry.row.reviews_json = reviews.length > 0 ? JSON.stringify(reviews) : "";
        entry.row.has_reviews = reviews.length > 0 ? "1" : "";
      } catch (e) {
        if (e instanceof DataForSeoConfigError) {
          await markReviewsError(env, dataSourceId, e.message);
          return;
        }
        const msg =
          e instanceof DataForSeoApiError
            ? `HTTP ${e.statusCode}: ${e.message}`
            : e instanceof Error
              ? e.message
              : String(e);
        // Per-business errors don't abort the whole job — record on
        // the row so the operator can spot them in the data.
        entry.row.reviews_error = msg;
      }
      // Write progress + accumulated rows after each business.
      await env.CONFIG_DB.prepare(
        `UPDATE site_data_sources
           SET rows = ?,
               reviews_progress_done = ?,
               reviews_progress_updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now'),
               updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
      )
        .bind(JSON.stringify(allRows), i + 1, dataSourceId)
        .run();
    }
    // Also update the columns list to surface the new fields in the UI.
    const colSet = new Set([...BUSINESS_LISTING_COLUMNS, "reviews_json", "has_reviews"]);
    const cols = JSON.stringify(Array.from(colSet));
    await env.CONFIG_DB.prepare(
      `UPDATE site_data_sources
         SET columns = ?,
             reviews_status = 'done',
             reviews_progress_updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now'),
             updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
    )
      .bind(cols, dataSourceId)
      .run();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await markReviewsError(env, dataSourceId, msg);
  }
}

async function markReviewsError(env: AppEnv, dataSourceId: number, message: string): Promise<void> {
  try {
    await env.CONFIG_DB.prepare(
      `UPDATE site_data_sources
         SET reviews_status = 'error',
             reviews_error = ?,
             reviews_progress_updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now'),
             updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
    )
      .bind(message, dataSourceId)
      .run();
  } catch {
    // best-effort
  }
}

export async function handleReviewsStartPost(
  request: Request,
  env: AppEnv,
  url: URL,
  _user: User,
  ds: SiteDataSourceRow,
): Promise<{ redirect: Response; job?: { dataSourceId: number } }> {
  const csrf = checkCsrf(request, url);
  if (csrf) return { redirect: csrf };
  if (ds.source_kind !== "dataforseo_business_listings") {
    return {
      redirect: flashRedirect(`/app/data-sources/${ds.id}/edit`, {
        text: "Reviews scrape only works on Maps-scraped data sources.",
        kind: "err",
      }),
    };
  }
  // Count rows with a place_id — that's our progress_total budget.
  let allRows: Array<Record<string, string>> = [];
  try {
    allRows = JSON.parse(ds.rows);
  } catch {
    return {
      redirect: flashRedirect(`/app/data-sources/${ds.id}/edit`, {
        text: "Data source rows are invalid JSON.",
        kind: "err",
      }),
    };
  }
  const eligible = allRows.filter((r) => (r.place_id ?? "").trim().length > 0);
  if (eligible.length === 0) {
    return {
      redirect: flashRedirect(`/app/data-sources/${ds.id}/edit`, {
        text: "No rows with a place_id — run/re-scrape the listings first.",
        kind: "warn",
      }),
    };
  }
  await env.CONFIG_DB.prepare(
    `UPDATE site_data_sources
       SET reviews_status = 'running',
           reviews_progress_total = ?,
           reviews_progress_done = 0,
           reviews_progress_updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now'),
           reviews_error = NULL,
           updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
  )
    .bind(eligible.length, ds.id)
    .run();
  return {
    redirect: flashRedirect(`/app/data-sources/${ds.id}/edit`, {
      text: `Reviews scrape started — ${eligible.length} task${eligible.length === 1 ? "" : "s"} (~\$${(eligible.length * 0.003).toFixed(2)}).`,
      kind: "ok",
    }),
    job: { dataSourceId: ds.id },
  };
}

/* Re-export so route handlers can typecheck ReviewItem when needed. */
export type { ReviewItem };
