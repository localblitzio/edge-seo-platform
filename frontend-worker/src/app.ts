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
import { LIST_EDITOR_JS } from "./list-editor-js.js";

/* ─── Types ─── */

export interface AppEnv {
  CONFIG_KV: KVNamespace;
  CONFIG_DB: D1Database;
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
  return `<nav class="app-sidebar">${items}${adminLink}${clientList}</nav>`;
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
    <p class="subtitle"><span class="mono">${esc(client.proxy_domain)}</span> &nbsp;→&nbsp; <span class="mono">${esc(client.source_domain)}</span></p>
    ${renderActionsRow(client)}
    ${parseError ? `<div class="empty">⚠ Config JSON parse error: ${esc(parseError)}</div>` : ""}
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
