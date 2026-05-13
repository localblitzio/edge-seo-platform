/**
 * Per-site Indexing page (`/app/clients/:id/indexing`).
 *
 * Two jobs:
 *   1. **Diagnose** — for every URL the operator has touched (per-page
 *      rules + seed_paths), show the SEO verdict (will be / won't be
 *      indexed) and the reason. Computed from config alone (no
 *      network calls), so the page loads instantly.
 *
 *   2. **Submit** — for every configured indexer (registry entries
 *      whose secret is bound), offer a "Submit all" button that
 *      pings the service with the include-verdict URL list.
 *
 * Operators get a clear "what's indexable, what isn't, and let me
 * push it to the engines now" workflow without leaving the admin UI.
 */

import { ACTIVE_INDEXERS, pingAllConfiguredIndexers } from "../../src/secrets/indexer-registry.js";
import { getSecret } from "../../src/secrets/store.js";
import { type PathDiagnostic, computePathDiagnostics } from "../../src/sitemap/diagnostics.js";
import { collectSitemapUrls } from "../../src/sitemap/generator.js";
import { probeUrl } from "../../src/sitemap/probe.js";

import type { AppEnv, ClientRow, FlashMessage } from "./app.js";
import { canSeeAllClients, esc } from "./app.js";
import type { User } from "./auth.js";

import { ClientConfig } from "../../src/config/schema.js";
import {
  type IndexationCheckRow,
  checkUrlIndexation,
  loadLatestChecksForClient,
} from "./indexation-check.js";

/* ─── Types ─── */

interface ConfiguredIndexer {
  slotKey: string;
  label: string;
  /** Brand-ish background colour for the Submit button — set per-entry in `indexer-registry.ts`. */
  color: string;
}

/* ─── Helpers ─── */

/**
 * Loaded ClientRow + parsed ClientConfig for a single client. Throws
 * if config is malformed (we let the caller convert to a 500 — at
 * that point the proxy worker would also be failing).
 */
async function loadClientForIndexing(
  env: AppEnv,
  user: User,
  clientId: string,
): Promise<{ row: ClientRow; config: ClientConfig } | null> {
  const sql = canSeeAllClients(user)
    ? "SELECT * FROM clients WHERE client_id = ?"
    : "SELECT * FROM clients WHERE client_id = ? AND owner_id = ?";
  const stmt = canSeeAllClients(user)
    ? env.CONFIG_DB.prepare(sql).bind(clientId)
    : env.CONFIG_DB.prepare(sql).bind(clientId, user.id);
  const row = await stmt.first<ClientRow>();
  if (!row) return null;
  const config = ClientConfig.parse(JSON.parse(row.config_json));
  return { row, config };
}

/**
 * Read every active-indexer slot in parallel; return the subset whose
 * secret is currently bound. Drives the "Submit" panel — operators
 * only see buttons for indexers they've actually configured.
 */
async function loadConfiguredIndexers(env: AppEnv): Promise<ConfiguredIndexer[]> {
  const sharedEnv = env as unknown as Parameters<typeof getSecret>[0];
  const values = await Promise.all(ACTIVE_INDEXERS.map((i) => getSecret(sharedEnv, i.slotKey)));
  const out: ConfiguredIndexer[] = [];
  for (let i = 0; i < ACTIVE_INDEXERS.length; i++) {
    const entry = ACTIVE_INDEXERS[i];
    const value = values[i];
    if (!entry || !value) continue;
    out.push({ slotKey: entry.slotKey, label: entry.label, color: entry.color });
  }
  return out;
}

const SOURCE_LABELS: Record<string, string> = {
  seed_paths: "seed",
  routing: "routing",
  text_rewrites: "text",
  meta_rewrites: "meta",
  canonicals: "canonical",
  schema_injections: "schema",
  content_injections: "content-inject",
  element_removals: "remove",
};

function renderVerdict(diag: PathDiagnostic): string {
  if (diag.verdict.kind === "include") {
    return `<span class="verdict verdict-ok" title="Will appear in /sitemap.xml and indexer pings"><strong>✓</strong> Will index</span>`;
  }
  const reason = diag.verdict.reason;
  const reasonLabel = (() => {
    switch (reason.kind) {
      case "canonical_origin":
        return "Canonical → origin";
      case "canonical_external":
        return "Canonical → external";
      case "noindex":
        return "noindex";
      case "redirect_source":
        return "Redirects away";
    }
  })();
  return `<span class="verdict verdict-err" title="${esc(reason.detail)}"><strong>✗</strong> ${esc(reasonLabel)}</span>`;
}

function renderIndexationCell(check: IndexationCheckRow | undefined): string {
  if (!check) {
    return `<span class="indexation-pill indexation-unchecked" title="No check run yet — click 'Check indexed' to query DataForSEO">unchecked</span>`;
  }
  if (check.indexed === 1) {
    return `<span class="indexation-pill indexation-yes" title="Last check ${esc(check.checked_at)} — Google site:URL returned an organic match">indexed</span> <span class="muted small" style="font-size:.7rem">${esc(check.checked_at)}</span>`;
  }
  if (check.indexed === 0) {
    return `<span class="indexation-pill indexation-no" title="Last check ${esc(check.checked_at)} — Google site:URL returned 0 organic results">not indexed</span> <span class="muted small" style="font-size:.7rem">${esc(check.checked_at)}</span>`;
  }
  return `<span class="indexation-pill indexation-unknown" title="Last check ${esc(check.checked_at)} — DataForSEO error or unparseable response">unknown</span> <span class="muted small" style="font-size:.7rem">${esc(check.checked_at)}</span>`;
}

function renderRow(diag: PathDiagnostic, check: IndexationCheckRow | undefined): string {
  const sources = diag.sources.map((s) => SOURCE_LABELS[s] ?? s).join(", ");
  const canonicalCell =
    diag.canonical === "custom" && diag.canonicalCustomUrl
      ? `custom → <code class="mono small">${esc(diag.canonicalCustomUrl)}</code>`
      : esc(diag.canonical);
  const robotsCell = diag.robots ? `<code class="mono small">${esc(diag.robots)}</code>` : "—";
  const isInclude = diag.verdict.kind === "include";
  const checkbox = `<input type="checkbox" name="path" value="${esc(diag.path)}" data-eligible="${isInclude ? "1" : "0"}"${isInclude ? " checked" : ""} aria-label="Include ${esc(diag.path)} in submission">`;
  const rowClass = isInclude ? "" : ' class="row-blocked"';
  const probeBtn = `<button type="button" class="probe-btn" data-path="${esc(diag.path)}" title="Fetch this URL through the proxy and show live SEO diagnostics">Probe</button>`;
  // `name="target_path"` (not `path`) so the click doesn't collide
  // with the row checkboxes' `name="path"` when the parent form
  // posts. `formaction="indexing/check"` resolves relative to the
  // form's action (`.../indexing`) → `.../indexing/check`.
  const indexedBtn = `<button type="submit" name="target_path" value="${esc(diag.path)}" class="probe-btn" formaction="indexing/check" formmethod="POST" title="Query DataForSEO site:URL — checks if Google has this URL indexed">Check indexed</button>`;
  return `<tr${rowClass} data-path-row="${esc(diag.path)}">
    <td>${checkbox}</td>
    <td><a href="${esc(diag.url)}" target="_blank" rel="noopener noreferrer" class="mono small">${esc(diag.path)}</a></td>
    <td class="muted small">${esc(sources) || "—"}</td>
    <td class="small">${canonicalCell}</td>
    <td class="small">${robotsCell}</td>
    <td>${renderVerdict(diag)}</td>
    <td class="small">${renderIndexationCell(check)}</td>
    <td>${probeBtn} ${indexedBtn}</td>
  </tr>`;
}

const INDEXING_CSS = `
.indexing-summary{display:flex;gap:1rem;margin:1rem 0 1.5rem;flex-wrap:wrap}
.indexing-summary .stat{padding:.6rem .9rem;background:var(--bg-elevated);border:1px solid var(--border);border-radius:var(--radius);min-width:8rem}
.indexing-summary .stat .label{font-size:.7rem;text-transform:uppercase;letter-spacing:.06em;color:var(--fg-muted);margin:0}
.indexing-summary .stat .value{font-size:1.5rem;font-weight:600;margin:.15rem 0 0}
.indexing-table{width:100%;border-collapse:collapse;background:var(--bg-elevated);border:1px solid var(--border);border-radius:var(--radius);overflow:hidden}
.indexing-table th{background:var(--bg-sidebar,#f4f4f5);text-align:left;font-weight:600;font-size:.75rem;text-transform:uppercase;letter-spacing:.04em;color:var(--fg-muted);padding:.55rem .9rem;border-bottom:1px solid var(--border)}
.indexing-table td{padding:.55rem .9rem;border-top:1px solid var(--border);vertical-align:middle}
.indexing-table .small{font-size:.82rem}
.indexing-table .muted{color:var(--fg-muted)}
.indexing-table tr.row-blocked{background:linear-gradient(transparent 0,transparent 100%);opacity:.85}
.indexing-table tr.row-blocked td:not(:first-child){color:var(--fg-muted)}
.verdict{display:inline-flex;align-items:center;gap:.35rem;padding:.15rem .5rem;border-radius:9999px;font-size:.78rem;font-weight:500;cursor:help}
.verdict strong{font-weight:700}
.verdict-ok{background:var(--green-bg);color:var(--green)}
.verdict-err{background:var(--red-bg);color:var(--red)}
.indexing-actions{margin-top:1.25rem;padding:1rem 1.25rem;background:var(--bg-elevated);border:1px solid var(--border);border-radius:var(--radius)}
.indexing-actions h3{margin:0 0 .65rem;font-size:.95rem}
.indexing-actions .submit-row{display:flex;gap:.5rem;flex-wrap:wrap;margin-top:.5rem}
.indexing-actions .submit-row button{font:inherit;padding:.45rem .9rem;border:1px solid var(--border-strong);background:var(--bg-elevated);color:var(--fg);border-radius:var(--radius);cursor:pointer;font-weight:500}
.indexing-actions .submit-row button:hover{border-color:var(--accent);color:var(--accent)}
.indexing-actions .submit-row button.indexer-btn:hover{filter:brightness(1.1);color:#fff!important}
.indexing-actions .empty{color:var(--fg-muted);font-size:.9rem;margin:0}
.indexing-actions .empty a{color:var(--accent)}
.probe-btn{font:inherit;font-size:.78rem;padding:.2rem .55rem;border:1px solid var(--border-strong);background:var(--bg-elevated);color:var(--fg);border-radius:.35rem;cursor:pointer}
.probe-btn:hover{border-color:var(--accent);color:var(--accent)}
.probe-btn[disabled]{opacity:.6;cursor:wait}
.probe-result{background:var(--bg-code,#f4f4f5);font-size:.82rem;padding:.6rem .9rem;border-top:2px solid var(--accent)}
.probe-result dl{margin:0;display:grid;grid-template-columns:auto 1fr;gap:.25rem .9rem}
.probe-result dt{color:var(--fg-muted);font-weight:600;font-size:.72rem;text-transform:uppercase;letter-spacing:.04em;align-self:center}
.probe-result dd{margin:0;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:.82rem;word-break:break-word;align-self:center}
.probe-result .status-ok{color:var(--green)}
.probe-result .status-err{color:var(--red)}
.probe-result .status-warn{color:var(--amber)}
.probe-result .empty-val{color:var(--fg-muted);font-style:italic}
.indexation-pill{display:inline-block;padding:.15rem .5rem;border-radius:9999px;font-size:.75rem;font-weight:500;line-height:1.2}
.indexation-yes{background:var(--green-bg);color:var(--green)}
.indexation-no{background:var(--red-bg);color:var(--red)}
.indexation-unknown{background:var(--amber-bg);color:var(--amber)}
.indexation-unchecked{background:var(--bg-elevated);color:var(--fg-muted);border:1px dashed var(--border)}
`;

/* ─── Render ─── */

export function renderIndexingPage(opts: {
  client: ClientRow;
  config: ClientConfig;
  diagnostics: PathDiagnostic[];
  configuredIndexers: ConfiguredIndexer[];
  /**
   * Latest known indexation-check result per URL (keyed on absolute
   * URL, not path). When a row has no entry, the cell renders
   * "unchecked." Pass an empty Map when the caller doesn't load them.
   */
  latestChecks?: Map<string, IndexationCheckRow>;
}): string {
  const { client, diagnostics, configuredIndexers, latestChecks } = opts;
  const includeCount = diagnostics.filter((d) => d.verdict.kind === "include").length;
  const excludeCount = diagnostics.length - includeCount;

  const tableRows = diagnostics.length
    ? diagnostics
        .map((d) => renderRow(d, latestChecks ? latestChecks.get(d.url) : undefined))
        .join("")
    : `<tr><td colspan="8" class="muted small" style="text-align:center;padding:1.25rem">No paths pinned. Add per-page rules or <code>seed_paths</code> entries in this site's config to start indexing.</td></tr>`;

  const indexerButtons = configuredIndexers.length
    ? configuredIndexers
        .map(
          (i) =>
            // Per-indexer hue from `indexer-registry.ts` so operators
            // can tell the four services apart at a glance. Inline
            // style keeps the colour source-of-truth in the registry
            // (no CSS-in-templates sync drift). White text against
            // each registry colour is WCAG-AA at minimum.
            `<button type="submit" name="indexer" value="${esc(i.slotKey)}" class="indexer-btn" style="background:${esc(i.color)};border-color:${esc(i.color)};color:#fff">Submit selected to ${esc(i.label)}</button>`,
        )
        .join("\n      ")
    : `<p class="empty">No indexers configured. Bind an API key in <a href="/app/settings/api-keys">Settings → API keys</a> to enable submissions.</p>`;

  return `<style>${INDEXING_CSS}</style>
<header class="page-header" style="display:flex;align-items:baseline;justify-content:space-between;gap:1rem;flex-wrap:wrap">
  <div>
    <h2 style="margin:0">Indexing — ${esc(client.client_id)}</h2>
    <p class="muted small" style="margin:.25rem 0 0">${esc(client.proxy_domain)}</p>
  </div>
  <div style="display:flex;gap:.5rem;align-items:center">
    ${
      configuredIndexers.length > 0 && includeCount > 0
        ? `<form method="post" action="/app/clients/${esc(client.client_id)}/indexing/reindex" style="margin:0">
            <button type="submit" class="btn-primary" title="Submit every eligible URL to all configured indexers — no per-row selection needed">Reindex now (${configuredIndexers.length} service${configuredIndexers.length === 1 ? "" : "s"})</button>
          </form>`
        : ""
    }
    <a href="/app/clients/${esc(client.client_id)}" class="btn">← Back to site</a>
  </div>
</header>

<div class="indexing-summary">
  <div class="stat"><p class="label">Will index</p><p class="value">${includeCount}</p></div>
  <div class="stat"><p class="label">Blocked</p><p class="value">${excludeCount}</p></div>
  <div class="stat"><p class="label">Total paths</p><p class="value">${diagnostics.length}</p></div>
</div>

<form method="post" action="/app/clients/${esc(client.client_id)}/indexing">
<table class="indexing-table">
  <thead>
    <tr>
      <th style="width:2.5rem">
        <input type="checkbox" id="select-all" aria-label="Select all eligible paths">
      </th>
      <th>Path</th>
      <th>Source</th>
      <th>Canonical</th>
      <th>Robots</th>
      <th>Verdict</th>
      <th>Indexed?</th>
      <th style="width:11rem">Actions</th>
    </tr>
  </thead>
  <tbody>${tableRows}</tbody>
</table>

<div class="indexing-actions">
  <h3>Submit to indexers</h3>
  <p class="muted small" style="margin:.15rem 0 .25rem">
    Submits every checked URL above. Eligible rows are pre-selected. To submit a blocked URL anyway (e.g. to test the indexer or override a noindex rule), tick its row manually.
  </p>
  <div class="submit-row">
    ${indexerButtons}
  </div>
</div>
</form>

<script>
  // Select-all has three states driven by user clicks:
  //   1st click  → check ALL eligible (data-eligible="1")
  //   2nd click  → also check blocked rows
  //   3rd click  → uncheck everything
  // This matches the most common operator flows: "submit eligible" /
  // "submit absolutely everything including overrides" / "clear".
  (function() {
    const master = document.getElementById("select-all");
    if (!master) return;
    let stage = 0;
    master.addEventListener("click", () => {
      stage = (stage + 1) % 3;
      const all = document.querySelectorAll('input[name="path"]');
      all.forEach((el) => {
        const cb = el;
        const eligible = cb.getAttribute("data-eligible") === "1";
        if (stage === 1) cb.checked = eligible;
        else if (stage === 2) cb.checked = true;
        else cb.checked = false;
      });
      master.checked = stage !== 0;
      master.indeterminate = stage === 1
        && document.querySelectorAll('input[name="path"][data-eligible="0"]').length > 0;
    });
  })();

  // Per-row Probe — POST /probe with the path, render JSON result
  // as a sub-row below the original row.
  (function() {
    const csrf = (function() {
      const m = document.cookie.match(/(?:^|; )csrf_token=([^;]*)/);
      return m ? decodeURIComponent(m[1]) : "";
    })();
    function fmt(v) {
      if (v === undefined || v === null || v === "") {
        return '<span class="empty-val">(none)</span>';
      }
      return String(v).replace(/[&<>]/g, function(c) {
        return c === "&" ? "&amp;" : c === "<" ? "&lt;" : "&gt;";
      });
    }
    function statusClass(status) {
      if (typeof status !== "number") return "status-err";
      if (status >= 200 && status < 300) return "status-ok";
      if (status >= 300 && status < 400) return "status-warn";
      return "status-err";
    }
    function renderResult(r) {
      if (!r.ok && r.error) {
        return '<dl><dt>Error</dt><dd class="status-err">' + fmt(r.error) + '</dd></dl>';
      }
      const rows = [];
      rows.push('<dt>Status</dt><dd class="' + statusClass(r.status) + '">' + fmt(r.status ?? "?") + '</dd>');
      if (r.finalUrl) rows.push('<dt>Final URL</dt><dd>' + fmt(r.finalUrl) + '</dd>');
      rows.push('<dt>Title</dt><dd>' + fmt(r.title) + '</dd>');
      rows.push('<dt>Description</dt><dd>' + fmt(r.description) + '</dd>');
      rows.push('<dt>Canonical</dt><dd>' + fmt(r.canonical) + '</dd>');
      rows.push('<dt>Meta robots</dt><dd>' + fmt(r.robots) + '</dd>');
      rows.push('<dt>X-Robots-Tag</dt><dd>' + fmt(r.xRobotsTag) + '</dd>');
      if (r.error) rows.push('<dt>Note</dt><dd class="status-warn">' + fmt(r.error) + '</dd>');
      return '<dl>' + rows.join('') + '</dl>';
    }
    document.querySelectorAll(".probe-btn").forEach(function(btn) {
      btn.addEventListener("click", async function() {
        const path = btn.getAttribute("data-path");
        if (!path) return;
        const row = btn.closest("tr");
        if (!row) return;
        // Tear down any previous result row.
        const existing = row.nextElementSibling;
        if (existing && existing.classList.contains("probe-result-row")) {
          existing.remove();
          if (btn.dataset.openState === "1") {
            btn.dataset.openState = "0";
            btn.textContent = "Probe";
            return;
          }
        }
        btn.disabled = true;
        btn.textContent = "Probing…";
        try {
          const fd = new FormData();
          fd.set("path", path);
          const action = window.location.pathname + "/probe";
          const resp = await fetch(action, {
            method: "POST",
            body: fd,
            credentials: "same-origin",
          });
          let result;
          try { result = await resp.json(); }
          catch { result = { ok: false, error: "Probe endpoint returned non-JSON (HTTP " + resp.status + ")." }; }
          const tr = document.createElement("tr");
          tr.className = "probe-result-row";
          const td = document.createElement("td");
          td.colSpan = 7;
          td.className = "probe-result";
          td.innerHTML = renderResult(result);
          tr.appendChild(td);
          row.insertAdjacentElement("afterend", tr);
          btn.dataset.openState = "1";
          btn.textContent = "Hide";
        } catch (e) {
          const tr = document.createElement("tr");
          tr.className = "probe-result-row";
          const td = document.createElement("td");
          td.colSpan = 7;
          td.className = "probe-result";
          td.innerHTML = '<dl><dt>Error</dt><dd class="status-err">' + fmt(String(e)) + '</dd></dl>';
          tr.appendChild(td);
          row.insertAdjacentElement("afterend", tr);
          btn.textContent = "Retry";
        } finally {
          btn.disabled = false;
        }
      });
    });
  })();
</script>`;
}

/* ─── Submit handler ─── */

/**
 * Handle POST: submit selected paths to the chosen indexer.
 *
 * Form fields:
 *   - `indexer` — slot key of the chosen indexer (e.g. INDEXNOW_KEY)
 *   - `path` — repeated, the paths to submit
 */
export async function handleIndexingSubmit(
  request: Request,
  env: AppEnv,
  user: User,
  clientId: string,
): Promise<Response> {
  const form = await request.formData();
  const indexerKey = String(form.get("indexer") ?? "");
  const paths = form
    .getAll("path")
    .map(String)
    .filter((p) => p.length > 0);

  const loaded = await loadClientForIndexing(env, user, clientId);
  if (!loaded) {
    return new Response("Not found", { status: 404 });
  }

  const indexer = ACTIVE_INDEXERS.find((i) => i.slotKey === indexerKey);
  if (!indexer) {
    return flashRedirect(`/app/clients/${clientId}/indexing`, {
      text: `Unknown indexer: ${indexerKey}`,
      kind: "err",
    });
  }

  const sharedEnv = env as unknown as Parameters<typeof getSecret>[0];
  const key = await getSecret(sharedEnv, indexer.slotKey);
  if (!key) {
    return flashRedirect(`/app/clients/${clientId}/indexing`, {
      text: `${indexer.label} key isn't configured. Set it in Settings → API keys first.`,
      kind: "err",
    });
  }

  if (paths.length === 0) {
    return flashRedirect(`/app/clients/${clientId}/indexing`, {
      text: "No paths selected. Tick at least one row before submitting.",
      kind: "warn",
    });
  }

  const urls = paths.map((p) => `https://${loaded.config.proxy_domain}${p}`);
  const result = await indexer.submit(key, urls, { proxyDomain: loaded.config.proxy_domain });

  return flashRedirect(`/app/clients/${clientId}/indexing`, {
    text: result.message,
    kind: result.ok ? "ok" : "err",
  });
}

/**
 * Handle the Reindex-now POST: fan out the full eligible-URL list to
 * every configured indexer in parallel, no per-row selection needed.
 *
 * Mirrors the save-time auto-ping (`maybePingIndexers` in app.ts) —
 * uses `collectSitemapUrls(cfg)` as the URL source so behaviour is
 * identical to "I just hit Save again." Returns a flash redirect
 * with a per-indexer summary so the operator sees what fired.
 */
export async function handleReindexAll(
  env: AppEnv,
  user: User,
  clientId: string,
): Promise<Response> {
  const loaded = await loadClientForIndexing(env, user, clientId);
  if (!loaded) {
    return new Response("Not found", { status: 404 });
  }
  const urls = collectSitemapUrls(loaded.config);
  if (urls.length === 0) {
    return flashRedirect(`/app/clients/${clientId}/indexing`, {
      text: "No eligible URLs to submit. Add per-page rules or seed_paths first.",
      kind: "warn",
    });
  }
  const results = await pingAllConfiguredIndexers(
    env as unknown as Parameters<typeof pingAllConfiguredIndexers>[0],
    urls,
    { proxyDomain: loaded.config.proxy_domain },
  );
  if (results.length === 0) {
    return flashRedirect(`/app/clients/${clientId}/indexing`, {
      text: "No indexers configured. Bind an API key in Settings → API keys first.",
      kind: "warn",
    });
  }
  // Compose a per-indexer summary, joined with "; " so operators see
  // each service's outcome in one flash banner.
  const summary = results.map((r) => r.result.message).join(" | ");
  const allOk = results.every((r) => r.result.ok);
  const allFailed = results.every((r) => !r.result.ok);
  const kind: "ok" | "warn" | "err" = allOk ? "ok" : allFailed ? "err" : "warn";
  return flashRedirect(`/app/clients/${clientId}/indexing`, {
    text: `Reindex (${urls.length} URL${urls.length === 1 ? "" : "s"}): ${summary}`,
    kind,
  });
}

/**
 * Handle the per-row Probe POST: fetch one URL through the proxy and
 * return SEO diagnostics as JSON. The Indexing page's inline JS
 * renders the result into the row.
 *
 * Form body: `path` — the path to probe, must be one of the rows in
 * computePathDiagnostics (defensive — prevents using this endpoint
 * to fetch arbitrary URLs).
 */
export async function handleProbeUrl(
  request: Request,
  env: AppEnv,
  user: User,
  clientId: string,
): Promise<Response> {
  const form = await request.formData();
  const path = String(form.get("path") ?? "");
  if (!path.startsWith("/")) {
    return new Response(JSON.stringify({ ok: false, error: "Invalid path" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }
  const loaded = await loadClientForIndexing(env, user, clientId);
  if (!loaded) {
    return new Response(JSON.stringify({ ok: false, error: "Not found" }), {
      status: 404,
      headers: { "content-type": "application/json" },
    });
  }
  // Defensive: only allow probing paths the diagnostics surface.
  // Stops anyone from using this endpoint to fetch arbitrary URLs
  // (the backend has more bandwidth than the operator's IP).
  const diagnostics = computePathDiagnostics(loaded.config);
  const validPaths = new Set(diagnostics.map((d) => d.path));
  if (!validPaths.has(path)) {
    return new Response(JSON.stringify({ ok: false, error: "Path not in diagnostics" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }
  const targetUrl = `https://${loaded.config.proxy_domain}${path}`;
  const result = await probeUrl(targetUrl);
  return new Response(JSON.stringify(result), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/* ─── Public entry: render full page state ─── */

export async function loadIndexingPageData(
  env: AppEnv,
  user: User,
  clientId: string,
): Promise<{
  client: ClientRow;
  config: ClientConfig;
  diagnostics: PathDiagnostic[];
  configuredIndexers: ConfiguredIndexer[];
  latestChecks: Map<string, IndexationCheckRow>;
} | null> {
  const loaded = await loadClientForIndexing(env, user, clientId);
  if (!loaded) return null;
  const diagnostics = computePathDiagnostics(loaded.config);
  const [configuredIndexers, latestChecks] = await Promise.all([
    loadConfiguredIndexers(env),
    loadLatestChecksForClient(
      env,
      clientId,
      diagnostics.map((d) => d.url),
    ),
  ]);
  return {
    client: loaded.row,
    config: loaded.config,
    diagnostics,
    configuredIndexers,
    latestChecks,
  };
}

/**
 * Handle a single per-URL "Check indexed" POST. Looks up the
 * client, validates the path is one we expose in diagnostics, runs
 * `checkUrlIndexation`, and flash-redirects back to the indexing
 * page with the result message. Bypasses the 24h cache when the
 * operator clicks (force=true) so the button is always meaningful.
 */
export async function handleIndexationCheck(
  request: Request,
  env: AppEnv,
  user: User,
  clientId: string,
): Promise<Response> {
  const form = await request.formData();
  // `target_path` (not `path`) — the per-row button uses this name
  // to avoid colliding with the parent form's `path` checkboxes
  // (the parent form is the submit-to-indexers form and posts every
  // row's checkbox when ANY submit button fires).
  const path = String(form.get("target_path") ?? "");
  if (!path) {
    return flashRedirect(`/app/clients/${encodeURIComponent(clientId)}/indexing`, {
      text: "Missing target_path.",
      kind: "err",
    });
  }
  const loaded = await loadClientForIndexing(env, user, clientId);
  if (!loaded) return new Response("Not found", { status: 404 });
  const diagnostics = computePathDiagnostics(loaded.config);
  const diag = diagnostics.find((d) => d.path === path);
  if (!diag) {
    return flashRedirect(`/app/clients/${encodeURIComponent(clientId)}/indexing`, {
      text: "Path not in diagnostics — re-check from this site's indexing page.",
      kind: "err",
    });
  }
  const result = await checkUrlIndexation(env, clientId, diag.url, user.email, true);
  return flashRedirect(`/app/clients/${encodeURIComponent(clientId)}/indexing`, {
    text: `${diag.path}: ${result.message}`,
    kind: result.status === "indexed" ? "ok" : result.status === "not_indexed" ? "warn" : "err",
  });
}

function flashRedirect(location: string, flash: FlashMessage): Response {
  const sep = location.includes("?") ? "&" : "?";
  const target = `${location}${sep}flash=${encodeURIComponent(flash.text)}&flash_kind=${flash.kind}`;
  return new Response(null, { status: 303, headers: { location: target } });
}
