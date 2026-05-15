/**
 * Business-backed embed renderers.
 *
 * Embeds whose `business_id` is non-NULL render their HTML from a
 * Business's scraped Maps fields. The HTML is generated once at
 * embed create-time (snapshot model) and re-rendered on operator
 * demand via the "Refresh from Business" button. Trade-off vs
 * render-time injection: stale until refresh, but the existing
 * HTMLRewriter / R2 paths don't need to know about Businesses.
 *
 * v1 ships two kinds:
 *   - business_card — name + address + click-to-call + rating
 *   - business_cta  — large CTA banner with phone
 *
 * v2 will add: business_map, business_reviews, business_hours.
 *
 * The HTML each kind produces is self-contained — inline styles,
 * no external dependencies — so it inserts cleanly into any host
 * page's layout. Width is constrained to its container.
 */

import type { AppEnv, FlashMessage } from "./app.js";
import { checkCsrf, flashRedirect } from "./app.js";
import type { User } from "./auth.js";
import { type BusinessRow, loadVisibleBusiness, loadVisibleBusinesses } from "./businesses.js";

export type BusinessEmbedKind =
  | "business_card"
  | "business_cta"
  | "business_map"
  | "business_reviews"
  | "business_hours";

export const BUSINESS_EMBED_KINDS: readonly BusinessEmbedKind[] = [
  "business_card",
  "business_cta",
  "business_map",
  "business_reviews",
  "business_hours",
];

/** Operator-facing label per kind. */
export const BUSINESS_EMBED_LABELS: Record<BusinessEmbedKind, string> = {
  business_card: "Business card",
  business_cta: "Call-to-action banner",
  business_map: "Google Maps (lat/lng)",
  business_reviews: "Customer reviews",
  business_hours: "Opening hours",
};

/** Short description per kind for the picker. */
export const BUSINESS_EMBED_DESCRIPTIONS: Record<BusinessEmbedKind, string> = {
  business_card: "Compact card with name, address, phone, and rating. Good in sidebars or footers.",
  business_cta: "Full-width banner with a big tel: click-to-call. Good for hero or page bottom.",
  business_map: "Embedded Google Map centered on the business's coordinates (v2 — coming soon).",
  business_reviews: "Carousel of customer reviews — needs the reviews scrape to be done (v2).",
  business_hours: "Today's hours + weekly toggle widget (v2).",
};

/* ─── Renderers ─── */

/**
 * HTML-escape (entity-encode) text. Local helper to avoid pulling in
 * the full app.ts esc and its dependencies.
 */
function esc(s: string | null | undefined): string {
  if (s == null) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function renderBusinessCard(b: BusinessRow): string {
  const title = b.title ?? b.name;
  const address = b.address ?? "";
  const phone = b.phone ?? "";
  const rating = b.rating ?? "";
  const ratingCount = b.rating_count ?? "";
  const categories = b.categories ?? "";
  return `<div class="edge-seo-business-card" style="background:#fff;border:1px solid #e5e7eb;border-radius:.6rem;padding:1.1rem 1.3rem;margin:1rem 0;box-shadow:0 1px 3px rgba(15,23,42,.05);font:14px/1.5 -apple-system,BlinkMacSystemFont,'Inter','Segoe UI',Roboto,sans-serif;color:#111;max-width:480px">
    <div style="font-weight:600;font-size:1.05rem;margin-bottom:.2rem">${esc(title)}</div>
    ${categories ? `<div style="color:#6b7280;font-size:.85rem;margin-bottom:.4rem">${esc(categories)}</div>` : ""}
    ${address ? `<div style="font-size:.9rem;margin-bottom:.35rem">${esc(address)}</div>` : ""}
    ${phone ? `<div style="margin-bottom:.35rem"><a href="tel:${esc(phone)}" style="color:#10b981;font-weight:600;text-decoration:none">📞 ${esc(phone)}</a></div>` : ""}
    ${rating ? `<div style="color:#d97706;font-size:.92rem">★ ${esc(rating)}${ratingCount ? ` <span style="color:#6b7280;font-size:.82rem">(${esc(ratingCount)} reviews)</span>` : ""}</div>` : ""}
  </div>`;
}

export function renderBusinessCta(b: BusinessRow): string {
  const title = b.title ?? b.name;
  const phone = b.phone ?? "";
  const city = b.city ?? "";
  return `<div class="edge-seo-business-cta" style="background:linear-gradient(135deg,#10b981,#059669);color:#fff;border-radius:.7rem;padding:1.5rem 1.75rem;margin:1.25rem 0;text-align:center;box-shadow:0 4px 12px rgba(16,185,129,.25);font:15px/1.5 -apple-system,BlinkMacSystemFont,'Inter','Segoe UI',Roboto,sans-serif">
    <div style="font-size:1.3rem;font-weight:700;margin-bottom:.4rem">Get in touch with ${esc(title)}</div>
    ${city ? `<div style="font-size:.95rem;opacity:.92;margin-bottom:1rem">Serving ${esc(city)} and nearby</div>` : ""}
    ${phone ? `<a href="tel:${esc(phone)}" style="display:inline-block;background:#fff;color:#059669;font-weight:700;padding:.85rem 1.6rem;border-radius:.5rem;text-decoration:none;font-size:1.05rem">📞 Call ${esc(phone)}</a>` : ""}
  </div>`;
}

/* placeholders for v2 — visible in picker but disabled */
export function renderBusinessMap(b: BusinessRow): string {
  if (!b.latitude || !b.longitude) {
    return `<div class="edge-seo-business-map" style="padding:1rem;background:#fef3c7;color:#92400e;border-radius:.5rem">No lat/lng on this Business — re-scrape it to populate coordinates.</div>`;
  }
  return `<div class="edge-seo-business-map" style="aspect-ratio:16/10;border-radius:.5rem;overflow:hidden;border:1px solid #e5e7eb;margin:1rem 0;max-width:680px">
    <iframe loading="lazy" src="https://maps.google.com/maps?q=${encodeURIComponent(b.latitude)},${encodeURIComponent(b.longitude)}&z=15&output=embed" style="width:100%;height:100%;border:0" referrerpolicy="no-referrer-when-downgrade"></iframe>
  </div>`;
}

export function renderBusinessReviews(b: BusinessRow): string {
  const raw = b.reviews_json ?? "[]";
  let reviews: Array<{ text: string; rating: string; author: string; date: string }> = [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) reviews = parsed;
  } catch {
    /* fall through */
  }
  if (reviews.length === 0) {
    return `<div class="edge-seo-business-reviews" style="padding:1rem;background:#fef3c7;color:#92400e;border-radius:.5rem">No reviews on this Business yet — run the reviews scrape on its detail page.</div>`;
  }
  const blocks = reviews
    .slice(0, 5)
    .map((r) => {
      const meta = [r.author || "Customer", r.rating ? `★ ${r.rating}` : "", r.date || ""]
        .filter(Boolean)
        .join(" · ");
      return `<blockquote style="margin:.8rem 0;padding:.55rem .9rem;border-left:3px solid #10b981;font-style:italic;color:#374151">
        <p style="margin:0 0 .35rem">&ldquo;${esc(r.text)}&rdquo;</p>
        <div style="font-size:.82rem;color:#6b7280;font-style:normal">${esc(meta)}</div>
      </blockquote>`;
    })
    .join("");
  return `<div class="edge-seo-business-reviews" style="margin:1rem 0;max-width:680px;font:14px/1.5 -apple-system,BlinkMacSystemFont,sans-serif">${blocks}</div>`;
}

export function renderBusinessHours(b: BusinessRow): string {
  const raw = b.hours_json ?? "";
  if (!raw) {
    return `<div class="edge-seo-business-hours" style="padding:1rem;background:#fef3c7;color:#92400e;border-radius:.5rem">No hours on this Business — re-scrape to populate.</div>`;
  }
  if (raw === "24/7") {
    return `<div class="edge-seo-business-hours" style="padding:1rem 1.25rem;background:#fff;border:1px solid #e5e7eb;border-radius:.6rem;margin:1rem 0;font:14px/1.5 sans-serif"><strong>Open 24 hours</strong></div>`;
  }
  let h: Record<string, string> = {};
  try {
    h = JSON.parse(raw);
  } catch {
    return `<div class="edge-seo-business-hours" style="padding:1rem;background:#fef3c7;color:#92400e;border-radius:.5rem">Hours data could not be parsed.</div>`;
  }
  const days = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
  const rows = days
    .map((d) => {
      const t = h[d] || "closed";
      const closed = t === "closed";
      return `<li style="display:flex;justify-content:space-between;padding:.2rem 0;border-bottom:1px dotted #e5e7eb">
        <span style="text-transform:capitalize">${d}</span>
        <span style="color:${closed ? "#9ca3af" : "#374151"};font-variant-numeric:tabular-nums">${closed ? "Closed" : esc(t)}</span>
      </li>`;
    })
    .join("");
  return `<div class="edge-seo-business-hours" style="padding:1rem 1.25rem;background:#fff;border:1px solid #e5e7eb;border-radius:.6rem;margin:1rem 0;max-width:380px;font:14px/1.5 sans-serif">
    <div style="font-weight:600;margin-bottom:.4rem">Hours</div>
    <ul style="list-style:none;padding:0;margin:0">${rows}</ul>
  </div>`;
}

/**
 * Render the HTML for a Business-backed embed at create / refresh
 * time. Returns "" for unknown kinds (caller validates).
 */
export function renderBusinessEmbedHtml(kind: BusinessEmbedKind, business: BusinessRow): string {
  switch (kind) {
    case "business_card":
      return renderBusinessCard(business);
    case "business_cta":
      return renderBusinessCta(business);
    case "business_map":
      return renderBusinessMap(business);
    case "business_reviews":
      return renderBusinessReviews(business);
    case "business_hours":
      return renderBusinessHours(business);
    default:
      return "";
  }
}

/* ─── New business embed form + handler ─── */

export function renderNewBusinessEmbedForm(opts: {
  businesses: readonly BusinessRow[];
  prefill: {
    name?: string;
    business_id?: string;
    business_kind?: string;
    default_position?: string;
  };
  errors: string[];
}): string {
  const errBox =
    opts.errors.length > 0
      ? `<div class="error-box">${opts.errors.map((e) => esc(e)).join("\n")}</div>`
      : "";
  if (opts.businesses.length === 0) {
    return `<div style="max-width:680px"><div class="crumbs"><a href="/app/embeds">← Embeds</a></div>
      <h1>New business embed</h1>
      <p class="subtitle">Render a card / CTA / map directly from one of your Businesses.</p>
      <div class="empty">No Businesses yet. <a href="/app/businesses/new">Add a Business →</a> first.</div>
    </div>`;
  }
  const businessOptions = opts.businesses
    .map(
      (b) =>
        `<option value="${b.id}"${opts.prefill.business_id === String(b.id) ? " selected" : ""}>${esc(b.name)}${b.title && b.title !== b.name ? ` — ${esc(b.title)}` : ""}</option>`,
    )
    .join("");
  const kindOptions = BUSINESS_EMBED_KINDS.map((k) => {
    const isV2 = k === "business_map" || k === "business_reviews" || k === "business_hours";
    return `<option value="${k}"${opts.prefill.business_kind === k ? " selected" : ""}>${esc(BUSINESS_EMBED_LABELS[k])}${isV2 ? "" : ""}</option>`;
  }).join("");
  return `<div style="max-width:680px">
    <div class="crumbs"><a href="/app/embeds">← Embeds</a></div>
    <h1>New business embed</h1>
    <p class="subtitle">Pick a Business + an embed kind. We render the HTML now from the Business's current data — refresh later if the Business updates.</p>
    ${errBox}
    <form class="editor" method="POST" action="/app/embeds/new-business">
      <div class="form-section">
        <label for="be_name">name</label>
        <input id="be_name" name="name" type="text" required maxlength="200" value="${esc(opts.prefill.name ?? "")}" placeholder="Acme Pools — sidebar card">
      </div>
      <div class="form-section">
        <label for="be_business">business</label>
        <select id="be_business" name="business_id" required>${businessOptions}</select>
      </div>
      <div class="form-section">
        <label for="be_kind">kind</label>
        <select id="be_kind" name="business_kind" required>${kindOptions}</select>
        <div class="field-hint" id="be_kind_hint">${esc(BUSINESS_EMBED_DESCRIPTIONS[(opts.prefill.business_kind as BusinessEmbedKind) ?? "business_card"] ?? "")}</div>
      </div>
      <div class="form-section">
        <label for="be_pos">default position</label>
        <select id="be_pos" name="default_position">
          <option value="bottom"${opts.prefill.default_position === "bottom" ? " selected" : ""}>bottom</option>
          <option value="middle"${opts.prefill.default_position === "middle" ? " selected" : ""}>middle</option>
        </select>
      </div>
      <div class="form-actions">
        <button class="btn btn-primary" type="submit">Render & save</button>
        <a class="btn" href="/app/embeds">Cancel</a>
      </div>
    </form>
    <script>
      (function(){
        var descs = ${JSON.stringify(BUSINESS_EMBED_DESCRIPTIONS)};
        var kindEl = document.getElementById('be_kind');
        var hint = document.getElementById('be_kind_hint');
        kindEl.addEventListener('change', function(){
          hint.textContent = descs[kindEl.value] || '';
        });
      })();
    </script>
  </div>`;
}

export async function handleNewBusinessEmbedPost(
  request: Request,
  env: AppEnv,
  url: URL,
  user: User,
): Promise<
  | { redirect: Response }
  | {
      errors: string[];
      prefill: {
        name?: string;
        business_id?: string;
        business_kind?: string;
        default_position?: string;
      };
    }
> {
  const csrf = checkCsrf(request, url);
  if (csrf) return { redirect: csrf };
  const form = await request.formData();
  const raw: Record<string, string> = {};
  for (const [k, v] of form.entries()) {
    if (typeof v === "string") raw[k] = v;
  }
  const errors: string[] = [];
  const name = (raw.name ?? "").trim();
  if (!name) errors.push("name is required");
  if (name.length > 200) errors.push("name must be ≤ 200 chars");

  const businessId = Number.parseInt(raw.business_id ?? "", 10);
  if (!Number.isFinite(businessId) || businessId <= 0) {
    errors.push("pick a business");
  }
  const kindRaw = (raw.business_kind ?? "").trim();
  let businessKind: BusinessEmbedKind = "business_card";
  if (!(BUSINESS_EMBED_KINDS as readonly string[]).includes(kindRaw)) {
    errors.push(`business_kind must be one of: ${BUSINESS_EMBED_KINDS.join(", ")}`);
  } else {
    businessKind = kindRaw as BusinessEmbedKind;
  }
  const positionRaw = (raw.default_position ?? "bottom").trim();
  const defaultPosition = positionRaw === "middle" ? "middle" : "bottom";

  const prefill = {
    name,
    business_id: raw.business_id,
    business_kind: raw.business_kind,
    default_position: positionRaw,
  };
  if (errors.length > 0) return { errors, prefill };

  const business = await loadVisibleBusiness(env, user, businessId);
  if (!business) {
    return { errors: ["Business not found or not visible"], prefill };
  }
  if (business.scrape_status !== "done") {
    return {
      errors: [
        `Business "${business.name}" hasn't finished scraping yet — wait for the Maps fetch to complete before creating an embed.`,
      ],
      prefill,
    };
  }
  const html = renderBusinessEmbedHtml(businessKind, business);
  if (!html) {
    return { errors: ["Failed to render embed HTML"], prefill };
  }

  try {
    await env.CONFIG_DB.prepare(
      `INSERT INTO embeds
         (owner_id, name, kind, html, default_position, business_id, business_kind)
       VALUES (?, ?, 'iframe', ?, ?, ?, ?)`,
    )
      .bind(user.id, name, html, defaultPosition, businessId, businessKind)
      .run();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const friendly =
      msg.includes("UNIQUE") && msg.includes("name")
        ? `An embed named "${name}" already exists. Pick a different name.`
        : `DB error: ${msg}`;
    return { errors: [friendly], prefill };
  }
  return {
    redirect: flashRedirect("/app/embeds", {
      text: `Created business embed "${name}" — apply it to clusters/sites from the embed detail page.`,
      kind: "ok",
    } satisfies FlashMessage),
  };
}

/* ─── Refresh handler ─── */

/**
 * Re-render a business-backed embed's HTML from the current Business
 * data. Operator hits this after a Business re-scrape to propagate
 * changes to all live placements.
 *
 * Note: the placements themselves still hold the OLD html-rewriter
 * rules until the operator clicks "Reapply" — that's a deliberate
 * two-step (refresh embed, then re-apply to live sites) so accidental
 * Business edits don't auto-cascade to production.
 */
export async function refreshBusinessEmbed(
  env: AppEnv,
  user: User,
  embedId: number,
): Promise<{ ok: true } | { ok: false; message: string }> {
  const row = await env.CONFIG_DB.prepare(
    "SELECT id, owner_id, business_id, business_kind FROM embeds WHERE id = ? AND owner_id = ?",
  )
    .bind(embedId, user.id)
    .first<{ id: number; business_id: number | null; business_kind: string | null }>();
  if (!row) return { ok: false, message: "Embed not found" };
  if (!row.business_id || !row.business_kind) {
    return { ok: false, message: "Not a Business-backed embed" };
  }
  const business = await loadVisibleBusiness(env, user, row.business_id);
  if (!business) return { ok: false, message: "Backing Business not found or archived" };
  const kind = row.business_kind as BusinessEmbedKind;
  if (!(BUSINESS_EMBED_KINDS as readonly string[]).includes(kind)) {
    return { ok: false, message: `Unknown business_kind: ${kind}` };
  }
  const html = renderBusinessEmbedHtml(kind, business);
  await env.CONFIG_DB.prepare(
    "UPDATE embeds SET html = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND owner_id = ?",
  )
    .bind(html, embedId, user.id)
    .run();
  return { ok: true };
}

export async function handleRefreshBusinessEmbedPost(
  request: Request,
  env: AppEnv,
  url: URL,
  user: User,
  embedId: number,
): Promise<Response> {
  const csrf = checkCsrf(request, url);
  if (csrf) return csrf;
  const r = await refreshBusinessEmbed(env, user, embedId);
  if (!r.ok) {
    return flashRedirect(`/app/embeds/${embedId}`, { text: r.message, kind: "err" });
  }
  return flashRedirect(`/app/embeds/${embedId}`, {
    text: "Refreshed embed HTML from Business. Click 'Reapply to all' if you want live placements to pick up the change.",
    kind: "ok",
  });
}

/* ─── List page for picker entry ─── */

export async function loadBusinessesForEmbedPicker(
  env: AppEnv,
  user: User,
): Promise<BusinessRow[]> {
  const rows = await loadVisibleBusinesses(env, user);
  // Only completed scrapes — embeds need fields to render.
  return rows.filter((b) => b.scrape_status === "done" && !b.archived_at);
}
