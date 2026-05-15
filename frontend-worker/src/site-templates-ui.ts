/**
 * Admin UI for programmatic SEO (Phase A).
 *
 * Page renderers + POST handlers for:
 *   - /app/templates     — list + new + edit
 *   - /app/data-sources  — list + new + edit
 *   - /app/templates/:id/generate — preview + execute render
 *
 * The pure engine lives in `site-templates.ts`. This file is
 * presentation + route handling only.
 */

import type { AppEnv } from "./app.js";
import { esc } from "./app.js";
import type { User } from "./auth.js";
import {
  DATA_SOURCE_KINDS,
  type DataSourceKind,
  type GenerateResult,
  type RenderPlan,
  type RenderTarget,
  type SiteDataSourceRow,
  type SiteTemplateRow,
  TEMPLATE_KINDS,
  type TemplateKind,
  buildPlaceholderSchema,
  checkCsrf,
  executeGenerate,
  extractPlaceholders,
  flashRedirect,
  loadVisibleDataSource,
  loadVisibleTemplate,
  parseCsv,
  planRender,
  validateTemplateInput,
} from "./site-templates.js";
import { TEMPLATE_STARTERS } from "./template-starters.js";

/* ─── Renderers ─── */

const TEMPLATES_CSS = `
.tmpl-page .stats{display:flex;gap:.75rem;flex-wrap:wrap;margin-bottom:1rem}
.tmpl-page .stat-chip{display:inline-flex;align-items:center;gap:.35rem;padding:.35rem .65rem;background:var(--bg-elevated);border:1px solid var(--border);border-radius:9999px;font-size:.8rem;color:var(--fg-muted)}
.tmpl-page .stat-chip strong{color:var(--fg);font-weight:700}
.tmpl-page .placeholder-list{display:flex;flex-wrap:wrap;gap:.35rem;margin:.3rem 0 .6rem}
.tmpl-page .placeholder-chip{display:inline-block;padding:.1rem .5rem;background:var(--accent-bg);color:var(--accent);border-radius:9999px;font-family:var(--mono);font-size:.78rem;font-weight:600}
.tmpl-page .placeholder-chip.raw::before{content:"⚠ ";color:var(--amber)}
.tmpl-page textarea.html-template{min-height:380px;font-family:var(--mono);font-size:.82rem}
.tmpl-page .preview-row{background:var(--bg-elevated);border:1px solid var(--border);border-radius:var(--radius);padding:.7rem .9rem;margin-bottom:.55rem}
.tmpl-page .preview-row .path{font-family:var(--mono);font-size:.85rem;color:var(--accent);font-weight:600;margin-bottom:.25rem}
.tmpl-page .preview-row pre.html-preview{margin:.25rem 0 0;font-family:var(--mono);font-size:.75rem;max-height:8rem;overflow:auto;background:var(--bg);padding:.5rem;border:1px solid var(--border);border-radius:var(--radius-sm);white-space:pre-wrap;word-break:break-word;color:var(--fg-muted)}
.tmpl-page .similarity-warn{background:var(--amber-bg);color:var(--amber);border:1px solid color-mix(in srgb,var(--amber) 30%,transparent);border-radius:var(--radius);padding:.7rem 1rem;margin:0 0 1rem;font-size:.9rem}
.tmpl-page .result-pill{display:inline-block;padding:.1rem .5rem;border-radius:9999px;font-size:.72rem;font-weight:600}
.tmpl-page .result-created{background:var(--green-bg);color:var(--green)}
.tmpl-page .result-updated{background:var(--accent-bg);color:var(--accent)}
.tmpl-page .result-unchanged{background:var(--bg-sidebar);color:var(--fg-muted)}
.tmpl-page .result-skipped{background:var(--amber-bg);color:var(--amber)}
.tmpl-page .result-error{background:var(--red-bg);color:var(--red)}
.tmpl-page .starter-row{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:.75rem;margin:.4rem 0 1.5rem}
.tmpl-page .starter-card{background:var(--bg-elevated);border:1px solid var(--border);border-radius:var(--radius);padding:.95rem 1.05rem;text-decoration:none;color:var(--fg);transition:border-color .15s ease,transform .1s ease,box-shadow .15s ease;display:flex;flex-direction:column;gap:.35rem}
.tmpl-page .starter-card:hover{border-color:var(--accent);box-shadow:var(--shadow-md);text-decoration:none;transform:translateY(-1px)}
.tmpl-page .starter-card .title{font-weight:600;font-size:.95rem;color:var(--fg)}
.tmpl-page .starter-card .desc{font-size:.82rem;color:var(--fg-muted);line-height:1.45}
.tmpl-page .starter-card .best-with{font-size:.72rem;color:var(--accent);font-weight:600;margin-top:auto;padding-top:.25rem}
.tmpl-page .starter-card .kind-chip{display:inline-block;font-family:var(--mono);font-size:.7rem;background:var(--accent-bg);color:var(--accent);padding:.05rem .4rem;border-radius:9999px;align-self:flex-start}
`;

function renderStarterCards(): string {
  const cards = TEMPLATE_STARTERS.map(
    (s) => `<a class="starter-card" href="/app/templates/new?starter=${esc(s.id)}">
      <span class="kind-chip">${esc(s.kind)}</span>
      <div class="title">${esc(s.label)}</div>
      <div class="desc">${esc(s.description)}</div>
      <div class="best-with">Best with: ${esc(s.bestWith)}</div>
    </a>`,
  ).join("");
  return `<h3 style="margin:1.25rem 0 .5rem">Start from a template</h3>
    <div class="starter-row">${cards}</div>`;
}

export function renderTemplatesList(rows: readonly SiteTemplateRow[], user: User): string {
  const ownership =
    user.role === "super_admin"
      ? "Showing all templates across the platform (super-admin)."
      : `Showing ${rows.length} template${rows.length === 1 ? "" : "s"} you own.`;
  if (rows.length === 0) {
    return `<style>${TEMPLATES_CSS}</style><div class="tmpl-page">
      <h1>Templates</h1>
      <p class="subtitle">${ownership} Templates are reusable HTML with <code>{{placeholders}}</code> that get filled in from a data source to produce one page per row.</p>
      ${renderStarterCards()}
      <p style="margin-bottom:1rem"><a class="btn btn-primary" href="/app/templates/new">+ New blank template</a></p>
      <div class="empty">No templates yet. Pick a starter above or create one from scratch.</div>
    </div>`;
  }
  const tbody = rows
    .map(
      (r) => `<tr>
      <td><a href="/app/templates/${r.id}/edit" class="mono">${esc(r.name)}</a></td>
      <td><code>${esc(r.kind)}</code></td>
      <td class="mono" style="font-size:.78rem;color:var(--fg-muted)">${esc(r.path_pattern)}</td>
      <td class="mono" style="font-size:.78rem;color:var(--fg-muted)">${esc(r.updated_at)}</td>
      <td><a class="btn" style="font-size:.78rem;padding:.25rem .65rem" href="/app/templates/${r.id}/generate">Generate →</a></td>
    </tr>`,
    )
    .join("");
  return `<style>${TEMPLATES_CSS}</style><div class="tmpl-page">
    <h1>Templates</h1>
    <p class="subtitle">${ownership}</p>
    ${renderStarterCards()}
    <p style="margin:1.25rem 0 1rem"><a class="btn btn-primary" href="/app/templates/new">+ New blank template</a></p>
    <table class="data">
      <thead><tr><th>Name</th><th>Kind</th><th>Path pattern</th><th>Updated</th><th></th></tr></thead>
      <tbody>${tbody}</tbody>
    </table>
  </div>`;
}

export function renderTemplateForm(opts: {
  prefill: Partial<{
    id: number;
    name: string;
    kind: TemplateKind;
    html_template: string;
    path_pattern: string;
    cross_link_strategy: string;
    cross_link_count: number | string;
  }>;
  errors: string[];
  mode: "new" | "edit";
}): string {
  const action =
    opts.mode === "new" ? "/app/templates/new" : `/app/templates/${opts.prefill.id}/edit`;
  const errBox =
    opts.errors.length > 0 ? `<div class="error-box">${opts.errors.map(esc).join("\n")}</div>` : "";
  const kindOptions = TEMPLATE_KINDS.map((k) => {
    const label =
      k === "pages_in_client"
        ? "pages_in_client — append pages under an existing proxied site"
        : "client_per_row — each row becomes its own single-page site";
    return `<option value="${esc(k)}"${opts.prefill.kind === k ? " selected" : ""}>${esc(label)}</option>`;
  }).join("");
  // Show live placeholder detection from the prefill (regenerated on save anyway).
  const detected =
    opts.prefill.html_template && opts.prefill.path_pattern
      ? buildPlaceholderSchema(opts.prefill.html_template, opts.prefill.path_pattern)
      : [];
  const placeholderChips = detected
    .map(
      (p) =>
        `<span class="placeholder-chip${p.raw ? " raw" : ""}" title="${p.raw ? "Raw HTML insertion — be careful with untrusted data" : "Escaped substitution"} (${p.usage})">{{${esc(p.name)}}}</span>`,
    )
    .join("");
  return `<style>${TEMPLATES_CSS}</style><div class="tmpl-page">
    <div class="crumbs"><a href="/app/templates">← Templates</a></div>
    <h1>${opts.mode === "new" ? "New template" : "Edit template"}</h1>
    ${errBox}
    <form class="editor" method="POST" action="${esc(action)}">
      <div class="form-section">
        <label for="tmpl_name">name</label>
        <input id="tmpl_name" name="name" type="text" required value="${esc(opts.prefill.name ?? "")}" placeholder="San Diego pool builder pages">
      </div>
      <div class="form-section">
        <label for="tmpl_kind">kind</label>
        <select id="tmpl_kind" name="kind">${kindOptions}</select>
        <div class="field-hint"><code>pages_in_client</code>: deep pages on one brand (acme.com/foo, acme.com/bar). <code>client_per_row</code>: one new single-page site per row (foo.localsitestage.us, bar.localsitestage.us).</div>
      </div>
      <div class="form-section">
        <label for="tmpl_path">path_pattern</label>
        <input id="tmpl_path" name="path_pattern" type="text" required value="${esc(opts.prefill.path_pattern ?? "/{{slugify city}}-pool-builders")}" placeholder="/{{slugify city}}-pool-builders">
        <div class="field-hint">URL path for each generated page. Uses the same <code>{{placeholders}}</code>. Slugified automatically.</div>
      </div>
      <div class="form-section">
        <label for="tmpl_html">html_template</label>
        ${detected.length > 0 ? `<div class="placeholder-list">${placeholderChips}</div>` : '<div class="field-hint">No placeholders detected yet — paste HTML with <code>{{key}}</code> references.</div>'}
        <textarea id="tmpl_html" name="html_template" class="html-template" required placeholder="&lt;!doctype html&gt;\n&lt;html lang=&quot;en&quot;&gt;\n&lt;head&gt;\n  &lt;title&gt;{{service}} in {{city}} — Top Pool Builders&lt;/title&gt;\n  &lt;meta name=&quot;description&quot; content=&quot;Looking for {{service}} in {{city}}? ...&quot;&gt;\n&lt;/head&gt;\n&lt;body&gt;\n  &lt;h1&gt;Best {{service}} in {{city}}&lt;/h1&gt;\n  &lt;p&gt;{{intro}}&lt;/p&gt;\n  {{#if phone}}&lt;p&gt;Call: {{phone}}&lt;/p&gt;{{/if}}\n&lt;/body&gt;\n&lt;/html&gt;">${esc(opts.prefill.html_template ?? "")}</textarea>
        <div class="field-hint"><code>{{key}}</code> = escaped substitution. <code>{{{key}}}</code> = raw HTML (be careful). <code>{{slugify key}}</code> = slug helper. <code>{{#if key}}...{{/if}}</code> = conditional. <code>{{#each cross_links}}{{title}}{{/each}}</code> = array iteration.</div>
      </div>
      <div class="form-section">
        <label for="tmpl_cross_strategy">cross-link strategy</label>
        <select id="tmpl_cross_strategy" name="cross_link_strategy">
          <option value="none"${(opts.prefill.cross_link_strategy ?? "none") === "none" ? " selected" : ""}>none — no cross-links</option>
          <option value="same_category_nearby_cities"${opts.prefill.cross_link_strategy === "same_category_nearby_cities" ? " selected" : ""}>same category, nearby cities (best for service-area pages)</option>
          <option value="same_city_other_categories"${opts.prefill.cross_link_strategy === "same_city_other_categories" ? " selected" : ""}>same city, other categories (best for local directory hubs)</option>
        </select>
        <div class="field-hint">When set, each generated page gets a <code>cross_links</code> array of related-business links. Reference via <code>{{#each cross_links}}&lt;a href="{{url}}"&gt;{{title}}&lt;/a&gt;{{/each}}</code>. Sorted by geographic distance when lat/lng is available.</div>
      </div>
      <div class="form-section">
        <label for="tmpl_cross_count">cross-link count (0 disables, max 50)</label>
        <input id="tmpl_cross_count" name="cross_link_count" type="number" min="0" max="50" value="${esc(String(opts.prefill.cross_link_count ?? 0))}" style="width:6rem">
      </div>
      <div class="form-actions">
        <button class="btn btn-primary" type="submit">${opts.mode === "new" ? "Create template" : "Save changes"}</button>
        <a class="btn" href="/app/templates">Cancel</a>
        ${opts.mode === "edit" ? `<a class="btn" href="/app/templates/${opts.prefill.id}/generate" style="margin-left:auto">Generate pages →</a>` : ""}
      </div>
    </form>
  </div>`;
}

export function renderDataSourcesList(rows: readonly SiteDataSourceRow[], user: User): string {
  const ownership =
    user.role === "super_admin"
      ? "Showing all data sources (super-admin)."
      : `Showing ${rows.length} data source${rows.length === 1 ? "" : "s"} you own.`;
  if (rows.length === 0) {
    return `<div class="tmpl-page">
      <h1>Data sources</h1>
      <p class="subtitle">${ownership} Tabular data — one row per page you want to generate. Upload a CSV, paste inline, or (later) auto-scrape from DataForSEO.</p>
      <p style="margin-bottom:1rem"><a class="btn btn-primary" href="/app/data-sources/new">+ New data source</a> <a class="btn" href="/app/data-sources/new-scrape">⚡ Scrape Google Maps</a></p>
      <div class="empty">No data sources yet.</div>
    </div>`;
  }
  const tbody = rows
    .map((r) => {
      const cols = safeParseArray<string>(r.columns).join(", ");
      const rowCount = safeParseArray<unknown>(r.rows).length;
      const statusChip = renderDataSourceStatusChip(r);
      return `<tr>
      <td><a href="/app/data-sources/${r.id}/edit" class="mono">${esc(r.name)}</a></td>
      <td><code>${esc(r.source_kind)}</code></td>
      <td>${statusChip}</td>
      <td class="mono" style="font-size:.78rem;color:var(--fg-muted)">${esc(cols.slice(0, 60))}${cols.length > 60 ? "…" : ""}</td>
      <td class="num" style="font-variant-numeric:tabular-nums;text-align:right">${rowCount}</td>
      <td class="mono" style="font-size:.78rem;color:var(--fg-muted)">${esc(r.updated_at)}</td>
    </tr>`;
    })
    .join("");
  return `<style>${TEMPLATES_CSS}</style><div class="tmpl-page">
    <h1>Data sources</h1>
    <p class="subtitle">${ownership}</p>
    <p style="margin-bottom:1rem"><a class="btn btn-primary" href="/app/data-sources/new">+ New data source</a> <a class="btn" href="/app/data-sources/new-scrape">⚡ Scrape Google Maps</a></p>
    <table class="data">
      <thead><tr><th>Name</th><th>Kind</th><th>Status</th><th>Columns</th><th class="num">Rows</th><th>Updated</th></tr></thead>
      <tbody>${tbody}</tbody>
    </table>
  </div>`;
}

function renderDataSourceStatusChip(r: SiteDataSourceRow): string {
  if (r.source_kind !== "dataforseo_business_listings") return "";
  if (r.scrape_status === "running") {
    const total = Math.max(1, r.scrape_progress_total);
    const pct = Math.min(100, Math.round((r.scrape_progress_done / total) * 100));
    return `<span class="result-pill result-updated">${pct}% · ${r.scrape_progress_done}/${r.scrape_progress_total}</span>`;
  }
  if (r.scrape_status === "done") {
    return `<span class="result-pill result-created">done</span>`;
  }
  if (r.scrape_status === "error") {
    return `<span class="result-pill result-error" title="${esc(r.scrape_error ?? "")}">error</span>`;
  }
  return "";
}

export function renderDataSourceForm(opts: {
  prefill: Partial<{
    id: number;
    name: string;
    source_kind: DataSourceKind;
    columns: string;
    rows: string;
  }>;
  errors: string[];
  mode: "new" | "edit";
}): string {
  const action =
    opts.mode === "new" ? "/app/data-sources/new" : `/app/data-sources/${opts.prefill.id}/edit`;
  const errBox =
    opts.errors.length > 0 ? `<div class="error-box">${opts.errors.map(esc).join("\n")}</div>` : "";
  const kindRaw = (opts.prefill.source_kind ?? "csv") as DataSourceKind;
  const kindOptions = DATA_SOURCE_KINDS.map((k) => {
    const label =
      k === "csv"
        ? "csv — paste a CSV blob"
        : k === "inline"
          ? "inline — small table edited in the browser"
          : k === "dataforseo_business_listings"
            ? "dataforseo_business_listings — Google Maps scrape (create via /app/data-sources/new-scrape)"
            : `${k} — Phase B+ (not yet wired)`;
    // Scraped kinds aren't manually selectable in the form — they
    // come from the dedicated scrape flow. Editor still shows the
    // current kind for read-only context.
    const disabled = k === "dataforseo_business_listings" || k === "dataforseo_serp";
    return `<option value="${esc(k)}"${kindRaw === k ? " selected" : ""}${disabled ? " disabled" : ""}>${esc(label)}</option>`;
  }).join("");
  // Re-scrape lives on the live progress block (renderScrapeProgress)
  // which is prepended by the route handler for scraped sources.

  const columns = safeParseArray<string>(opts.prefill.columns ?? "[]");
  const rows = safeParseArray<Record<string, string>>(opts.prefill.rows ?? "[]");
  const csvFromInline =
    columns.length === 0
      ? ""
      : [
          columns.join(","),
          ...rows.map((r) => columns.map((c) => csvEscapeCell(r[c] ?? "")).join(",")),
        ].join("\n");

  return `<div class="tmpl-page">
    <div class="crumbs"><a href="/app/data-sources">← Data sources</a></div>
    <h1>${opts.mode === "new" ? "New data source" : "Edit data source"}</h1>
    ${errBox}
    <form class="editor" method="POST" action="${esc(action)}">
      <div class="form-section">
        <label for="ds_name">name</label>
        <input id="ds_name" name="name" type="text" required value="${esc(opts.prefill.name ?? "")}" placeholder="San Diego cities + variants">
      </div>
      <div class="form-section">
        <label for="ds_kind">kind</label>
        <select id="ds_kind" name="source_kind">${kindOptions}</select>
        <div class="field-hint">CSV and inline are supported in v1. DataForSEO auto-scrape ships in Phase B.</div>
      </div>
      <div class="form-section">
        <label for="ds_csv">data (CSV format — first row is headers)</label>
        <textarea id="ds_csv" name="csv" rows="14" required placeholder="city,service,phone\\nSan Diego,pool builders,619-555-0001\\nChula Vista,pool builders,619-555-0002\\nLa Jolla,pool builders,858-555-0003" style="font-family:var(--mono);font-size:.82rem;padding:.55rem;width:100%">${esc(csvFromInline)}</textarea>
        <div class="field-hint">First row is treated as column names. Embed commas in double quotes (<code>"like, this"</code>). Max ${500} rows per source.</div>
      </div>
      <div class="form-actions">
        <button class="btn btn-primary" type="submit">${opts.mode === "new" ? "Create data source" : "Save changes"}</button>
        <a class="btn" href="/app/data-sources">Cancel</a>
      </div>
    </form>
  </div>`;
}

export function renderGenerateForm(opts: {
  template: SiteTemplateRow;
  dataSources: readonly SiteDataSourceRow[];
  visibleClients: readonly Array<{ client_id: string; proxy_domain: string }>;
  /** Available staging/prod zones for client_per_row mode. */
  zones: readonly string[];
  errors: string[];
}): string {
  const errBox =
    opts.errors.length > 0 ? `<div class="error-box">${opts.errors.map(esc).join("\n")}</div>` : "";
  // Find a data source whose columns cover every template placeholder.
  // Most-recently-updated compatible source wins.
  const placeholders = new Set(
    extractPlaceholders(opts.template.html_template, "body")
      .concat(extractPlaceholders(opts.template.path_pattern, "path"))
      .map((p) => p.name),
  );
  const compatibleId = pickCompatibleDataSource(opts.dataSources, placeholders);
  const dataSourceOptions =
    opts.dataSources.length === 0
      ? `<option value="">— no data sources yet —</option>`
      : [
          `<option value="">— pick a data source —</option>`,
          ...opts.dataSources.map((d) => {
            const cols = new Set(safeParseArray<string>(d.columns));
            const covers = Array.from(placeholders).every((p) => cols.has(p));
            const rowCount = safeParseArray<unknown>(d.rows).length;
            const label = covers
              ? `${d.name} (${rowCount} rows) ✓ matches`
              : `${d.name} (${rowCount} rows)`;
            const sel = d.id === compatibleId ? " selected" : "";
            return `<option value="${d.id}"${sel}>${esc(label)}</option>`;
          }),
        ].join("");
  const clientOptions = [
    `<option value="">— pick a client —</option>`,
    ...opts.visibleClients.map(
      (c) =>
        `<option value="${esc(c.client_id)}">${esc(c.client_id)} (${esc(c.proxy_domain)})</option>`,
    ),
  ].join("");
  const zoneOptions = opts.zones
    .map((z) => `<option value="${esc(z)}">${esc(z)}</option>`)
    .join("");
  const modeIsPagesInClient = opts.template.kind === "pages_in_client";
  return `<style>${TEMPLATES_CSS}</style><div class="tmpl-page">
    <div class="crumbs"><a href="/app/templates/${opts.template.id}/edit">← ${esc(opts.template.name)}</a></div>
    <h1>Generate pages — ${esc(opts.template.name)}</h1>
    <p class="subtitle">Path pattern: <code>${esc(opts.template.path_pattern)}</code> · Mode: <code>${esc(opts.template.kind)}</code></p>
    ${errBox}
    <form class="editor" method="POST" action="/app/templates/${opts.template.id}/generate/preview">
      <div class="form-section">
        <label for="gen_ds">data source</label>
        <select id="gen_ds" name="data_source_id" required>${dataSourceOptions}</select>
      </div>
      <div class="form-section">
        ${
          modeIsPagesInClient
            ? `<label for="gen_client">target client</label>
             <select id="gen_client" name="client_id" required>${clientOptions}</select>
             <div class="field-hint">Pages will be appended to this client's routing as <code>custom_page</code> entries.</div>`
            : `<label for="gen_zone">target zone (for new clients)</label>
             <select id="gen_zone" name="zone" required>${zoneOptions}</select>
             <div class="field-hint">Each row becomes a new client at <code>&lt;client_id&gt;.&lt;zone&gt;</code>.</div>`
        }
      </div>
      <div class="form-actions">
        <button class="btn btn-primary" type="submit">Preview →</button>
        <a class="btn" href="/app/templates/${opts.template.id}/edit">Cancel</a>
      </div>
    </form>
  </div>`;
}

export function renderGeneratePreview(opts: {
  template: SiteTemplateRow;
  dataSource: SiteDataSourceRow;
  target: RenderTarget;
  plan: RenderPlan;
}): string {
  const warn = opts.plan.similarity_warn
    ? `<div class="similarity-warn">⚠ Generated pages are <strong>${(opts.plan.max_similarity * 100).toFixed(0)}%</strong> similar to each other (worst-case pair). Google may flag this as thin/duplicate content. Recommend more variation per row before deploying.</div>`
    : "";
  const summary =
    opts.target.mode === "pages_in_client"
      ? `<p class="subtitle">Will append <strong>${opts.plan.rows.length}</strong> <code>custom_page</code> route${opts.plan.rows.length === 1 ? "" : "s"} to client <code>${esc(opts.target.client_id ?? "")}</code>.</p>`
      : `<p class="subtitle">Will create / update <strong>${opts.plan.rows.length}</strong> single-page client${opts.plan.rows.length === 1 ? "" : "s"} under <code>${esc(opts.target.zone ?? "")}</code>.</p>`;
  const rowsHtml = opts.plan.rows
    .map(
      (r) => `<div class="preview-row">
        <div class="path">${esc(r.generated_path)} <span style="color:var(--fg-muted);font-size:.75rem;font-weight:400">${r.html_full_length} bytes</span></div>
        <details><summary style="font-size:.78rem;color:var(--fg-muted);cursor:pointer">Show first 1KB</summary><pre class="html-preview">${esc(r.html_preview)}</pre></details>
      </div>`,
    )
    .join("");
  const hidden = `
    <input type="hidden" name="data_source_id" value="${opts.dataSource.id}">
    ${
      opts.target.mode === "pages_in_client"
        ? `<input type="hidden" name="client_id" value="${esc(opts.target.client_id ?? "")}">`
        : `<input type="hidden" name="zone" value="${esc(opts.target.zone ?? "")}">`
    }
  `;
  return `<style>${TEMPLATES_CSS}</style><div class="tmpl-page">
    <div class="crumbs"><a href="/app/templates/${opts.template.id}/generate">← Pick data source</a></div>
    <h1>Preview — ${esc(opts.template.name)}</h1>
    ${summary}
    ${warn}
    <div style="margin-bottom:1rem">${rowsHtml}</div>
    <form method="POST" action="/app/templates/${opts.template.id}/generate/confirm">
      ${hidden}
      <div class="form-actions">
        <button class="btn btn-primary" type="submit"${opts.plan.rows.length === 0 ? " disabled" : ""}>Generate ${opts.plan.rows.length} page${opts.plan.rows.length === 1 ? "" : "s"}</button>
        <a class="btn" href="/app/templates/${opts.template.id}/generate">← Back</a>
      </div>
    </form>
  </div>`;
}

export function renderGenerateResult(opts: {
  template: SiteTemplateRow;
  results: readonly GenerateResult[];
}): string {
  const byStatus = opts.results.reduce(
    (acc, r) => {
      acc[r.status] = (acc[r.status] ?? 0) + 1;
      return acc;
    },
    {} as Record<GenerateResult["status"], number>,
  );
  const summary = `<p class="subtitle">${[
    byStatus.created ? `<strong>${byStatus.created}</strong> created` : "",
    byStatus.updated ? `<strong>${byStatus.updated}</strong> updated` : "",
    byStatus.unchanged ? `<strong>${byStatus.unchanged}</strong> unchanged` : "",
    byStatus.skipped ? `<strong>${byStatus.skipped}</strong> skipped` : "",
    byStatus.error
      ? `<strong style="color:var(--red)">${byStatus.error}</strong> error${byStatus.error === 1 ? "" : "s"}`
      : "",
  ]
    .filter(Boolean)
    .join(" · ")}</p>`;
  const tbody = opts.results
    .map(
      (r) => `<tr>
      <td class="num" style="text-align:right;font-variant-numeric:tabular-nums">${r.row_index >= 0 ? r.row_index : "—"}</td>
      <td class="mono">${r.client_id ? `<a href="/app/clients/${esc(r.client_id)}">${esc(r.client_id)}</a>` : "—"}</td>
      <td class="mono" style="font-size:.8rem;color:var(--fg-muted)">${esc(r.generated_path)}</td>
      <td><span class="result-pill result-${esc(r.status)}">${esc(r.status)}</span></td>
      <td style="font-size:.8rem;color:var(--fg-muted)">${esc(r.message ?? "")}</td>
    </tr>`,
    )
    .join("");
  return `<style>${TEMPLATES_CSS}</style><div class="tmpl-page">
    <div class="crumbs"><a href="/app/templates/${opts.template.id}/edit">← ${esc(opts.template.name)}</a></div>
    <h1>Generate result — ${esc(opts.template.name)}</h1>
    ${summary}
    <table class="data">
      <thead><tr><th class="num">Row</th><th>Client</th><th>Path</th><th>Status</th><th>Message</th></tr></thead>
      <tbody>${tbody}</tbody>
    </table>
    <div class="actions-row" style="margin-top:1rem">
      <a class="btn btn-primary" href="/app/templates/${opts.template.id}/generate">Generate more</a>
      <a class="btn" href="/app/templates">All templates</a>
    </div>
  </div>`;
}

/* ─── POST handlers ─── */

export async function handleTemplateNewPost(
  request: Request,
  env: AppEnv,
  url: URL,
  user: User,
): Promise<
  { redirect: Response } | { errors: string[]; prefill: Partial<Record<string, string>> }
> {
  const csrf = checkCsrf(request, url);
  if (csrf) return { redirect: csrf };
  const form = await request.formData();
  const raw: Record<string, string> = {};
  for (const [k, v] of form.entries()) {
    if (typeof v === "string") raw[k] = v;
  }
  const validation = validateTemplateInput(raw);
  if (!validation.ok) {
    return { errors: validation.errors, prefill: raw };
  }
  const v = validation.value;
  const placeholders = buildPlaceholderSchema(v.html_template, v.path_pattern);
  try {
    await env.CONFIG_DB.prepare(
      `INSERT INTO site_templates
         (owner_id, name, kind, html_template, path_pattern, placeholder_schema,
          cross_link_strategy, cross_link_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        user.id,
        v.name,
        v.kind,
        v.html_template,
        v.path_pattern,
        JSON.stringify(placeholders),
        v.cross_link_strategy,
        v.cross_link_count,
      )
      .run();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const friendly =
      msg.includes("UNIQUE") && msg.includes("name")
        ? `Template named "${v.name}" already exists.`
        : `DB error: ${msg}`;
    return { errors: [friendly], prefill: raw };
  }
  return {
    redirect: flashRedirect("/app/templates", {
      text: `Created template "${v.name}".`,
      kind: "ok",
    }),
  };
}

export async function handleTemplateEditPost(
  request: Request,
  env: AppEnv,
  url: URL,
  user: User,
  id: number,
): Promise<
  | { redirect: Response }
  | { errors: string[]; prefill: Partial<Record<string, string>> & { id: number } }
> {
  const csrf = checkCsrf(request, url);
  if (csrf) return { redirect: csrf };
  const tmpl = await loadVisibleTemplate(env, user, id);
  if (!tmpl) return { redirect: new Response("Not found", { status: 404 }) };
  const form = await request.formData();
  const raw: Record<string, string> = {};
  for (const [k, v] of form.entries()) {
    if (typeof v === "string") raw[k] = v;
  }
  const validation = validateTemplateInput(raw);
  if (!validation.ok) {
    return { errors: validation.errors, prefill: { id, ...raw } };
  }
  const v = validation.value;
  const placeholders = buildPlaceholderSchema(v.html_template, v.path_pattern);
  try {
    await env.CONFIG_DB.prepare(
      `UPDATE site_templates SET name=?, kind=?, html_template=?, path_pattern=?,
         placeholder_schema=?, cross_link_strategy=?, cross_link_count=?,
         updated_at=CURRENT_TIMESTAMP
       WHERE id=?`,
    )
      .bind(
        v.name,
        v.kind,
        v.html_template,
        v.path_pattern,
        JSON.stringify(placeholders),
        v.cross_link_strategy,
        v.cross_link_count,
        id,
      )
      .run();
  } catch (e) {
    return {
      errors: [`DB error: ${e instanceof Error ? e.message : String(e)}`],
      prefill: { id, ...raw },
    };
  }
  return {
    redirect: flashRedirect(`/app/templates/${id}/edit`, {
      text: `Saved "${v.name}".`,
      kind: "ok",
    }),
  };
}

export async function handleDataSourceNewPost(
  request: Request,
  env: AppEnv,
  url: URL,
  user: User,
): Promise<
  { redirect: Response } | { errors: string[]; prefill: Partial<Record<string, string>> }
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
  const kindRaw = (raw.source_kind ?? "csv").trim();
  let kind: DataSourceKind = "csv";
  if ((DATA_SOURCE_KINDS as readonly string[]).includes(kindRaw)) {
    kind = kindRaw as DataSourceKind;
    if (kind === "dataforseo_business_listings" || kind === "dataforseo_serp") {
      errors.push("DataForSEO scraping ships in Phase B — pick csv or inline for now.");
    }
  } else {
    errors.push("invalid source_kind");
  }
  const csv = (raw.csv ?? "").trim();
  if (!csv) errors.push("data (CSV) is required");
  const parsed = parseCsv(csv);
  if (parsed.columns.length === 0)
    errors.push("CSV must have at least one column in the first row");
  if (parsed.rows.length === 0) errors.push("CSV must have at least one data row");
  if (parsed.rows.length > 500) errors.push("CSV has > 500 rows; hard cap is 500");
  if (errors.length > 0) return { errors, prefill: raw };

  try {
    await env.CONFIG_DB.prepare(
      `INSERT INTO site_data_sources (owner_id, name, source_kind, columns, rows)
       VALUES (?, ?, ?, ?, ?)`,
    )
      .bind(user.id, name, kind, JSON.stringify(parsed.columns), JSON.stringify(parsed.rows))
      .run();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const friendly =
      msg.includes("UNIQUE") && msg.includes("name")
        ? `Data source named "${name}" already exists.`
        : `DB error: ${msg}`;
    return { errors: [friendly], prefill: raw };
  }
  return {
    redirect: flashRedirect("/app/data-sources", {
      text: `Created data source "${name}" (${parsed.rows.length} rows).`,
      kind: "ok",
    }),
  };
}

export async function handleDataSourceEditPost(
  request: Request,
  env: AppEnv,
  url: URL,
  user: User,
  id: number,
): Promise<
  | { redirect: Response }
  | { errors: string[]; prefill: Partial<Record<string, string>> & { id: number } }
> {
  const csrf = checkCsrf(request, url);
  if (csrf) return { redirect: csrf };
  const existing = await loadVisibleDataSource(env, user, id);
  if (!existing) return { redirect: new Response("Not found", { status: 404 }) };
  const form = await request.formData();
  const raw: Record<string, string> = {};
  for (const [k, v] of form.entries()) {
    if (typeof v === "string") raw[k] = v;
  }
  const errors: string[] = [];
  const name = (raw.name ?? "").trim();
  if (!name) errors.push("name is required");
  const csv = (raw.csv ?? "").trim();
  if (!csv) errors.push("data (CSV) is required");
  const parsed = parseCsv(csv);
  if (parsed.rows.length > 500) errors.push("CSV has > 500 rows; hard cap is 500");
  if (errors.length > 0) return { errors, prefill: { id, ...raw } };
  try {
    await env.CONFIG_DB.prepare(
      "UPDATE site_data_sources SET name=?, columns=?, rows=?, updated_at=CURRENT_TIMESTAMP WHERE id=?",
    )
      .bind(name, JSON.stringify(parsed.columns), JSON.stringify(parsed.rows), id)
      .run();
  } catch (e) {
    return {
      errors: [`DB error: ${e instanceof Error ? e.message : String(e)}`],
      prefill: { id, ...raw },
    };
  }
  return {
    redirect: flashRedirect("/app/data-sources", {
      text: `Saved "${name}" (${parsed.rows.length} rows).`,
      kind: "ok",
    }),
  };
}

export async function handleGeneratePreviewPost(
  request: Request,
  env: AppEnv,
  url: URL,
  user: User,
  templateId: number,
): Promise<
  | {
      preview: {
        template: SiteTemplateRow;
        dataSource: SiteDataSourceRow;
        target: RenderTarget;
        plan: RenderPlan;
      };
    }
  | { response: Response }
> {
  const csrf = checkCsrf(request, url);
  if (csrf) return { response: csrf };
  const template = await loadVisibleTemplate(env, user, templateId);
  if (!template) return { response: new Response("Template not found", { status: 404 }) };
  const form = await request.formData();
  const raw: Record<string, string> = {};
  for (const [k, v] of form.entries()) {
    if (typeof v === "string") raw[k] = v;
  }
  const dataSourceId = Number.parseInt(raw.data_source_id ?? "", 10);
  if (!Number.isFinite(dataSourceId) || dataSourceId <= 0) {
    return {
      response: flashRedirect(`/app/templates/${templateId}/generate`, {
        text: "Pick a data source.",
        kind: "err",
      }),
    };
  }
  const dataSource = await loadVisibleDataSource(env, user, dataSourceId);
  if (!dataSource) {
    return {
      response: flashRedirect(`/app/templates/${templateId}/generate`, {
        text: "Data source not found or not visible.",
        kind: "err",
      }),
    };
  }
  const target: RenderTarget =
    template.kind === "pages_in_client"
      ? { mode: "pages_in_client", client_id: (raw.client_id ?? "").trim() }
      : { mode: "client_per_row", zone: (raw.zone ?? "").trim() };
  if (target.mode === "pages_in_client" && !target.client_id) {
    return {
      response: flashRedirect(`/app/templates/${templateId}/generate`, {
        text: "Pick a target client.",
        kind: "err",
      }),
    };
  }
  if (target.mode === "client_per_row" && !target.zone) {
    return {
      response: flashRedirect(`/app/templates/${templateId}/generate`, {
        text: "Pick a target zone.",
        kind: "err",
      }),
    };
  }
  const plan = planRender(template, dataSource);
  return { preview: { template, dataSource, target, plan } };
}

export async function handleGenerateConfirmPost(
  request: Request,
  env: AppEnv,
  url: URL,
  user: User,
  templateId: number,
): Promise<
  { result: { template: SiteTemplateRow; results: GenerateResult[] } } | { response: Response }
> {
  const csrf = checkCsrf(request, url);
  if (csrf) return { response: csrf };
  const template = await loadVisibleTemplate(env, user, templateId);
  if (!template) return { response: new Response("Template not found", { status: 404 }) };
  const form = await request.formData();
  const raw: Record<string, string> = {};
  for (const [k, v] of form.entries()) {
    if (typeof v === "string") raw[k] = v;
  }
  const dataSourceId = Number.parseInt(raw.data_source_id ?? "", 10);
  const dataSource = await loadVisibleDataSource(env, user, dataSourceId);
  if (!dataSource) {
    return {
      response: flashRedirect(`/app/templates/${templateId}/generate`, {
        text: "Data source not found.",
        kind: "err",
      }),
    };
  }
  const target: RenderTarget =
    template.kind === "pages_in_client"
      ? { mode: "pages_in_client", client_id: (raw.client_id ?? "").trim() }
      : { mode: "client_per_row", zone: (raw.zone ?? "").trim() };
  const results = await executeGenerate(env, user, template, dataSource, target);
  return { result: { template, results } };
}

/* ─── Tiny helpers ─── */

function safeParseArray<T>(s: string): T[] {
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? (v as T[]) : [];
  } catch {
    return [];
  }
}

function csvEscapeCell(s: string): string {
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/**
 * Pick the most recently-updated data source whose columns cover every
 * placeholder the template references. Returns null when nothing
 * matches — operators still pick manually, just no preselect.
 */
function pickCompatibleDataSource(
  dataSources: readonly SiteDataSourceRow[],
  placeholders: Set<string>,
): number | null {
  if (placeholders.size === 0) return null;
  const compatible = dataSources.filter((d) => {
    const cols = new Set(safeParseArray<string>(d.columns));
    for (const p of placeholders) {
      if (!cols.has(p)) return false;
    }
    return true;
  });
  if (compatible.length === 0) return null;
  // Sort by updated_at desc — freshest match wins.
  compatible.sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));
  return compatible[0]?.id ?? null;
}
