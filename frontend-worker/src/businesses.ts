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
  type BusinessListingRow,
  DataForSeoApiError,
  DataForSeoConfigError,
  fetchBusinessListings,
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
  notes: string;
}

const MAX_NAME = 200;
const MAX_NOTES = 2000;

export function validateBusinessForm(
  raw: Record<string, string>,
):
  | { ok: true; value: BusinessFormInput }
  | { ok: false; errors: string[]; prefill: BusinessFormInput } {
  const value: BusinessFormInput = {
    name: (raw.name ?? "").trim(),
    keyword: (raw.keyword ?? "").trim(),
    location: (raw.location ?? "").trim(),
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

/* ─── Scrape ─── */

/**
 * Create a new Business row in `running` state. The actual scrape
 * runs via `ctx.waitUntil(runBusinessScrapeJob(...))` in the route
 * handler.
 */
export async function startBusinessScrape(
  env: AppEnv,
  user: User,
  input: BusinessFormInput,
): Promise<number> {
  const r = await env.CONFIG_DB.prepare(
    `INSERT INTO businesses (owner_id, name, notes, place_id, scrape_status, scrape_progress_updated_at)
     VALUES (?, ?, ?, '', 'running', strftime('%Y-%m-%dT%H:%M:%SZ','now'))
     RETURNING id`,
  )
    .bind(user.id, input.name, input.notes || null)
    .first<{ id: number }>();
  if (!r) throw new Error("Insert returned no row");
  return r.id;
}

/**
 * Run the actual DataForSEO Maps fetch for one Business. Looks up the
 * first organic result for (keyword, location) and copies its fields
 * onto the Business row. MUST NOT throw — terminal status is written.
 */
export async function runBusinessScrapeJob(
  env: AppEnv,
  businessId: number,
  input: BusinessFormInput,
): Promise<void> {
  try {
    const rows = await fetchBusinessListings(env, {
      keyword: input.keyword,
      location_name: input.location,
      language_code: "en",
      depth: 1,
    });
    const first = rows[0];
    if (!first) {
      await markBusinessError(
        env,
        businessId,
        `No Google Maps result for "${input.keyword}" in "${input.location}". Try a more specific keyword or check the location format.`,
      );
      return;
    }
    await writeScrapedFields(env, businessId, first);
  } catch (e) {
    if (e instanceof DataForSeoConfigError || e instanceof DataForSeoApiError) {
      await markBusinessError(env, businessId, e.message);
      return;
    }
    await markBusinessError(env, businessId, e instanceof Error ? e.message : String(e));
  }
}

async function writeScrapedFields(
  env: AppEnv,
  businessId: number,
  row: BusinessListingRow,
): Promise<void> {
  await env.CONFIG_DB.prepare(
    `UPDATE businesses SET
       place_id = ?, title = ?, address = ?, city = ?, state = ?, country = ?, zip = ?,
       phone = ?, website = ?, rating = ?, rating_count = ?, categories = ?,
       latitude = ?, longitude = ?, hours_json = ?, price_level = ?,
       description = ?, main_image_url = ?, photos_json = ?, attributes_json = ?,
       scrape_status = 'done', scrape_progress_updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now'),
       scrape_error = NULL, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
  )
    .bind(
      row.place_id,
      row.title,
      row.address,
      row.city,
      row.state,
      row.country,
      row.zip,
      row.phone,
      row.website,
      row.rating,
      row.rating_count,
      row.categories,
      row.latitude,
      row.longitude,
      row.hours_json,
      row.price_level,
      row.description,
      row.main_image_url,
      row.photos_json,
      row.attributes_json,
      businessId,
    )
    .run();
}

async function markBusinessError(env: AppEnv, businessId: number, message: string): Promise<void> {
  try {
    await env.CONFIG_DB.prepare(
      `UPDATE businesses SET
         scrape_status = 'error',
         scrape_error = ?,
         scrape_progress_updated_at = strftime('%Y-%m-%dT%H:%M:%SZ','now'),
         updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
    )
      .bind(message, businessId)
      .run();
  } catch {
    // best-effort
  }
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
    has_target: "1",
  };
}

/* ─── POST handlers ─── */

export interface NewBusinessOutcome {
  redirect?: Response;
  errors?: string[];
  prefill?: BusinessFormInput;
  job?: { businessId: number; input: BusinessFormInput };
}

export async function handleNewBusinessPost(
  request: Request,
  env: AppEnv,
  url: URL,
  user: User,
): Promise<NewBusinessOutcome> {
  const csrf = checkCsrf(request, url);
  if (csrf) return { redirect: csrf };
  const form = await request.formData();
  const raw: Record<string, string> = {};
  for (const [k, v] of form.entries()) {
    if (typeof v === "string") raw[k] = v;
  }
  const validation = validateBusinessForm(raw);
  if (!validation.ok) return { errors: validation.errors, prefill: validation.prefill };

  let businessId: number;
  try {
    businessId = await startBusinessScrape(env, user, validation.value);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const friendly =
      msg.includes("UNIQUE") && msg.includes("name")
        ? `A business named "${validation.value.name}" already exists.`
        : `DB error: ${msg}`;
    return { errors: [friendly], prefill: validation.value };
  }
  return {
    redirect: flashRedirect(`/app/businesses/${businessId}`, {
      text: `Looking up "${validation.value.keyword}" on Google Maps…`,
      kind: "ok",
    } satisfies FlashMessage),
    job: { businessId, input: validation.value },
  };
}

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
}): string {
  const errBox =
    opts.errors.length > 0 ? `<div class="error-box">${opts.errors.map(esc).join("\n")}</div>` : "";
  return `<style>${BUSINESSES_CSS}</style><div class="biz-page" style="max-width:680px">
    <div class="crumbs"><a href="/app/businesses">← Businesses</a></div>
    <h1>Add business</h1>
    <p class="subtitle">One DataForSEO Maps task (~\$0.003) fetches the full profile. You can refresh + add reviews afterwards.</p>
    ${errBox}
    <form class="editor" method="POST" action="/app/businesses/new">
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
        <label for="biz_notes">notes <span style="color:var(--fg-muted);font-weight:400">(optional — contract details, contact email, etc.)</span></label>
        <textarea id="biz_notes" name="notes" rows="3" maxlength="2000" style="width:100%">${esc(opts.prefill.notes ?? "")}</textarea>
      </div>
      <div class="form-actions">
        <button class="btn btn-primary" type="submit">Scrape & save →</button>
        <a class="btn" href="/app/businesses">Cancel</a>
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

  const archiveAction = isArchived
    ? ""
    : `<form method="POST" action="/app/businesses/${b.id}/archive" style="margin:0" onsubmit="return confirm('Archive this business? It can be restored later.')"><button class="btn" type="submit" style="color:var(--red);border-color:color-mix(in srgb,var(--red) 40%,transparent)">Archive</button></form>`;

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
      <div class="form-actions" style="margin-top:.6rem">
        ${targetActions}
        ${archiveAction}
      </div>
    </div>
    <div class="biz-card">
      <h3 style="margin:0 0 .5rem">Notes</h3>
      <form method="POST" action="/app/businesses/${b.id}/notes">
        <textarea name="notes" rows="3" maxlength="2000" style="width:100%;font:inherit">${esc(b.notes ?? "")}</textarea>
        <div class="form-actions" style="margin-top:.5rem"><button class="btn" type="submit">Save notes</button></div>
      </form>
    </div>
  </div>`;
}

/** Auto-refresh meta when a scrape is in flight, same pattern as data sources. */
export function businessAutoRefreshHeader(b: BusinessRow): string {
  if (b.scrape_status === "running") return `<meta http-equiv="refresh" content="2">`;
  return "";
}
