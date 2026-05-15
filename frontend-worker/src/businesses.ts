/**
 * Businesses — operator's registry of agency-client / featured /
 * target business profiles.
 *
 * Distinct from:
 *   - `clients` (proxy hosting configs)
 *   - `site_data_sources` (bulk row data for Generate runs)
 *
 * One Business = one Google Maps profile + optional reviews + city
 * facts. Used as:
 *   - The default {{target_*}} target on Generate runs
 *   - Backing data for future business_card / business_map embed kinds
 *   - Auto-powered /about/ route on generated sites (deferred)
 *
 * Scrape uses the existing Maps SERP endpoint (one task, depth=1)
 * with the business name as keyword + location_name. Cheaper than
 * the dedicated my_business_info endpoint at the cost of needing
 * a name + city up front (operators always have those).
 */

import type { AppEnv, FlashMessage } from "./app.js";
import { canSeeAllClients, checkCsrf, esc, flashRedirect } from "./app.js";
import type { User } from "./auth.js";
import {
  renderBusinessCard,
  renderBusinessCta,
  renderBusinessHours,
  renderBusinessMap,
  renderBusinessReviews,
} from "./business-embeds.js";
import { fetchAndCacheCityFacts } from "./city-enrichment.js";
import {
  type BusinessListingRow,
  DataForSeoApiError,
  DataForSeoConfigError,
  fetchBusinessListings,
  fetchReviews,
} from "./dataforseo.js";

/* ─── Types ─── */

export interface BusinessRow {
  id: number;
  owner_id: number;
  name: string;
  notes: string | null;
  place_id: string;
  proxy_client_id: string | null;

  /* Scraped Maps fields */
  title: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  zip: string | null;
  phone: string | null;
  website: string | null;
  rating: string | null;
  rating_count: string | null;
  categories: string | null;
  latitude: string | null;
  longitude: string | null;
  hours_json: string | null;
  price_level: string | null;
  description: string | null;
  main_image_url: string | null;
  photos_json: string | null;
  attributes_json: string | null;
  reviews_json: string;
  city_facts_json: string | null;

  scrape_status: "none" | "running" | "done" | "error";
  scrape_progress_updated_at: string | null;
  scrape_error: string | null;
  reviews_status: "none" | "running" | "done" | "error";
  reviews_progress_updated_at: string | null;
  reviews_error: string | null;

  is_default_target: number;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

/* ─── CRUD ─── */

export async function loadVisibleBusinesses(
  env: AppEnv,
  user: User,
  opts: { includeArchived?: boolean } = {},
): Promise<BusinessRow[]> {
  const archivedFilter = opts.includeArchived ? "" : " AND archived_at IS NULL";
  if (canSeeAllClients(user)) {
    const r = await env.CONFIG_DB.prepare(
      `SELECT * FROM businesses WHERE 1=1${archivedFilter} ORDER BY is_default_target DESC, name`,
    ).all<BusinessRow>();
    return r.results ?? [];
  }
  const r = await env.CONFIG_DB.prepare(
    `SELECT * FROM businesses WHERE owner_id = ?${archivedFilter} ORDER BY is_default_target DESC, name`,
  )
    .bind(user.id)
    .all<BusinessRow>();
  return r.results ?? [];
}

export async function loadVisibleBusiness(
  env: AppEnv,
  user: User,
  id: number,
): Promise<BusinessRow | null> {
  if (canSeeAllClients(user)) {
    return env.CONFIG_DB.prepare("SELECT * FROM businesses WHERE id = ?")
      .bind(id)
      .first<BusinessRow>();
  }
  return env.CONFIG_DB.prepare("SELECT * FROM businesses WHERE id = ? AND owner_id = ?")
    .bind(id, user.id)
    .first<BusinessRow>();
}

export async function loadDefaultTargetBusiness(
  env: AppEnv,
  user: User,
): Promise<BusinessRow | null> {
  return env.CONFIG_DB.prepare(
    "SELECT * FROM businesses WHERE owner_id = ? AND is_default_target = 1 AND archived_at IS NULL LIMIT 1",
  )
    .bind(user.id)
    .first<BusinessRow>();
}

/* ─── Form validation ─── */

export interface BusinessFormInput {
  name: string;
  keyword: string;
  location: string;
  /** Optional address-contains filter — applied after fetch to narrow candidates. */
  address_filter: string;
  notes: string;
}

const MAX_NAME = 200;
const MAX_NOTES = 2000;
/** Top-N candidates we show on the picker step. */
const PICKER_DEPTH = 5;

export function validateBusinessForm(
  raw: Record<string, string>,
):
  | { ok: true; value: BusinessFormInput }
  | { ok: false; errors: string[]; prefill: BusinessFormInput } {
  const value: BusinessFormInput = {
    name: (raw.name ?? "").trim(),
    keyword: (raw.keyword ?? "").trim(),
    location: (raw.location ?? "").trim(),
    address_filter: (raw.address_filter ?? "").trim(),
    notes: (raw.notes ?? "").trim(),
  };
  const errors: string[] = [];
  if (!value.name) errors.push("name is required");
  if (value.name.length > MAX_NAME) errors.push(`name must be ≤ ${MAX_NAME} chars`);
  if (!value.keyword) errors.push("keyword is required (used to find the business on Google Maps)");
  if (!value.location) errors.push("location is required (City,Region,Country format)");
  if (value.notes.length > MAX_NOTES) errors.push(`notes must be ≤ ${MAX_NOTES} chars`);
  if (errors.length > 0) return { ok: false, errors, prefill: value };
  return { ok: true, value };
}

/**
 * Fetch the top-N Maps candidates for a (keyword, location). Applied
 * filter: when `address_filter` is non-empty, drop candidates whose
 * address doesn't contain it (case-insensitive substring match) —
 * helps narrow when the operator already knows the street address.
 *
 * Returns a friendly error message via the `error` field instead of
 * throwing so the caller can render the picker page with an error
 * banner without an exception path.
 */
export async function fetchBusinessCandidates(
  env: AppEnv,
  input: BusinessFormInput,
): Promise<{ candidates: BusinessListingRow[] } | { error: string }> {
  try {
    const rows = await fetchBusinessListings(env, {
      keyword: input.keyword,
      location_name: input.location,
      language_code: "en",
      depth: PICKER_DEPTH,
    });
    if (rows.length === 0) {
      return {
        error: `No Google Maps results for "${input.keyword}" in "${input.location}". Try a more specific keyword or check the location format (City,Region,Country).`,
      };
    }
    const filter = input.address_filter.toLowerCase();
    const filtered = filter
      ? rows.filter((r) => (r.address ?? "").toLowerCase().includes(filter))
      : rows;
    if (filtered.length === 0) {
      return {
        error: `${rows.length} candidate${rows.length === 1 ? "" : "s"} returned but none match address filter "${input.address_filter}". Refine or clear the filter.`,
      };
    }
    return { candidates: filtered };
  } catch (e) {
    if (e instanceof DataForSeoConfigError || e instanceof DataForSeoApiError) {
      return { error: e.message };
    }
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Persist a fresh Business from a candidate row. Used by the picker
 * confirm step. Synchronous + atomic — no async job.
 */
export async function createBusinessFromCandidate(
  env: AppEnv,
  user: User,
  name: string,
  notes: string,
  candidate: BusinessListingRow,
): Promise<number> {
  const r = await env.CONFIG_DB.prepare(
    `INSERT INTO businesses (
       owner_id, name, notes, place_id,
       title, address, city, state, country, zip,
       phone, website, rating, rating_count, categories,
       latitude, longitude, hours_json, price_level,
       description, main_image_url, photos_json, attributes_json,
       scrape_status, scrape_progress_updated_at
     )
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'done', strftime('%Y-%m-%dT%H:%M:%SZ','now'))
     RETURNING id`,
  )
    .bind(
      user.id,
      name,
      notes || null,
      candidate.place_id,
      candidate.title,
      candidate.address,
      candidate.city,
      candidate.state,
      candidate.country,
      candidate.zip,
      candidate.phone,
      candidate.website,
      candidate.rating,
      candidate.rating_count,
      candidate.categories,
      candidate.latitude,
      candidate.longitude,
      candidate.hours_json,
      candidate.price_level,
      candidate.description,
      candidate.main_image_url,
      candidate.photos_json,
      candidate.attributes_json,
    )
    .first<{ id: number }>();
  if (!r) throw new Error("Insert returned no row");
  return r.id;
}

/**
 * Overwrite an existing Business's scraped fields from a freshly-picked
 * candidate. Keeps owner_id + workflow flags (is_default_target,
 * archived_at) + notes preserved; the operator can edit the `name`
 * separately. Used by the Edit & re-scrape flow.
 */
export async function updateBusinessFromCandidate(
  env: AppEnv,
  user: User,
  id: number,
  name: string,
  notes: string,
  candidate: BusinessListingRow,
): Promise<void> {
  await env.CONFIG_DB.prepare(
    `UPDATE businesses SET
       name = ?, notes = ?, place_id = ?,
       title = ?, address = ?, city = ?, state = ?, country = ?, zip = ?,
       phone = ?, website = ?, rating = ?, rating_count = ?, categories = ?,
       latitude = ?, longitude = ?, hours_json = ?, price_level = ?,
       description = ?, main_image_url = ?, photos_json = ?, attributes_json = ?,
       scrape_status = 'done', scrape_progress_updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now'),
       scrape_error = NULL, updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND owner_id = ?`,
  )
    .bind(
      name,
      notes || null,
      candidate.place_id,
      candidate.title,
      candidate.address,
      candidate.city,
      candidate.state,
      candidate.country,
      candidate.zip,
      candidate.phone,
      candidate.website,
      candidate.rating,
      candidate.rating_count,
      candidate.categories,
      candidate.latitude,
      candidate.longitude,
      candidate.hours_json,
      candidate.price_level,
      candidate.description,
      candidate.main_image_url,
      candidate.photos_json,
      candidate.attributes_json,
      id,
      user.id,
    )
    .run();
}

/** How many embeds currently reference this Business — surfaced on the delete confirm page. */
export async function countEmbedsReferencingBusiness(
  env: AppEnv,
  businessId: number,
): Promise<number> {
  const r = await env.CONFIG_DB.prepare("SELECT COUNT(*) AS n FROM embeds WHERE business_id = ?")
    .bind(businessId)
    .first<{ n: number }>();
  return r?.n ?? 0;
}

/** Hard-delete a Business. CASCADE in 0020 sets embeds.business_id to NULL. */
export async function hardDeleteBusiness(env: AppEnv, user: User, id: number): Promise<void> {
  await env.CONFIG_DB.prepare("DELETE FROM businesses WHERE id = ? AND owner_id = ?")
    .bind(id, user.id)
    .run();
}

/* ─── Set default target ─── */

/**
 * Mark a business as the default target. Atomically clears the flag
 * on every OTHER business for the same owner, so there's never more
 * than one default target per operator.
 */
export async function setDefaultTarget(env: AppEnv, user: User, businessId: number): Promise<void> {
  await env.CONFIG_DB.batch([
    env.CONFIG_DB.prepare(
      "UPDATE businesses SET is_default_target = 0 WHERE owner_id = ? AND is_default_target = 1",
    ).bind(user.id),
    env.CONFIG_DB.prepare(
      "UPDATE businesses SET is_default_target = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND owner_id = ?",
    ).bind(businessId, user.id),
  ]);
}

export async function clearDefaultTarget(env: AppEnv, user: User): Promise<void> {
  await env.CONFIG_DB.prepare(
    "UPDATE businesses SET is_default_target = 0 WHERE owner_id = ? AND is_default_target = 1",
  )
    .bind(user.id)
    .run();
}

/* ─── Archive / restore ─── */

export async function archiveBusiness(env: AppEnv, user: User, id: number): Promise<void> {
  await env.CONFIG_DB.prepare(
    `UPDATE businesses
       SET archived_at = CURRENT_TIMESTAMP,
           is_default_target = 0,
           updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND owner_id = ?`,
  )
    .bind(id, user.id)
    .run();
}

export async function restoreBusiness(env: AppEnv, user: User, id: number): Promise<void> {
  await env.CONFIG_DB.prepare(
    "UPDATE businesses SET archived_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND owner_id = ?",
  )
    .bind(id, user.id)
    .run();
}

/* ─── Target scalars for Generate runs ─── */

/**
 * Expose a Business's fields as `{{target_*}}` scalars on every
 * rendered row. Pure helper — caller spreads the result onto the
 * row's render context.
 */
export function targetScalars(b: BusinessRow): Record<string, string> {
  // City facts (if Wikipedia enrichment has been run) come from the
  // city_facts_json blob. Best-effort parse — corrupt JSON → empty.
  let cityFacts: {
    description?: string;
    population?: number | null;
    founded_year?: number | null;
    wiki_url?: string;
  } = {};
  if (b.city_facts_json) {
    try {
      cityFacts = JSON.parse(b.city_facts_json) ?? {};
    } catch {
      /* ignore */
    }
  }
  return {
    target_title: b.title ?? b.name,
    target_address: b.address ?? "",
    target_city: b.city ?? "",
    target_state: b.state ?? "",
    target_country: b.country ?? "",
    target_zip: b.zip ?? "",
    target_phone: b.phone ?? "",
    target_website: b.website ?? "",
    target_rating: b.rating ?? "",
    target_rating_count: b.rating_count ?? "",
    target_categories: b.categories ?? "",
    target_latitude: b.latitude ?? "",
    target_longitude: b.longitude ?? "",
    target_place_id: b.place_id,
    target_description: b.description ?? "",
    target_main_image_url: b.main_image_url ?? "",
    target_city_description: cityFacts.description ?? "",
    target_city_population: cityFacts.population != null ? cityFacts.population.toString() : "",
    target_city_founded_year:
      cityFacts.founded_year != null ? cityFacts.founded_year.toString() : "",
    target_city_wiki_url: cityFacts.wiki_url ?? "",
    has_target: "1",
    has_target_reviews: typeof b.reviews_json === "string" && b.reviews_json.length > 2 ? "1" : "",
    has_target_city_facts: cityFacts.description ? "1" : "",
    // Pre-rendered embed HTML for templates to drop in via the raw
    // `{{{...}}}` syntax. Operators write:
    //   {{#if has_target}}{{{target_card_html}}}{{/if}}
    target_card_html: renderBusinessCard(b),
    target_cta_html: renderBusinessCta(b),
    target_map_html: renderBusinessMap(b),
    target_reviews_html: renderBusinessReviews(b),
    target_hours_html: renderBusinessHours(b),
  };
}

/* ─── POST handlers ─── */

export async function handleSetDefaultTargetPost(
  request: Request,
  env: AppEnv,
  url: URL,
  user: User,
  id: number,
): Promise<Response> {
  const csrf = checkCsrf(request, url);
  if (csrf) return csrf;
  await setDefaultTarget(env, user, id);
  return flashRedirect(`/app/businesses/${id}`, {
    text: "Set as default target — generated pages will inject {{target_*}} fields from this business.",
    kind: "ok",
  });
}

export async function handleClearDefaultTargetPost(
  request: Request,
  env: AppEnv,
  url: URL,
  user: User,
): Promise<Response> {
  const csrf = checkCsrf(request, url);
  if (csrf) return csrf;
  await clearDefaultTarget(env, user);
  return flashRedirect("/app/businesses", {
    text: "Cleared default target.",
    kind: "ok",
  });
}

export async function handleArchiveBusinessPost(
  request: Request,
  env: AppEnv,
  url: URL,
  user: User,
  id: number,
): Promise<Response> {
  const csrf = checkCsrf(request, url);
  if (csrf) return csrf;
  await archiveBusiness(env, user, id);
  return flashRedirect("/app/businesses", { text: "Business archived.", kind: "ok" });
}

export async function handleRestoreBusinessPost(
  request: Request,
  env: AppEnv,
  url: URL,
  user: User,
  id: number,
): Promise<Response> {
  const csrf = checkCsrf(request, url);
  if (csrf) return csrf;
  await restoreBusiness(env, user, id);
  return flashRedirect(`/app/businesses/${id}`, { text: "Business restored.", kind: "ok" });
}

export async function handleEditNotesPost(
  request: Request,
  env: AppEnv,
  url: URL,
  user: User,
  id: number,
): Promise<Response> {
  const csrf = checkCsrf(request, url);
  if (csrf) return csrf;
  const form = await request.formData();
  const notes = String(form.get("notes") ?? "").trim();
  if (notes.length > MAX_NOTES) {
    return flashRedirect(`/app/businesses/${id}`, {
      text: `Notes must be ≤ ${MAX_NOTES} chars.`,
      kind: "err",
    });
  }
  await env.CONFIG_DB.prepare(
    "UPDATE businesses SET notes = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND owner_id = ?",
  )
    .bind(notes || null, id, user.id)
    .run();
  return flashRedirect(`/app/businesses/${id}`, { text: "Notes saved.", kind: "ok" });
}

/* ─── UI renderers ─── */

const BUSINESSES_CSS = `
.biz-page .biz-card{background:var(--bg-elevated);border:1px solid var(--border);border-radius:var(--radius);padding:1rem 1.25rem;margin-bottom:1rem}
.biz-page .biz-card h2{margin:.1rem 0 .35rem;font-size:1.15rem}
.biz-page .biz-meta{color:var(--fg-muted);font-size:.85rem;margin-bottom:.5rem}
.biz-page .biz-target-chip{display:inline-block;background:var(--accent-bg);color:var(--accent);padding:.1rem .55rem;border-radius:9999px;font-size:.72rem;font-weight:600;margin-left:.4rem}
.biz-page .biz-status-chip{display:inline-block;padding:.1rem .55rem;border-radius:9999px;font-size:.72rem;font-weight:600}
.biz-page .biz-status-running{background:var(--amber-bg);color:var(--amber)}
.biz-page .biz-status-done{background:var(--green-bg);color:var(--green)}
.biz-page .biz-status-error{background:var(--red-bg);color:var(--red)}
.biz-page .biz-status-none{background:var(--bg-sidebar);color:var(--fg-muted)}
.biz-page .biz-detail dl{display:grid;grid-template-columns:max-content 1fr;gap:.35rem .9rem;margin:.6rem 0}
.biz-page .biz-detail dt{color:var(--fg-muted);font-size:.85rem}
.biz-page .biz-detail dd{margin:0;font-size:.92rem;word-break:break-word}
.biz-page .biz-hero{aspect-ratio:16/6;background-size:cover;background-position:center;border-radius:var(--radius);margin-bottom:1rem;background-color:var(--bg-code)}
`;

function statusChip(status: string): string {
  return `<span class="biz-status-chip biz-status-${esc(status)}">${esc(status)}</span>`;
}

export function renderBusinessesList(opts: {
  rows: readonly BusinessRow[];
  user: User;
  includeArchived: boolean;
}): string {
  const { rows, includeArchived } = opts;
  const archivedToggle = includeArchived
    ? `<a href="/app/businesses" class="btn" style="font-size:.82rem;padding:.3rem .65rem">Hide archived</a>`
    : `<a href="/app/businesses?show_archived=1" class="btn" style="font-size:.82rem;padding:.3rem .65rem;color:var(--fg-muted)">Show archived</a>`;
  if (rows.length === 0) {
    return `<style>${BUSINESSES_CSS}</style><div class="biz-page">
      <h1>Businesses</h1>
      <p class="subtitle">Your registry of agency clients, featured brands, and target businesses. Each one = a Google Maps profile that templates and embeds can reference. ${archivedToggle}</p>
      <p style="margin-bottom:1rem"><a class="btn btn-primary" href="/app/businesses/new">+ Add business</a></p>
      <div class="empty">No businesses yet. Add one to use it as the <code>{{target_*}}</code> source on Generate runs (and later, as backing data for business embeds).</div>
    </div>`;
  }
  const tbody = rows
    .map((b) => {
      const isArchived = !!b.archived_at;
      const targetChip = b.is_default_target
        ? `<span class="biz-target-chip">⭐ Default target</span>`
        : "";
      const archivedChip = isArchived
        ? `<span class="biz-target-chip" style="background:var(--amber-bg);color:var(--amber)">archived</span>`
        : "";
      return `<tr${isArchived ? ' style="opacity:.65"' : ""}>
        <td><a href="/app/businesses/${b.id}" class="mono">${esc(b.name)}</a> ${targetChip} ${archivedChip}</td>
        <td class="mono" style="font-size:.85rem">${esc(b.title ?? "")}</td>
        <td>${[b.city, b.state].filter(Boolean).map(esc).join(", ")}</td>
        <td>${b.rating ? `★ ${esc(b.rating)} (${esc(b.rating_count ?? "0")})` : ""}</td>
        <td>${statusChip(b.scrape_status)}</td>
        <td class="mono" style="font-size:.78rem;color:var(--fg-muted)">${esc(b.updated_at)}</td>
      </tr>`;
    })
    .join("");
  return `<style>${BUSINESSES_CSS}</style><div class="biz-page">
    <h1>Businesses</h1>
    <p class="subtitle">Your registry of agency clients, featured brands, and target businesses. ${archivedToggle}</p>
    <p style="margin-bottom:1rem"><a class="btn btn-primary" href="/app/businesses/new">+ Add business</a></p>
    <table class="data">
      <thead><tr><th>Name</th><th>Title (Maps)</th><th>Location</th><th>Rating</th><th>Status</th><th>Updated</th></tr></thead>
      <tbody>${tbody}</tbody>
    </table>
  </div>`;
}

export function renderNewBusinessForm(opts: {
  prefill: Partial<BusinessFormInput>;
  errors: string[];
  /** Edit-flow target id — form posts to /:id/edit instead of /new. */
  editId?: number;
}): string {
  const errBox =
    opts.errors.length > 0 ? `<div class="error-box">${opts.errors.map(esc).join("\n")}</div>` : "";
  const isEdit = typeof opts.editId === "number";
  const action = isEdit ? `/app/businesses/${opts.editId}/edit` : "/app/businesses/new";
  const backHref = isEdit ? `/app/businesses/${opts.editId}` : "/app/businesses";
  return `<style>${BUSINESSES_CSS}</style><div class="biz-page" style="max-width:680px">
    <div class="crumbs"><a href="${esc(backHref)}">← ${isEdit ? "Back to business" : "Businesses"}</a></div>
    <h1>${isEdit ? "Edit & re-scrape business" : "Add business"}</h1>
    <p class="subtitle">${isEdit ? "Re-fetch top 5 Maps results — pick the right one to overwrite the current fields." : "Fetches top 5 Google Maps results — pick the correct business on the next step."} One DataForSEO Maps task (~\$0.003).</p>
    ${errBox}
    <form class="editor" method="POST" action="${esc(action)}">
      <div class="form-section">
        <label for="biz_name">name <span style="color:var(--fg-muted);font-weight:400">(your label — how you refer to this business)</span></label>
        <input id="biz_name" name="name" type="text" required value="${esc(opts.prefill.name ?? "")}" placeholder="Acme Pool Builders" maxlength="200">
      </div>
      <div class="form-section">
        <label for="biz_keyword">Google Maps keyword <span style="color:var(--fg-muted);font-weight:400">(business name as Google knows it)</span></label>
        <input id="biz_keyword" name="keyword" type="text" required value="${esc(opts.prefill.keyword ?? "")}" placeholder="Acme Pool Builders">
      </div>
      <div class="form-section">
        <label for="biz_location">location <span style="color:var(--fg-muted);font-weight:400">(City,Region,Country — same format as scrape)</span></label>
        <input id="biz_location" name="location" type="text" required value="${esc(opts.prefill.location ?? "")}" placeholder="San Diego,California,United States">
      </div>
      <div class="form-section">
        <label for="biz_addr">address contains <span style="color:var(--fg-muted);font-weight:400">(optional — narrows candidates by substring match)</span></label>
        <input id="biz_addr" name="address_filter" type="text" value="${esc(opts.prefill.address_filter ?? "")}" placeholder="123 Main St">
      </div>
      <div class="form-section">
        <label for="biz_notes">notes <span style="color:var(--fg-muted);font-weight:400">(optional — contract details, contact email, etc.)</span></label>
        <textarea id="biz_notes" name="notes" rows="3" maxlength="2000" style="width:100%">${esc(opts.prefill.notes ?? "")}</textarea>
      </div>
      <div class="form-actions">
        <button class="btn btn-primary" type="submit">Fetch candidates →</button>
        <a class="btn" href="${esc(backHref)}">Cancel</a>
      </div>
    </form>
  </div>`;
}

/**
 * Picker step — operator sees the top-N Maps results as cards and
 * picks the right one. State is encoded in hidden form fields so the
 * picker is fully stateless (no draft rows in DB until pick).
 */
export function renderBusinessPicker(opts: {
  input: BusinessFormInput;
  candidates: readonly BusinessListingRow[];
  /** Edit-flow target id — confirm posts to /:id/edit/confirm. */
  editId?: number;
}): string {
  const isEdit = typeof opts.editId === "number";
  const confirmAction = isEdit
    ? `/app/businesses/${opts.editId}/edit/confirm`
    : "/app/businesses/new/confirm";
  const refineUrl = isEdit ? `/app/businesses/${opts.editId}/edit` : "/app/businesses/new";
  const cards = opts.candidates
    .map((c, i) => {
      const photo = c.main_image_url
        ? `<div style="aspect-ratio:16/9;background:#e5e7eb;background-image:url('${esc(c.main_image_url)}');background-size:cover;background-position:center;border-radius:var(--radius);margin-bottom:.5rem"></div>`
        : "";
      const rating = c.rating
        ? `<div style="color:#d97706;font-weight:600;font-size:.92rem">★ ${esc(c.rating)} <span style="color:var(--fg-muted);font-size:.82rem">(${esc(c.rating_count ?? "0")} reviews)</span></div>`
        : "";
      return `<form method="POST" action="${esc(confirmAction)}" style="margin:0">
        <input type="hidden" name="name" value="${esc(opts.input.name)}">
        <input type="hidden" name="notes" value="${esc(opts.input.notes)}">
        <input type="hidden" name="candidate" value="${esc(JSON.stringify(c))}">
        <button type="submit" class="biz-pick-card" style="all:unset;cursor:pointer;display:block;background:var(--bg-elevated);border:1px solid var(--border);border-radius:var(--radius);padding:1rem 1.15rem;width:100%;text-align:left;transition:border-color .15s ease,box-shadow .15s ease" onmouseover="this.style.borderColor='var(--accent)';this.style.boxShadow='var(--shadow-md)'" onmouseout="this.style.borderColor='var(--border)';this.style.boxShadow='none'">
          ${photo}
          <div style="font-size:.78rem;color:var(--fg-muted);margin-bottom:.25rem">Result #${i + 1}</div>
          <div style="font-weight:600;font-size:1.05rem;margin-bottom:.25rem">${esc(c.title)}</div>
          <div style="font-size:.85rem;color:var(--fg-muted);margin-bottom:.35rem">${esc(c.address ?? "")}</div>
          ${c.categories ? `<div style="font-size:.78rem;color:var(--fg-muted);margin-bottom:.35rem">${esc(c.categories)}</div>` : ""}
          ${c.phone ? `<div style="font-size:.85rem;margin-bottom:.25rem">📞 ${esc(c.phone)}</div>` : ""}
          ${rating}
          <div style="margin-top:.6rem;color:var(--accent);font-weight:600;font-size:.85rem">Pick this one →</div>
        </button>
      </form>`;
    })
    .join("");
  return `<style>${BUSINESSES_CSS}</style><div class="biz-page" style="max-width:780px">
    <div class="crumbs"><a href="${esc(refineUrl)}">← Refine search</a></div>
    <h1>Pick the right business</h1>
    <p class="subtitle">Top ${opts.candidates.length} Maps result${opts.candidates.length === 1 ? "" : "s"} for <code>${esc(opts.input.keyword)}</code> in <code>${esc(opts.input.location)}</code>${opts.input.address_filter ? ` filtered by <code>${esc(opts.input.address_filter)}</code>` : ""}. Click the card that matches the business.</p>
    <div style="display:grid;gap:.75rem">${cards}</div>
    <p style="margin-top:1.25rem;color:var(--fg-muted);font-size:.85rem">None of these? <a href="${esc(refineUrl)}">← Refine the keyword/location/address filter</a> and try again.</p>
  </div>`;
}

/* ─── Delete confirm ─── */

export function renderBusinessDeleteConfirm(opts: {
  business: BusinessRow;
  embedRefCount: number;
  errors: string[];
}): string {
  const { business: b, embedRefCount, errors } = opts;
  const errBox =
    errors.length > 0 ? `<div class="error-box">${errors.map(esc).join("\n")}</div>` : "";
  const isDefault = b.is_default_target === 1;
  return `<style>${BUSINESSES_CSS}</style><div class="biz-page" style="max-width:680px">
    <div class="crumbs"><a href="/app/businesses/${b.id}">← ${esc(b.name)}</a></div>
    <h1 style="color:var(--red)">Permanently delete business</h1>
    ${errBox}
    <div style="background:var(--red-bg);border:1px solid color-mix(in srgb,var(--red) 30%,transparent);border-radius:var(--radius);padding:1rem 1.25rem;margin-bottom:1.25rem">
      <strong>This deletes <code>${esc(b.name)}</code> for good.</strong>
      <ul style="margin:.5rem 0 0;padding-left:1.2rem;line-height:1.7">
        ${isDefault ? `<li><strong style="color:var(--red)">This is your default-target business</strong> — generated pages relying on <code>{{target_*}}</code> will render empty after deletion.</li>` : ""}
        ${embedRefCount > 0 ? `<li><strong style="color:var(--red)">${embedRefCount} embed${embedRefCount === 1 ? "" : "s"}</strong> reference this business. They keep their static HTML but the "Refresh from Business" button will error.</li>` : "<li>No embeds reference this business — clean delete.</li>"}
        <li>If you want a reversible option, use <strong>Archive</strong> on the business page instead.</li>
        <li>This action <strong>cannot be undone</strong>.</li>
      </ul>
    </div>
    <form method="POST" action="/app/businesses/${b.id}/delete">
      <div class="form-section">
        <label for="confirm_word">Type <code style="font-family:var(--mono);font-weight:700">DELETE</code> to confirm:</label>
        <input id="confirm_word" name="confirm_word" type="text" required autocomplete="off" autofocus placeholder="DELETE" style="font-family:var(--mono);font-size:1rem;text-transform:uppercase">
      </div>
      <div class="form-actions">
        <button class="btn" type="submit" style="background:var(--red);border-color:var(--red);color:#fff">Permanently delete</button>
        <a class="btn" href="/app/businesses/${b.id}">Cancel</a>
      </div>
    </form>
  </div>`;
}

export function renderBusinessDetail(b: BusinessRow): string {
  const isArchived = !!b.archived_at;
  const photoUrl = b.main_image_url ?? "";
  const heroBlock = photoUrl
    ? `<div class="biz-hero" style="background-image:url('${esc(photoUrl)}')"></div>`
    : "";
  const dl = `<dl>
    ${b.title ? `<dt>Title</dt><dd>${esc(b.title)}</dd>` : ""}
    ${b.address ? `<dt>Address</dt><dd>${esc(b.address)}</dd>` : ""}
    ${b.phone ? `<dt>Phone</dt><dd><a href="tel:${esc(b.phone)}">${esc(b.phone)}</a></dd>` : ""}
    ${b.website ? `<dt>Website</dt><dd><a href="${esc(b.website)}" rel="nofollow noopener" target="_blank">${esc(b.website)}</a></dd>` : ""}
    ${b.rating ? `<dt>Rating</dt><dd>★ ${esc(b.rating)} (${esc(b.rating_count ?? "0")} reviews)</dd>` : ""}
    ${b.categories ? `<dt>Categories</dt><dd>${esc(b.categories)}</dd>` : ""}
    ${b.place_id ? `<dt>place_id</dt><dd class="mono" style="font-size:.78rem">${esc(b.place_id)}</dd>` : ""}
    ${b.latitude && b.longitude ? `<dt>Coordinates</dt><dd class="mono" style="font-size:.85rem">${esc(b.latitude)}, ${esc(b.longitude)}</dd>` : ""}
    ${b.description ? `<dt>Description</dt><dd>${esc(b.description)}</dd>` : ""}
  </dl>`;

  const archivedBanner = isArchived
    ? `<div style="background:var(--amber-bg);color:var(--amber);border:1px solid color-mix(in srgb,var(--amber) 30%,transparent);border-radius:var(--radius);padding:.75rem 1rem;margin-bottom:1rem;display:flex;align-items:center;justify-content:space-between;gap:1rem">
        <div><strong>Archived ${esc(b.archived_at ?? "")}</strong></div>
        <form method="POST" action="/app/businesses/${b.id}/restore" style="margin:0"><button class="btn btn-primary" type="submit">Restore</button></form>
      </div>`
    : "";

  const errorBox = b.scrape_error ? `<div class="error-box">${esc(b.scrape_error)}</div>` : "";

  const targetActions = b.is_default_target
    ? `<form method="POST" action="/app/businesses/default-target/clear" style="margin:0"><button class="btn" type="submit">Unset default</button></form>`
    : `<form method="POST" action="/app/businesses/${b.id}/set-default-target" style="margin:0"><button class="btn btn-primary" type="submit">⭐ Set as default target</button></form>`;

  const editAction = `<a class="btn" href="/app/businesses/${b.id}/edit">Edit & re-scrape</a>`;
  const archiveAction = isArchived
    ? ""
    : `<form method="POST" action="/app/businesses/${b.id}/archive" style="margin:0" onsubmit="return confirm('Archive this business? It can be restored later.')"><button class="btn" type="submit" style="color:var(--amber);border-color:color-mix(in srgb,var(--amber) 40%,transparent)">Archive</button></form>`;
  const deleteAction = `<a class="btn" href="/app/businesses/${b.id}/delete" style="color:var(--red);border-color:color-mix(in srgb,var(--red) 40%,transparent)">Permanently delete…</a>`;

  const refreshAuto =
    b.scrape_status === "running" ? `<meta http-equiv="refresh" content="2">` : "";

  void refreshAuto; // headExtra is emitted by the route handler via opts; leave inline for clarity

  return `<style>${BUSINESSES_CSS}</style><div class="biz-page" style="max-width:780px">
    <div class="crumbs"><a href="/app/businesses">← Businesses</a></div>
    <h1>${esc(b.name)} ${statusChip(b.scrape_status)} ${b.is_default_target ? '<span class="biz-target-chip">⭐ Default target</span>' : ""}</h1>
    ${archivedBanner}
    ${errorBox}
    ${heroBlock}
    <div class="biz-card biz-detail">
      ${dl}
      <div class="form-actions" style="margin-top:.6rem;flex-wrap:wrap">
        ${targetActions}
        ${editAction}
        ${archiveAction}
        ${deleteAction}
      </div>
    </div>
    ${renderReviewsPanel(b)}
    ${renderCityFactsPanel(b)}
    <div class="biz-card">
      <h3 style="margin:0 0 .5rem">Notes</h3>
      <form method="POST" action="/app/businesses/${b.id}/notes">
        <textarea name="notes" rows="3" maxlength="2000" style="width:100%;font:inherit">${esc(b.notes ?? "")}</textarea>
        <div class="form-actions" style="margin-top:.5rem"><button class="btn" type="submit">Save notes</button></div>
      </form>
    </div>
  </div>`;
}

function renderReviewsPanel(b: BusinessRow): string {
  // Don't surface the panel until the initial scrape is done — without
  // a place_id the reviews call would 400.
  if (b.scrape_status !== "done") return "";
  if (!b.place_id) return "";

  let reviews: Array<{ text: string; rating: string; author: string; date: string }> = [];
  try {
    const parsed = JSON.parse(b.reviews_json || "[]");
    if (Array.isArray(parsed)) reviews = parsed;
  } catch {
    /* ignore */
  }
  const status = b.reviews_status;
  const errorBox = b.reviews_error ? `<div class="error-box">${esc(b.reviews_error)}</div>` : "";
  const button =
    status === "running"
      ? `<span class="running-pulse"></span><strong>fetching…</strong>`
      : status === "done"
        ? `<form method="POST" action="/app/businesses/${b.id}/reviews/fetch" style="margin:0"><button class="btn" type="submit">↻ Re-fetch reviews</button></form>`
        : `<form method="POST" action="/app/businesses/${b.id}/reviews/fetch" style="margin:0"><button class="btn btn-primary" type="submit">+ Fetch reviews ($0.003)</button></form>`;

  const blocks =
    reviews.length === 0
      ? status === "done"
        ? `<div style="color:var(--fg-muted);font-style:italic">No reviews returned.</div>`
        : ""
      : reviews
          .map((r) => {
            const meta = [r.author || "Customer", r.rating ? `★ ${r.rating}` : "", r.date || ""]
              .filter(Boolean)
              .join(" · ");
            return `<blockquote style="margin:.7rem 0;padding:.55rem .9rem;border-left:3px solid var(--accent);font-style:italic;color:var(--fg)">
              <p style="margin:0 0 .3rem">"${esc(r.text)}"</p>
              <div style="font-size:.82rem;color:var(--fg-muted);font-style:normal">${esc(meta)}</div>
            </blockquote>`;
          })
          .join("");

  return `<div class="biz-card">
    <div style="display:flex;align-items:center;justify-content:space-between;gap:1rem;margin-bottom:.5rem">
      <h3 style="margin:0">Customer reviews ${statusChip(status)}</h3>
      ${button}
    </div>
    ${errorBox}
    ${blocks}
  </div>`;
}

function renderCityFactsPanel(b: BusinessRow): string {
  if (b.scrape_status !== "done") return "";
  if (!b.city) return "";

  let facts: {
    description?: string;
    population?: number | null;
    founded_year?: number | null;
    wiki_url?: string;
  } | null = null;
  if (b.city_facts_json) {
    try {
      facts = JSON.parse(b.city_facts_json);
    } catch {
      /* ignore */
    }
  }
  const action = facts
    ? `<form method="POST" action="/app/businesses/${b.id}/enrich-city" style="margin:0"><button class="btn" type="submit">↻ Refresh from Wikipedia</button></form>`
    : `<form method="POST" action="/app/businesses/${b.id}/enrich-city" style="margin:0"><button class="btn btn-primary" type="submit">+ Enrich with Wikipedia (free)</button></form>`;
  const body = facts
    ? `${facts.description ? `<p style="margin:.4rem 0">${esc(facts.description)}</p>` : ""}
       <dl style="display:grid;grid-template-columns:max-content 1fr;gap:.25rem .9rem;font-size:.88rem;margin:.4rem 0">
         ${facts.population != null ? `<dt style="color:var(--fg-muted)">Population</dt><dd style="margin:0">${esc(facts.population.toLocaleString())}</dd>` : ""}
         ${facts.founded_year != null ? `<dt style="color:var(--fg-muted)">Founded</dt><dd style="margin:0">${esc(String(facts.founded_year))}</dd>` : ""}
         ${facts.wiki_url ? `<dt style="color:var(--fg-muted)">Source</dt><dd style="margin:0"><a href="${esc(facts.wiki_url)}" target="_blank" rel="noopener nofollow">Wikipedia →</a></dd>` : ""}
       </dl>`
    : `<div style="color:var(--fg-muted);font-style:italic">Adds <code>city_description</code>, <code>city_population</code>, <code>city_founded_year</code> as <code>{{target_*}}</code> placeholders on Generate runs.</div>`;
  return `<div class="biz-card">
    <div style="display:flex;align-items:center;justify-content:space-between;gap:1rem;margin-bottom:.5rem">
      <h3 style="margin:0">City facts — ${esc(b.city)}</h3>
      ${action}
    </div>
    ${body}
  </div>`;
}

/** Auto-refresh meta when a scrape is in flight, same pattern as data sources. */
export function businessAutoRefreshHeader(b: BusinessRow): string {
  if (b.scrape_status === "running") return `<meta http-equiv="refresh" content="2">`;
  if (b.reviews_status === "running") return `<meta http-equiv="refresh" content="2">`;
  return "";
}

/* ─── Enrichment: reviews ─── */

/** Default reviews depth — Google Maps tends to surface ~5 recent reviews. */
const BUSINESS_REVIEWS_DEPTH = 5;

/**
 * Fetch reviews for one Business via DataForSEO's reviews endpoint
 * (~$0.003 per task). Synchronous — caller awaits.
 *
 * MUST NOT throw — writes terminal status (`done`/`error`) on the
 * business row so the UI reflects what happened.
 */
export async function runBusinessReviewsJob(
  env: AppEnv,
  user: User,
  businessId: number,
): Promise<void> {
  const biz = await loadVisibleBusiness(env, user, businessId);
  if (!biz) return;
  if (!biz.place_id) {
    await markBusinessReviewsError(env, businessId, "Business has no place_id — re-scrape first.");
    return;
  }
  try {
    const reviews = await fetchReviews(env, biz.place_id, BUSINESS_REVIEWS_DEPTH);
    await env.CONFIG_DB.prepare(
      `UPDATE businesses SET
         reviews_json = ?,
         reviews_status = 'done',
         reviews_progress_updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now'),
         reviews_error = NULL,
         updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND owner_id = ?`,
    )
      .bind(JSON.stringify(reviews), businessId, user.id)
      .run();
  } catch (e) {
    if (e instanceof DataForSeoConfigError || e instanceof DataForSeoApiError) {
      await markBusinessReviewsError(env, businessId, e.message);
      return;
    }
    await markBusinessReviewsError(env, businessId, e instanceof Error ? e.message : String(e));
  }
}

async function markBusinessReviewsError(
  env: AppEnv,
  businessId: number,
  message: string,
): Promise<void> {
  try {
    await env.CONFIG_DB.prepare(
      `UPDATE businesses SET
         reviews_status = 'error',
         reviews_error = ?,
         reviews_progress_updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now'),
         updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
    )
      .bind(message, businessId)
      .run();
  } catch {
    // best-effort
  }
}

/**
 * Mark a Business's reviews job as running so the UI shows the
 * progress chip + auto-refreshes. Returns the businessId for the
 * route handler to use with ctx.waitUntil.
 */
export async function startBusinessReviewsJob(
  env: AppEnv,
  user: User,
  businessId: number,
): Promise<void> {
  await env.CONFIG_DB.prepare(
    `UPDATE businesses SET
       reviews_status = 'running',
       reviews_progress_updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now'),
       reviews_error = NULL,
       updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND owner_id = ?`,
  )
    .bind(businessId, user.id)
    .run();
}

export async function handleBusinessReviewsPost(
  request: Request,
  env: AppEnv,
  url: URL,
  user: User,
  businessId: number,
): Promise<{ redirect: Response; job?: { businessId: number } }> {
  const csrf = checkCsrf(request, url);
  if (csrf) return { redirect: csrf };
  const biz = await loadVisibleBusiness(env, user, businessId);
  if (!biz) {
    return { redirect: new Response("Not found", { status: 404 }) };
  }
  if (!biz.place_id) {
    return {
      redirect: flashRedirect(`/app/businesses/${businessId}`, {
        text: "Business has no place_id — re-scrape first.",
        kind: "err",
      }),
    };
  }
  await startBusinessReviewsJob(env, user, businessId);
  return {
    redirect: flashRedirect(`/app/businesses/${businessId}`, {
      text: `Fetching up to ${BUSINESS_REVIEWS_DEPTH} reviews from Google Maps (~\$0.003)…`,
      kind: "ok",
    } satisfies FlashMessage),
    job: { businessId },
  };
}

/* ─── Enrichment: city facts (Wikipedia) ─── */

/**
 * Fetch Wikipedia city facts for one Business and stash on the row.
 * Free (no API key), cached for 30 days via city_facts table.
 * Synchronous — caller awaits.
 */
export async function runBusinessCityEnrichmentJob(
  env: AppEnv,
  user: User,
  businessId: number,
): Promise<void> {
  const biz = await loadVisibleBusiness(env, user, businessId);
  if (!biz) return;
  const city = (biz.city ?? "").trim();
  if (!city) return; // silent no-op when city is unknown
  const region = (biz.state ?? "").trim();
  const country = (biz.country ?? "").trim() || "United States";
  const facts = await fetchAndCacheCityFacts(env, { city, region, country });
  if (!facts) return; // best-effort; Wikipedia miss leaves city_facts_json untouched
  const factsJson = JSON.stringify({
    description: facts.description,
    population: facts.population,
    founded_year: facts.founded_year,
    wiki_url: facts.wiki_url,
  });
  await env.CONFIG_DB.prepare(
    "UPDATE businesses SET city_facts_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND owner_id = ?",
  )
    .bind(factsJson, businessId, user.id)
    .run();
}

export async function handleBusinessCityEnrichmentPost(
  request: Request,
  env: AppEnv,
  url: URL,
  user: User,
  businessId: number,
): Promise<{ redirect: Response; job?: { businessId: number } }> {
  const csrf = checkCsrf(request, url);
  if (csrf) return { redirect: csrf };
  const biz = await loadVisibleBusiness(env, user, businessId);
  if (!biz) return { redirect: new Response("Not found", { status: 404 }) };
  if (!biz.city) {
    return {
      redirect: flashRedirect(`/app/businesses/${businessId}`, {
        text: "Business has no city set — re-scrape first.",
        kind: "err",
      }),
    };
  }
  return {
    redirect: flashRedirect(`/app/businesses/${businessId}`, {
      text: `Fetching Wikipedia summary for ${biz.city}…`,
      kind: "ok",
    } satisfies FlashMessage),
    job: { businessId },
  };
}
