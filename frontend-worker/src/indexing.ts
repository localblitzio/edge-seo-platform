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

import { ACTIVE_INDEXERS } from "../../src/secrets/indexer-registry.js";
import { getSecret } from "../../src/secrets/store.js";
import { type PathDiagnostic, computePathDiagnostics } from "../../src/sitemap/diagnostics.js";

import type { AppEnv, ClientRow, FlashMessage } from "./app.js";
import { canSeeAllClients, esc } from "./app.js";
import type { User } from "./auth.js";

import { ClientConfig } from "../../src/config/schema.js";

/* ─── Types ─── */

interface ConfiguredIndexer {
  slotKey: string;
  label: string;
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
    out.push({ slotKey: entry.slotKey, label: entry.label });
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

function renderRow(diag: PathDiagnostic): string {
  const sources = diag.sources.map((s) => SOURCE_LABELS[s] ?? s).join(", ");
  const canonicalCell =
    diag.canonical === "custom" && diag.canonicalCustomUrl
      ? `custom → <code class="mono small">${esc(diag.canonicalCustomUrl)}</code>`
      : esc(diag.canonical);
  const robotsCell = diag.robots ? `<code class="mono small">${esc(diag.robots)}</code>` : "—";
  // All rows have enabled checkboxes — eligible rows are checked by
  // default, blocked rows unchecked. Operators can override the
  // verdict by ticking a blocked row (e.g. to submit anyway because
  // the engines will index regardless, or to test the indexer end
  // to end).
  const isInclude = diag.verdict.kind === "include";
  const checkbox = `<input type="checkbox" name="path" value="${esc(diag.path)}" data-eligible="${isInclude ? "1" : "0"}"${isInclude ? " checked" : ""} aria-label="Include ${esc(diag.path)} in submission">`;
  const rowClass = isInclude ? "" : ' class="row-blocked"';
  return `<tr${rowClass}>
    <td>${checkbox}</td>
    <td><a href="${esc(diag.url)}" target="_blank" rel="noopener noreferrer" class="mono small">${esc(diag.path)}</a></td>
    <td class="muted small">${esc(sources) || "—"}</td>
    <td class="small">${canonicalCell}</td>
    <td class="small">${robotsCell}</td>
    <td>${renderVerdict(diag)}</td>
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
.indexing-actions .submit-row button{font:inherit;padding:.45rem .9rem;border:1px solid var(--border-strong);background:var(--bg-elevated);color:var(--fg);border-radius:var(--radius);cursor:pointer}
.indexing-actions .submit-row button:hover{border-color:var(--accent);color:var(--accent)}
.indexing-actions .submit-row button.primary{background:var(--accent);color:var(--accent-fg);border-color:var(--accent)}
.indexing-actions .submit-row button.primary:hover{filter:brightness(1.1);color:var(--accent-fg)}
.indexing-actions .empty{color:var(--fg-muted);font-size:.9rem;margin:0}
.indexing-actions .empty a{color:var(--accent)}
`;

/* ─── Render ─── */

export function renderIndexingPage(opts: {
  client: ClientRow;
  config: ClientConfig;
  diagnostics: PathDiagnostic[];
  configuredIndexers: ConfiguredIndexer[];
}): string {
  const { client, diagnostics, configuredIndexers } = opts;
  const includeCount = diagnostics.filter((d) => d.verdict.kind === "include").length;
  const excludeCount = diagnostics.length - includeCount;

  const tableRows = diagnostics.length
    ? diagnostics.map(renderRow).join("")
    : `<tr><td colspan="6" class="muted small" style="text-align:center;padding:1.25rem">No paths pinned. Add per-page rules or <code>seed_paths</code> entries in this site's config to start indexing.</td></tr>`;

  const indexerButtons = configuredIndexers.length
    ? configuredIndexers
        .map(
          (i) =>
            `<button type="submit" name="indexer" value="${esc(i.slotKey)}" class="primary">Submit selected to ${esc(i.label)}</button>`,
        )
        .join("\n      ")
    : `<p class="empty">No indexers configured. Bind an API key in <a href="/app/settings/api-keys">Settings → API keys</a> to enable submissions.</p>`;

  return `<style>${INDEXING_CSS}</style>
<header class="page-header" style="display:flex;align-items:baseline;justify-content:space-between;gap:1rem;flex-wrap:wrap">
  <div>
    <h2 style="margin:0">Indexing — ${esc(client.client_id)}</h2>
    <p class="muted small" style="margin:.25rem 0 0">${esc(client.proxy_domain)}</p>
  </div>
  <a href="/app/clients/${esc(client.client_id)}" class="btn">← Back to site</a>
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
} | null> {
  const loaded = await loadClientForIndexing(env, user, clientId);
  if (!loaded) return null;
  const diagnostics = computePathDiagnostics(loaded.config);
  const configuredIndexers = await loadConfiguredIndexers(env);
  return { client: loaded.row, config: loaded.config, diagnostics, configuredIndexers };
}

function flashRedirect(location: string, flash: FlashMessage): Response {
  const sep = location.includes("?") ? "&" : "?";
  const target = `${location}${sep}flash=${encodeURIComponent(flash.text)}&flash_kind=${flash.kind}`;
  return new Response(null, { status: 303, headers: { location: target } });
}
