/**
 * Bulk-create proxied sites — Slice 1.
 *
 * A two-step paste-URLs flow that turns 1–100 source URLs into proxied
 * sites in one go. Step 1 collects the URL list + form-level defaults
 * (zone, attestation, optional cluster); step 2 shows a preview table
 * of derived client_ids with overrides + checkboxes; step 3 creates
 * the selected rows and reports the result.
 *
 * Slice 1 design choices (locked in conversation):
 *   - subdomain_proxy mode only (in_place needs per-site DNS work)
 *   - Single zone per batch
 *   - Single attestation captures permission for every created site
 *   - No reachability probe (deferred to Slice 2)
 *   - Cap 100 rows per batch
 *   - Optional "add to cluster" applies the same cluster to every row
 *
 * Created clients use the same NEW_CLIENT_TEMPLATE shape the single-add
 * form produces — empty canonical/indexation/etc rules, status=active,
 * caching=600s, owner_id = current user.
 */
import {
  PRODUCTION_PROXY_ZONES,
  PROXY_ZONES,
  type ProxyZone,
  RESERVED_SUBDOMAINS,
} from "../../src/config/proxy-zone.js";
import type { AppEnv, FlashMessage } from "./app.js";
import { esc, fnvHash, validateConfigJson, writeAudit } from "./app.js";
import type { User } from "./auth.js";
import { type ClusterRow, loadVisibleClusters } from "./clusters.js";

export const MAX_BULK_BATCH_SIZE = 100;

const MAX_CLIENT_ID_LENGTH = 63; // RFC 1035 DNS label limit
const CLIENT_ID_PATTERN = /^[a-z0-9-]+$/;
const ATTEST_SCOPES = ["full_site", "specified_paths"] as const;
type AttestScope = (typeof ATTEST_SCOPES)[number];

/**
 * Canonical-tag policy applied to every site created in the batch.
 *   - `none`: don't inject any canonical rule (operator can add later)
 *   - `self`: inject a wildcard rule with strategy `self` — proxy is
 *     the canonical URL. SEO-aggressive; the standard duplicate-
 *     content risk PRD §13 calls out
 *   - `origin`: inject a wildcard rule with strategy `origin` — points
 *     back at the source domain. The safe default for proxies
 */
export const CANONICAL_MODES = ["none", "self", "origin"] as const;
export type CanonicalMode = (typeof CANONICAL_MODES)[number];

export interface BulkPreviewRow {
  /** The original URL the operator pasted (post-trim, post-scheme-prepend). */
  source_url: string;
  /** Bare hostname extracted from source_url (used as `source_domain`). */
  source_domain: string;
  /** Operator-supplied; defaults to the deterministic derivation. */
  client_id: string;
  /** True when client_id was rewritten to avoid a conflict with an existing or earlier-batch row. */
  renamed_from_collision: boolean;
  /** True when the row should be created (operator can uncheck in preview). */
  include: boolean;
  /**
   * Per-row proxy zone — set explicitly when the form's `zone_strategy`
   * is `mixed` (operator can override per row in the preview table).
   * For `single` mode this is always the batch-level zone.
   */
  zone: ProxyZone;
  /** Computed proxy domain — `<client_id>.<zone>`. */
  proxy_domain: string;
  /** Per-row validation problem (e.g. malformed URL); rows with errors auto-uncheck. */
  error: string | null;
}

export interface BulkFormSettings {
  /** Batch-level zone; in `mixed` strategy this is the default for new rows. */
  zone: ProxyZone;
  /**
   * `single` — every row uses `zone`. `mixed` — preview shows a
   * per-row zone selector; rows alternate between the registered
   * zones by default.
   */
  zone_strategy: "single" | "mixed";
  attested_by_email: string;
  attested_ip: string;
  scope: AttestScope;
  /**
   * When true, the operator skips capturing third-party attestation
   * (the source-domain owner's permission) and takes responsibility
   * themselves. The created config still has an `authorization`
   * field — populated with the operator's own email + the current
   * timestamp — so the schema requirement (§4) is satisfied and the
   * Worker's authorization check (§5.2) passes.
   *
   * Audit-log entries created with this flag include `bypass=true` in
   * `notes` so the trail clearly records who took the risk.
   */
  bypass_attestation: boolean;
  /** Canonical-tag policy injected into every created config. */
  canonical_mode: CanonicalMode;
  /** When non-null, every created site is also added to this cluster (id). */
  cluster_id: number | null;
  /** Initial status applied to every created site. */
  status: "active" | "paused";
}

/* ─── URL parsing + client_id derivation ─── */

/**
 * Parse the raw textarea — split on newlines, trim, drop blanks, prepend
 * https:// when scheme is missing. Returns the cleaned URL strings.
 */
export function parseSourceUrls(raw: string): string[] {
  return raw
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .map((s) => (/^https?:\/\//i.test(s) ? s : `https://${s}`));
}

/**
 * Extract the bare hostname from a URL string (for use as `source_domain`).
 * Returns null if the URL doesn't parse or has no hostname.
 */
export function hostnameFromUrl(rawUrl: string): string | null {
  try {
    const u = new URL(rawUrl);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (!u.hostname) return null;
    return u.hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Deterministic client_id from a hostname. Strips a leading `www.`,
 * replaces dots with hyphens, lowercases, and trims to the DNS label
 * limit. Reserved infrastructure labels (www, api, admin, etc.) get a
 * `-site` suffix so they aren't allowed as bare client_ids.
 *
 * Examples:
 *   www.acme.com    → acme-com
 *   acme.co.uk      → acme-co-uk
 *   bar-foo.com     → bar-foo-com
 *   www.com         → www-com  (no leftmost-label collision since the
 *                                whole derived id is "www-com")
 *   admin.acme.com  → admin-acme-com  (reserved-label check applies to
 *                                       the leftmost label of the
 *                                       resulting `<id>.<zone>`, which
 *                                       IS `admin-acme-com` — fine)
 */
export function deriveClientIdFromHostname(hostname: string): string {
  const stripped = hostname.replace(/^www\./i, "");
  let id = stripped.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  // Collapse repeated hyphens + trim leading/trailing hyphens.
  id = id.replace(/-+/g, "-").replace(/^-+|-+$/g, "");
  if (id.length === 0) return "site";
  if (id.length > MAX_CLIENT_ID_LENGTH) id = id.slice(0, MAX_CLIENT_ID_LENGTH);
  // If the derived id (used as the leftmost label of <id>.<zone>) is a
  // reserved infrastructure name, append "-site" to avoid the
  // RESERVED_SUBDOMAINS check rejecting it.
  if (RESERVED_SUBDOMAINS.has(id)) id = `${id}-site`;
  return id;
}

/**
 * Resolve client_ids across the batch with conflict checking. Each row
 * gets its derived id; if that collides with an existing client OR an
 * earlier-batch row, append `-2`, `-3`, ... until unique.
 *
 * Operator can override per-row in the preview table — `resolveOne`
 * is exported so the same conflict logic applies on confirm.
 */
export function resolveBatchClientIds(
  hostnames: readonly string[],
  existingIds: ReadonlySet<string>,
): { client_ids: string[]; renamed: boolean[] } {
  const client_ids: string[] = [];
  const renamed: boolean[] = [];
  const taken = new Set<string>(existingIds);
  for (const host of hostnames) {
    const derived = deriveClientIdFromHostname(host);
    const { id, was_renamed } = resolveOne(derived, taken);
    client_ids.push(id);
    renamed.push(was_renamed);
    taken.add(id);
  }
  return { client_ids, renamed };
}

/**
 * Single-row conflict resolver. Returns the original id when no
 * collision; otherwise appends `-2`, `-3`, ... until unique.
 */
export function resolveOne(
  derived: string,
  taken: ReadonlySet<string>,
): { id: string; was_renamed: boolean } {
  if (!taken.has(derived)) return { id: derived, was_renamed: false };
  let n = 2;
  for (;;) {
    const candidate = `${derived}-${n}`;
    if (!taken.has(candidate)) return { id: candidate, was_renamed: true };
    n += 1;
  }
}

/* ─── Form-level validation ─── */

/**
 * Validate the Step 1 form payload (settings only — URL list parsing
 * happens in `parseSourceUrls`). Cluster ID is checked at confirm time
 * against the operator's visible set.
 */
export function validateBulkFormSettings(
  raw: Record<string, string>,
): { ok: true; value: BulkFormSettings } | { ok: false; errors: string[] } {
  const errors: string[] = [];

  const zoneRaw = (raw.zone ?? "").trim();
  let zone: ProxyZone = PROXY_ZONES[0];
  if (zoneRaw.length === 0) {
    errors.push("zone is required");
  } else if (!(PROXY_ZONES as readonly string[]).includes(zoneRaw)) {
    errors.push(`zone must be one of: ${PROXY_ZONES.join(", ")}`);
  } else {
    zone = zoneRaw as ProxyZone;
  }

  const bypass = raw.bypass_attestation === "1" || raw.bypass_attestation === "true";

  const email = (raw.attested_by_email ?? "").trim();
  if (!bypass) {
    if (email.length === 0) {
      errors.push("attested_by_email is required");
    } else if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      errors.push("attested_by_email must look like an email address");
    }
  }

  const ip = (raw.attested_ip ?? "0.0.0.0").trim() || "0.0.0.0";

  const scopeRaw = (raw.scope ?? "full_site").trim();
  let scope: AttestScope = "full_site";
  if (!(ATTEST_SCOPES as readonly string[]).includes(scopeRaw)) {
    errors.push(`scope must be one of: ${ATTEST_SCOPES.join(", ")}`);
  } else {
    scope = scopeRaw as AttestScope;
  }

  const canonicalRaw = (raw.canonical_mode ?? "none").trim();
  let canonical_mode: CanonicalMode = "none";
  if ((CANONICAL_MODES as readonly string[]).includes(canonicalRaw)) {
    canonical_mode = canonicalRaw as CanonicalMode;
  } else {
    errors.push(`canonical_mode must be one of: ${CANONICAL_MODES.join(", ")}`);
  }

  const strategyRaw = (raw.zone_strategy ?? "single").trim();
  let zone_strategy: BulkFormSettings["zone_strategy"] = "single";
  if (strategyRaw === "single" || strategyRaw === "mixed") {
    zone_strategy = strategyRaw;
  } else {
    errors.push("zone_strategy must be 'single' or 'mixed'");
  }

  let cluster_id: number | null = null;
  const clusterRaw = (raw.cluster_id ?? "").trim();
  if (clusterRaw.length > 0 && clusterRaw !== "0") {
    const parsed = Number.parseInt(clusterRaw, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      errors.push("cluster_id is not a valid id");
    } else {
      cluster_id = parsed;
    }
  }

  const statusRaw = (raw.status ?? "active").trim();
  let status: BulkFormSettings["status"] = "active";
  if (statusRaw === "active" || statusRaw === "paused") {
    status = statusRaw;
  } else {
    errors.push("status must be 'active' or 'paused'");
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      zone,
      zone_strategy,
      attested_by_email: email,
      attested_ip: ip,
      scope,
      bypass_attestation: bypass,
      canonical_mode,
      cluster_id,
      status,
    },
  };
}

/**
 * Default zone for the i-th row in a `mixed` batch — round-robins
 * through the registered `PROXY_ZONES`. Operators can override per
 * row in the preview table.
 */
/**
 * Round-robin a default zone for the i-th row in a `mixed` batch.
 *
 * `zoneSet` is the set of zones to alternate between — typically
 * `PRODUCTION_PROXY_ZONES` on prod and `STAGING_PROXY_ZONES` on
 * staging. Defaults to `PRODUCTION_PROXY_ZONES` for backwards
 * compatibility with tests + callers that pre-date the staging
 * split.
 */
export function defaultZoneForRow(
  index: number,
  zoneSet: readonly ProxyZone[] = PRODUCTION_PROXY_ZONES,
): ProxyZone {
  if (zoneSet.length === 0) return PRODUCTION_PROXY_ZONES[0];
  // `?? zoneSet[0] ?? PRODUCTION_PROXY_ZONES[0]` avoids a non-null
  // assertion while satisfying noUncheckedIndexedAccess: the modulo
  // access can't actually be undefined when length > 0, but tsc
  // doesn't know that.
  return zoneSet[index % zoneSet.length] ?? zoneSet[0] ?? PRODUCTION_PROXY_ZONES[0];
}

/**
 * Build the wildcard canonical rule the bulk path injects for
 * `canonical_mode = self | origin`. Returns null for `none`.
 *
 * Wildcard `^/.*` is intentional: bulk-created sites usually proxy
 * a whole upstream domain, so one rule covers every path. Operators
 * can layer per-page canonicals later without conflict (rules later
 * in the array override earlier ones for matching paths).
 */
export function canonicalRuleForMode(mode: CanonicalMode): Record<string, unknown> | null {
  if (mode === "none") return null;
  return {
    match: "^/.*",
    strategy: { type: mode },
    sync_og_url: true,
    sync_twitter_url: true,
    sync_jsonld_url: true,
  };
}

/* ─── Build per-row config JSON ─── */

/**
 * Construct the ClientConfig JSON for a single bulk row. Uses the same
 * shape as NEW_CLIENT_TEMPLATE — empty rule arrays, status from form,
 * routing[0] proxies to the source domain, attestation from form.
 */
export function buildBulkClientConfigJson(
  row: BulkPreviewRow,
  settings: BulkFormSettings,
  attested_at: string,
  /**
   * Email to record on the authorization object when
   * `bypass_attestation` is true — the schema requires a valid email
   * and we use the operator's own as the self-attestation marker.
   * Optional; falls back to `settings.attested_by_email` (which the
   * non-bypass path validates as a real email anyway).
   */
  bypass_actor_email?: string,
): string {
  const auth_email = settings.bypass_attestation
    ? (bypass_actor_email ?? settings.attested_by_email)
    : settings.attested_by_email;
  const canonicalRule = canonicalRuleForMode(settings.canonical_mode);
  return JSON.stringify({
    client_id: row.client_id,
    proxy_domain: row.proxy_domain,
    source_domain: row.source_domain,
    mode: "subdomain_proxy",
    authorization: {
      attested_by_email: auth_email,
      attested_at,
      attested_ip: settings.attested_ip,
      scope: settings.scope,
      expires_at: null,
    },
    status: settings.status,
    routing: [
      {
        match: "^/.*",
        type: "proxy",
        origin: `https://${row.source_domain}`,
        origin_auth: { type: "none" },
      },
    ],
    redirects: { static: [], patterns: [], conditional: [] },
    canonicals: canonicalRule === null ? [] : [canonicalRule],
    schema_injections: [],
    link_rewrites: [],
    element_removals: [],
    content_injections: [],
    text_rewrites: [],
    meta_rewrites: [],
    indexation: [],
    caching: [
      {
        match: "^/.*",
        ttl_seconds: 600,
        cache_key_includes_cookies: [],
        bypass_on_cookie: [],
      },
    ],
    forms: [],
    schema_version: 1,
  });
}

/* ─── CSRF + flash (mirrors clusters.ts pattern) ─── */

function checkCsrf(request: Request, url: URL): Response | null {
  const expected = `${url.protocol}//${url.host}`;
  const origin = request.headers.get("origin");
  if (origin) {
    return origin === expected ? null : new Response("CSRF: Origin mismatch", { status: 403 });
  }
  const referer = request.headers.get("referer");
  if (referer) {
    try {
      const ref = new URL(referer);
      return ref.host === url.host && ref.protocol === url.protocol
        ? null
        : new Response("CSRF: Referer mismatch", { status: 403 });
    } catch {
      return new Response("CSRF: invalid Referer", { status: 403 });
    }
  }
  return new Response("CSRF: missing Origin and Referer", { status: 403 });
}

function flashRedirect(location: string, flash: FlashMessage): Response {
  const sep = location.includes("?") ? "&" : "?";
  const target = `${location}${sep}flash=${encodeURIComponent(flash.text)}&flash_kind=${flash.kind}`;
  return new Response(null, { status: 303, headers: { location: target } });
}

function actorIp(request: Request): string {
  return request.headers.get("cf-connecting-ip") ?? "0.0.0.0";
}

/* ─── Renderers ─── */

export interface BulkFormPrefill extends BulkFormSettings {
  raw_urls: string;
}

function rawToBulkFormPrefill(raw: Record<string, string>, rawUrls: string): BulkFormPrefill {
  return {
    zone: (PROXY_ZONES as readonly string[]).includes(raw.zone ?? "")
      ? (raw.zone as ProxyZone)
      : PROXY_ZONES[0],
    zone_strategy: raw.zone_strategy === "mixed" ? "mixed" : "single",
    attested_by_email: raw.attested_by_email ?? "",
    attested_ip: raw.attested_ip ?? "",
    scope: raw.scope === "specified_paths" || raw.scope === "full_site" ? raw.scope : "full_site",
    bypass_attestation: raw.bypass_attestation === "1" || raw.bypass_attestation === "true",
    canonical_mode: (CANONICAL_MODES as readonly string[]).includes(raw.canonical_mode ?? "")
      ? (raw.canonical_mode as CanonicalMode)
      : "none",
    cluster_id:
      raw.cluster_id && raw.cluster_id !== "0" ? Number.parseInt(raw.cluster_id, 10) : null,
    status: raw.status === "paused" ? "paused" : "active",
    raw_urls: rawUrls,
  };
}

export function renderBulkNewForm(opts: {
  prefill: BulkFormPrefill;
  visibleClusters: readonly ClusterRow[];
  errors: string[];
}): string {
  const errBox =
    opts.errors.length > 0 ? `<div class="error-box">${opts.errors.map(esc).join("\n")}</div>` : "";
  const zoneRadios = PROXY_ZONES.map(
    (z, i) =>
      `<label class="proxy-radio">
        <input type="radio" name="zone" value="${esc(z)}"${z === opts.prefill.zone ? " checked" : ""} id="bulk_zone_${i}">
        <span>*.${esc(z)}</span>
      </label>`,
  ).join("");
  const zoneStrategyRadios = `
    <label class="proxy-radio">
      <input type="radio" name="zone_strategy" value="single"${opts.prefill.zone_strategy === "single" ? " checked" : ""}>
      <span>single zone (use the one above)</span>
    </label>
    <label class="proxy-radio">
      <input type="radio" name="zone_strategy" value="mixed"${opts.prefill.zone_strategy === "mixed" ? " checked" : ""}>
      <span>mixed (alternate between registered zones; override per row in preview)</span>
    </label>`;
  const canonicalRadios = CANONICAL_MODES.map(
    (m) =>
      `<label class="proxy-radio">
        <input type="radio" name="canonical_mode" value="${esc(m)}"${m === opts.prefill.canonical_mode ? " checked" : ""}>
        <span>${esc(m)}</span>
      </label>`,
  ).join("");
  const clusterOptions = [
    `<option value="">— don't add to a cluster —</option>`,
    ...opts.visibleClusters.map(
      (c) =>
        `<option value="${c.id}"${opts.prefill.cluster_id === c.id ? " selected" : ""}>${esc(c.label)} (${esc(c.type)})</option>`,
    ),
  ].join("");
  return `<div class="crumbs"><a href="/app/clients">← Sites</a></div>
    <h1>Bulk-create sites</h1>
    <p class="subtitle">Paste 1–${MAX_BULK_BATCH_SIZE} source URLs (one per line). Each becomes a proxied site under the chosen zone, sharing one attestation. Step 2 lets you preview + override before commit.</p>
    ${errBox}
    <form class="editor" method="POST" action="/app/clients/bulk-new/preview">
      <div class="form-section">
        <h2 style="margin-top:0">Source URLs</h2>
        <p class="field-hint" style="margin:0 0 .6rem">One per line. Schemes optional (we prepend <code>https://</code>). Up to ${MAX_BULK_BATCH_SIZE}.</p>
        <textarea id="bulk_urls" name="raw_urls" rows="10" required style="font-family:var(--mono);font-size:.85rem;width:100%;padding:.5rem .65rem;border:1px solid var(--border-strong);border-radius:var(--radius);background:var(--bg-elevated);color:var(--fg)" placeholder="https://acme.com&#10;otherco.net&#10;https://thirdsite.io">${esc(opts.prefill.raw_urls)}</textarea>
      </div>
      <div class="form-section">
        <h2 style="margin-top:0">Shared settings</h2>
        <div class="form-grid">
          <div class="full-width">
            <label>zone</label>
            <div class="proxy-mode">${zoneRadios}</div>
            <div class="field-hint">Every site in this batch gets a subdomain on the chosen zone. Use the single-add form if you need <code>in_place</code> mode or a custom domain.</div>
          </div>
          <div class="full-width">
            <label>zone strategy</label>
            <div class="proxy-mode">${zoneStrategyRadios}</div>
            <div class="field-hint"><code>mixed</code> alternates between the registered zones (round-robin) and lets you override per row in the preview.</div>
          </div>
          <div class="full-width">
            <label>canonical_mode <span style="color:var(--fg-muted);font-weight:400">(injects a wildcard canonical rule into every site)</span></label>
            <div class="proxy-mode">${canonicalRadios}</div>
            <div class="field-hint"><code>none</code>: no rule — add canonicals later. <code>self</code>: proxy is canonical (max SEO aggression — duplicate-content risk). <code>origin</code>: source domain is canonical (safe default for proxies).</div>
          </div>
          <div>
            <label for="bulk_status">status</label>
            <select id="bulk_status" name="status">
              <option value="active"${opts.prefill.status === "active" ? " selected" : ""}>active</option>
              <option value="paused"${opts.prefill.status === "paused" ? " selected" : ""}>paused</option>
            </select>
          </div>
          <div>
            <label for="bulk_cluster">add all to cluster <span style="color:var(--fg-muted);font-weight:400">(optional)</span></label>
            <select id="bulk_cluster" name="cluster_id">${clusterOptions}</select>
            <div class="field-hint">Every created site joins this cluster. Skip to leave the sites un-clustered.</div>
          </div>
        </div>
      </div>
      <div class="form-section">
        <h2 style="margin-top:0">Permission attestation</h2>
        <p class="field-hint" style="margin:0 0 .6rem">One attestation captures permission for every site in this batch.</p>
        <label class="proxy-radio" style="margin-bottom:.6rem">
          <input type="checkbox" name="bypass_attestation" value="1"${opts.prefill.bypass_attestation ? " checked" : ""}>
          <span><strong>Bypass attestation</strong> — I take responsibility for proxying these sites without third-party permission. The created sites will be self-attested (operator email + now).</span>
        </label>
        <div class="form-grid">
          <div>
            <label for="bulk_email">attested_by_email</label>
            <input id="bulk_email" name="attested_by_email" type="email" value="${esc(opts.prefill.attested_by_email)}">
            <div class="field-hint">Ignored when <code>bypass</code> is checked.</div>
          </div>
          <div>
            <label for="bulk_ip">attested_ip <span style="color:var(--fg-muted);font-weight:400">(optional)</span></label>
            <input id="bulk_ip" name="attested_ip" type="text" placeholder="0.0.0.0" value="${esc(opts.prefill.attested_ip)}">
          </div>
          <div>
            <label for="bulk_scope">scope</label>
            <select id="bulk_scope" name="scope">
              <option value="full_site"${opts.prefill.scope === "full_site" ? " selected" : ""}>full_site</option>
              <option value="specified_paths"${opts.prefill.scope === "specified_paths" ? " selected" : ""}>specified_paths</option>
            </select>
          </div>
        </div>
      </div>
      <div class="form-actions">
        <button class="btn btn-primary" type="submit">Preview →</button>
        <a class="btn" href="/app/clients">Cancel</a>
      </div>
    </form>`;
}

export function renderBulkPreview(opts: {
  rows: readonly BulkPreviewRow[];
  settings: BulkFormSettings;
  clusterLabel: string | null;
  /**
   * Clusters the operator can choose from in the editable picker on
   * the preview page. When omitted, the picker is hidden and the
   * step-1 cluster selection is preserved as a hidden input (back-
   * compat for callers that haven't been updated yet).
   */
  visibleClusters?: readonly ClusterRow[];
  errors: string[];
}): string {
  const errBox =
    opts.errors.length > 0 ? `<div class="error-box">${opts.errors.map(esc).join("\n")}</div>` : "";
  // When visibleClusters is supplied we render the cluster picker
  // inline and DROP the cluster_id hidden field (the picker's <select>
  // posts the field instead). Otherwise keep the hidden input so the
  // step-1 cluster selection still rides through.
  const clusterIdHidden =
    opts.visibleClusters !== undefined
      ? ""
      : `<input type="hidden" name="cluster_id" value="${opts.settings.cluster_id ?? ""}">`;
  const settingsHidden = `
    <input type="hidden" name="zone" value="${esc(opts.settings.zone)}">
    <input type="hidden" name="zone_strategy" value="${esc(opts.settings.zone_strategy)}">
    <input type="hidden" name="canonical_mode" value="${esc(opts.settings.canonical_mode)}">
    <input type="hidden" name="bypass_attestation" value="${opts.settings.bypass_attestation ? "1" : "0"}">
    <input type="hidden" name="attested_by_email" value="${esc(opts.settings.attested_by_email)}">
    <input type="hidden" name="attested_ip" value="${esc(opts.settings.attested_ip)}">
    <input type="hidden" name="scope" value="${esc(opts.settings.scope)}">
    ${clusterIdHidden}
    <input type="hidden" name="status" value="${esc(opts.settings.status)}">`;
  const clusterPicker =
    opts.visibleClusters !== undefined
      ? (() => {
          const options = [
            `<option value=""${opts.settings.cluster_id == null ? " selected" : ""}>— don't add to a cluster —</option>`,
            ...opts.visibleClusters.map(
              (c) =>
                `<option value="${c.id}"${opts.settings.cluster_id === c.id ? " selected" : ""}>${esc(c.label)} (${esc(c.type)})</option>`,
            ),
          ].join("");
          return `<div class="form-section">
        <label for="preview_cluster" style="display:block;font-weight:500;margin-bottom:.35rem">Add all created sites to cluster <span style="color:var(--fg-muted);font-weight:400">(optional)</span></label>
        <div style="display:flex;gap:.6rem;align-items:center;flex-wrap:wrap">
          <select id="preview_cluster" name="cluster_id" style="flex:1;min-width:240px">${options}</select>
          <a class="btn" href="/app/clusters/new" target="_blank" rel="noopener" title="Opens cluster-creation page in a new tab; reload this page after creating to pick it.">+ New cluster ↗</a>
        </div>
        <div class="field-hint" style="margin-top:.4rem">Created a new cluster in the other tab? Reload this preview page (your row selections will reset) and pick it from the list.</div>
      </div>`;
        })()
      : "";
  const mixedZones = opts.settings.zone_strategy === "mixed";
  const zoneCell = (r: BulkPreviewRow, i: number): string => {
    if (!mixedZones) {
      return `<input type="hidden" name="zone_${i}" value="${esc(r.zone)}">`;
    }
    const opts2 = PROXY_ZONES.map(
      (z) => `<option value="${esc(z)}"${z === r.zone ? " selected" : ""}>${esc(z)}</option>`,
    ).join("");
    return `<select name="zone_${i}" style="font-family:var(--mono);font-size:.78rem;padding:.25rem .35rem;width:100%;box-sizing:border-box">${opts2}</select>`;
  };
  const zoneHeader = mixedZones ? "<th>zone</th>" : "";
  const tbody = opts.rows
    .map((r, i) => {
      const errCell = r.error
        ? `<td colspan="${mixedZones ? 4 : 3}" style="color:var(--red);font-style:italic">${esc(r.error)}</td>`
        : `<td><input type="text" name="client_id_${i}" value="${esc(r.client_id)}" pattern="[a-z0-9-]+" maxlength="63" style="font-family:var(--mono);font-size:.82rem;padding:.3rem .5rem;width:100%;box-sizing:border-box">${r.renamed_from_collision ? `<div style="color:var(--amber);font-size:.7rem;margin-top:.15rem">renamed (id was taken)</div>` : ""}</td>
            ${mixedZones ? `<td>${zoneCell(r, i)}</td>` : zoneCell(r, i)}
            <td class="mono" style="font-size:.8rem;color:var(--fg-muted)">${esc(r.proxy_domain)}</td>
            <td class="mono" style="font-size:.8rem;color:var(--fg-muted)">${esc(r.source_domain)}</td>`;
      const checked = r.include && !r.error ? " checked" : "";
      const disabled = r.error ? " disabled" : "";
      return `<tr>
        <td><input type="checkbox" name="include_${i}" value="1"${checked}${disabled}><input type="hidden" name="source_url_${i}" value="${esc(r.source_url)}"></td>
        ${errCell}
      </tr>`;
    })
    .join("");
  const settingsSummary = `
    <p class="subtitle">
      Zone: <code>${esc(opts.settings.zone)}</code>${opts.settings.zone_strategy === "mixed" ? " (mixed)" : ""} ·
      Canonical: <code>${esc(opts.settings.canonical_mode)}</code> ·
      Status: <code>${esc(opts.settings.status)}</code> ·
      ${opts.settings.bypass_attestation ? `Attestation: <code style="color:var(--amber)">BYPASSED</code>` : `Attestation: <code>${esc(opts.settings.attested_by_email)}</code> (${esc(opts.settings.scope)})`}
      ${opts.clusterLabel ? `· Cluster: <code>${esc(opts.clusterLabel)}</code>` : ""}
    </p>`;
  const validCount = opts.rows.filter((r) => !r.error).length;
  return `<div class="crumbs"><a href="/app/clients/bulk-new">← Bulk-create sites</a></div>
    <h1>Preview — ${validCount} site${validCount === 1 ? "" : "s"} to create</h1>
    ${settingsSummary}
    ${errBox}
    <form class="editor" method="POST" action="/app/clients/bulk-new/confirm">
      ${settingsHidden}
      <input type="hidden" name="row_count" value="${opts.rows.length}">
      ${clusterPicker}
      <div class="form-section">
        <p class="field-hint" style="margin:0 0 .6rem">Uncheck rows you don't want to create. Override <code>client_id</code> if the auto-derived value isn't what you want — must be lowercase letters, digits, or hyphens.</p>
        <table class="data" style="margin:0">
          <thead><tr><th style="width:2.5rem"></th><th>client_id</th>${zoneHeader}<th>proxy_domain</th><th>source_domain</th></tr></thead>
          <tbody>${tbody}</tbody>
        </table>
      </div>
      <div class="form-actions">
        <button class="btn btn-primary" type="submit">Create selected</button>
        <a class="btn" href="/app/clients/bulk-new">← Back to edit</a>
      </div>
    </form>`;
}

export function renderBulkResult(opts: {
  created: string[];
  skipped: Array<{ source_url: string; reason: string }>;
  clusterLabel: string | null;
}): string {
  const createdList =
    opts.created.length === 0
      ? '<div class="empty">No sites were created.</div>'
      : `<ul style="margin:0;padding-left:1.2rem">${opts.created
          .map((id) => `<li class="mono"><a href="/app/clients/${esc(id)}">${esc(id)}</a></li>`)
          .join("")}</ul>`;
  const skippedList =
    opts.skipped.length === 0
      ? ""
      : `<div class="card">
          <h2 style="margin-top:0">Skipped (${opts.skipped.length})</h2>
          <table class="data"><thead><tr><th>Source URL</th><th>Reason</th></tr></thead><tbody>
            ${opts.skipped.map((s) => `<tr><td class="mono" style="font-size:.85rem">${esc(s.source_url)}</td><td style="color:var(--red);font-size:.85rem">${esc(s.reason)}</td></tr>`).join("")}
          </tbody></table>
        </div>`;
  return `<div class="crumbs"><a href="/app/clients">← Sites</a></div>
    <h1>Bulk-create result</h1>
    <p class="subtitle">${opts.created.length} created${opts.clusterLabel ? `, all added to cluster <code>${esc(opts.clusterLabel)}</code>` : ""}.${opts.skipped.length > 0 ? ` ${opts.skipped.length} skipped — see below.` : ""}</p>
    <div class="actions-row">
      <a class="btn btn-primary" href="/app/clients">Back to sites</a>
      <a class="btn" href="/app/clients/bulk-new">Bulk-create more</a>
    </div>
    <div class="card">
      <h2 style="margin-top:0">Created (${opts.created.length})</h2>
      ${createdList}
    </div>
    ${skippedList}`;
}

/* ─── POST handlers ─── */

export async function handleBulkPreviewPost(
  request: Request,
  env: AppEnv,
  url: URL,
  user: User,
): Promise<{
  step1Render?: { errors: string[]; prefill: BulkFormPrefill; visibleClusters: ClusterRow[] };
  step2Render?: {
    rows: BulkPreviewRow[];
    settings: BulkFormSettings;
    clusterLabel: string | null;
    visibleClusters: readonly ClusterRow[];
  };
  response?: Response;
}> {
  const csrf = checkCsrf(request, url);
  if (csrf) return { response: csrf };
  const form = await request.formData();
  const raw: Record<string, string> = {};
  for (const [k, v] of form.entries()) {
    if (typeof v === "string") raw[k] = v;
  }
  const rawUrls = raw.raw_urls ?? "";
  const visibleClusters = await loadVisibleClusters(env, user);

  const settingsValidation = validateBulkFormSettings(raw);
  const urls = parseSourceUrls(rawUrls);

  const errors: string[] = [];
  if (!settingsValidation.ok) errors.push(...settingsValidation.errors);
  if (urls.length === 0) errors.push("Paste at least one source URL");
  if (urls.length > MAX_BULK_BATCH_SIZE) {
    errors.push(
      `Got ${urls.length} URLs — cap is ${MAX_BULK_BATCH_SIZE}. Split into multiple batches.`,
    );
  }

  // If a cluster was selected, confirm it's visible to the operator.
  let clusterLabel: string | null = null;
  if (settingsValidation.ok && settingsValidation.value.cluster_id != null) {
    const c = visibleClusters.find((c) => c.id === settingsValidation.value.cluster_id);
    if (!c) {
      errors.push("Selected cluster not found or not visible to you");
    } else {
      clusterLabel = c.label;
    }
  }

  if (errors.length > 0 || !settingsValidation.ok) {
    return {
      step1Render: {
        errors,
        prefill: rawToBulkFormPrefill(raw, rawUrls),
        visibleClusters,
      },
    };
  }

  // Derive client_ids + check for collisions against existing clients.
  // Per-row hostname extraction can fail (malformed URLs) — those rows
  // get error messages instead of being checked by default.
  const hostnames: string[] = [];
  const hostErrors: (string | null)[] = [];
  for (const u of urls) {
    const h = hostnameFromUrl(u);
    if (h === null) {
      hostnames.push("");
      hostErrors.push(`couldn't parse URL`);
    } else {
      hostnames.push(h);
      hostErrors.push(null);
    }
  }
  const existing = await env.CONFIG_DB.prepare("SELECT client_id FROM clients").all<{
    client_id: string;
  }>();
  const existingIds = new Set((existing.results ?? []).map((r) => r.client_id));
  // Resolve ids only for rows whose hostname parsed; others get empty
  // ids and error states so the preview row still renders.
  const validHostnames = hostnames.map((h) => (h.length > 0 ? h : "x"));
  const resolved = resolveBatchClientIds(validHostnames, existingIds);
  const settings = settingsValidation.value;
  const rows: BulkPreviewRow[] = urls.map((src, i) => {
    const err = hostErrors[i];
    const h = hostnames[i] ?? "";
    const id = resolved.client_ids[i] ?? "";
    const renamed = resolved.renamed[i] ?? false;
    const rowZone = settings.zone_strategy === "mixed" ? defaultZoneForRow(i) : settings.zone;
    return {
      source_url: src,
      source_domain: h,
      client_id: err ? "" : id,
      renamed_from_collision: renamed && !err,
      include: !err,
      zone: rowZone,
      proxy_domain: err ? "" : `${id}.${rowZone}`,
      error: err ?? null,
    };
  });
  return { step2Render: { rows, settings, clusterLabel, visibleClusters } };
}

export async function handleBulkConfirmPost(
  request: Request,
  env: AppEnv,
  url: URL,
  user: User,
): Promise<{
  result?: {
    created: string[];
    skipped: Array<{ source_url: string; reason: string }>;
    clusterLabel: string | null;
  };
  response?: Response;
}> {
  const csrf = checkCsrf(request, url);
  if (csrf) return { response: csrf };
  const form = await request.formData();
  const raw: Record<string, string> = {};
  for (const [k, v] of form.entries()) {
    if (typeof v === "string") raw[k] = v;
  }
  const settingsValidation = validateBulkFormSettings(raw);
  if (!settingsValidation.ok) {
    return {
      response: flashRedirect("/app/clients/bulk-new", {
        text: `Bulk create failed: ${settingsValidation.errors.join("; ")}`,
        kind: "err",
      }),
    };
  }
  const settings = settingsValidation.value;
  const rowCount = Number.parseInt(raw.row_count ?? "0", 10);
  if (!Number.isFinite(rowCount) || rowCount <= 0 || rowCount > MAX_BULK_BATCH_SIZE) {
    return {
      response: flashRedirect("/app/clients/bulk-new", {
        text: "Invalid batch — re-run from the bulk-create form",
        kind: "err",
      }),
    };
  }

  const visibleClusters = await loadVisibleClusters(env, user);
  let clusterLabel: string | null = null;
  if (settings.cluster_id != null) {
    const c = visibleClusters.find((c) => c.id === settings.cluster_id);
    if (!c) {
      return {
        response: flashRedirect("/app/clients/bulk-new", {
          text: "Selected cluster not found or not visible to you",
          kind: "err",
        }),
      };
    }
    clusterLabel = c.label;
  }

  // Re-validate every checked row server-side (hidden source_url +
  // operator-supplied client_id). Operator could have edited the
  // hidden field, so we re-run id derivation + collision check.
  const existing = await env.CONFIG_DB.prepare("SELECT client_id FROM clients").all<{
    client_id: string;
  }>();
  const taken = new Set((existing.results ?? []).map((r) => r.client_id));
  const created: string[] = [];
  const skipped: Array<{ source_url: string; reason: string }> = [];
  const attested_at = new Date().toISOString();
  const ip = actorIp(request);

  for (let i = 0; i < rowCount; i++) {
    const includeRaw = raw[`include_${i}`];
    if (includeRaw !== "1") continue;
    const sourceUrl = raw[`source_url_${i}`] ?? "";
    const requestedId = (raw[`client_id_${i}`] ?? "").trim().toLowerCase();
    const hostname = hostnameFromUrl(sourceUrl);
    if (hostname === null) {
      skipped.push({ source_url: sourceUrl, reason: "couldn't parse source URL" });
      continue;
    }
    if (requestedId.length === 0 || !CLIENT_ID_PATTERN.test(requestedId)) {
      skipped.push({
        source_url: sourceUrl,
        reason: "client_id missing or has invalid characters",
      });
      continue;
    }
    if (requestedId.length > MAX_CLIENT_ID_LENGTH) {
      skipped.push({
        source_url: sourceUrl,
        reason: `client_id exceeds ${MAX_CLIENT_ID_LENGTH} chars`,
      });
      continue;
    }
    if (RESERVED_SUBDOMAINS.has(requestedId)) {
      skipped.push({
        source_url: sourceUrl,
        reason: `client_id "${requestedId}" is reserved`,
      });
      continue;
    }
    if (taken.has(requestedId)) {
      skipped.push({
        source_url: sourceUrl,
        reason: `client_id "${requestedId}" already exists or duplicate in batch`,
      });
      continue;
    }
    // Per-row zone resolution (mixed strategy uses the hidden
    // `zone_<i>` field; single strategy ignores it and uses the
    // batch-level zone).
    let rowZone: ProxyZone = settings.zone;
    if (settings.zone_strategy === "mixed") {
      const zoneRaw = (raw[`zone_${i}`] ?? "").trim();
      if ((PROXY_ZONES as readonly string[]).includes(zoneRaw)) {
        rowZone = zoneRaw as ProxyZone;
      } else {
        rowZone = defaultZoneForRow(i);
      }
    }
    const proxyDomain = `${requestedId}.${rowZone}`;
    const row: BulkPreviewRow = {
      source_url: sourceUrl,
      source_domain: hostname,
      client_id: requestedId,
      renamed_from_collision: false,
      include: true,
      zone: rowZone,
      proxy_domain: proxyDomain,
      error: null,
    };
    const json = buildBulkClientConfigJson(row, settings, attested_at, user.email);
    // Pass through the same Zod + invariant validation the single-add
    // path uses. Catches any oddity in the synthesized config (e.g.
    // bad source_domain shape) before it reaches D1.
    const validation = validateConfigJson(json);
    if (!validation.ok) {
      skipped.push({
        source_url: sourceUrl,
        reason: validation.error.split("\n")[0] ?? "validation failed",
      });
      continue;
    }
    try {
      await env.CONFIG_DB.prepare(
        `INSERT INTO clients (client_id, proxy_domain, source_domain, status, config_json, schema_version, owner_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
        .bind(requestedId, proxyDomain, hostname, settings.status, json, 1, user.id)
        .run();
      await Promise.all([
        env.CONFIG_KV.put(`config:${requestedId}`, json),
        env.CONFIG_KV.put(`domain:${proxyDomain}`, requestedId),
      ]);
      if (settings.cluster_id != null) {
        await env.CONFIG_DB.prepare(
          "INSERT INTO cluster_members (cluster_id, client_id) VALUES (?, ?)",
        )
          .bind(settings.cluster_id, requestedId)
          .run();
      }
      try {
        const noteParts = [
          `bulk_create: zone=${rowZone}`,
          `cluster_id=${settings.cluster_id ?? "none"}`,
          `canonical=${settings.canonical_mode}`,
        ];
        if (settings.bypass_attestation) noteParts.push("bypass=true");
        await writeAudit(env, {
          client_id: requestedId,
          actor_email: user.email,
          actor_ip: ip,
          event_type: settings.bypass_attestation ? "config_create_bypass" : "config_create",
          before_hash: null,
          after_hash: fnvHash(json),
          previous_status: null,
          new_status: settings.status,
          notes: noteParts.join(" "),
        });
      } catch (e) {
        console.warn("bulk-create: audit write failed", e);
      }
      taken.add(requestedId);
      created.push(requestedId);
    } catch (e) {
      const message = e instanceof Error ? e.message : "unknown error";
      skipped.push({ source_url: sourceUrl, reason: `DB error: ${message}` });
    }
  }
  return { result: { created, skipped, clusterLabel } };
}
