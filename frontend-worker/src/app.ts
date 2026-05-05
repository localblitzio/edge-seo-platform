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

import type { User } from "./auth.js";

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
    return `<h1>Clients</h1>
      <p class="subtitle">${user.role === "super_admin" ? "No clients in the platform yet." : "You don't own any clients yet. Ask a super-admin to create one for you, or transfer ownership of an existing client."}</p>
      <div class="empty">No clients to show.</div>`;
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
  return `<h1>Clients</h1>
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

  const adminBase = "https://edge-seo-admin.localblitzio.workers.dev";
  return `<div class="crumbs"><a href="/app/clients">← Clients</a></div>
    <h1>${esc(client.client_id)} ${statusPill(client.status)}</h1>
    <p class="subtitle"><span class="mono">${esc(client.proxy_domain)}</span> &nbsp;→&nbsp; <span class="mono">${esc(client.source_domain)}</span></p>
    <div class="actions-row">
      <span style="color:var(--fg-muted);font-size:.85rem;align-self:center;">Write actions ship in Phase E v2. For now, edit on the legacy admin worker:</span>
      <a class="btn-link" href="${adminBase}/clients/${esc(client.client_id)}/edit" target="_blank" rel="noopener">Edit config ↗</a>
      <a class="btn-link" href="${adminBase}/clients/${esc(client.client_id)}/attest" target="_blank" rel="noopener">Capture attestation ↗</a>
      <a class="btn-link" href="${adminBase}/clients/${esc(client.client_id)}" target="_blank" rel="noopener">Status / cache-purge ↗</a>
    </div>
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
