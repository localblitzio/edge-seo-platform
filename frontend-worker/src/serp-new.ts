/**
 * Create sites from a Google SERP — `/app/clients/serp-new`.
 *
 * Three-step flow:
 *   1. Query form  — keyword + locale + count + shared settings
 *      (zone strategy, canonical mode, bypass-attestation flag).
 *   2. Results picker — DataForSEO fetch happens here, results are
 *      shown with checkboxes. Operator picks which to proxy.
 *   3. Preview + confirm — feeds straight into `handleBulkConfirmPost`
 *      (same codepath the paste-URLs flow uses).
 *
 * Defaults differ from the regular bulk-create form:
 *   - canonical_mode defaults to `self` (the intent is to outrank the
 *     source; the regular bulk form defaults to `none`)
 *   - zone_strategy defaults to `mixed` (per the operator's request to
 *     alternate between the registered zones)
 *
 * Permission warning: bypass-attestation is intentionally exposed
 * here because operators typically don't own the SERP results they
 * want to clone. Audit log records `config_create_bypass` when used.
 */

import { PROXY_ZONES, type ProxyZone } from "../../src/config/proxy-zone.js";
import type { AppEnv } from "./app.js";
import { esc } from "./app.js";
import type { User } from "./auth.js";
import {
  type BulkFormSettings,
  type BulkPreviewRow,
  CANONICAL_MODES,
  type CanonicalMode,
  defaultZoneForRow,
  hostnameFromUrl,
  renderBulkPreview,
  resolveBatchClientIds,
} from "./bulk-clients.js";
import { type ClusterRow, loadVisibleClusters } from "./clusters.js";
import {
  DataForSeoApiError,
  DataForSeoConfigError,
  SERP_LANGUAGES,
  SERP_LOCATIONS,
  SERP_MAX_DEPTH,
  type SerpQuery,
  type SerpResult,
  fetchSerpResults,
} from "./dataforseo.js";

/* ─── Form prefill / validation ─── */

export interface SerpQueryFormPrefill {
  keyword: string;
  location_code: number;
  language_code: string;
  device: "desktop" | "mobile";
  depth: number;
  zone_strategy: "single" | "mixed";
  zone: ProxyZone;
  canonical_mode: CanonicalMode;
  bypass_attestation: boolean;
  cluster_id: number | null;
  status: "active" | "paused";
}

export function defaultSerpPrefill(): SerpQueryFormPrefill {
  return {
    keyword: "",
    location_code: SERP_LOCATIONS[0].code,
    language_code: SERP_LANGUAGES[0].code,
    device: "desktop",
    depth: SERP_MAX_DEPTH,
    zone_strategy: "mixed",
    zone: PROXY_ZONES[0],
    canonical_mode: "self",
    bypass_attestation: false,
    cluster_id: null,
    status: "active",
  };
}

export interface SerpQueryValidated {
  query: SerpQuery;
  settings: Omit<BulkFormSettings, "attested_by_email" | "attested_ip" | "scope">;
}

/**
 * Validate the step-1 SERP form. Returns either the parsed query +
 * shared settings to feed forward, or a flat list of errors.
 */
export function validateSerpForm(
  raw: Record<string, string>,
):
  | { ok: true; value: SerpQueryValidated }
  | { ok: false; errors: string[]; prefill: SerpQueryFormPrefill } {
  const errors: string[] = [];
  const prefill = rawToSerpPrefill(raw);

  const keyword = (raw.keyword ?? "").trim();
  if (keyword.length === 0) errors.push("keyword is required");
  if (keyword.length > 200) errors.push("keyword must be ≤ 200 chars");

  const locationCode = Number.parseInt((raw.location_code ?? "").trim(), 10);
  if (!Number.isFinite(locationCode) || locationCode <= 0) {
    errors.push("location_code is invalid");
  } else if (!SERP_LOCATIONS.some((l) => l.code === locationCode)) {
    errors.push("location_code is not one of the offered options");
  }

  const languageCode = (raw.language_code ?? "").trim();
  if (!SERP_LANGUAGES.some((l) => l.code === languageCode)) {
    errors.push("language_code is not one of the offered options");
  }

  const device = raw.device === "mobile" ? "mobile" : "desktop";

  const depth = Number.parseInt((raw.depth ?? "").trim(), 10);
  if (!Number.isFinite(depth) || depth < 1 || depth > SERP_MAX_DEPTH) {
    errors.push(`depth must be 1..${SERP_MAX_DEPTH}`);
  }

  const zoneRaw = (raw.zone ?? "").trim();
  let zone: ProxyZone = PROXY_ZONES[0];
  if (!(PROXY_ZONES as readonly string[]).includes(zoneRaw)) {
    errors.push(`zone must be one of: ${PROXY_ZONES.join(", ")}`);
  } else {
    zone = zoneRaw as ProxyZone;
  }

  const zone_strategy =
    raw.zone_strategy === "mixed" ? "mixed" : raw.zone_strategy === "single" ? "single" : "mixed";

  const canonicalRaw = (raw.canonical_mode ?? "self").trim();
  let canonical_mode: CanonicalMode = "self";
  if ((CANONICAL_MODES as readonly string[]).includes(canonicalRaw)) {
    canonical_mode = canonicalRaw as CanonicalMode;
  } else {
    errors.push(`canonical_mode must be one of: ${CANONICAL_MODES.join(", ")}`);
  }

  const bypass = raw.bypass_attestation === "1" || raw.bypass_attestation === "true";

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

  const status: BulkFormSettings["status"] = raw.status === "paused" ? "paused" : "active";

  if (errors.length > 0) return { ok: false, errors, prefill };

  return {
    ok: true,
    value: {
      query: {
        keyword,
        location_code: locationCode,
        language_code: languageCode,
        device,
        depth,
      },
      settings: {
        zone,
        zone_strategy,
        canonical_mode,
        bypass_attestation: bypass,
        cluster_id,
        status,
      },
    },
  };
}

function rawToSerpPrefill(raw: Record<string, string>): SerpQueryFormPrefill {
  const def = defaultSerpPrefill();
  const locationCode = Number.parseInt(raw.location_code ?? "", 10);
  const depth = Number.parseInt(raw.depth ?? "", 10);
  return {
    keyword: raw.keyword ?? "",
    location_code:
      Number.isFinite(locationCode) && SERP_LOCATIONS.some((l) => l.code === locationCode)
        ? locationCode
        : def.location_code,
    language_code: SERP_LANGUAGES.some((l) => l.code === (raw.language_code ?? ""))
      ? (raw.language_code ?? def.language_code)
      : def.language_code,
    device: raw.device === "mobile" ? "mobile" : "desktop",
    depth: Number.isFinite(depth) && depth >= 1 && depth <= SERP_MAX_DEPTH ? depth : def.depth,
    zone: (PROXY_ZONES as readonly string[]).includes(raw.zone ?? "")
      ? (raw.zone as ProxyZone)
      : def.zone,
    zone_strategy: raw.zone_strategy === "single" ? "single" : "mixed",
    canonical_mode: (CANONICAL_MODES as readonly string[]).includes(raw.canonical_mode ?? "")
      ? (raw.canonical_mode as CanonicalMode)
      : def.canonical_mode,
    bypass_attestation: raw.bypass_attestation === "1" || raw.bypass_attestation === "true",
    cluster_id:
      raw.cluster_id && raw.cluster_id !== "0" ? Number.parseInt(raw.cluster_id, 10) : null,
    status: raw.status === "paused" ? "paused" : "active",
  };
}

/* ─── Convert SERP results to bulk preview rows ─── */

/**
 * Pure transform: SERP results → bulk preview rows. Mirrors the
 * paste-URLs path's `handleBulkPreviewPost` row-building but starts
 * from `SerpResult[]` instead of raw URL text.
 *
 * Reuses `deriveClientIdFromHostname` + `resolveBatchClientIds` from
 * bulk-clients so the id derivation is identical.
 */
export function serpResultsToPreviewRows(
  results: readonly SerpResult[],
  settings: BulkFormSettings,
  existingIds: ReadonlySet<string>,
): BulkPreviewRow[] {
  const hostnames: (string | null)[] = results.map((r) => hostnameFromUrl(r.url));
  const validHosts = hostnames.map((h) => h ?? "x");
  const resolved = resolveBatchClientIds(validHosts, existingIds);
  return results.map((r, i) => {
    const h = hostnames[i];
    const id = resolved.client_ids[i] ?? "";
    const renamed = resolved.renamed[i] ?? false;
    const err = h === null ? "couldn't parse URL" : null;
    const rowZone = settings.zone_strategy === "mixed" ? defaultZoneForRow(i) : settings.zone;
    return {
      source_url: r.url,
      source_domain: h ?? "",
      client_id: err ? "" : id,
      renamed_from_collision: renamed && !err,
      include: !err,
      zone: rowZone,
      proxy_domain: err ? "" : `${id}.${rowZone}`,
      error: err,
    };
  });
}

/* ─── CSRF helper (mirrors bulk-clients.ts) ─── */

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

/* ─── Renderers ─── */

export function renderSerpNewForm(opts: {
  prefill: SerpQueryFormPrefill;
  visibleClusters: readonly ClusterRow[];
  errors: string[];
}): string {
  const errBox =
    opts.errors.length > 0 ? `<div class="error-box">${opts.errors.map(esc).join("\n")}</div>` : "";
  const locationOptions = SERP_LOCATIONS.map(
    (l) =>
      `<option value="${l.code}"${l.code === opts.prefill.location_code ? " selected" : ""}>${esc(l.label)}</option>`,
  ).join("");
  const languageOptions = SERP_LANGUAGES.map(
    (l) =>
      `<option value="${esc(l.code)}"${l.code === opts.prefill.language_code ? " selected" : ""}>${esc(l.label)}</option>`,
  ).join("");
  const zoneRadios = PROXY_ZONES.map(
    (z, i) =>
      `<label class="proxy-radio">
        <input type="radio" name="zone" value="${esc(z)}"${z === opts.prefill.zone ? " checked" : ""} id="serp_zone_${i}">
        <span>*.${esc(z)}</span>
      </label>`,
  ).join("");
  const zoneStrategyRadios = `
    <label class="proxy-radio">
      <input type="radio" name="zone_strategy" value="single"${opts.prefill.zone_strategy === "single" ? " checked" : ""}>
      <span>single zone</span>
    </label>
    <label class="proxy-radio">
      <input type="radio" name="zone_strategy" value="mixed"${opts.prefill.zone_strategy === "mixed" ? " checked" : ""}>
      <span>mixed (alternate; override per row)</span>
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
    <h1>Create sites from SERP</h1>
    <p class="subtitle">Run a Google SERP query via DataForSEO and pick which results to proxy. Default: canonical=<code>self</code>, zones alternate, attestation bypassed. Every call charges your DataForSEO account.</p>
    ${errBox}
    <form class="editor" method="POST" action="/app/clients/serp-new/preview">
      <div class="form-section">
        <h2 style="margin-top:0">SERP query</h2>
        <div class="form-grid">
          <div class="full-width">
            <label for="serp_keyword">keyword</label>
            <input id="serp_keyword" name="keyword" type="text" required maxlength="200" value="${esc(opts.prefill.keyword)}" placeholder="best widgets near me">
          </div>
          <div>
            <label for="serp_location">location</label>
            <select id="serp_location" name="location_code">${locationOptions}</select>
          </div>
          <div>
            <label for="serp_language">language</label>
            <select id="serp_language" name="language_code">${languageOptions}</select>
          </div>
          <div>
            <label for="serp_device">device</label>
            <select id="serp_device" name="device">
              <option value="desktop"${opts.prefill.device === "desktop" ? " selected" : ""}>desktop</option>
              <option value="mobile"${opts.prefill.device === "mobile" ? " selected" : ""}>mobile</option>
            </select>
          </div>
          <div>
            <label for="serp_depth">results to fetch (1–${SERP_MAX_DEPTH})</label>
            <input id="serp_depth" name="depth" type="number" min="1" max="${SERP_MAX_DEPTH}" required value="${opts.prefill.depth}">
          </div>
        </div>
      </div>
      <div class="form-section">
        <h2 style="margin-top:0">Proxy settings (apply to selected results)</h2>
        <div class="form-grid">
          <div class="full-width">
            <label>zone</label>
            <div class="proxy-mode">${zoneRadios}</div>
          </div>
          <div class="full-width">
            <label>zone strategy</label>
            <div class="proxy-mode">${zoneStrategyRadios}</div>
          </div>
          <div class="full-width">
            <label>canonical_mode</label>
            <div class="proxy-mode">${canonicalRadios}</div>
            <div class="field-hint"><code>self</code> tells Google the proxy is the canonical URL — duplicate-content risk if the source still indexes. Default for this flow.</div>
          </div>
          <div>
            <label for="serp_status">initial status</label>
            <select id="serp_status" name="status">
              <option value="active"${opts.prefill.status === "active" ? " selected" : ""}>active</option>
              <option value="paused"${opts.prefill.status === "paused" ? " selected" : ""}>paused</option>
            </select>
          </div>
          <div>
            <label for="serp_cluster">add all to cluster <span style="color:var(--fg-muted);font-weight:400">(optional)</span></label>
            <select id="serp_cluster" name="cluster_id">${clusterOptions}</select>
          </div>
        </div>
      </div>
      <div class="form-section">
        <h2 style="margin-top:0">Permission</h2>
        <label class="proxy-radio">
          <input type="checkbox" name="bypass_attestation" value="1"${opts.prefill.bypass_attestation ? " checked" : ""}>
          <span><strong>Bypass attestation</strong> — proxy these SERP results without third-party permission. I accept full responsibility. (Audit log records this as a bypassed create.)</span>
        </label>
      </div>
      <div class="form-actions">
        <button class="btn btn-primary" type="submit" id="serp-fetch-btn">Fetch SERP →</button>
        <a class="btn" href="/app/clients">Cancel</a>
      </div>
    </form>
    <style>
      @keyframes serp-spin { to { transform: rotate(360deg); } }
      .serp-spinner { display: inline-block; width: .85em; height: .85em; margin-right: .45em; vertical-align: -.1em; border: 2px solid currentColor; border-right-color: transparent; border-radius: 50%; animation: serp-spin .8s linear infinite; }
      .serp-progress-bar { position: fixed; top: 0; left: 0; right: 0; height: 3px; background: linear-gradient(90deg, transparent, var(--primary, #4f8cff), transparent); background-size: 50% 100%; background-repeat: no-repeat; animation: serp-progress 1.2s ease-in-out infinite; z-index: 9999; display: none; }
      @keyframes serp-progress { 0% { background-position: -50% 0; } 100% { background-position: 150% 0; } }
      .serp-progress-bar.active { display: block; }
    </style>
    <div class="serp-progress-bar" id="serp-progress-bar"></div>
    <script>
      (function() {
        var form = document.querySelector('form.editor');
        if (!form) return;
        form.addEventListener('submit', function() {
          var btn = document.getElementById('serp-fetch-btn');
          var bar = document.getElementById('serp-progress-bar');
          if (btn) {
            btn.disabled = true;
            btn.innerHTML = '<span class="serp-spinner"></span>Fetching SERP results — this can take 5–15 seconds…';
          }
          if (bar) bar.classList.add('active');
        });
      })();
    </script>`;
}

export function renderSerpPicker(opts: {
  results: readonly SerpResult[];
  query: SerpQuery;
  settings: Omit<BulkFormSettings, "attested_by_email" | "attested_ip" | "scope">;
  clusterLabel: string | null;
  errors: string[];
}): string {
  const errBox =
    opts.errors.length > 0 ? `<div class="error-box">${opts.errors.map(esc).join("\n")}</div>` : "";
  if (opts.results.length === 0) {
    return `<div class="crumbs"><a href="/app/clients/serp-new">← Back</a></div>
      <h1>No organic results</h1>
      <p class="subtitle">DataForSEO returned no organic results for that query. Try a broader keyword.</p>`;
  }
  // Hidden inputs carry settings + query through to the picker confirm
  // step, which converts to bulk preview rows.
  const hidden = `
    <input type="hidden" name="zone" value="${esc(opts.settings.zone)}">
    <input type="hidden" name="zone_strategy" value="${esc(opts.settings.zone_strategy)}">
    <input type="hidden" name="canonical_mode" value="${esc(opts.settings.canonical_mode)}">
    <input type="hidden" name="bypass_attestation" value="${opts.settings.bypass_attestation ? "1" : "0"}">
    <input type="hidden" name="cluster_id" value="${opts.settings.cluster_id ?? ""}">
    <input type="hidden" name="status" value="${esc(opts.settings.status)}">
    <input type="hidden" name="serp_keyword" value="${esc(opts.query.keyword)}">`;
  const rows = opts.results
    .map((r, i) => {
      const host = hostnameFromUrl(r.url) ?? "(unparseable)";
      return `<tr>
        <td><input type="checkbox" name="pick_${i}" value="1" checked><input type="hidden" name="url_${i}" value="${esc(r.url)}"></td>
        <td style="text-align:center;font-variant-numeric:tabular-nums">${r.position}</td>
        <td><div style="font-weight:500">${esc(r.title || "(no title)")}</div><div class="mono" style="font-size:.75rem;color:var(--fg-muted);margin-top:.15rem">${esc(host)}</div></td>
        <td style="font-size:.8rem;color:var(--fg-muted)">${esc(r.description.slice(0, 200))}${r.description.length > 200 ? "…" : ""}</td>
      </tr>`;
    })
    .join("");
  return `<div class="crumbs"><a href="/app/clients/serp-new">← Back to query</a></div>
    <h1>SERP results — ${opts.results.length} organic</h1>
    <p class="subtitle">Keyword: <code>${esc(opts.query.keyword)}</code> · ${opts.results.length} results · Settings carry through: canonical=<code>${esc(opts.settings.canonical_mode)}</code>${opts.settings.bypass_attestation ? `, <code style="color:var(--amber)">bypass</code>` : ""}.</p>
    ${errBox}
    <form class="editor" method="POST" action="/app/clients/serp-new/preview-pick">
      ${hidden}
      <input type="hidden" name="result_count" value="${opts.results.length}">
      <div class="form-section">
        <p class="field-hint" style="margin:0 0 .6rem">Uncheck results you don't want to proxy. Use the header checkbox to select/deselect all. Next step lets you tweak <code>client_id</code> + zone per row.</p>
        <table class="data" style="margin:0">
          <thead><tr>
            <th style="width:2.5rem">
              <input type="checkbox" id="serp-select-all" checked title="Select / deselect all">
            </th>
            <th style="width:3rem">#</th>
            <th>title / domain</th>
            <th>snippet</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
        <div class="field-hint" style="margin:.6rem 0 0">
          <span id="serp-pick-count">${opts.results.length}</span> of ${opts.results.length} selected
        </div>
      </div>
      <div class="form-actions">
        <button class="btn btn-primary" type="submit">Preview selected →</button>
        <a class="btn" href="/app/clients/serp-new">← Back</a>
      </div>
    </form>
    <script>
      (function() {
        var master = document.getElementById('serp-select-all');
        var counter = document.getElementById('serp-pick-count');
        if (!master) return;
        function pickBoxes() {
          return Array.prototype.slice.call(document.querySelectorAll('input[type=checkbox][name^="pick_"]'));
        }
        function updateCounter() {
          if (!counter) return;
          var boxes = pickBoxes();
          var checked = boxes.filter(function(b) { return b.checked; }).length;
          counter.textContent = String(checked);
        }
        function syncMaster() {
          var boxes = pickBoxes();
          if (boxes.length === 0) return;
          var checkedCount = boxes.filter(function(b) { return b.checked; }).length;
          master.checked = checkedCount === boxes.length;
          master.indeterminate = checkedCount > 0 && checkedCount < boxes.length;
          updateCounter();
        }
        master.addEventListener('change', function() {
          var boxes = pickBoxes();
          boxes.forEach(function(b) { b.checked = master.checked; });
          master.indeterminate = false;
          updateCounter();
        });
        pickBoxes().forEach(function(b) {
          b.addEventListener('change', syncMaster);
        });
        syncMaster();
      })();
    </script>`;
}

/* ─── POST handlers ─── */

export async function handleSerpQueryPost(
  request: Request,
  env: AppEnv,
  url: URL,
  user: User,
): Promise<{
  pickerRender?: {
    results: SerpResult[];
    query: SerpQuery;
    settings: Omit<BulkFormSettings, "attested_by_email" | "attested_ip" | "scope">;
    clusterLabel: string | null;
  };
  formRender?: {
    errors: string[];
    prefill: SerpQueryFormPrefill;
    visibleClusters: ClusterRow[];
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
  const visibleClusters = await loadVisibleClusters(env, user);
  const validation = validateSerpForm(raw);
  if (!validation.ok) {
    return {
      formRender: { errors: validation.errors, prefill: validation.prefill, visibleClusters },
    };
  }
  // Verify cluster (if any) is visible to the operator.
  let clusterLabel: string | null = null;
  if (validation.value.settings.cluster_id != null) {
    const c = visibleClusters.find((c) => c.id === validation.value.settings.cluster_id);
    if (!c) {
      return {
        formRender: {
          errors: ["Selected cluster not found or not visible to you"],
          prefill: rawToSerpPrefill(raw),
          visibleClusters,
        },
      };
    }
    clusterLabel = c.label;
  }
  let results: SerpResult[];
  try {
    results = await fetchSerpResults(env, validation.value.query);
  } catch (e) {
    let msg = "DataForSEO fetch failed";
    if (e instanceof DataForSeoConfigError || e instanceof DataForSeoApiError) {
      msg = e.message;
    } else if (e instanceof Error) {
      msg = e.message;
    }
    return {
      formRender: {
        errors: [msg],
        prefill: rawToSerpPrefill(raw),
        visibleClusters,
      },
    };
  }
  return {
    pickerRender: {
      results,
      query: validation.value.query,
      settings: validation.value.settings,
      clusterLabel,
    },
  };
}

/**
 * Handle the picker submit — turns checked SERP results into a bulk
 * preview by feeding them through `serpResultsToPreviewRows`. The
 * returned shape is the same as `handleBulkPreviewPost`'s
 * `step2Render`, so the caller can render it with
 * `renderBulkPreview` and the existing `/bulk-new/confirm` POST takes
 * it from there.
 */
export async function handleSerpPickPost(
  request: Request,
  env: AppEnv,
  url: URL,
  user: User,
): Promise<{
  step2Render?: {
    rows: BulkPreviewRow[];
    settings: BulkFormSettings;
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
  const resultCount = Number.parseInt(raw.result_count ?? "0", 10);
  if (!Number.isFinite(resultCount) || resultCount <= 0) {
    return {
      response: new Response("invalid result_count", { status: 400 }),
    };
  }
  // Reconstruct the picked SERP URLs (just the ones checked).
  const pickedUrls: string[] = [];
  for (let i = 0; i < resultCount; i++) {
    if (raw[`pick_${i}`] !== "1") continue;
    const u = (raw[`url_${i}`] ?? "").trim();
    if (u.length > 0) pickedUrls.push(u);
  }
  if (pickedUrls.length === 0) {
    return {
      response: new Response("No results selected — go back and check at least one.", {
        status: 400,
      }),
    };
  }

  // Settings come from the hidden fields the picker form carries.
  const zone = (PROXY_ZONES as readonly string[]).includes(raw.zone ?? "")
    ? (raw.zone as ProxyZone)
    : PROXY_ZONES[0];
  const zone_strategy = raw.zone_strategy === "single" ? "single" : "mixed";
  const canonical_mode = (CANONICAL_MODES as readonly string[]).includes(raw.canonical_mode ?? "")
    ? (raw.canonical_mode as CanonicalMode)
    : "self";
  const bypass = raw.bypass_attestation === "1";
  const cluster_id =
    raw.cluster_id && raw.cluster_id !== "0" ? Number.parseInt(raw.cluster_id, 10) : null;
  const status: "active" | "paused" = raw.status === "paused" ? "paused" : "active";

  const settings: BulkFormSettings = {
    zone,
    zone_strategy,
    attested_by_email: user.email,
    attested_ip: request.headers.get("cf-connecting-ip") ?? "0.0.0.0",
    scope: "full_site",
    bypass_attestation: bypass,
    canonical_mode,
    cluster_id,
    status,
  };

  // Build preview rows using the same id derivation the paste-URLs
  // path uses (resolveBatchClientIds checks for collisions with
  // existing clients + within the batch).
  const existing = await env.CONFIG_DB.prepare("SELECT client_id FROM clients").all<{
    client_id: string;
  }>();
  const existingIds = new Set((existing.results ?? []).map((r) => r.client_id));
  const fakeResults: SerpResult[] = pickedUrls.map((u, i) => ({
    position: i + 1,
    url: u,
    title: "",
    description: "",
  }));
  const rows = serpResultsToPreviewRows(fakeResults, settings, existingIds);

  // Resolve cluster label, if any.
  const visibleClusters = await loadVisibleClusters(env, user);
  let clusterLabel: string | null = null;
  if (cluster_id != null) {
    const c = visibleClusters.find((c) => c.id === cluster_id);
    if (c) clusterLabel = c.label;
  }

  return { step2Render: { rows, settings, clusterLabel } };
}

// Re-export `renderBulkPreview` so the index router can call a single
// import to render the SERP-derived preview. Keeps the route handlers
// in index.ts compact.
export { renderBulkPreview };
