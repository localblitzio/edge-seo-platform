/**
 * Authenticated app — /app/* routes for the frontend worker.
 *
 * Phase E (this commit, v1):
 *   - /app — overview: stats + clients list, filtered by ownership
 *   - /app/clients — full clients list, filtered by ownership
 *   - /app/clients/:id — read-only detail page (config sections, audit
 *     trail, attestations) with explicit "Edit on legacy admin worker"
 *     links for write operations
 *   - /app/audit — audit log + attestations (filtered to clients the
 *     user can see)
 *
 * Phase E v2 (next): port the write handlers (edit, status flip,
 * cache-purge, attestation capture, new client) and remove the legacy-
 * admin links. Phase G (after F) deletes the admin-worker entirely.
 *
 * Multi-tenancy contract (Decision 2):
 *   - Regular users see only `WHERE owner_id = self`.
 *   - Super-admins see all clients.
 *   - All filtering is enforced at the SQL layer in `loadVisibleClients`
 *     / `loadVisibleClient`.
 */

import { DEFAULT_PROXY_ZONE } from "../../src/config/proxy-zone.js";
import { ClientConfig } from "../../src/config/schema.js";
import { assertConfigInvariants } from "../../src/config/validator.js";
import { ConfigValidationError } from "../../src/lib/errors.js";
import type { User } from "./auth.js";
import { BUILD_VERSION } from "./build-version.js";
import { LIST_EDITOR_JS } from "./list-editor-js.js";
import {
  ZIP_MAX_BYTES,
  autoFlattenCommonPrefix,
  contentTypeForPath,
  extractZip,
} from "./zip-extractor.js";

/* ─── Types ─── */

export interface AppEnv {
  CONFIG_KV: KVNamespace;
  CONFIG_DB: D1Database;
  /** Custom-page HTML uploads. Only present on workers configured for
   *  the write surface (admin/frontend), not on read-only auth flows. */
  CONTENT_R2?: R2Bucket;
}

export interface ClientRow {
  client_id: string;
  proxy_domain: string;
  source_domain: string;
  status: string;
  config_json: string;
  schema_version: number;
  created_at: string;
  updated_at: string;
  owner_id: number | null;
}

export interface AttestationRow {
  id: number;
  client_id: string;
  proxy_domain: string;
  source_domain: string;
  attested_by_email: string;
  attested_at: string;
  attested_ip: string;
  user_agent: string | null;
  scope: string;
  scope_paths_json: string | null;
}

export interface AuditRow {
  id: number;
  client_id: string;
  actor_email: string;
  actor_ip: string;
  event_type: string;
  previous_status: string | null;
  new_status: string | null;
  notes: string | null;
  occurred_at: string;
}

export interface FlashMessage {
  text: string;
  kind: "ok" | "warn" | "err";
}

/* ─── Multi-tenancy helpers ─── */

export function canSeeAllClients(user: User): boolean {
  return user.role === "super_admin";
}

export async function loadVisibleClients(env: AppEnv, user: User): Promise<ClientRow[]> {
  if (canSeeAllClients(user)) {
    const r = await env.CONFIG_DB.prepare(
      "SELECT * FROM clients ORDER BY client_id",
    ).all<ClientRow>();
    return r.results ?? [];
  }
  const r = await env.CONFIG_DB.prepare(
    "SELECT * FROM clients WHERE owner_id = ? ORDER BY client_id",
  )
    .bind(user.id)
    .all<ClientRow>();
  return r.results ?? [];
}

export async function loadVisibleClient(
  env: AppEnv,
  user: User,
  id: string,
): Promise<ClientRow | null> {
  if (canSeeAllClients(user)) {
    return env.CONFIG_DB.prepare("SELECT * FROM clients WHERE client_id = ? LIMIT 1")
      .bind(id)
      .first<ClientRow>();
  }
  return env.CONFIG_DB.prepare("SELECT * FROM clients WHERE client_id = ? AND owner_id = ? LIMIT 1")
    .bind(id, user.id)
    .first<ClientRow>();
}

async function loadVisibleAuditRows(env: AppEnv, user: User, limit = 200): Promise<AuditRow[]> {
  try {
    if (canSeeAllClients(user)) {
      const r = await env.CONFIG_DB.prepare("SELECT * FROM audit_log ORDER BY id DESC LIMIT ?")
        .bind(limit)
        .all<AuditRow>();
      return r.results ?? [];
    }
    const r = await env.CONFIG_DB.prepare(
      `SELECT a.* FROM audit_log a
         JOIN clients c ON c.client_id = a.client_id
        WHERE c.owner_id = ?
        ORDER BY a.id DESC LIMIT ?`,
    )
      .bind(user.id, limit)
      .all<AuditRow>();
    return r.results ?? [];
  } catch {
    return [];
  }
}

async function loadVisibleAttestations(
  env: AppEnv,
  user: User,
  limit = 200,
): Promise<AttestationRow[]> {
  try {
    if (canSeeAllClients(user)) {
      const r = await env.CONFIG_DB.prepare("SELECT * FROM attestations ORDER BY id DESC LIMIT ?")
        .bind(limit)
        .all<AttestationRow>();
      return r.results ?? [];
    }
    const r = await env.CONFIG_DB.prepare(
      `SELECT a.* FROM attestations a
         JOIN clients c ON c.client_id = a.client_id
        WHERE c.owner_id = ?
        ORDER BY a.id DESC LIMIT ?`,
    )
      .bind(user.id, limit)
      .all<AttestationRow>();
    return r.results ?? [];
  } catch {
    return [];
  }
}

/* ─── HTML escaping ─── */

const HTML_ENTITIES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};
export function esc(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (c) => HTML_ENTITIES[c] ?? c);
}

function statusPill(status: string): string {
  const cls =
    status === "active" ? "pill-active" : status === "paused" ? "pill-paused" : "pill-terminated";
  return `<span class="pill ${cls}">${esc(status)}</span>`;
}

/* ─── App layout (sidebar nav) ─── */

export const APP_STYLE = `
.app-layout{display:grid;grid-template-columns:220px 1fr;min-height:calc(100vh - 56px - 80px)}
.app-sidebar{background:var(--bg-sidebar,#f4f4f5);border-right:1px solid var(--border);padding:1.25rem .75rem;display:flex;flex-direction:column}
@media (prefers-color-scheme:dark){.app-sidebar{background:#0d0d10}}
.app-sidebar a{display:block;padding:.45rem .75rem;border-radius:var(--radius);color:var(--fg);text-decoration:none}
.app-sidebar a:hover{background:var(--bg-elevated)}
.app-sidebar a.active{background:var(--accent);color:var(--accent-fg)}
.app-sidebar-section{font-size:.7rem;text-transform:uppercase;letter-spacing:.08em;color:var(--fg-muted);font-weight:600;padding:.5rem .75rem;margin-top:.75rem}
.app-sidebar-version{margin-top:auto;padding:.55rem .75rem;font-size:.7rem;color:var(--fg-muted);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.04em;border-top:1px solid var(--border)}
.app-main{padding:1.75rem 2rem;max-width:1100px}
.app-main h1{font-size:1.45rem;margin:0 0 .4rem;font-weight:700;letter-spacing:-.01em}
.app-main h2{font-size:1.05rem;margin:1.75rem 0 .6rem;font-weight:600}
.app-main .subtitle{color:var(--fg-muted);margin:0 0 1.5rem}
.app-main .card{background:var(--bg-elevated);border:1px solid var(--border);border-radius:var(--radius);padding:1rem 1.25rem;margin-bottom:1rem;box-shadow:var(--shadow,0 1px 2px rgba(0,0,0,.04))}
.app-main .stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:.85rem;margin:0 0 1.5rem}
.app-main .stat{background:var(--bg-elevated);border:1px solid var(--border);border-radius:var(--radius);padding:.85rem 1rem}
.app-main .stat .label{font-size:.72rem;text-transform:uppercase;letter-spacing:.05em;color:var(--fg-muted);font-weight:600}
.app-main .stat .value{font-size:1.6rem;font-weight:700;margin-top:.15rem;letter-spacing:-.02em}
table.data{width:100%;border-collapse:collapse;font-size:.9rem;background:var(--bg-elevated);border:1px solid var(--border);border-radius:var(--radius);overflow:hidden}
table.data th{background:var(--bg-sidebar,#f4f4f5);text-align:left;font-weight:600;font-size:.78rem;text-transform:uppercase;letter-spacing:.04em;color:var(--fg-muted);padding:.55rem .9rem;border-bottom:1px solid var(--border)}
@media (prefers-color-scheme:dark){table.data th{background:#0d0d10}}
table.data td{padding:.55rem .9rem;border-bottom:1px solid var(--border);vertical-align:top}
table.data tr:last-child td{border-bottom:0}
.pill{display:inline-block;padding:.1rem .55rem;border-radius:9999px;font-size:.72rem;font-weight:600}
.pill-active{background:var(--green-bg);color:var(--green)}
.pill-paused{background:var(--amber-bg);color:var(--amber)}
.pill-terminated{background:var(--red-bg);color:var(--red)}
.pill-neutral{background:var(--bg-sidebar,#f4f4f5);color:var(--fg-muted);border:1px solid var(--border)}
@media (prefers-color-scheme:dark){.pill-neutral{background:#0d0d10}}
.crumbs{font-size:.85rem;color:var(--fg-muted);margin-bottom:.4rem}
.crumbs a{color:var(--fg-muted)}
dl.kv{display:grid;grid-template-columns:max-content 1fr;gap:.4rem 1.25rem;margin:.5rem 0 0;font-size:.9rem}
dl.kv dt{color:var(--fg-muted);font-weight:500}
dl.kv dd{margin:0;font-family:var(--mono);font-size:.85rem;word-break:break-word}
.empty{color:var(--fg-muted);font-style:italic;padding:.5rem 0}
.actions-row{display:flex;flex-wrap:wrap;gap:.5rem;margin:0 0 1.25rem;padding:.85rem 1rem;background:var(--bg-elevated);border:1px solid var(--border);border-radius:var(--radius)}
details.section{background:var(--bg-elevated);border:1px solid var(--border);border-radius:var(--radius);padding:.75rem 1rem;margin-bottom:.6rem}
details.section>summary{cursor:pointer;font-weight:600;user-select:none;display:flex;justify-content:space-between;align-items:center}
details.section>summary::after{content:"▸";color:var(--fg-muted);transition:transform .15s}
details.section[open]>summary::after{transform:rotate(90deg)}
details.section>summary .count{background:var(--bg-sidebar,#f4f4f5);color:var(--fg-muted);font-weight:500;padding:.05rem .5rem;border-radius:9999px;font-size:.78rem;margin-left:.5rem}
details.section>.body{margin-top:.85rem}
.json-block{background:var(--bg-code,#f4f4f5);border:1px solid var(--border);border-radius:var(--radius);padding:1rem;overflow-x:auto;font-family:var(--mono);font-size:.85rem;line-height:1.5;margin:.4rem 0 0}
.btn-link{color:var(--accent);text-decoration:none}.btn-link:hover{text-decoration:underline}
.actions-row form{display:inline}
form.editor{display:flex;flex-direction:column;gap:.85rem}
form.editor label{font-weight:600;font-size:.85rem}
form.editor textarea{font:inherit;font-family:var(--mono);font-size:.85rem;padding:.5rem .65rem;border:1px solid var(--border-strong);border-radius:var(--radius);background:var(--bg-elevated);color:var(--fg);width:100%;min-height:520px;line-height:1.45;resize:vertical}
form.editor input[type=text],form.editor input[type=email],form.editor select{font:inherit;font-size:.95rem;padding:.55rem .75rem;border:1px solid var(--border-strong);border-radius:var(--radius);background:var(--bg-elevated);color:var(--fg);width:100%}
form.editor .hint{font-size:.78rem;color:var(--fg-muted);margin-top:-.35rem}
form.editor .form-actions{display:flex;gap:.5rem;align-items:center;margin-top:.5rem}
.form-section{background:var(--bg-elevated);border:1px solid var(--border);border-radius:var(--radius);padding:1rem 1.25rem}
.form-section h2{margin-top:0;margin-bottom:.85rem;font-size:.95rem;font-weight:600}
.form-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:.85rem 1.25rem}
.form-grid .full-width{grid-column:span 2}
.form-grid label{font-weight:600;font-size:.78rem;display:block;margin-bottom:.2rem}
.form-grid input[type=text],.form-grid input[type=email],.form-grid select{font:inherit;font-size:.88rem;padding:.4rem .55rem;border:1px solid var(--border-strong);border-radius:var(--radius);background:var(--bg);color:var(--fg);width:100%}
.form-grid input[readonly]{background:var(--bg-sidebar,#f4f4f5);cursor:not-allowed;color:var(--fg-muted)}
.form-grid .field-hint{font-size:.72rem;color:var(--fg-muted);margin-top:.2rem;line-height:1.35}
.proxy-mode{display:flex;flex-direction:column;gap:.4rem;margin-top:.2rem}
.proxy-radio{display:flex;align-items:center;gap:.5rem;font-weight:400;font-size:.9rem;cursor:pointer}
.proxy-radio input[type=radio]{margin:0}
.proxy-radio input[type=text]{flex:0 0 auto}
.proxy-suffix{font-family:var(--mono);font-size:.85rem;color:var(--fg-muted)}
.error-box{background:var(--red-bg);color:var(--red);border:1px solid var(--red);border-radius:var(--radius);padding:.65rem 1rem;font-family:var(--mono);font-size:.85rem;white-space:pre-wrap;margin:0 0 1rem}
.btn{font:inherit;border:1px solid var(--border-strong);background:var(--bg-elevated);color:var(--fg);padding:.35rem .85rem;border-radius:var(--radius);cursor:pointer;display:inline-block;text-decoration:none}
.btn:hover{border-color:var(--accent);color:var(--accent);text-decoration:none}
.btn-primary{background:var(--accent);color:var(--accent-fg);border-color:var(--accent)}.btn-primary:hover{filter:brightness(1.1);color:var(--accent-fg)}
.btn-success{border-color:var(--green);color:var(--green)}.btn-success:hover{background:var(--green-bg);color:var(--green)}
.btn-warn{border-color:var(--amber);color:var(--amber)}.btn-warn:hover{background:var(--amber-bg);color:var(--amber)}
.btn-danger{border-color:var(--red);color:var(--red)}.btn-danger:hover{background:var(--red-bg);color:var(--red)}
.list-entry{background:var(--bg);border:1px solid var(--border);border-radius:var(--radius);padding:.85rem 1rem;margin-bottom:.6rem}
.list-entry .list-entry-foot{margin-top:.75rem;display:flex;justify-content:flex-end}
.list-entry textarea{font-family:var(--mono);font-size:.82rem;width:100%;padding:.5rem .65rem;border:1px solid var(--border-strong);border-radius:var(--radius);background:var(--bg-elevated);color:var(--fg);resize:vertical}
.checkbox-row{display:flex;flex-wrap:wrap;gap:.85rem;margin-top:.3rem}
.checkbox-inline{display:inline-flex;align-items:center;gap:.4rem;font-weight:400;font-size:.85rem;cursor:pointer}
.checkbox-inline input[type=checkbox]{margin:0}
.form-section h2{display:flex;justify-content:space-between;align-items:center}
.form-section h2 .btn{font-size:.75rem;padding:.3rem .7rem;font-weight:600}
.inspect-panel{background:var(--bg-sidebar,#f4f4f5);border:1px solid var(--border);border-radius:var(--radius);padding:.75rem 1rem;margin:0 0 .85rem}
@media (prefers-color-scheme:dark){.inspect-panel{background:#0d0d10}}
.inspect-row{display:flex;gap:.5rem;align-items:center;flex-wrap:wrap}
.inspect-row label{font-weight:600;font-size:.85rem}
.inspect-row input[type=text]{font:inherit;font-size:.9rem;padding:.4rem .55rem;border:1px solid var(--border-strong);border-radius:var(--radius);background:var(--bg-elevated);color:var(--fg)}
.inspect-result-list{display:flex;flex-direction:column;gap:.4rem;max-height:400px;overflow-y:auto}
.inspect-result-row{display:flex;gap:.6rem;align-items:flex-start;background:var(--bg-elevated);border:1px solid var(--border);border-radius:var(--radius);padding:.5rem .75rem}
.inspect-result-tag{display:inline-block;padding:.05rem .45rem;border-radius:9999px;font-size:.7rem;font-weight:700;background:var(--accent);color:var(--accent-fg);text-transform:uppercase;flex-shrink:0;font-family:var(--mono);min-width:1.6rem;text-align:center}
.inspect-result-text{flex:1;font-size:.85rem;line-height:1.4;color:var(--fg);overflow-wrap:break-word;min-width:0}
.inspect-result-selector{font-family:var(--mono);font-size:.7rem;color:var(--fg-muted);margin-top:.15rem;display:block}
.inspect-result-row .btn{flex-shrink:0;font-size:.72rem;padding:.25rem .65rem}
.inspect-status-ok{color:var(--green);font-size:.85rem}
.inspect-status-err{color:var(--red);font-size:.85rem}
.inspect-status-loading{color:var(--fg-muted);font-size:.85rem}
`;

interface AppLayoutOpts {
  title: string;
  content: string;
  activeNav: string;
  user: User;
  flash: FlashMessage | null;
  clients: ClientRow[];
}

export function appSidebar(opts: { activeNav: string; clients: ClientRow[]; user: User }): string {
  const navLinks = [
    { href: "/app", id: "home", label: "Overview" },
    { href: "/app/clients", id: "clients", label: "Clients" },
    { href: "/app/audit", id: "audit", label: "Audit log" },
  ];
  const items = navLinks
    .map(
      (l) =>
        `<a href="${l.href}"${opts.activeNav === l.id ? ' class="active"' : ""}>${esc(l.label)}</a>`,
    )
    .join("");
  const adminLink =
    opts.user.role === "super_admin"
      ? `<div class="app-sidebar-section">Super-admin</div><a href="/admin/users"${opts.activeNav === "admin:users" ? ' class="active"' : ""}>Users</a>`
      : "";
  const clientList =
    opts.clients.length > 0
      ? `<div class="app-sidebar-section">Clients</div>${opts.clients
          .map(
            (c) =>
              `<a href="/app/clients/${esc(c.client_id)}"${
                opts.activeNav === `client:${c.client_id}` ? ' class="active"' : ""
              } style="padding-left:1.25rem;font-size:.85rem;">${esc(c.client_id)}</a>`,
          )
          .join("")}`
      : "";
  // Build version pinned at deploy time — operators use this to
  // verify a change actually shipped. Click to reveal full SHA via
  // title attribute.
  const versionFooter = `<div class="app-sidebar-version" title="Build ${esc(BUILD_VERSION)}">build ${esc(BUILD_VERSION)}</div>`;
  return `<nav class="app-sidebar">${items}${adminLink}${clientList}${versionFooter}</nav>`;
}

export function appLayout(opts: AppLayoutOpts): string {
  const flashHtml = opts.flash
    ? `<div class="flash flash-${esc(opts.flash.kind)}" role="alert">${esc(opts.flash.text)}</div>`
    : "";
  return `<div class="app-layout">
    ${appSidebar({ activeNav: opts.activeNav, clients: opts.clients, user: opts.user })}
    <main class="app-main">${flashHtml}${opts.content}</main>
  </div>`;
}

/* ─── Pages ─── */

export async function renderOverview(env: AppEnv, user: User): Promise<string> {
  const clients = await loadVisibleClients(env, user);
  let totalRoutes = 0;
  let totalRedirects = 0;
  let totalCanonicals = 0;
  let totalSchema = 0;
  for (const c of clients) {
    try {
      const cfg = JSON.parse(c.config_json);
      totalRoutes += cfg.routing?.length ?? 0;
      totalRedirects +=
        (cfg.redirects?.static?.length ?? 0) +
        (cfg.redirects?.patterns?.length ?? 0) +
        (cfg.redirects?.conditional?.length ?? 0);
      totalCanonicals += cfg.canonicals?.length ?? 0;
      totalSchema += cfg.schema_injections?.length ?? 0;
    } catch {
      /* ignore */
    }
  }
  const stat = (label: string, value: number | string) =>
    `<div class="stat"><div class="label">${esc(label)}</div><div class="value">${esc(value)}</div></div>`;
  const rows = clients
    .map(
      (c) => `<tr>
        <td><a href="/app/clients/${esc(c.client_id)}" class="mono">${esc(c.client_id)}</a></td>
        <td class="mono">${esc(c.proxy_domain)}</td>
        <td>${statusPill(c.status)}</td>
        <td class="mono" style="color:var(--fg-muted)">${esc(c.updated_at)}</td>
      </tr>`,
    )
    .join("");
  const ownership =
    user.role === "super_admin"
      ? "Showing all clients across the platform (super-admin)."
      : `Showing ${clients.length} client${clients.length === 1 ? "" : "s"} you own.`;
  return `<h1>Overview</h1>
    <p class="subtitle">${ownership}</p>
    <div class="stats">${stat("Clients", clients.length)}${stat("Routes", totalRoutes)}${stat("Redirects", totalRedirects)}${stat("Canonicals", totalCanonicals)}${stat("Schemas", totalSchema)}</div>
    ${
      clients.length === 0
        ? `<div class="empty">No clients to show. Use the legacy admin worker to create one (write surface ports here in a follow-up).</div>`
        : `<h2>Your clients</h2><table class="data"><thead><tr><th>client_id</th><th>proxy</th><th>status</th><th>updated</th></tr></thead><tbody>${rows}</tbody></table>`
    }`;
}

export async function renderClientsList(env: AppEnv, user: User): Promise<string> {
  const clients = await loadVisibleClients(env, user);
  if (clients.length === 0) {
    return `<h1>Clients <a href="/app/clients/new" class="btn btn-primary" style="float:right">+ New client</a></h1>
      <p class="subtitle">${user.role === "super_admin" ? "No clients in the platform yet." : "You don't own any clients yet."}</p>
      <div class="empty">No clients to show. <a href="/app/clients/new">Create the first one →</a></div>`;
  }
  const rows = clients
    .map(
      (c) => `<tr>
        <td><a href="/app/clients/${esc(c.client_id)}" class="mono">${esc(c.client_id)}</a></td>
        <td class="mono">${esc(c.proxy_domain)}</td>
        <td class="mono">${esc(c.source_domain)}</td>
        <td>${statusPill(c.status)}</td>
        <td>v${esc(c.schema_version)}</td>
        <td class="mono" style="color:var(--fg-muted)">${esc(c.created_at)}</td>
      </tr>`,
    )
    .join("");
  const ownership =
    user.role === "super_admin"
      ? "All clients across the platform (super-admin)."
      : `Clients you own (${clients.length}).`;
  return `<h1>Clients <a href="/app/clients/new" class="btn btn-primary" style="float:right">+ New client</a></h1>
    <p class="subtitle">${ownership}</p>
    <table class="data">
      <thead><tr><th>client_id</th><th>proxy</th><th>source</th><th>status</th><th>schema</th><th>created</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
}

function rulesTable(headers: string[], rows: string[]): string {
  if (rows.length === 0) return `<div class="empty">none configured</div>`;
  return `<table class="data"><thead><tr>${headers.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>${rows.join("")}</tbody></table>`;
}

function section(label: string, count: number, body: string): string {
  return `<details class="section"${count > 0 ? " open" : ""}><summary>${esc(label)} <span class="count">${count}</span></summary><div class="body">${body}</div></details>`;
}

function jsonHtml(value: unknown): string {
  if (value === null) return `<span style="color:var(--fg-muted)">null</span>`;
  if (typeof value === "boolean") return `<span>${value}</span>`;
  if (typeof value === "number") return `<span>${value}</span>`;
  if (typeof value === "string") return `<span style="color:var(--green)">"${esc(value)}"</span>`;
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    const items = value
      .map((v) => `<div style="padding-left:1.5em">${jsonHtml(v)},</div>`)
      .join("");
    return `[<div>${items}</div>]`;
  }
  if (typeof value === "object") {
    const keys = Object.keys(value);
    if (keys.length === 0) return "{}";
    const items = keys
      .map(
        (k) =>
          `<div style="padding-left:1.5em"><span style="color:var(--accent)">"${esc(k)}"</span>: ${jsonHtml(
            (value as Record<string, unknown>)[k],
          )},</div>`,
      )
      .join("");
    return `{<div>${items}</div>}`;
  }
  return esc(String(value));
}

/* ─── Per-page edit grouping ─── */

/**
 * Rule-array keys we group by `match` for the per-page editor. These are
 * the rule types where a `match` regex names a path or path-pattern.
 */
const PER_PAGE_RULE_KINDS = [
  "text_rewrites",
  "meta_rewrites",
  "redirects.static",
  "schema_injections",
  "indexation",
  "canonicals",
] as const;

type PerPageRuleKind = (typeof PER_PAGE_RULE_KINDS)[number];

interface PageGroup {
  /** The raw match value (regex source) used as the grouping key. */
  match: string;
  /**
   * Whether this match looks like a per-page literal (e.g. `^/about-us$`)
   * or a wildcard pattern (e.g. `^/.*`, `^/blog/.*`). Wildcards group
   * under "Site-wide / section-wide" so they don't crowd the per-page list.
   */
  wildcard: boolean;
  /** Human-readable derived path if the match is a literal `^/path$`. */
  literalPath: string | null;
  /** Per-rule-kind counts. */
  counts: Partial<Record<PerPageRuleKind, number>>;
}

/**
 * Walk a client config and return one group per distinct `match` value
 * across the per-page rule kinds. Wildcards (anything containing `.*`,
 * `.+`, `[^/]*`, etc.) get the `wildcard` flag set so the UI separates
 * them from per-page literal matches.
 */
export function summarizeEditedPages(cfg: Record<string, unknown>): PageGroup[] {
  const groupsByMatch = new Map<string, PageGroup>();

  function pushRule(match: string, kind: PerPageRuleKind): void {
    const existing = groupsByMatch.get(match);
    if (existing) {
      existing.counts[kind] = (existing.counts[kind] ?? 0) + 1;
      return;
    }
    const wildcard = isWildcardMatch(match);
    groupsByMatch.set(match, {
      match,
      wildcard,
      literalPath: wildcard ? null : derivLiteralPath(match),
      counts: { [kind]: 1 },
    });
  }

  function arr(key: string): Array<Record<string, unknown>> {
    if (key === "redirects.static") {
      const r = cfg.redirects as Record<string, unknown> | undefined;
      return ((r?.static ?? []) as Array<Record<string, unknown>>) || [];
    }
    return ((cfg[key] ?? []) as Array<Record<string, unknown>>) || [];
  }

  for (const kind of PER_PAGE_RULE_KINDS) {
    for (const rule of arr(kind)) {
      const match = typeof rule.match === "string" ? rule.match : null;
      if (match) pushRule(match, kind);
    }
  }

  return [...groupsByMatch.values()].sort((a, b) => {
    // Literal per-page first, then wildcards. Within each, alphabetical.
    if (a.wildcard !== b.wildcard) return a.wildcard ? 1 : -1;
    return a.match.localeCompare(b.match);
  });
}

/**
 * Public accessor for `derivLiteralPath` so the route handler can derive
 * a path from the match regex when no existing rule is around to do it
 * (e.g. opening the per-page editor for a path that has no rules yet —
 * the Inspect field should still pre-fill with the path, not `/`).
 */
export function literalPathFromMatch(match: string): string | null {
  return derivLiteralPath(match);
}

function isWildcardMatch(m: string): boolean {
  // Heuristic: any pattern with regex repetition or character-class
  // ranges is treated as wildcard. Literal matches like `^/about$` use
  // only escaped specials and have no repetition operators.
  // Strip a trailing `/?` (optional-slash form emitted by the per-page
  // editor for `^/path/?$`) before testing — that's still a per-page
  // literal, not a real wildcard.
  const stripped = m.replace(/\/\?\$$/, "$");
  return /[*+?]|\[\^/.test(stripped);
}

/**
 * Try to derive a literal path from a regex like `^/about-us$`. Returns
 * null if the pattern isn't a clean literal-match shape.
 */
function derivLiteralPath(m: string): string | null {
  if (!m.startsWith("^") || !m.endsWith("$")) return null;
  // The per-page editor emits `^/path/?$` so the rule matches both
  // `/path` and `/path/`. Strip the optional-slash so the inner-loop
  // sees a clean literal — display the slash-form for clarity since
  // most origins canonicalize to it.
  const trailingOptionalSlash = m.endsWith("/?$");
  const inner = trailingOptionalSlash ? m.slice(1, -3) : m.slice(1, -1);
  // Un-escape regex specials. If any unescaped special remains, it's
  // not a clean literal and we return null.
  let out = "";
  let i = 0;
  while (i < inner.length) {
    const c = inner[i] ?? "";
    if (c === "\\" && i + 1 < inner.length) {
      out += inner[i + 1] ?? "";
      i += 2;
    } else if (".*+?()[]{}|^$\\".includes(c)) {
      // Unescaped regex special — not a literal path.
      return null;
    } else {
      out += c;
      i += 1;
    }
  }
  if (!out.startsWith("/")) return null;
  // Display the slash-form for clarity — origins usually canonicalize
  // to it. `^/$` (root) stays as `/`.
  if (trailingOptionalSlash && out !== "/" && !out.endsWith("/")) {
    out += "/";
  }
  return out;
}

/**
 * Derive the base path from a static-site route regex. The form
 * emitted by the upload handler is `^<basePath>(/.*)?$` (and the
 * legacy `^<basePath>/.*` is also accepted for forward compatibility
 * with hand-edited configs). Returns the basePath portion (e.g.
 * `/site/landing`) or null if the regex doesn't match either shape.
 */
function deriveStaticSiteBase(match: string): string | null {
  // Try the canonical shape first: `^<basePath>(/.*)?$`.
  let m = match.match(/^\^(.+?)\(\/\.\*\)\?\$$/);
  if (!m) {
    // Legacy shape: `^<basePath>/.*` (no closing $).
    m = match.match(/^\^(.+?)\/\.\*$/);
  }
  if (!m || !m[1]) return null;
  // Un-escape regex specials in the basePath segment.
  let out = "";
  const inner = m[1];
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i] ?? "";
    if (c === "\\" && i + 1 < inner.length) {
      out += inner[++i] ?? "";
    } else if (".*+?()[]{}|^$\\".includes(c)) {
      return null;
    } else {
      out += c;
    }
  }
  return out.startsWith("/") ? out : null;
}

function renderPagesWithEditsPanel(
  clientId: string,
  proxyDomain: string,
  cfg: Record<string, unknown>,
): string {
  const groups = summarizeEditedPages(cfg);
  const literal = groups.filter((g) => !g.wildcard);
  const wildcard = groups.filter((g) => g.wildcard);

  const renderCounts = (counts: PageGroup["counts"]): string => {
    const parts: string[] = [];
    const labels: Record<PerPageRuleKind, string> = {
      text_rewrites: "text",
      meta_rewrites: "meta",
      "redirects.static": "redirect",
      schema_injections: "schema",
      indexation: "indexation",
      canonicals: "canonical",
    };
    for (const [kind, count] of Object.entries(counts)) {
      parts.push(`${count} ${labels[kind as PerPageRuleKind]}`);
    }
    return parts.join(" · ");
  };

  const renderRow = (g: PageGroup): string => {
    const display = g.literalPath ?? g.match;
    const editHref = `/app/clients/${esc(clientId)}/page?match=${encodeURIComponent(g.match)}`;
    // Wildcards have no concrete URL to open; only literal paths get
    // the live-link.
    const liveCell = g.literalPath
      ? `<a href="https://${esc(proxyDomain)}${esc(g.literalPath)}" target="_blank" rel="noopener" title="Open on proxy">↗</a>`
      : "";
    return `<tr>
      <td class="mono">${esc(display)}${g.wildcard ? ' <span class="pill pill-neutral">wildcard</span>' : ""}</td>
      <td style="color:var(--fg-muted);font-size:.85rem">${esc(renderCounts(g.counts))}</td>
      <td style="text-align:center;width:1.5rem">${liveCell}</td>
      <td><a href="${editHref}" class="btn-link">Edit →</a></td>
    </tr>`;
  };

  const literalRows = literal.length
    ? `<table class="data" style="margin-bottom:.6rem"><thead><tr><th>path</th><th>edits</th><th></th><th></th></tr></thead><tbody>${literal.map(renderRow).join("")}</tbody></table>`
    : '<div class="empty" style="margin:0 0 .6rem">no per-page edits yet</div>';

  const wildcardRows = wildcard.length
    ? `<details class="section" style="margin:0 0 1rem"><summary>Site-wide / section-wide rules <span class="count">${wildcard.length}</span></summary><div class="body"><table class="data"><thead><tr><th>match</th><th>edits</th><th></th><th></th></tr></thead><tbody>${wildcard.map(renderRow).join("")}</tbody></table></div></details>`
    : "";

  return `<div class="card" style="margin-bottom:1rem">
    <div style="display:flex;justify-content:space-between;align-items:center;margin:0 0 .85rem">
      <h2 style="margin:0;font-size:1.05rem;font-weight:600">Pages with edits</h2>
      <button type="button" class="btn btn-primary" data-edit-page-prompt="${esc(clientId)}" style="font-size:.78rem;padding:.3rem .8rem">+ Edit a page</button>
    </div>
    ${literalRows}
    ${wildcardRows}
    <p class="field-hint" style="margin:0">Each row is a unique <code>match</code> regex across your text/meta/redirect/schema/indexation/canonical rules. Click <strong>Edit →</strong> to manage all rules for that path in one view.</p>
  </div>
  <script>
  (function() {
    document.addEventListener('click', function(e) {
      var t = e.target;
      if (t && t.dataset && t.dataset.editPagePrompt) {
        var p = prompt('Edit which path? (e.g. /about-us)', '/');
        if (p == null) return;
        var clean = p.trim();
        if (!clean) return;
        if (!clean.startsWith('/')) clean = '/' + clean;
        // Strip a trailing slash and emit "/?$" so the regex matches
        // both /about-us and /about-us/. Origins like WordPress canon-
        // calize to the trailing-slash form; the operator should not
        // need to know which form the proxy is currently serving.
        var stripped = clean.replace(/\\/+$/, '');
        var match;
        if (stripped === '') {
          match = '^/$';
        } else {
          match = '^' + stripped.replace(/[.*+?^\$()|[\\]{}\\\\]/g, '\\\\$&') + '/?$';
        }
        location.href = '/app/clients/' + encodeURIComponent(t.dataset.editPagePrompt) + '/page?match=' + encodeURIComponent(match);
      }
    });
  })();
  </script>`;
}

export async function renderClientDetail(env: AppEnv, user: User, id: string): Promise<string> {
  const client = await loadVisibleClient(env, user, id);
  if (!client) {
    return `<div class="crumbs"><a href="/app/clients">← Clients</a></div>
      <h1>Not found</h1>
      <div class="empty">No client with that id, or you don't have access to it.</div>`;
  }
  let cfg: Record<string, unknown> = {};
  let parseError: string | null = null;
  try {
    cfg = JSON.parse(client.config_json);
  } catch (e) {
    parseError = (e as Error).message;
  }
  const auth = (cfg.authorization as Record<string, unknown> | undefined) ?? {};
  const arr = (k: string) => (cfg[k] as Array<Record<string, unknown>>) ?? [];
  const r = (cfg.redirects as Record<string, unknown> | undefined) ?? {};
  const staticR = (r.static as Array<Record<string, unknown>>) ?? [];
  const patternR = (r.patterns as Array<Record<string, unknown>>) ?? [];
  const conditionalR = (r.conditional as Array<Record<string, unknown>>) ?? [];

  const routesRows = arr("routing").map(
    (rr, i) =>
      `<tr><td>${i}</td><td class="mono">${esc(rr.match)}</td><td><span class="pill pill-neutral">${esc(rr.type)}</span></td><td class="mono">${esc(rr.origin ?? "")}</td><td class="mono">${esc((rr.origin_auth as { type?: string } | undefined)?.type ?? "none")}</td></tr>`,
  );
  const staticRows = staticR.map(
    (rr, i) =>
      `<tr><td>${i}</td><td class="mono">${esc(rr.from)}</td><td class="mono">${esc(rr.to)}</td><td class="mono">${esc(rr.status ?? "301")}</td></tr>`,
  );
  const patternRows = patternR.map(
    (rr, i) =>
      `<tr><td>${i}</td><td class="mono">${esc(rr.pattern)}</td><td class="mono">${esc(rr.replacement)}</td><td class="mono">${esc(rr.status ?? "301")}</td></tr>`,
  );
  const conditionalRows = conditionalR.map(
    (rr, i) =>
      `<tr><td>${i}</td><td class="mono">${esc(rr.match)}</td><td class="mono" style="font-size:.8rem">${esc(JSON.stringify(rr.conditions))}</td><td class="mono">${esc(rr.to)}</td></tr>`,
  );
  const canonicalRows = arr("canonicals").map(
    (rr, i) =>
      `<tr><td>${i}</td><td class="mono">${esc(rr.match)}</td><td class="mono">${esc((rr.strategy as { type?: string } | undefined)?.type)}</td></tr>`,
  );
  const schemaRows = arr("schema_injections").map(
    (rr, i) =>
      `<tr><td>${i}</td><td class="mono">${esc(rr.match)}</td><td class="mono">${esc(rr.schema_type)}</td><td class="mono">${esc(rr.position)}</td></tr>`,
  );
  const indexRows = arr("indexation").map(
    (rr, i) =>
      `<tr><td>${i}</td><td class="mono">${esc(rr.match)}</td><td class="mono">${esc(rr.robots)}</td></tr>`,
  );
  const cacheRows = arr("caching").map(
    (rr, i) =>
      `<tr><td>${i}</td><td class="mono">${esc(rr.match)}</td><td class="mono">${esc(rr.ttl_seconds)}</td></tr>`,
  );

  return `<div class="crumbs"><a href="/app/clients">← Clients</a></div>
    <h1>${esc(client.client_id)} ${statusPill(client.status)}</h1>
    <p class="subtitle"><a class="mono" href="https://${esc(client.proxy_domain)}/" target="_blank" rel="noopener">${esc(client.proxy_domain)}</a> &nbsp;→&nbsp; <span class="mono">${esc(client.source_domain)}</span></p>
    ${renderActionsRow(client)}
    ${parseError ? `<div class="empty">⚠ Config JSON parse error: ${esc(parseError)}</div>` : ""}
    ${renderPagesWithEditsPanel(client.client_id, client.proxy_domain, cfg)}
    ${renderCustomPagesPanel(client, cfg)}
    <div class="card"><h2 style="margin-top:0">Authorization</h2><dl class="kv">
      <dt>Attested by</dt><dd>${esc(auth.attested_by_email)}</dd>
      <dt>At</dt><dd>${esc(auth.attested_at)}</dd>
      <dt>From IP</dt><dd>${esc(auth.attested_ip)}</dd>
      <dt>Scope</dt><dd>${esc(auth.scope)}${auth.scope_paths ? ` (${esc((auth.scope_paths as string[]).join(", "))})` : ""}</dd>
      <dt>Expires at</dt><dd>${auth.expires_at === null || auth.expires_at === undefined ? "—" : esc(auth.expires_at)}</dd>
      <dt>Schema version</dt><dd>${esc(client.schema_version)}</dd>
    </dl></div>
    ${section("Routing", routesRows.length, rulesTable(["#", "match", "type", "origin", "auth"], routesRows))}
    ${section("Static redirects", staticRows.length, rulesTable(["#", "from", "to", "status"], staticRows))}
    ${section("Pattern redirects", patternRows.length, rulesTable(["#", "pattern", "replacement", "status"], patternRows))}
    ${section("Conditional redirects", conditionalRows.length, rulesTable(["#", "match", "conditions", "to"], conditionalRows))}
    ${section("Canonicals", canonicalRows.length, rulesTable(["#", "match", "strategy"], canonicalRows))}
    ${section("Schema injections", schemaRows.length, rulesTable(["#", "match", "schema_type", "position"], schemaRows))}
    ${section("Indexation", indexRows.length, rulesTable(["#", "match", "robots"], indexRows))}
    ${section("Caching", cacheRows.length, rulesTable(["#", "match", "ttl_seconds"], cacheRows))}
    <details class="section"><summary>Raw ClientConfig <span class="count">json</span></summary><div class="body"><div class="json-block">${jsonHtml(cfg)}</div></div></details>`;
}

export async function renderAuditPage(env: AppEnv, user: User): Promise<string> {
  const audit = await loadVisibleAuditRows(env, user);
  const attest = await loadVisibleAttestations(env, user);
  const auditRows = audit
    .map(
      (a) =>
        `<tr><td>${esc(a.id)}</td><td class="mono" style="color:var(--fg-muted)">${esc(a.occurred_at)}</td><td><a href="/app/clients/${esc(a.client_id)}" class="mono">${esc(a.client_id)}</a></td><td><span class="pill pill-neutral">${esc(a.event_type)}</span></td><td class="mono">${esc(a.actor_email)}</td><td class="mono" style="color:var(--fg-muted)">${esc(a.notes ?? "")}</td></tr>`,
    )
    .join("");
  const attestRows = attest
    .map(
      (a) =>
        `<tr><td>${esc(a.id)}</td><td class="mono" style="color:var(--fg-muted)">${esc(a.attested_at)}</td><td><a href="/app/clients/${esc(a.client_id)}" class="mono">${esc(a.client_id)}</a></td><td class="mono">${esc(a.proxy_domain)}</td><td class="mono">${esc(a.source_domain)}</td><td class="mono">${esc(a.attested_by_email)}</td><td class="mono">${esc(a.scope)}</td></tr>`,
    )
    .join("");
  const ownership =
    user.role === "super_admin"
      ? "All audit + attestation events across the platform."
      : "Audit + attestation events on clients you own.";
  return `<h1>Audit log</h1>
    <p class="subtitle">${ownership}</p>
    <h2>Audit events</h2>
    ${auditRows ? `<table class="data"><thead><tr><th>id</th><th>at</th><th>client</th><th>event</th><th>actor</th><th>notes</th></tr></thead><tbody>${auditRows}</tbody></table>` : `<div class="empty">No audit events recorded.</div>`}
    <h2>Attestations</h2>
    ${attestRows ? `<table class="data"><thead><tr><th>id</th><th>at</th><th>client</th><th>proxy</th><th>source</th><th>by</th><th>scope</th></tr></thead><tbody>${attestRows}</tbody></table>` : `<div class="empty">No attestations recorded.</div>`}`;
}

/* ─── Audit + KV + validation helpers ─── */

type AuditEventType =
  | "config_create"
  | "config_update"
  | "status_change"
  | "revocation"
  | "authorization_update";

export interface AuditEntry {
  client_id: string;
  actor_email: string;
  actor_ip: string;
  event_type: AuditEventType;
  before_hash: string | null;
  after_hash: string | null;
  previous_status: string | null;
  new_status: string | null;
  notes: string | null;
}

export async function writeAudit(env: AppEnv, entry: AuditEntry): Promise<void> {
  await env.CONFIG_DB.prepare(
    `INSERT INTO audit_log
       (client_id, actor_email, actor_ip, event_type,
        before_hash, after_hash, previous_status, new_status, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      entry.client_id,
      entry.actor_email,
      entry.actor_ip,
      entry.event_type,
      entry.before_hash,
      entry.after_hash,
      entry.previous_status,
      entry.new_status,
      entry.notes,
    )
    .run();
}

export async function invalidateKv(
  env: AppEnv,
  clientId: string,
  proxyDomain: string,
): Promise<void> {
  await Promise.all([
    env.CONFIG_KV.delete(`config:${clientId}`),
    env.CONFIG_KV.delete(`domain:${proxyDomain}`),
  ]);
}

export function fnvHash(s: string): string {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

export function validateConfigJson(
  raw: string,
):
  | { ok: true; config: import("../../src/config/schema.js").ClientConfig }
  | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { ok: false, error: `JSON parse error: ${(e as Error).message}` };
  }
  const result = ClientConfig.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .slice(0, 25)
      .map((i) => `  ${i.path.join(".") || "<root>"}: ${i.message}`)
      .join("\n");
    return { ok: false, error: `Schema validation failed:\n${issues}` };
  }
  try {
    assertConfigInvariants(result.data);
  } catch (e) {
    if (e instanceof ConfigValidationError) {
      return { ok: false, error: `Invariant failed: ${e.message}` };
    }
    return { ok: false, error: `Validation failed: ${(e as Error).message}` };
  }
  return { ok: true, config: result.data };
}

/* ─── Actions row ─── */

function renderActionsRow(client: ClientRow): string {
  const statusBtn = (target: string, label: string, cls: string, confirm: string | null) => {
    if (client.status === target)
      return `<button class="btn" disabled style="opacity:.5;cursor:not-allowed">${esc(label)} (current)</button>`;
    const onclick = confirm ? ` onclick="return confirm(${JSON.stringify(confirm)})"` : "";
    return `<form method="POST" action="/app/clients/${esc(client.client_id)}/status">
      <input type="hidden" name="status" value="${esc(target)}">
      <button class="btn ${cls}" type="submit"${onclick}>${esc(label)}</button>
    </form>`;
  };
  return `<div class="actions-row">
    <a class="btn btn-primary" href="/app/clients/${esc(client.client_id)}/edit">Edit config</a>
    <a class="btn" href="/app/clients/${esc(client.client_id)}/attest">Capture attestation</a>
    <form method="POST" action="/app/clients/${esc(client.client_id)}/cache-purge"><button class="btn" type="submit">Purge cache</button></form>
    ${statusBtn("active", "Activate", "btn-success", null)}
    ${statusBtn("paused", "Pause", "btn-warn", "Pause this client? The Worker will return 410 for all requests.")}
    ${statusBtn("terminated", "Terminate", "btn-danger", "Terminate is a one-way door per PRD §6.3. Requests will return 410 permanently. Are you sure?")}
  </div>`;
}

/* ─── Form renderers ─── */

function renderStructuredFormBody(opts: {
  prefilledJson: string;
  isEdit: boolean;
}): string {
  const idAttrs = opts.isEdit ? "readonly" : 'required pattern="[a-z0-9-]+"';
  return [
    '<div class="form-section"><h2>Identity</h2><div class="form-grid">',
    '<div><label for="f_client_id">client_id</label>',
    `<input id="f_client_id" type="text" ${idAttrs}>`,
    `<div class="field-hint">${opts.isEdit ? "cannot be changed via edit" : "lowercase letters, digits, or hyphens (DNS-safe)"}</div></div>`,
    '<div><label for="f_status">status</label><select id="f_status"><option value="active">active</option><option value="paused">paused</option><option value="terminated">terminated</option></select></div>',
    '<div class="full-width"><label>proxy_domain</label><div class="proxy-mode">',
    '<label class="proxy-radio"><input type="radio" name="proxy_mode" value="default" id="f_proxy_mode_default" checked>',
    '<span>Default zone:</span><input id="f_proxy_subdomain" type="text" placeholder="client-id" style="width:14rem">',
    `<span class="proxy-suffix">.${esc(DEFAULT_PROXY_ZONE)}</span></label>`,
    '<label class="proxy-radio"><input type="radio" name="proxy_mode" value="custom" id="f_proxy_mode_custom">',
    '<span>Custom domain:</span><input id="f_proxy_custom" type="text" placeholder="yourdomain.com" style="width:18rem" disabled></label>',
    '</div><div class="field-hint">Default zone: served by the platform\'s wildcard DNS. Custom: requires DNS pointed at the worker.</div>',
    '<input type="hidden" id="f_proxy_domain"></div>',
    '<div class="full-width"><label for="f_source_domain">source_domain</label><input id="f_source_domain" type="text" required>',
    '<div class="field-hint">the upstream the platform fetches from (e.g. customer-cms.example.com)</div></div>',
    "</div></div>",
    '<div class="form-section"><h2>Permission attestation</h2><div class="form-grid">',
    '<div><label for="f_attested_by_email">attested_by_email</label><input id="f_attested_by_email" type="email" required></div>',
    '<div><label for="f_attested_ip">attested_ip</label><input id="f_attested_ip" type="text" placeholder="0.0.0.0"></div>',
    '<div><label for="f_scope">scope</label><select id="f_scope"><option value="full_site">full_site</option><option value="specified_paths">specified_paths</option></select></div>',
    '<div><label for="f_scope_paths">scope_paths (CSV)</label><input id="f_scope_paths" type="text" placeholder="/blog,/landing"><div class="field-hint">used only when scope = specified_paths</div></div>',
    "</div></div>",
    '<div class="form-section"><h2>Primary route</h2><div class="form-grid"><div class="full-width">',
    '<label for="f_origin">routing[0].origin</label><input id="f_origin" type="text" placeholder="https://example.com">',
    '<div class="field-hint">URL the proxy fetches from for the default route. For multiple routes / custom_pages / origin_auth / strip_prefix, edit the JSON below.</div>',
    "</div></div></div>",
    '<div class="form-section" id="section-indexation"><h2>Indexation rules <button type="button" class="btn" data-add-to="indexation">+ Add</button></h2>',
    '<p class="field-hint" style="margin:0 0 .6rem">Tells search engines which pages to index. Each entry pairs a path-regex with a <code>robots</code> meta value. Example: match <code>^/blog/.*</code> with robots <code>index,follow</code> to allow indexing of blog posts.</p>',
    '<div data-list-container="indexation"></div></div>',
    '<div class="form-section" id="section-canonicals"><h2>Canonical rules <button type="button" class="btn" data-add-to="canonicals">+ Add</button></h2>',
    '<p class="field-hint" style="margin:0 0 .6rem">Sets <code>&lt;link rel="canonical"&gt;</code>. <code>origin</code> points to the upstream (don\'t compete with source). <code>self</code> points to the proxy (rank the proxy). <code>custom</code> takes a URL. Example: match <code>^/.*</code> with strategy <code>origin</code> for a SaaS subfolder.</p>',
    '<div data-list-container="canonicals"></div></div>',
    '<div class="form-section" id="section-schema-injections"><h2>Schema injections <button type="button" class="btn" data-add-to="schema_injections">+ Add</button></h2>',
    '<p class="field-hint" style="margin:0 0 .6rem">Injects JSON-LD <code>&lt;script type="application/ld+json"&gt;</code> into <code>&lt;head&gt;</code>. Example: match <code>^/about</code>, schema_type <code>LocalBusiness</code>, payload with <code>@type:LocalBusiness</code>, name, address, phone.</p>',
    '<div data-list-container="schema_injections"></div></div>',
    '<div class="form-section" id="section-static-redirects"><h2>Static redirects <button type="button" class="btn" data-add-to="redirects.static">+ Add</button></h2>',
    '<p class="field-hint" style="margin:0 0 .6rem">Exact-path redirects evaluated before proxy fetch. Example: from <code>/old-product</code>, to <code>/products/new-product</code>, status <code>301</code>.</p>',
    '<div data-list-container="redirects.static"></div></div>',
    '<div class="form-section" id="section-meta-rewrites"><h2>Meta rewrites <button type="button" class="btn" data-add-to="meta_rewrites">+ Add</button></h2>',
    '<p class="field-hint" style="margin:0 0 .6rem">Rewrites <code>&lt;title&gt;</code>, <code>meta name="description"</code>, OG/Twitter tags. Example: match <code>^/blog/post-x</code>, tag <code>title</code>, value <code>Post X — My Blog</code>.</p>',
    '<div data-list-container="meta_rewrites"></div></div>',
    '<div class="form-section" id="section-text-rewrites"><h2>Text &amp; heading rewrites <button type="button" class="btn" data-add-to="text_rewrites">+ Add</button></h2>',
    '<p class="field-hint" style="margin:0 0 .6rem">Replaces the inner content of any element matching a CSS selector — H1/H2/H3, paragraphs, taglines, button text, etc. Element attributes and classes are preserved. Example: match <code>^/$</code>, selector <code>h1</code>, content <code>Welcome — Now Accepting Residents</code>. Use <code>html</code> mode to wrap part of the replacement in an <code>&lt;em&gt;</code> or <code>&lt;span&gt;</code>.</p>',
    // Page-element picker. Operator types a path, clicks Fetch, the
    // worker hits the source domain and returns a list of h1/h2/h3/p
    // elements with computed CSS selectors. Clicking "Use this" adds
    // a text_rewrites entry pre-filled with match=^path$, the
    // selector, and the current text as the starting content.
    '<div class="inspect-panel" data-inspect-panel>',
    '<div class="inspect-row">',
    '<label for="inspect_path">Inspect page on source:</label>',
    '<input id="inspect_path" type="text" value="/" placeholder="/about" style="flex:1">',
    '<button type="button" class="btn" data-inspect-fetch>Fetch</button>',
    "</div>",
    '<div class="field-hint" style="margin-top:.4rem">Loads the page from the source domain and lists its headings + paragraphs. Click <strong>Use this</strong> on any to pre-fill a text_rewrites rule. Selectors are starting points — edit before saving if your source DOM is volatile.</div>',
    '<div data-inspect-status style="margin-top:.6rem"></div>',
    '<div data-inspect-results style="margin-top:.6rem"></div>',
    "</div>",
    '<div data-list-container="text_rewrites"></div></div>',
    '<div class="form-section"><h2>Raw <code>ClientConfig</code> JSON</h2>',
    '<p class="field-hint" style="margin-bottom:.6rem">Source of truth on submit. Form fields above sync into this textarea on every keystroke. Advanced fields not exposed as form sections (pattern/conditional redirects, link rewrites, element removals, content injections, caching, forms) are edited directly here.</p>',
    `<textarea id="config_json" name="config_json" spellcheck="false" autocomplete="off">${esc(opts.prefilledJson)}</textarea>`,
    "</div>",
    "<script>",
    "(function(){",
    `var ZONE=${JSON.stringify(DEFAULT_PROXY_ZONE)};var ZONE_SUFFIX='.'+ZONE;`,
    "var ta=document.getElementById('config_json');if(!ta)return;",
    "var scalarFields={f_client_id:['client_id'],f_source_domain:['source_domain'],f_status:['status'],f_attested_by_email:['authorization','attested_by_email'],f_attested_ip:['authorization','attested_ip'],f_scope:['authorization','scope']};",
    "function get(o,p){for(var i=0;i<p.length;i++){if(o==null)return undefined;o=o[p[i]];}return o;}",
    "function setPath(o,p,v){for(var i=0;i<p.length-1;i++){var k=p[i];if(o[k]==null||typeof o[k]!=='object')o[k]={};o=o[k];}o[p[p.length-1]]=v;}",
    "function safeParse(){try{return JSON.parse(ta.value);}catch(e){return null;}}",
    "function applyProxyDomain(pd){var dR=document.getElementById('f_proxy_mode_default'),cR=document.getElementById('f_proxy_mode_custom'),sE=document.getElementById('f_proxy_subdomain'),cE=document.getElementById('f_proxy_custom');if(typeof pd==='string'&&pd.length>ZONE_SUFFIX.length&&pd.slice(-ZONE_SUFFIX.length)===ZONE_SUFFIX){dR.checked=true;sE.value=pd.slice(0,-ZONE_SUFFIX.length);sE.disabled=false;cE.value='';cE.disabled=true;}else{cR.checked=true;cE.value=pd||'';cE.disabled=false;sE.disabled=true;}}",
    "function currentProxyDomain(){var d=document.getElementById('f_proxy_mode_default').checked;if(d){var s=document.getElementById('f_proxy_subdomain').value.trim();return s===''?'':s+ZONE_SUFFIX;}return document.getElementById('f_proxy_custom').value.trim();}",
    "function syncFromJson(){var j=safeParse();if(!j)return;Object.keys(scalarFields).forEach(function(id){var el=document.getElementById(id);if(!el)return;var v=get(j,scalarFields[id]);el.value=v==null?'':String(v);});applyProxyDomain(j.proxy_domain||'');var sp=get(j,['authorization','scope_paths']),spEl=document.getElementById('f_scope_paths');if(spEl)spEl.value=Array.isArray(sp)?sp.join(', '):'';var or=get(j,['routing',0,'origin']),oEl=document.getElementById('f_origin');if(oEl)oEl.value=or||'';}",
    "function syncToJson(){var j=safeParse();if(!j)return;Object.keys(scalarFields).forEach(function(id){var el=document.getElementById(id);if(!el)return;if(el.value!=='')setPath(j,scalarFields[id],el.value);});var pd=currentProxyDomain();if(pd)j.proxy_domain=pd;var spEl=document.getElementById('f_scope_paths'),scEl=document.getElementById('f_scope');if(j.authorization==null||typeof j.authorization!=='object')j.authorization={};if(scEl&&scEl.value==='specified_paths'&&spEl&&spEl.value.trim()!==''){j.authorization.scope_paths=spEl.value.split(',').map(function(s){return s.trim();}).filter(Boolean);}else{delete j.authorization.scope_paths;}var oEl=document.getElementById('f_origin');if(oEl&&oEl.value!==''){if(!Array.isArray(j.routing))j.routing=[];if(j.routing[0]==null||typeof j.routing[0]!=='object')j.routing[0]={match:'^/.*',type:'proxy',origin_auth:{type:'none'}};j.routing[0].origin=oEl.value;}ta.value=JSON.stringify(j,null,2);}",
    "var cidEl=document.getElementById('f_client_id');if(cidEl&&!cidEl.readOnly){cidEl.addEventListener('input',function(){var sE=document.getElementById('f_proxy_subdomain');if(!sE)return;if(sE.dataset.userEdited!=='1'){sE.value=cidEl.value;syncToJson();}});}",
    "var sE0=document.getElementById('f_proxy_subdomain');if(sE0)sE0.addEventListener('input',function(){sE0.dataset.userEdited='1';});",
    "var srcEl=document.getElementById('f_source_domain'),orgEl=document.getElementById('f_origin');function shouldFillOrigin(){if(!orgEl)return false;if(orgEl.dataset.userEdited==='1')return false;var v=orgEl.value||'';return v===''||v.indexOf('REPLACE_')!==-1;}if(srcEl&&orgEl){srcEl.addEventListener('input',function(){if(!shouldFillOrigin())return;var s=srcEl.value.trim();orgEl.value=s===''?'':'https://'+s.replace(/^https?:\\/\\//i,'');syncToJson();});orgEl.addEventListener('input',function(){orgEl.dataset.userEdited='1';});if(shouldFillOrigin()&&srcEl.value&&srcEl.value.indexOf('REPLACE_')===-1){orgEl.value='https://'+srcEl.value.replace(/^https?:\\/\\//i,'');syncToJson();}}",
    "function onMode(){var d=document.getElementById('f_proxy_mode_default').checked;document.getElementById('f_proxy_subdomain').disabled=!d;document.getElementById('f_proxy_custom').disabled=d;syncToJson();}",
    "document.getElementById('f_proxy_mode_default').addEventListener('change',onMode);",
    "document.getElementById('f_proxy_mode_custom').addEventListener('change',onMode);",
    "Object.keys(scalarFields).concat(['f_scope_paths','f_origin','f_proxy_subdomain','f_proxy_custom']).forEach(function(id){var el=document.getElementById(id);if(el)el.addEventListener('input',syncToJson);});",
    "ta.addEventListener('input',syncFromJson);syncFromJson();",
    "})();",
    "</script>",
    // List-section editors live in their own clean IIFE in
    // list-editor-js.ts (separate file so syntax errors are caught by
    // the unit test before deploy — Phase E v3 was rolled back because
    // the original array-of-strings approach broke V8 parsing).
    "<script>",
    LIST_EDITOR_JS,
    "</script>",
  ].join("");
}

export const NEW_CLIENT_TEMPLATE = `{
  "client_id": "your-client-id",
  "proxy_domain": "your-client-id.${DEFAULT_PROXY_ZONE}",
  "source_domain": "REPLACE_WITH_SOURCE_HOST",
  "authorization": {
    "attested_by_email": "you@example.com",
    "attested_at": "2026-01-01T00:00:00Z",
    "attested_ip": "0.0.0.0",
    "scope": "full_site",
    "expires_at": null
  },
  "status": "active",
  "routing": [
    {
      "match": "^/.*",
      "type": "proxy",
      "origin": "https://REPLACE_WITH_SOURCE_HOST",
      "origin_auth": { "type": "none" }
    }
  ],
  "redirects": { "static": [], "patterns": [], "conditional": [] },
  "canonicals": [
    {
      "match": "^/.*",
      "strategy": { "type": "origin" },
      "sync_og_url": true,
      "sync_twitter_url": true,
      "sync_jsonld_url": true
    }
  ],
  "schema_injections": [],
  "link_rewrites": [],
  "element_removals": [],
  "content_injections": [],
  "text_rewrites": [],
  "meta_rewrites": [],
  "indexation": [{ "match": "^/.*", "robots": "noindex,follow", "additional_directives": [] }],
  "caching": [{ "match": "^/.*", "ttl_seconds": 600, "cache_key_includes_cookies": [], "bypass_on_cookie": [] }],
  "forms": [],
  "schema_version": 1
}`;

export function renderNewClientForm(prefilledJson: string, error: string | null): string {
  return `<div class="crumbs"><a href="/app/clients">← Clients</a></div>
    <h1>New client</h1>
    <p class="subtitle">Fill the structured fields below or edit the JSON directly. Validates against the same Zod schema the Worker uses at load time.</p>
    ${error ? `<div class="error-box">${esc(error)}</div>` : ""}
    <form class="editor" method="POST" action="/app/clients/new">
      ${renderStructuredFormBody({ prefilledJson, isEdit: false })}
      <div class="hint">After save: D1 INSERT with you as owner_id, KV primed under <code>config:&lt;id&gt;</code> and <code>domain:&lt;proxy_domain&gt;</code>, audit_log entry written.</div>
      <div class="form-actions">
        <button class="btn btn-primary" type="submit">Create client</button>
        <a class="btn" href="/app/clients">Cancel</a>
      </div>
    </form>`;
}

export function renderEditClientForm(
  client: ClientRow,
  prefilledJson: string,
  error: string | null,
): string {
  return `<div class="crumbs"><a href="/app/clients/${esc(client.client_id)}">← ${esc(client.client_id)}</a></div>
    <h1>Edit ${esc(client.client_id)}</h1>
    <p class="subtitle">Editing the full <code>ClientConfig</code>. <code>client_id</code> cannot change via this form.</p>
    ${error ? `<div class="error-box">${esc(error)}</div>` : ""}
    <form class="editor" method="POST" action="/app/clients/${esc(client.client_id)}/edit">
      ${renderStructuredFormBody({ prefilledJson, isEdit: true })}
      <div class="hint">On save: D1 UPDATE, KV invalidated for <code>config:${esc(client.client_id)}</code> and <code>domain:${esc(client.proxy_domain)}</code>, audit_log entry written.</div>
      <div class="form-actions">
        <button class="btn btn-primary" type="submit">Save</button>
        <a class="btn" href="/app/clients/${esc(client.client_id)}">Cancel</a>
      </div>
    </form>`;
}

/**
 * Per-page editor — alternate view of the same client config that
 * filters the list-section rules by their `match` regex. Operator
 * mental model: "I'm editing /about-us" rather than "I'm adding rule
 * #5 with match=^/about-us$".
 *
 * Same backend: this form POSTs to /app/clients/:id/edit (the regular
 * edit handler), submitting the FULL config_json. The list-section
 * editors render with `data-filter-match` attributes so they only
 * show rules whose match equals the active filter — but the underlying
 * JSON contains all rules, so saving doesn't drop anything.
 */
export function renderPerPageEditor(opts: {
  client: ClientRow;
  match: string;
  literalPath: string | null;
  prefilledJson: string;
  error: string | null;
}): string {
  const display = opts.literalPath ?? opts.match;
  const inspectInitialPath = opts.literalPath ?? "/";
  // If we have a literal path, build a one-click link to the live proxy
  // URL so the operator can open the page they just edited in a new tab.
  const liveUrl = opts.literalPath
    ? `https://${opts.client.proxy_domain}${opts.literalPath}`
    : null;
  const liveLink = liveUrl
    ? ` <a href="${esc(liveUrl)}" target="_blank" rel="noopener" style="font-size:.55em;font-weight:400;margin-left:.5rem;text-decoration:none">↗ open live</a>`
    : "";
  return `<div class="crumbs"><a href="/app/clients/${esc(opts.client.client_id)}">← ${esc(opts.client.client_id)}</a></div>
    <h1>Edit page <code style="font-size:.7em">${esc(display)}</code>${liveLink}</h1>
    <p class="subtitle">All rules whose <code>match</code> equals <code>${esc(opts.match)}</code> on <strong>${esc(opts.client.client_id)}</strong>. Other client config (identity, auth, routing, site-wide rules) is preserved on save.</p>
    ${opts.error ? `<div class="error-box">${esc(opts.error)}</div>` : ""}
    <form class="editor" method="POST" action="/app/clients/${esc(opts.client.client_id)}/edit">
      <div class="form-section">
        <h2 style="margin-top:0">Inspect this page</h2>
        <div class="inspect-panel" data-inspect-panel>
          <div class="inspect-row">
            <label for="inspect_path">Path on source:</label>
            <input id="inspect_path" type="text" value="${esc(inspectInitialPath)}" placeholder="/about-us" style="flex:1">
            <button type="button" class="btn" data-inspect-fetch>Fetch</button>
          </div>
          <div class="field-hint" style="margin-top:.4rem">Loads the live source page so you can grab selectors. <strong>Use this</strong> on any element pre-fills a text rewrite for this path.</div>
          <div data-inspect-status style="margin-top:.6rem"></div>
          <div data-inspect-results style="margin-top:.6rem"></div>
        </div>
      </div>
      <div class="form-section" id="section-text-rewrites">
        <h2>Text &amp; heading rewrites <button type="button" class="btn" data-add-to="text_rewrites">+ Add</button></h2>
        <p class="field-hint" style="margin:0 0 .6rem">Replaces the inner content of any element matching a CSS selector. Examples in the Inspect panel above.</p>
        <div data-list-container="text_rewrites" data-filter-match="${esc(opts.match)}"></div>
      </div>
      <div class="form-section" id="section-meta-rewrites">
        <h2>Meta rewrites <button type="button" class="btn" data-add-to="meta_rewrites">+ Add</button></h2>
        <p class="field-hint" style="margin:0 0 .6rem">Override <code>&lt;title&gt;</code>, meta description, OG/Twitter tags for this path.</p>
        <div data-list-container="meta_rewrites" data-filter-match="${esc(opts.match)}"></div>
      </div>
      <div class="form-section" id="section-static-redirects">
        <h2>Static redirects <button type="button" class="btn" data-add-to="redirects.static">+ Add</button></h2>
        <p class="field-hint" style="margin:0 0 .6rem">Redirect this path to another URL. Static redirects don't use the <code>match</code> field — they use <code>from</code> — so changes here add to the global static-redirect list.</p>
        <div data-list-container="redirects.static"></div>
      </div>
      <div class="form-section" id="section-schema-injections">
        <h2>Schema injections <button type="button" class="btn" data-add-to="schema_injections">+ Add</button></h2>
        <p class="field-hint" style="margin:0 0 .6rem">Inject JSON-LD <code>&lt;script type="application/ld+json"&gt;</code> for this path.</p>
        <div data-list-container="schema_injections" data-filter-match="${esc(opts.match)}"></div>
      </div>
      <div class="form-section" id="section-indexation">
        <h2>Indexation rules <button type="button" class="btn" data-add-to="indexation">+ Add</button></h2>
        <p class="field-hint" style="margin:0 0 .6rem">Robots meta override for this path.</p>
        <div data-list-container="indexation" data-filter-match="${esc(opts.match)}"></div>
      </div>
      <div class="form-section" id="section-canonicals">
        <h2>Canonical rules <button type="button" class="btn" data-add-to="canonicals">+ Add</button></h2>
        <p class="field-hint" style="margin:0 0 .6rem">Canonical link strategy for this path.</p>
        <div data-list-container="canonicals" data-filter-match="${esc(opts.match)}"></div>
      </div>
      <textarea id="config_json" name="config_json" hidden>${esc(opts.prefilledJson)}</textarea>
      <div class="hint">On save: full config UPDATE, KV invalidated, audit log entry. Rules outside this page (other paths, site-wide, identity, auth) are preserved untouched.</div>
      <div class="form-actions">
        <button class="btn btn-primary" type="submit">Save</button>
        <a class="btn" href="/app/clients/${esc(opts.client.client_id)}">Cancel</a>
      </div>
    </form>
    <script>${LIST_EDITOR_JS}</script>`;
}

/* ─── Custom pages (raw HTML upload) ─── */

/**
 * A custom_page route stored in the client's routing[]. We surface only
 * the literal-path subset (where the operator can derive a real URL),
 * not arbitrary regex routes — those would have been written by hand
 * via the structured config edit, not via the upload form.
 */
export interface CustomPageEntry {
  /** The match regex on the routing rule (e.g. "^/lp/austin/?$"). */
  match: string;
  /** The literal path derived from the regex, or null if not literal. */
  literalPath: string | null;
  /** The R2/KV storage key prefix on the route. */
  customPageKey: string;
  /**
   * Whether this is a single-page upload (anchored match like
   * `^/foo/?$`) or a static-site bundle (open match like `^/foo/.*`).
   * Drives the Edit/Delete UI: single pages have an Edit form, sites
   * are delete + reupload.
   */
  kind: "page" | "site";
}

/**
 * Walk a parsed config and return one entry per custom_page route. Used
 * to render the "Custom pages" panel on the client detail.
 */
export function listCustomPages(cfg: Record<string, unknown>): CustomPageEntry[] {
  const routing = (cfg.routing as Array<Record<string, unknown>> | undefined) ?? [];
  const out: CustomPageEntry[] = [];
  for (const r of routing) {
    if (r.type !== "custom_page") continue;
    const match = typeof r.match === "string" ? r.match : "";
    const customPageKey = typeof r.custom_page_key === "string" ? r.custom_page_key : "";
    // Static-site routes are open-ended (e.g. `^/site/(/.*)?$` or
    // `^/site/.*`). Single-page routes are anchored (`^/path/?$`).
    // Heuristic: if the regex contains `.*` or `(/.*)` it's a site.
    const kind: "page" | "site" = /\.\*|\(\/\.\*/.test(match) ? "site" : "page";
    // For static-site routes, derive the base prefix from the regex
    // for display + delete listing.
    const literalPath = kind === "site" ? deriveStaticSiteBase(match) : derivLiteralPath(match);
    out.push({
      match,
      literalPath,
      customPageKey,
      kind,
    });
  }
  return out;
}

/**
 * Render the Custom pages section on the client detail. Shows existing
 * routes (path + ↗ live link + Delete) and a "+ New custom page" CTA.
 */
function renderCustomPagesPanel(client: ClientRow, cfg: Record<string, unknown>): string {
  const entries = listCustomPages(cfg);
  const rows = entries
    .map((e) => {
      // For static sites the displayed path is the base prefix shown
      // with a trailing slash so it's clear it covers everything below.
      const display =
        e.kind === "site" && e.literalPath ? `${e.literalPath}/` : (e.literalPath ?? e.match);
      const kindLabel =
        e.kind === "site"
          ? '<span class="pill pill-neutral" style="margin-left:.4rem">site</span>'
          : "";
      const liveHref =
        e.kind === "site" && e.literalPath
          ? `https://${client.proxy_domain}${e.literalPath}/`
          : e.literalPath
            ? `https://${client.proxy_domain}${e.literalPath}`
            : null;
      const liveCell = liveHref
        ? `<a href="${esc(liveHref)}" target="_blank" rel="noopener" title="Open on proxy">↗</a>`
        : "";
      // Edit only for single-page entries with a literal path. Static
      // sites are delete + reupload (zip semantics make incremental
      // edit a separate, larger feature).
      const editLink =
        e.kind === "page" && e.literalPath
          ? `<a href="/app/clients/${esc(client.client_id)}/custom-page/edit?match=${encodeURIComponent(e.match)}" class="btn-link">Edit →</a>`
          : "";
      const confirmMsg =
        e.kind === "site"
          ? "Delete this static site? All R2 objects under the prefix are removed along with the routing rule."
          : "Delete this custom page? The R2 object and routing rule are both removed.";
      const deleteForm = `<form method="POST" action="/app/clients/${esc(client.client_id)}/custom-page/delete" style="display:inline" onsubmit="return confirm('${esc(confirmMsg)}');">
          <input type="hidden" name="match" value="${esc(e.match)}">
          <button type="submit" class="btn-link" style="color:var(--red);background:none;border:none;cursor:pointer;font:inherit;padding:0">Delete</button>
        </form>`;
      return `<tr>
        <td class="mono">${esc(display)}${kindLabel}</td>
        <td style="text-align:center;width:1.5rem">${liveCell}</td>
        <td>${editLink}</td>
        <td>${deleteForm}</td>
      </tr>`;
    })
    .join("");
  const body = entries.length
    ? `<table class="data" style="margin-bottom:.6rem"><thead><tr><th>path</th><th></th><th></th><th></th></tr></thead><tbody>${rows}</tbody></table>`
    : '<div class="empty" style="margin:0 0 .6rem">no custom pages yet</div>';
  return `<div class="card" style="margin-bottom:1rem">
    <div style="display:flex;justify-content:space-between;align-items:center;margin:0 0 .85rem;gap:.5rem;flex-wrap:wrap">
      <h2 style="margin:0;font-size:1.05rem;font-weight:600">Custom pages</h2>
      <div style="display:flex;gap:.5rem;flex-wrap:wrap">
        <a href="/app/clients/${esc(client.client_id)}/custom-page/new" class="btn" style="font-size:.78rem;padding:.3rem .8rem">+ New page (HTML)</a>
        <a href="/app/clients/${esc(client.client_id)}/custom-page/new-site" class="btn btn-primary" style="font-size:.78rem;padding:.3rem .8rem">+ Upload site (zip)</a>
      </div>
    </div>
    ${body}
    <p class="field-hint" style="margin:0"><strong>Page (HTML):</strong> single path served from R2. <strong>Site (zip):</strong> upload an archive — a base path covers all files inside (assets, sub-pages, etc).</p>
  </div>`;
}

/**
 * Render the form for creating a new custom page. Operator picks a path
 * (e.g. `/lp/austin`) and pastes raw HTML.
 */
export function renderNewCustomPageForm(
  client: ClientRow,
  error: string | null,
  prefilled?: { path?: string; html?: string },
): string {
  const path = prefilled?.path ?? "";
  const html = prefilled?.html ?? "";
  return `<div class="crumbs"><a href="/app/clients/${esc(client.client_id)}">← ${esc(client.client_id)}</a></div>
    <h1>New custom page <span style="color:var(--fg-muted);font-size:.6em;font-weight:400">on ${esc(client.client_id)}</span></h1>
    <p class="subtitle">Upload raw HTML for a path on <span class="mono">${esc(client.proxy_domain)}</span>. The path is added to the routing rules as <code>type: custom_page</code> and the body is stored in R2 at <code>${esc(client.client_id)}/&lt;path&gt;</code>.</p>
    ${error ? `<div class="error-box">${esc(error)}</div>` : ""}
    <form class="editor" method="POST" action="/app/clients/${esc(client.client_id)}/custom-page/new">
      <label for="path">Path</label>
      <input id="path" name="path" type="text" required value="${esc(path)}" placeholder="/lp/austin" pattern="^/[A-Za-z0-9/_\\-]*$">
      <div class="hint">Must start with <code>/</code>. Allowed: letters, digits, <code>/</code>, <code>_</code>, <code>-</code>. The page will be reachable at <code>https://${esc(client.proxy_domain)}&lt;path&gt;</code>.</div>
      <label for="html">HTML body</label>
      <textarea id="html" name="html" rows="20" required placeholder="<!doctype html>&#10;<html>&#10;  <head><title>...</title></head>&#10;  <body>...</body>&#10;</html>" style="font-family:var(--mono);font-size:.85rem">${esc(html)}</textarea>
      <div class="hint">Full document recommended (doctype + head + body). The HTMLRewriter pipeline still runs on this response — your meta_rewrites / canonicals / indexation rules apply if their <code>match</code> regex covers this path.</div>
      <div class="hint">On save: HTML written to R2, custom_page route prepended to <code>routing[]</code> (so it precedes the catch-all proxy), KV invalidated, audit_log entry written.</div>
      <div class="form-actions">
        <button class="btn btn-primary" type="submit">Create page</button>
        <a class="btn" href="/app/clients/${esc(client.client_id)}">Cancel</a>
      </div>
    </form>`;
}

/**
 * Render the form for editing an existing custom page. The path is
 * read-only (changing it = different R2 key, handled as delete + create
 * by the operator). HTML body is pre-filled from R2.
 */
export function renderEditCustomPageForm(opts: {
  client: ClientRow;
  match: string;
  literalPath: string;
  html: string;
  error: string | null;
}): string {
  const liveUrl = `https://${opts.client.proxy_domain}${opts.literalPath}`;
  return `<div class="crumbs"><a href="/app/clients/${esc(opts.client.client_id)}">← ${esc(opts.client.client_id)}</a></div>
    <h1>Edit custom page <code style="font-size:.7em">${esc(opts.literalPath)}</code> <a href="${esc(liveUrl)}" target="_blank" rel="noopener" style="font-size:.55em;font-weight:400;margin-left:.5rem;text-decoration:none">↗ open live</a></h1>
    <p class="subtitle">HTML body for <span class="mono">${esc(opts.client.proxy_domain)}${esc(opts.literalPath)}</span> on <strong>${esc(opts.client.client_id)}</strong>. The path itself is fixed — to move the page, delete and recreate.</p>
    ${opts.error ? `<div class="error-box">${esc(opts.error)}</div>` : ""}
    <form class="editor" method="POST" action="/app/clients/${esc(opts.client.client_id)}/custom-page/edit">
      <input type="hidden" name="match" value="${esc(opts.match)}">
      <label for="path">Path (read-only)</label>
      <input id="path" type="text" value="${esc(opts.literalPath)}" disabled>
      <div class="hint">To rename, delete this page and create a new one.</div>
      <label for="html">HTML body</label>
      <textarea id="html" name="html" rows="24" required style="font-family:var(--mono);font-size:.85rem">${esc(opts.html)}</textarea>
      <div class="hint">On save: R2 object overwritten, KV invalidated, audit_log entry written. The route entry in <code>routing[]</code> is unchanged.</div>
      <div class="form-actions">
        <button class="btn btn-primary" type="submit">Save</button>
        <a class="btn" href="/app/clients/${esc(opts.client.client_id)}">Cancel</a>
      </div>
    </form>`;
}

/**
 * Render the upload form for a static-site bundle. Operator picks a
 * base path (e.g. `/lp`) and uploads a zip. The form posts as
 * multipart/form-data because <input type="file"> requires it.
 */
export function renderNewStaticSiteForm(
  client: ClientRow,
  error: string | null,
  prefilledBase?: string,
): string {
  const base = prefilledBase ?? "";
  return `<div class="crumbs"><a href="/app/clients/${esc(client.client_id)}">← ${esc(client.client_id)}</a></div>
    <h1>Upload static site <span style="color:var(--fg-muted);font-size:.6em;font-weight:400">on ${esc(client.client_id)}</span></h1>
    <p class="subtitle">Upload a ZIP archive containing HTML, CSS, JS, images, and any other files. The bundle is extracted and served on the proxy domain at the base path you choose.</p>
    ${error ? `<div class="error-box">${esc(error)}</div>` : ""}
    <form class="editor" method="POST" enctype="multipart/form-data" action="/app/clients/${esc(client.client_id)}/custom-page/new-site">
      <label for="base_path">Base path</label>
      <input id="base_path" name="base_path" type="text" required value="${esc(base)}" placeholder="/lp/austin" pattern="^/[A-Za-z0-9/_\\-]+$">
      <div class="hint">Must start with <code>/</code>. Allowed: letters, digits, <code>/</code>, <code>_</code>, <code>-</code>. Files in the zip serve relative to this base — e.g. with base <code>/lp</code>, an entry <code>css/main.css</code> serves at <code>https://${esc(client.proxy_domain)}/lp/css/main.css</code>.</div>
      <label for="zip">ZIP archive</label>
      <input id="zip" name="zip" type="file" accept=".zip,application/zip" required>
      <div class="hint">Max 50 MB total / 500 entries / 10 MB per file. Path traversal (<code>..</code>, absolute paths) is rejected.</div>
      <div class="hint">Index resolution: requesting <code>&lt;base&gt;/</code> serves <code>index.html</code> from the bundle. Requesting <code>&lt;base&gt;/about/</code> serves <code>about/index.html</code>.</div>
      <div class="hint">On save: each entry written to R2 at <code>${esc(client.client_id)}&lt;base&gt;/&lt;entry-path&gt;</code>, one custom_page route prepended to <code>routing[]</code>, KV invalidated, audit_log entry written.</div>
      <div class="form-actions">
        <button class="btn btn-primary" type="submit">Upload site</button>
        <a class="btn" href="/app/clients/${esc(client.client_id)}">Cancel</a>
      </div>
    </form>`;
}

export function renderAttestForm(client: ClientRow, error: string | null): string {
  return `<div class="crumbs"><a href="/app/clients/${esc(client.client_id)}">← ${esc(client.client_id)}</a></div>
    <h1>Capture attestation — ${esc(client.client_id)}</h1>
    <p class="subtitle">Append a permission record to the <code>attestations</code> table per spec §6.8. Append-only.</p>
    ${error ? `<div class="error-box">${esc(error)}</div>` : ""}
    <form class="editor" method="POST" action="/app/clients/${esc(client.client_id)}/attest">
      <label for="attested_by_email">Attested by (email)</label>
      <input id="attested_by_email" name="attested_by_email" type="email" required>
      <label for="attested_ip">Attested IP</label>
      <input id="attested_ip" name="attested_ip" type="text" placeholder="0.0.0.0">
      <div class="hint">Leave blank to use the requesting <code>cf-connecting-ip</code>.</div>
      <label for="scope">Scope</label>
      <select id="scope" name="scope">
        <option value="full_site">full_site</option>
        <option value="specified_paths">specified_paths</option>
      </select>
      <label for="scope_paths">Scope paths (CSV, only used if scope = specified_paths)</label>
      <input id="scope_paths" name="scope_paths" type="text" placeholder="/blog,/landing">
      <label for="user_agent">User agent (optional)</label>
      <input id="user_agent" name="user_agent" type="text" placeholder="auto from request if blank">
      <div class="form-actions">
        <button class="btn btn-primary" type="submit">Record attestation</button>
        <a class="btn" href="/app/clients/${esc(client.client_id)}">Cancel</a>
      </div>
    </form>`;
}

/* ─── Write handlers ─── */

interface ActorContext {
  user: User;
  ip: string;
}

function actorOf(user: User, request: Request): ActorContext {
  return {
    user,
    ip: request.headers.get("cf-connecting-ip") ?? "0.0.0.0",
  };
}

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

function flashRedirect(
  location: string,
  flash: { text: string; kind: "ok" | "warn" | "err" },
): Response {
  const sep = location.includes("?") ? "&" : "?";
  const target = `${location}${sep}flash=${encodeURIComponent(flash.text)}&flash_kind=${flash.kind}`;
  return new Response(null, { status: 303, headers: { location: target } });
}

/**
 * Create a new client. Sets owner_id = current user (super-admin's
 * own clients still owned by them; reassignment via UI is a future v2).
 */
export async function handleNewClientPost(
  request: Request,
  env: AppEnv,
  url: URL,
  user: User,
): Promise<{ response?: Response; rerenderError?: { error: string; raw: string } }> {
  const csrf = checkCsrf(request, url);
  if (csrf) return { response: csrf };
  const form = await request.formData();
  const raw = String(form.get("config_json") ?? "");
  const validation = validateConfigJson(raw);
  if (!validation.ok) return { rerenderError: { error: validation.error, raw } };

  const cfg = validation.config;
  const existing = await env.CONFIG_DB.prepare(
    "SELECT client_id FROM clients WHERE client_id = ? LIMIT 1",
  )
    .bind(cfg.client_id)
    .first<{ client_id: string }>();
  if (existing) {
    return {
      rerenderError: {
        error: `A client with id "${cfg.client_id}" already exists.`,
        raw,
      },
    };
  }

  const json = JSON.stringify(cfg);
  await env.CONFIG_DB.prepare(
    `INSERT INTO clients
       (client_id, proxy_domain, source_domain, status, config_json, schema_version, owner_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      cfg.client_id,
      cfg.proxy_domain,
      cfg.source_domain,
      cfg.status,
      json,
      cfg.schema_version,
      user.id,
    )
    .run();
  await Promise.all([
    env.CONFIG_KV.put(`config:${cfg.client_id}`, json),
    env.CONFIG_KV.put(`domain:${cfg.proxy_domain}`, cfg.client_id),
  ]);
  const actor = actorOf(user, request);
  await writeAudit(env, {
    client_id: cfg.client_id,
    actor_email: actor.user.email,
    actor_ip: actor.ip,
    event_type: "config_create",
    before_hash: null,
    after_hash: fnvHash(json),
    previous_status: null,
    new_status: cfg.status,
    notes: null,
  });
  return {
    response: flashRedirect(`/app/clients/${cfg.client_id}`, {
      text: `Created ${cfg.client_id}.`,
      kind: "ok",
    }),
  };
}

export async function handleEditClientPost(
  request: Request,
  env: AppEnv,
  url: URL,
  user: User,
  clientId: string,
): Promise<{
  response?: Response;
  rerenderError?: { error: string; raw: string; client: ClientRow };
}> {
  const csrf = checkCsrf(request, url);
  if (csrf) return { response: csrf };
  const client = await loadVisibleClient(env, user, clientId);
  if (!client) return { response: new Response("Not found", { status: 404 }) };

  const form = await request.formData();
  const raw = String(form.get("config_json") ?? "");
  const validation = validateConfigJson(raw);
  if (!validation.ok) return { rerenderError: { error: validation.error, raw, client } };

  const cfg = validation.config;
  if (cfg.client_id !== clientId) {
    return {
      rerenderError: {
        error: `client_id in JSON ("${cfg.client_id}") doesn't match the URL ("${clientId}"). Renaming via edit is not supported.`,
        raw,
        client,
      },
    };
  }

  const beforeHash = fnvHash(client.config_json);
  const newJson = JSON.stringify(cfg);
  const afterHash = fnvHash(newJson);

  await env.CONFIG_DB.prepare(
    `UPDATE clients
       SET proxy_domain = ?, source_domain = ?, status = ?, config_json = ?,
           schema_version = ?, updated_at = CURRENT_TIMESTAMP
     WHERE client_id = ?`,
  )
    .bind(cfg.proxy_domain, cfg.source_domain, cfg.status, newJson, cfg.schema_version, clientId)
    .run();
  await invalidateKv(env, clientId, client.proxy_domain);
  if (cfg.proxy_domain !== client.proxy_domain) {
    await env.CONFIG_KV.delete(`domain:${cfg.proxy_domain}`);
  }
  const actor = actorOf(user, request);
  await writeAudit(env, {
    client_id: clientId,
    actor_email: actor.user.email,
    actor_ip: actor.ip,
    event_type: "config_update",
    before_hash: beforeHash,
    after_hash: afterHash,
    previous_status: client.status,
    new_status: cfg.status,
    notes: null,
  });
  return {
    response: flashRedirect(`/app/clients/${clientId}`, {
      text: `Saved. before=${beforeHash} → after=${afterHash}`,
      kind: "ok",
    }),
  };
}

export async function handleStatusPost(
  request: Request,
  env: AppEnv,
  url: URL,
  user: User,
  clientId: string,
): Promise<Response> {
  const csrf = checkCsrf(request, url);
  if (csrf) return csrf;
  const client = await loadVisibleClient(env, user, clientId);
  if (!client) return new Response("Not found", { status: 404 });

  const form = await request.formData();
  const target = String(form.get("status") ?? "");
  if (target !== "active" && target !== "paused" && target !== "terminated") {
    return flashRedirect(`/app/clients/${clientId}`, {
      text: `Invalid status target: ${target}`,
      kind: "err",
    });
  }
  if (client.status === target) {
    return flashRedirect(`/app/clients/${clientId}`, {
      text: `Already ${target}.`,
      kind: "warn",
    });
  }
  if (client.status === "terminated") {
    return flashRedirect(`/app/clients/${clientId}`, {
      text: "Terminated is a one-way door per PRD §6.3 — cannot be reversed.",
      kind: "err",
    });
  }

  let parsedCfg: Record<string, unknown>;
  try {
    parsedCfg = JSON.parse(client.config_json);
  } catch (e) {
    return flashRedirect(`/app/clients/${clientId}`, {
      text: `Cannot flip status: existing config_json is invalid: ${(e as Error).message}`,
      kind: "err",
    });
  }
  parsedCfg.status = target;
  const newJson = JSON.stringify(parsedCfg);

  await env.CONFIG_DB.prepare(
    `UPDATE clients
       SET status = ?, config_json = ?, updated_at = CURRENT_TIMESTAMP
     WHERE client_id = ?`,
  )
    .bind(target, newJson, clientId)
    .run();
  await invalidateKv(env, clientId, client.proxy_domain);
  const actor = actorOf(user, request);
  await writeAudit(env, {
    client_id: clientId,
    actor_email: actor.user.email,
    actor_ip: actor.ip,
    event_type: target === "terminated" ? "revocation" : "status_change",
    before_hash: fnvHash(client.config_json),
    after_hash: fnvHash(newJson),
    previous_status: client.status,
    new_status: target,
    notes: null,
  });
  return flashRedirect(`/app/clients/${clientId}`, {
    text: `Status: ${client.status} → ${target}.`,
    kind: target === "terminated" ? "warn" : "ok",
  });
}

export async function handleCachePurgePost(
  request: Request,
  env: AppEnv,
  url: URL,
  user: User,
  clientId: string,
): Promise<Response> {
  const csrf = checkCsrf(request, url);
  if (csrf) return csrf;
  const client = await loadVisibleClient(env, user, clientId);
  if (!client) return new Response("Not found", { status: 404 });

  await invalidateKv(env, clientId, client.proxy_domain);
  const actor = actorOf(user, request);
  await writeAudit(env, {
    client_id: clientId,
    actor_email: actor.user.email,
    actor_ip: actor.ip,
    event_type: "config_update",
    before_hash: null,
    after_hash: null,
    previous_status: client.status,
    new_status: client.status,
    notes: "manual cache purge (KV invalidate)",
  });
  return flashRedirect(`/app/clients/${clientId}`, {
    text: `Purged config:${clientId} and domain:${client.proxy_domain} from KV.`,
    kind: "ok",
  });
}

/* ─── Custom-page handlers ─── */

const CUSTOM_PAGE_PATH_RE = /^\/[A-Za-z0-9/_-]*$/;
/**
 * R2 has a 5 GB per-object cap; this app-level cap is well below it but
 * far above any sane HTML size. Catches accidental binary uploads.
 */
const CUSTOM_PAGE_MAX_HTML_BYTES = 1_000_000; // 1 MB

/**
 * The R2/KV storage key for a client's custom-page upload. Per-client
 * scoping (`<client_id>/<path…>`) ensures pages from different clients
 * can't collide on the same path. The trailing path always starts with
 * `/`, giving keys like `lantern-crest/lp/austin`.
 */
function customPageStorageKey(clientId: string, path: string): string {
  return `${clientId}${path}`;
}

/**
 * The match regex emitted for a custom_page route. Mirrors the per-page
 * editor convention: `/?$` so both `/lp/austin` and `/lp/austin/` match.
 */
function customPageMatch(path: string): string {
  const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return `^${escaped}/?$`;
}

export async function handleNewCustomPageGet(
  env: AppEnv,
  user: User,
  clientId: string,
): Promise<Response | { client: ClientRow }> {
  const client = await loadVisibleClient(env, user, clientId);
  if (!client) return new Response("Not found", { status: 404 });
  return { client };
}

export async function handleNewCustomPagePost(
  request: Request,
  env: AppEnv,
  url: URL,
  user: User,
  clientId: string,
): Promise<{
  response?: Response;
  rerenderError?: { client: ClientRow; error: string; path: string; html: string };
}> {
  const csrf = checkCsrf(request, url);
  if (csrf) return { response: csrf };
  const client = await loadVisibleClient(env, user, clientId);
  if (!client) return { response: new Response("Not found", { status: 404 }) };
  if (!env.CONTENT_R2) {
    return { response: new Response("CONTENT_R2 binding not configured", { status: 500 }) };
  }

  const form = await request.formData();
  const path = String(form.get("path") ?? "").trim();
  const html = String(form.get("html") ?? "");

  if (!path || !CUSTOM_PAGE_PATH_RE.test(path)) {
    return {
      rerenderError: {
        client,
        path,
        html,
        error: "Path must start with `/` and contain only letters, digits, `/`, `_`, `-`.",
      },
    };
  }
  if (path === "/") {
    return {
      rerenderError: {
        client,
        path,
        html,
        error: "Cannot create a custom page at the root `/`. Use a subpath like `/lp/austin`.",
      },
    };
  }
  if (!html.trim()) {
    return { rerenderError: { client, path, html, error: "HTML body is required." } };
  }
  if (new TextEncoder().encode(html).byteLength > CUSTOM_PAGE_MAX_HTML_BYTES) {
    return {
      rerenderError: {
        client,
        path,
        html,
        error: `HTML body exceeds ${CUSTOM_PAGE_MAX_HTML_BYTES} bytes.`,
      },
    };
  }

  // Reject paths that already have a custom_page route. Editing an
  // existing custom page is a separate flow (delete + recreate, for
  // now — clarifies that re-uploads invalidate cache).
  const cfg = JSON.parse(client.config_json) as Record<string, unknown>;
  const existing = listCustomPages(cfg).find((e) => e.literalPath === path);
  if (existing) {
    return {
      rerenderError: {
        client,
        path,
        html,
        error: `A custom page already exists at \`${path}\`. Delete it first to replace the content.`,
      },
    };
  }

  const beforeHash = fnvHash(client.config_json);
  const storageKey = customPageStorageKey(clientId, path);

  // Write to R2. Content-Type is set as metadata so future inspectors
  // can tell it's HTML; the proxy renderer always serves text/html.
  await env.CONTENT_R2.put(storageKey, html, {
    httpMetadata: { contentType: "text/html; charset=utf-8" },
    customMetadata: {
      uploaded_by: user.email,
      uploaded_at: new Date().toISOString(),
    },
  });

  // Prepend the route so it precedes the catch-all proxy rule (route
  // resolution is first-match-wins per spec §5 step 6).
  const routing = Array.isArray(cfg.routing) ? (cfg.routing as Array<unknown>) : [];
  const newRoute = {
    match: customPageMatch(path),
    type: "custom_page",
    custom_page_key: clientId,
    origin_auth: { type: "none" },
  };
  cfg.routing = [newRoute, ...routing];
  const newJson = JSON.stringify(cfg);
  const afterHash = fnvHash(newJson);

  await env.CONFIG_DB.prepare(
    "UPDATE clients SET config_json = ?, updated_at = CURRENT_TIMESTAMP WHERE client_id = ?",
  )
    .bind(newJson, clientId)
    .run();
  await invalidateKv(env, clientId, client.proxy_domain);
  const actor = actorOf(user, request);
  await writeAudit(env, {
    client_id: clientId,
    actor_email: actor.user.email,
    actor_ip: actor.ip,
    event_type: "config_update",
    before_hash: beforeHash,
    after_hash: afterHash,
    previous_status: client.status,
    new_status: client.status,
    notes: `created custom page ${path} (R2 key ${storageKey})`,
  });

  return {
    response: flashRedirect(`/app/clients/${clientId}`, {
      text: `Custom page created at ${path}. View it at https://${client.proxy_domain}${path}`,
      kind: "ok",
    }),
  };
}

/**
 * Serve the GET form for static-site upload.
 */
export async function handleNewStaticSiteGet(
  env: AppEnv,
  user: User,
  clientId: string,
): Promise<Response | { client: ClientRow }> {
  const client = await loadVisibleClient(env, user, clientId);
  if (!client) return new Response("Not found", { status: 404 });
  return { client };
}

/**
 * Build the match regex for a static-site route: `^<basePath>(/.*)?$`.
 * The optional `(/.*)?` group ensures both the bare base path
 * (`/site`) and any sub-path (`/site/foo/bar.css`) match the route.
 */
function staticSiteMatch(basePath: string): string {
  const escaped = basePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return `^${escaped}(/.*)?$`;
}

/**
 * Handle the static-site upload POST. Extracts the zip in-memory,
 * validates entries, writes each file to R2 under
 * `<client_id><basePath>/<entry-path>`, and prepends a single
 * custom_page route to routing[].
 */
export async function handleNewStaticSitePost(
  request: Request,
  env: AppEnv,
  url: URL,
  user: User,
  clientId: string,
): Promise<{
  response?: Response;
  rerenderError?: { client: ClientRow; basePath: string; error: string };
}> {
  const csrf = checkCsrf(request, url);
  if (csrf) return { response: csrf };
  const client = await loadVisibleClient(env, user, clientId);
  if (!client) return { response: new Response("Not found", { status: 404 }) };
  if (!env.CONTENT_R2) {
    return { response: new Response("CONTENT_R2 binding not configured", { status: 500 }) };
  }

  const form = await request.formData();
  const basePath = String(form.get("base_path") ?? "").trim();
  const file = form.get("zip");

  if (!basePath || !CUSTOM_PAGE_PATH_RE.test(basePath) || basePath === "/") {
    return {
      rerenderError: {
        client,
        basePath,
        error:
          "Base path must start with `/`, contain only letters/digits/`/`/`_`/`-`, and not be the root.",
      },
    };
  }
  if (!(file instanceof File)) {
    return { rerenderError: { client, basePath, error: "ZIP file is required." } };
  }
  if (file.size === 0) {
    return { rerenderError: { client, basePath, error: "Uploaded ZIP is empty." } };
  }
  if (file.size > ZIP_MAX_BYTES) {
    return {
      rerenderError: {
        client,
        basePath,
        error: `ZIP exceeds ${ZIP_MAX_BYTES} bytes (got ${file.size}).`,
      },
    };
  }

  // Reject if a route at this base already exists — operator must
  // delete first. Same defensive posture as single-page uploads.
  const cfg = JSON.parse(client.config_json) as Record<string, unknown>;
  const existing = listCustomPages(cfg).find(
    (e) => e.kind === "site" && e.literalPath === basePath,
  );
  if (existing) {
    return {
      rerenderError: {
        client,
        basePath,
        error: `A static site already exists at \`${basePath}\`. Delete it first to replace.`,
      },
    };
  }

  // Extract.
  let extracted: ReturnType<typeof extractZip>;
  try {
    const buf = new Uint8Array(await file.arrayBuffer());
    extracted = extractZip(buf);
  } catch (e) {
    return {
      rerenderError: { client, basePath, error: `Invalid ZIP: ${(e as Error).message}` },
    };
  }
  if (extracted.files.length === 0) {
    return {
      rerenderError: { client, basePath, error: "ZIP contains no files." },
    };
  }

  // Auto-flatten a single common parent folder. Many website-builder
  // exports wrap content (e.g. `mysite/index.html`); without this the
  // operator's `<base>/index.html` lookup misses and they hit 404s.
  const { files: filesToWrite, strippedPrefix } = autoFlattenCommonPrefix(extracted.files);

  // Write each file to R2 with the right content-type. Bundle path
  // shape: `<client_id><basePath>/<entry-path>` — matches what
  // renderCustomPage will look up for an inbound URL of
  // `<basePath>/<entry-path>`.
  const beforeHash = fnvHash(client.config_json);
  const r2 = env.CONTENT_R2;
  const storedPaths: string[] = [];
  for (const entry of filesToWrite) {
    const ct = contentTypeForPath(entry.path) ?? "application/octet-stream";
    const key = `${clientId}${basePath}/${entry.path}`;
    await r2.put(key, entry.bytes, {
      httpMetadata: { contentType: ct },
      customMetadata: {
        uploaded_by: user.email,
        uploaded_at: new Date().toISOString(),
      },
    });
    storedPaths.push(entry.path);
  }
  const hasIndex = storedPaths.some((p) => p === "index.html" || p.endsWith("/index.html"));

  // Add the routing entry.
  const routing = Array.isArray(cfg.routing) ? (cfg.routing as Array<unknown>) : [];
  const newRoute = {
    match: staticSiteMatch(basePath),
    type: "custom_page",
    custom_page_key: clientId,
    origin_auth: { type: "none" },
  };
  cfg.routing = [newRoute, ...routing];
  const newJson = JSON.stringify(cfg);
  const afterHash = fnvHash(newJson);

  await env.CONFIG_DB.prepare(
    "UPDATE clients SET config_json = ?, updated_at = CURRENT_TIMESTAMP WHERE client_id = ?",
  )
    .bind(newJson, clientId)
    .run();
  await invalidateKv(env, clientId, client.proxy_domain);
  const actor = actorOf(user, request);
  await writeAudit(env, {
    client_id: clientId,
    actor_email: actor.user.email,
    actor_ip: actor.ip,
    event_type: "config_update",
    before_hash: beforeHash,
    after_hash: afterHash,
    previous_status: client.status,
    new_status: client.status,
    notes: `uploaded static site ${basePath} (${storedPaths.length} files, ${extracted.totalBytes} bytes uncompressed${strippedPrefix ? `, auto-flattened "${strippedPrefix}/"` : ""})`,
  });

  // Build a concise success message that exposes what was actually
  // stored. If the bundle has an index.html the operator gets a
  // direct live link. If it doesn't, surface a warning so they don't
  // wonder why <base>/ 404s.
  const samplePaths = storedPaths.slice(0, 5).join(", ");
  const moreSuffix = storedPaths.length > 5 ? ` … +${storedPaths.length - 5} more` : "";
  const flattenedNote = strippedPrefix ? ` (auto-flattened "${strippedPrefix}/")` : "";
  const flashText = hasIndex
    ? `Site uploaded at ${basePath}${flattenedNote}: ${storedPaths.length} files (${samplePaths}${moreSuffix}). View at https://${client.proxy_domain}${basePath}/`
    : `Site uploaded at ${basePath}${flattenedNote}: ${storedPaths.length} files (${samplePaths}${moreSuffix}). NOTE: no index.html found — visiting ${basePath}/ will 404 unless you add one.`;
  return {
    response: flashRedirect(`/app/clients/${clientId}`, {
      text: flashText,
      kind: hasIndex ? "ok" : "warn",
    }),
  };
}

/**
 * Look up an existing custom_page route by its match regex and load
 * the current R2 body. Used by the edit-form GET handler.
 *
 * Returns either a Response (404 / 500) or the data needed to render
 * the form.
 */
export async function handleEditCustomPageGet(
  env: AppEnv,
  user: User,
  clientId: string,
  matchParam: string,
): Promise<Response | { client: ClientRow; match: string; literalPath: string; html: string }> {
  const client = await loadVisibleClient(env, user, clientId);
  if (!client) return new Response("Not found", { status: 404 });
  if (!env.CONTENT_R2) {
    return new Response("CONTENT_R2 binding not configured", { status: 500 });
  }
  const cfg = JSON.parse(client.config_json) as Record<string, unknown>;
  const entry = listCustomPages(cfg).find((e) => e.match === matchParam);
  if (!entry || !entry.literalPath) {
    return new Response("Custom page not found", { status: 404 });
  }
  // Read the existing R2 body. Try the literal path verbatim, fall
  // back to the toggled-trailing-slash form (mirrors the renderer's
  // lookup tolerance from src/custom-pages/index.ts).
  const prefix = entry.customPageKey;
  const primaryKey = `${prefix}${entry.literalPath}`;
  const altKey = entry.literalPath.endsWith("/")
    ? `${prefix}${entry.literalPath.slice(0, -1)}`
    : `${prefix}${entry.literalPath}/`;
  let r2 = await env.CONTENT_R2.get(primaryKey);
  if (r2 === null) r2 = await env.CONTENT_R2.get(altKey);
  const html = r2 !== null ? await r2.text() : "";
  return { client, match: entry.match, literalPath: entry.literalPath, html };
}

export async function handleEditCustomPagePost(
  request: Request,
  env: AppEnv,
  url: URL,
  user: User,
  clientId: string,
): Promise<{
  response?: Response;
  rerenderError?: {
    client: ClientRow;
    match: string;
    literalPath: string;
    html: string;
    error: string;
  };
}> {
  const csrf = checkCsrf(request, url);
  if (csrf) return { response: csrf };
  const client = await loadVisibleClient(env, user, clientId);
  if (!client) return { response: new Response("Not found", { status: 404 }) };
  if (!env.CONTENT_R2) {
    return { response: new Response("CONTENT_R2 binding not configured", { status: 500 }) };
  }
  const form = await request.formData();
  const matchValue = String(form.get("match") ?? "");
  const html = String(form.get("html") ?? "");

  const cfg = JSON.parse(client.config_json) as Record<string, unknown>;
  const entry = listCustomPages(cfg).find((e) => e.match === matchValue);
  if (!entry || !entry.literalPath) {
    return {
      response: flashRedirect(`/app/clients/${clientId}`, {
        text: `No custom page found for match=${matchValue}`,
        kind: "err",
      }),
    };
  }
  if (!html.trim()) {
    return {
      rerenderError: {
        client,
        match: entry.match,
        literalPath: entry.literalPath,
        html,
        error: "HTML body is required.",
      },
    };
  }
  if (new TextEncoder().encode(html).byteLength > CUSTOM_PAGE_MAX_HTML_BYTES) {
    return {
      rerenderError: {
        client,
        match: entry.match,
        literalPath: entry.literalPath,
        html,
        error: `HTML body exceeds ${CUSTOM_PAGE_MAX_HTML_BYTES} bytes.`,
      },
    };
  }

  // Overwrite at the same key the renderer's primary lookup will use
  // (literalPath verbatim). The fallback tolerance in renderCustomPage
  // covers the trailing-slash toggle on read; we don't need to write
  // both forms.
  const storageKey = customPageStorageKey(clientId, entry.literalPath);
  await env.CONTENT_R2.put(storageKey, html, {
    httpMetadata: { contentType: "text/html; charset=utf-8" },
    customMetadata: {
      uploaded_by: user.email,
      uploaded_at: new Date().toISOString(),
    },
  });
  await invalidateKv(env, clientId, client.proxy_domain);
  const actor = actorOf(user, request);
  await writeAudit(env, {
    client_id: clientId,
    actor_email: actor.user.email,
    actor_ip: actor.ip,
    event_type: "config_update",
    before_hash: null,
    after_hash: null,
    previous_status: client.status,
    new_status: client.status,
    notes: `updated custom page ${entry.literalPath} (R2 key ${storageKey})`,
  });
  return {
    response: flashRedirect(`/app/clients/${clientId}`, {
      text: `Saved custom page ${entry.literalPath}.`,
      kind: "ok",
    }),
  };
}

export async function handleDeleteCustomPagePost(
  request: Request,
  env: AppEnv,
  url: URL,
  user: User,
  clientId: string,
): Promise<Response> {
  const csrf = checkCsrf(request, url);
  if (csrf) return csrf;
  const client = await loadVisibleClient(env, user, clientId);
  if (!client) return new Response("Not found", { status: 404 });
  if (!env.CONTENT_R2) {
    return new Response("CONTENT_R2 binding not configured", { status: 500 });
  }

  const form = await request.formData();
  const matchToDelete = String(form.get("match") ?? "");
  if (!matchToDelete) {
    return flashRedirect(`/app/clients/${clientId}`, {
      text: "Delete failed: missing match.",
      kind: "err",
    });
  }

  const cfg = JSON.parse(client.config_json) as Record<string, unknown>;
  const routing = Array.isArray(cfg.routing) ? (cfg.routing as Array<Record<string, unknown>>) : [];
  const target = routing.find(
    (r) => r.type === "custom_page" && typeof r.match === "string" && r.match === matchToDelete,
  );
  if (!target) {
    return flashRedirect(`/app/clients/${clientId}`, {
      text: `No custom_page route found with match=${matchToDelete}`,
      kind: "err",
    });
  }
  // Use the catalog entry to know the route's kind (page vs site) and
  // its literalPath (single page) or basePath (site). Falls back to
  // the regex-derived literal for legacy entries.
  const catalogEntry = listCustomPages(cfg).find((e) => e.match === matchToDelete);
  const literalPath = catalogEntry?.literalPath ?? derivLiteralPath(matchToDelete);
  const isSite = catalogEntry?.kind === "site";

  const beforeHash = fnvHash(client.config_json);
  cfg.routing = routing.filter((r) => r !== target);
  const newJson = JSON.stringify(cfg);
  const afterHash = fnvHash(newJson);

  await env.CONFIG_DB.prepare(
    "UPDATE clients SET config_json = ?, updated_at = CURRENT_TIMESTAMP WHERE client_id = ?",
  )
    .bind(newJson, clientId)
    .run();

  // Best-effort R2 delete. If it fails, we still want the route gone
  // from the config so traffic stops. Orphaned R2 objects are a
  // cleanup-script concern, not a correctness issue.
  let r2DeletedCount = 0;
  if (literalPath) {
    if (isSite) {
      // Static-site route — sweep all R2 keys under <client_id><base>/.
      // R2 list pagination is handled by the truncated/cursor loop
      // below; in practice a single bundle stays under one page (1000
      // objects) but the loop is correct for arbitrarily large sites.
      const prefix = `${clientId}${literalPath}/`;
      try {
        let cursor: string | undefined;
        for (;;) {
          const listed = await env.CONTENT_R2.list({ prefix, cursor });
          for (const obj of listed.objects) {
            try {
              await env.CONTENT_R2.delete(obj.key);
              r2DeletedCount += 1;
            } catch {
              /* best-effort per-object */
            }
          }
          if (!listed.truncated) break;
          cursor = listed.cursor;
        }
      } catch {
        /* best-effort listing */
      }
    } else {
      const storageKey = customPageStorageKey(clientId, literalPath);
      try {
        await env.CONTENT_R2.delete(storageKey);
        r2DeletedCount = 1;
      } catch {
        /* best-effort */
      }
    }
  }
  await invalidateKv(env, clientId, client.proxy_domain);
  const actor = actorOf(user, request);
  const kindLabel = isSite ? "static site" : "custom page";
  await writeAudit(env, {
    client_id: clientId,
    actor_email: actor.user.email,
    actor_ip: actor.ip,
    event_type: "config_update",
    before_hash: beforeHash,
    after_hash: afterHash,
    previous_status: client.status,
    new_status: client.status,
    notes: `deleted ${kindLabel} ${literalPath ?? matchToDelete} (R2 objects removed: ${r2DeletedCount})`,
  });

  const flashText = isSite
    ? `Deleted static site ${literalPath ?? matchToDelete} (${r2DeletedCount} R2 object${r2DeletedCount === 1 ? "" : "s"}).`
    : `Deleted custom page ${literalPath ?? matchToDelete}.`;
  return flashRedirect(`/app/clients/${clientId}`, {
    text: flashText,
    kind: "ok",
  });
}

export async function handleAttestPost(
  request: Request,
  env: AppEnv,
  url: URL,
  user: User,
  clientId: string,
): Promise<{ response?: Response; rerenderError?: { error: string; client: ClientRow } }> {
  const csrf = checkCsrf(request, url);
  if (csrf) return { response: csrf };
  const client = await loadVisibleClient(env, user, clientId);
  if (!client) return { response: new Response("Not found", { status: 404 }) };

  const form = await request.formData();
  const email = String(form.get("attested_by_email") ?? "").trim();
  const ipRaw = String(form.get("attested_ip") ?? "").trim();
  const scope = String(form.get("scope") ?? "");
  const scopePathsRaw = String(form.get("scope_paths") ?? "").trim();
  const uaRaw = String(form.get("user_agent") ?? "").trim();

  if (!email || !email.includes("@"))
    return { rerenderError: { error: "attested_by_email is required.", client } };
  if (scope !== "full_site" && scope !== "specified_paths")
    return { rerenderError: { error: "scope must be full_site or specified_paths.", client } };
  let scopePathsJson: string | null = null;
  if (scope === "specified_paths") {
    const paths = scopePathsRaw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (paths.length === 0) {
      return {
        rerenderError: { error: "scope_paths is required when scope = specified_paths.", client },
      };
    }
    scopePathsJson = JSON.stringify(paths);
  }
  const actor = actorOf(user, request);
  const ip = ipRaw || actor.ip;
  const userAgent = uaRaw || request.headers.get("user-agent") || null;
  const attestedAt = new Date().toISOString();

  await env.CONFIG_DB.prepare(
    `INSERT INTO attestations
       (client_id, proxy_domain, source_domain, attested_by_email,
        attested_at, attested_ip, user_agent, scope, scope_paths_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      clientId,
      client.proxy_domain,
      client.source_domain,
      email,
      attestedAt,
      ip,
      userAgent,
      scope,
      scopePathsJson,
    )
    .run();
  await writeAudit(env, {
    client_id: clientId,
    actor_email: actor.user.email,
    actor_ip: actor.ip,
    event_type: "authorization_update",
    before_hash: null,
    after_hash: null,
    previous_status: null,
    new_status: null,
    notes: `attestation by ${email} (scope=${scope})`,
  });
  return {
    response: flashRedirect(`/app/clients/${clientId}`, {
      text: `Attestation recorded for ${email}.`,
      kind: "ok",
    }),
  };
}
