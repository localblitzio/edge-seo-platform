/**
 * Edge SEO Admin — hosted dashboard + write surface for the platform's
 * live state (clients, configs, KV entries, attestations, audit log).
 *
 * Phase 2 admin editor: edit JSON configs, flip status, purge cache,
 * capture attestations, add new clients. All writes go through the SAME
 * Zod schema + invariant checks the Worker uses at load time, so admin-time
 * validation is identical to runtime validation (spec §7 invariant).
 *
 * Auth: HTTP Basic against `ADMIN_USERNAME` / `ADMIN_PASSWORD` Worker
 * secrets. Set via:
 *   npx wrangler secret put ADMIN_USERNAME --config=admin-worker/wrangler.toml
 *   npx wrangler secret put ADMIN_PASSWORD --config=admin-worker/wrangler.toml
 *
 * For production, wrap this Worker behind Cloudflare Access for SSO.
 */

import { ClientConfig } from "../../src/config/schema.js";
import { assertConfigInvariants } from "../../src/config/validator.js";
import { ConfigValidationError } from "../../src/lib/errors.js";
import { type FlashMessage, checkCsrf, flashRedirect, fnvHash, readFlash } from "./helpers.js";

interface Env {
  CONFIG_KV: KVNamespace;
  CONFIG_DB: D1Database;
  ADMIN_USERNAME?: string;
  ADMIN_PASSWORD?: string;
}

interface ClientRow {
  client_id: string;
  proxy_domain: string;
  source_domain: string;
  status: string;
  config_json: string;
  schema_version: number;
  created_at: string;
  updated_at: string;
}

interface AttestationRow {
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

interface AuditRow {
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

type AuditEventType =
  | "config_create"
  | "config_update"
  | "status_change"
  | "revocation"
  | "authorization_update";

interface AuditEntry {
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

interface Actor {
  email: string;
  ip: string;
}

const HTML_ENTITIES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};
function esc(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (c) => HTML_ENTITIES[c] ?? c);
}

function statusPill(status: string): string {
  const cls =
    status === "active" ? "pill-active" : status === "paused" ? "pill-paused" : "pill-terminated";
  return `<span class="pill ${cls}">${esc(status)}</span>`;
}

function jsonHtml(value: unknown): string {
  if (value === null) return `<span class="json-null">null</span>`;
  if (typeof value === "boolean") return `<span class="json-boolean">${value}</span>`;
  if (typeof value === "number") return `<span class="json-number">${value}</span>`;
  if (typeof value === "string") return `<span class="json-string">"${esc(value)}"</span>`;
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
          `<div style="padding-left:1.5em"><span class="json-key">"${esc(k)}"</span>: ${jsonHtml(
            (value as Record<string, unknown>)[k],
          )},</div>`,
      )
      .join("");
    return `{<div>${items}</div>}`;
  }
  return esc(String(value));
}

const STYLE = `
:root{color-scheme:light dark;--bg:#fafafa;--bg-elevated:#fff;--bg-sidebar:#f4f4f5;--bg-code:#f4f4f5;--border:#e4e4e7;--border-strong:#d4d4d8;--fg:#18181b;--fg-muted:#71717a;--accent:#2563eb;--accent-fg:#fff;--green:#16a34a;--green-bg:#dcfce7;--amber:#b45309;--amber-bg:#fef3c7;--red:#b91c1c;--red-bg:#fee2e2;--shadow:0 1px 2px rgba(0,0,0,.04),0 1px 3px rgba(0,0,0,.06);--radius:.5rem;--mono:ui-monospace,"SFMono-Regular","Menlo","Cascadia Mono",monospace}
@media (prefers-color-scheme:dark){:root{--bg:#09090b;--bg-elevated:#18181b;--bg-sidebar:#0d0d10;--bg-code:#18181b;--border:#27272a;--border-strong:#3f3f46;--fg:#fafafa;--fg-muted:#a1a1aa;--accent:#60a5fa;--green:#4ade80;--green-bg:#052e16;--amber:#fbbf24;--amber-bg:#422006;--red:#f87171;--red-bg:#450a0a}}
*{box-sizing:border-box}html,body{margin:0;padding:0;background:var(--bg);color:var(--fg);font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
a{color:var(--accent);text-decoration:none}a:hover{text-decoration:underline}
code,.mono{font-family:var(--mono);font-size:.92em}
.topbar{display:flex;align-items:center;justify-content:space-between;padding:.75rem 1.5rem;background:var(--bg-elevated);border-bottom:1px solid var(--border);position:sticky;top:0;z-index:10}
.topbar .brand{display:flex;align-items:center;gap:.6rem;font-size:.95rem}
.topbar .logo{display:inline-block;width:.85rem;height:.85rem;border-radius:9999px;background:linear-gradient(135deg,#2563eb,#7c3aed)}
.topbar .env{font-size:.72rem;text-transform:uppercase;letter-spacing:.05em;color:var(--fg-muted);font-weight:600;padding:.15rem .5rem;border:1px solid var(--border-strong);border-radius:9999px}
.btn{font:inherit;border:1px solid var(--border-strong);background:var(--bg-elevated);color:var(--fg);padding:.35rem .85rem;border-radius:var(--radius);cursor:pointer;display:inline-block;text-decoration:none}.btn:hover{border-color:var(--accent);color:var(--accent);text-decoration:none}
.btn-primary{background:var(--accent);color:var(--accent-fg);border-color:var(--accent)}.btn-primary:hover{filter:brightness(1.1);color:var(--accent-fg)}
.btn-danger{border-color:var(--red);color:var(--red)}.btn-danger:hover{background:var(--red-bg);color:var(--red)}
.btn-warn{border-color:var(--amber);color:var(--amber)}.btn-warn:hover{background:var(--amber-bg);color:var(--amber)}
.btn-success{border-color:var(--green);color:var(--green)}.btn-success:hover{background:var(--green-bg);color:var(--green)}
.layout{display:grid;grid-template-columns:220px 1fr;min-height:calc(100vh - 56px)}
.sidebar{background:var(--bg-sidebar);border-right:1px solid var(--border);padding:1.25rem .75rem;display:flex;flex-direction:column}
.sidebar a{display:block;padding:.45rem .75rem;border-radius:var(--radius);color:var(--fg)}
.sidebar a:hover{background:var(--bg-elevated);text-decoration:none}
.sidebar a.active{background:var(--accent);color:var(--accent-fg)}
.sidebar-section{font-size:.7rem;text-transform:uppercase;letter-spacing:.08em;color:var(--fg-muted);font-weight:600;padding:.5rem .75rem;margin-top:.75rem}
.sidebar-foot{margin-top:auto;padding:1rem .75rem 0;font-size:.72rem;color:var(--fg-muted);border-top:1px solid var(--border);line-height:1.4}
.main{padding:1.75rem 2rem;max-width:1100px}
h1{font-size:1.45rem;margin:0 0 .4rem;font-weight:700;letter-spacing:-.01em}
h2{font-size:1.05rem;margin:1.75rem 0 .6rem;font-weight:600}
.subtitle{color:var(--fg-muted);margin:0 0 1.5rem}
.card{background:var(--bg-elevated);border:1px solid var(--border);border-radius:var(--radius);padding:1rem 1.25rem;margin-bottom:1rem;box-shadow:var(--shadow)}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:.85rem;margin:0 0 1.5rem}
.stat{background:var(--bg-elevated);border:1px solid var(--border);border-radius:var(--radius);padding:.85rem 1rem}
.stat .label{font-size:.72rem;text-transform:uppercase;letter-spacing:.05em;color:var(--fg-muted);font-weight:600}
.stat .value{font-size:1.6rem;font-weight:700;margin-top:.15rem;letter-spacing:-.02em}
table.data{width:100%;border-collapse:collapse;font-size:.9rem;background:var(--bg-elevated);border:1px solid var(--border);border-radius:var(--radius);overflow:hidden}
table.data th{background:var(--bg-sidebar);text-align:left;font-weight:600;font-size:.78rem;text-transform:uppercase;letter-spacing:.04em;color:var(--fg-muted);padding:.55rem .9rem;border-bottom:1px solid var(--border)}
table.data td{padding:.55rem .9rem;border-bottom:1px solid var(--border);vertical-align:top}
table.data tr:last-child td{border-bottom:0}
table.data tr:hover td{background:rgba(37,99,235,.04)}
.pill{display:inline-block;padding:.1rem .55rem;border-radius:9999px;font-size:.72rem;font-weight:600}
.pill-active{background:var(--green-bg);color:var(--green)}
.pill-paused{background:var(--amber-bg);color:var(--amber)}
.pill-terminated{background:var(--red-bg);color:var(--red)}
.pill-neutral{background:var(--bg-sidebar);color:var(--fg-muted);border:1px solid var(--border)}
.json-block{background:var(--bg-code);border:1px solid var(--border);border-radius:var(--radius);padding:1rem;overflow-x:auto;font-family:var(--mono);font-size:.85rem;line-height:1.5;margin:.4rem 0 0}
.json-key{color:#2563eb}.json-string{color:#16a34a}.json-number,.json-boolean{color:#b45309}.json-null{color:var(--fg-muted)}
@media (prefers-color-scheme:dark){.json-key{color:#60a5fa}.json-string{color:#4ade80}.json-number,.json-boolean{color:#fbbf24}}
details.section{background:var(--bg-elevated);border:1px solid var(--border);border-radius:var(--radius);padding:.75rem 1rem;margin-bottom:.6rem}
details.section>summary{cursor:pointer;font-weight:600;user-select:none;display:flex;justify-content:space-between;align-items:center}
details.section>summary::after{content:"▸";color:var(--fg-muted);transition:transform .15s}
details.section[open]>summary::after{transform:rotate(90deg)}
details.section>summary .count{background:var(--bg-sidebar);color:var(--fg-muted);font-weight:500;padding:.05rem .5rem;border-radius:9999px;font-size:.78rem;margin-left:.5rem}
details.section>.body{margin-top:.85rem}
.empty{color:var(--fg-muted);font-style:italic;padding:.5rem 0}
.crumbs{font-size:.85rem;color:var(--fg-muted);margin-bottom:.4rem}
.crumbs a{color:var(--fg-muted)}
dl.kv{display:grid;grid-template-columns:max-content 1fr;gap:.4rem 1.25rem;margin:.5rem 0 0;font-size:.9rem}
dl.kv dt{color:var(--fg-muted);font-weight:500}
dl.kv dd{margin:0;font-family:var(--mono);font-size:.85rem;word-break:break-word}
.kv-key{font-family:var(--mono);font-size:.85rem;word-break:break-all}
.kv-preview{color:var(--fg-muted);font-size:.85rem;max-width:32rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.actions-row{display:flex;flex-wrap:wrap;gap:.5rem;margin:0 0 1.25rem;padding:.85rem 1rem;background:var(--bg-elevated);border:1px solid var(--border);border-radius:var(--radius)}
.actions-row form{display:inline}
.flash{padding:.65rem 1rem;border-radius:var(--radius);margin:0 0 1rem;border:1px solid transparent}
.flash-ok{background:var(--green-bg);color:var(--green);border-color:var(--green)}
.flash-warn{background:var(--amber-bg);color:var(--amber);border-color:var(--amber)}
.flash-err{background:var(--red-bg);color:var(--red);border-color:var(--red)}
form.editor{display:flex;flex-direction:column;gap:.85rem}
form.editor label{font-weight:600;font-size:.85rem}
.form-section{background:var(--bg-elevated);border:1px solid var(--border);border-radius:var(--radius);padding:1rem 1.25rem}
.form-section h2{margin-top:0;margin-bottom:.85rem;font-size:.95rem;font-weight:600}
.form-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:.85rem 1.25rem}
.form-grid .full-width{grid-column:span 2}
.form-grid label{font-weight:600;font-size:.78rem;display:block;margin-bottom:.2rem}
.form-grid input[type=text],.form-grid input[type=email],.form-grid select{font:inherit;font-family:inherit;font-size:.88rem;padding:.4rem .55rem;border:1px solid var(--border-strong);border-radius:var(--radius);background:var(--bg);color:var(--fg);width:100%}
.form-grid input[readonly]{background:var(--bg-sidebar);cursor:not-allowed;color:var(--fg-muted)}
.form-grid .field-hint{font-size:.72rem;color:var(--fg-muted);margin-top:.2rem;line-height:1.35}
form.editor input[type=text],form.editor input[type=email],form.editor select,form.editor textarea{font:inherit;font-family:var(--mono);font-size:.85rem;padding:.5rem .65rem;border:1px solid var(--border-strong);border-radius:var(--radius);background:var(--bg-elevated);color:var(--fg);width:100%}
form.editor textarea{min-height:520px;line-height:1.45;resize:vertical}
form.editor .hint{font-size:.78rem;color:var(--fg-muted);margin-top:-.35rem}
form.editor .form-actions{display:flex;gap:.5rem;align-items:center;margin-top:.5rem}
.error-box{background:var(--red-bg);color:var(--red);border:1px solid var(--red);border-radius:var(--radius);padding:.65rem 1rem;font-family:var(--mono);font-size:.85rem;white-space:pre-wrap;margin:0 0 1rem}
`;

function flashBanner(flash: FlashMessage | null): string {
  if (!flash) return "";
  return `<div class="flash flash-${esc(flash.kind)}">${esc(flash.text)}</div>`;
}

function layout(opts: {
  title: string;
  content: string;
  activeNav: string;
  clients: ClientRow[];
  flash: FlashMessage | null;
}): string {
  const navLinks = [
    { href: "/", id: "home", label: "Overview" },
    { href: "/clients", id: "clients", label: "Clients" },
    { href: "/clients/new", id: "clients:new", label: "+ New client" },
    { href: "/redirects", id: "redirects", label: "Redirect rules" },
    { href: "/audit", id: "audit", label: "Audit log" },
    { href: "/kv", id: "kv", label: "KV browser" },
  ]
    .map(
      (l) =>
        `<a href="${l.href}" class="${opts.activeNav === l.id ? "active" : ""}">${esc(l.label)}</a>`,
    )
    .join("");
  const clientList = opts.clients
    .map(
      (c) =>
        `<a href="/clients/${esc(c.client_id)}" class="${
          opts.activeNav === `client:${c.client_id}` ? "active" : ""
        }" style="padding-left:1.25rem;font-size:.85rem;">${esc(c.client_id)}</a>`,
    )
    .join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(
    opts.title,
  )} — Edge SEO Admin</title><style>${STYLE}</style></head><body>
<header class="topbar"><div class="brand"><span class="logo"></span><strong>Edge SEO Admin</strong><span class="env">staging</span></div>
<div class="actions"><button onclick="location.reload()" class="btn">Refresh</button></div></header>
<div class="layout"><nav class="sidebar">${navLinks}${
    opts.clients.length > 0
      ? `<div class="sidebar-section">Configured clients</div>${clientList}`
      : ""
  }<div class="sidebar-foot">Phase-2 admin UI.<br>Edits validate against the same Zod schema the Worker uses at load time.</div></nav><main class="main">${flashBanner(opts.flash)}${opts.content}</main></div></body></html>`;
}

async function loadAllClients(env: Env): Promise<ClientRow[]> {
  const result = await env.CONFIG_DB.prepare(
    "SELECT * FROM clients ORDER BY client_id",
  ).all<ClientRow>();
  return result.results ?? [];
}

async function loadClient(env: Env, id: string): Promise<ClientRow | null> {
  return await env.CONFIG_DB.prepare("SELECT * FROM clients WHERE client_id = ?")
    .bind(id)
    .first<ClientRow>();
}

async function loadAuditLog(env: Env): Promise<AuditRow[]> {
  try {
    const result = await env.CONFIG_DB.prepare(
      "SELECT * FROM audit_log ORDER BY id DESC LIMIT 200",
    ).all<AuditRow>();
    return result.results ?? [];
  } catch {
    return [];
  }
}

async function loadAttestations(env: Env): Promise<AttestationRow[]> {
  try {
    const result = await env.CONFIG_DB.prepare(
      "SELECT * FROM attestations ORDER BY id DESC LIMIT 200",
    ).all<AttestationRow>();
    return result.results ?? [];
  } catch {
    return [];
  }
}

interface KvKeyInfo {
  name: string;
  expiration: number | null;
}

async function listKv(env: Env): Promise<KvKeyInfo[]> {
  const list = await env.CONFIG_KV.list();
  return list.keys.map((k) => ({ name: k.name, expiration: k.expiration ?? null }));
}

async function invalidateKv(env: Env, clientId: string, proxyDomain: string): Promise<void> {
  await Promise.all([
    env.CONFIG_KV.delete(`config:${clientId}`),
    env.CONFIG_KV.delete(`domain:${proxyDomain}`),
  ]);
}

async function writeAudit(env: Env, entry: AuditEntry): Promise<void> {
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

/** Constant-time string comparison guard against timing attacks on the password. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

/**
 * Returns either a 401/503 Response (block the request) or the basic-auth
 * username on success. The username is later used as `audit_log.actor_email`.
 */
function checkAuth(request: Request, env: Env): Response | string {
  const username = env.ADMIN_USERNAME;
  const password = env.ADMIN_PASSWORD;
  if (!username || !password) {
    return new Response(
      "Admin auth not configured. Set ADMIN_USERNAME and ADMIN_PASSWORD secrets.",
      {
        status: 503,
        headers: { "content-type": "text/plain" },
      },
    );
  }
  const header = request.headers.get("authorization");
  if (header?.startsWith("Basic ")) {
    try {
      const decoded = atob(header.slice("Basic ".length));
      const colon = decoded.indexOf(":");
      if (colon !== -1) {
        const u = decoded.slice(0, colon);
        const p = decoded.slice(colon + 1);
        if (timingSafeEqual(u, username) && timingSafeEqual(p, password)) {
          return username;
        }
      }
    } catch {
      // fall through to 401
    }
  }
  return new Response("Authentication required", {
    status: 401,
    headers: {
      "www-authenticate": 'Basic realm="Edge SEO Admin"',
      "content-type": "text/plain",
    },
  });
}

/**
 * Validate a JSON string against ClientConfig schema + load-time invariants.
 * Mirrors the Worker's load-time validation exactly (spec §7).
 */
function validateConfigJson(
  raw: string,
): { ok: true; config: ClientConfig } | { ok: false; error: string } {
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

/* ─── Pages: read-only ─── */

async function renderOverview(env: Env): Promise<string> {
  const clients = await loadAllClients(env);
  const kvKeys = await listKv(env);
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
        <td><a href="/clients/${esc(c.client_id)}" class="mono">${esc(c.client_id)}</a></td>
        <td class="mono">${esc(c.proxy_domain)}</td>
        <td class="mono">${esc(c.source_domain)}</td>
        <td>${statusPill(c.status)}</td>
        <td class="mono" style="color:var(--fg-muted)">${esc(c.updated_at)}</td>
      </tr>`,
    )
    .join("");
  return `<h1>Overview</h1><p class="subtitle">Live state of the Edge SEO Platform on Cloudflare.</p>
    <div class="stats">${stat("Clients", clients.length)}${stat("Routes", totalRoutes)}${stat("Redirects", totalRedirects)}${stat("Canonicals", totalCanonicals)}${stat("Schemas", totalSchema)}${stat("KV entries", kvKeys.length)}</div>
    ${
      clients.length === 0
        ? `<div class="empty">No clients configured yet. <a href="/clients/new">Add the first one →</a></div>`
        : `<h2>Clients</h2><table class="data"><thead><tr><th>client_id</th><th>proxy</th><th>source</th><th>status</th><th>updated</th></tr></thead><tbody>${rows}</tbody></table>`
    }`;
}

async function renderClientsList(env: Env): Promise<string> {
  const clients = await loadAllClients(env);
  if (clients.length === 0)
    return `<h1>Clients</h1><div class="empty">No clients configured. <a href="/clients/new">Add the first one →</a></div>`;
  const rows = clients
    .map(
      (c) => `<tr>
        <td><a href="/clients/${esc(c.client_id)}" class="mono">${esc(c.client_id)}</a></td>
        <td class="mono">${esc(c.proxy_domain)}</td>
        <td class="mono">${esc(c.source_domain)}</td>
        <td>${statusPill(c.status)}</td>
        <td>v${esc(c.schema_version)}</td>
        <td class="mono" style="color:var(--fg-muted)">${esc(c.created_at)}</td>
      </tr>`,
    )
    .join("");
  return `<h1>Clients</h1><p class="subtitle">All rows from the <code>clients</code> table in <code>CONFIG_DB</code>. <a href="/clients/new" class="btn btn-primary" style="float:right">+ New client</a></p>
    <table class="data"><thead><tr><th>client_id</th><th>proxy</th><th>source</th><th>status</th><th>schema</th><th>created</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function rulesTable(headers: string[], rows: string[]): string {
  if (rows.length === 0) return `<div class="empty">none configured</div>`;
  return `<table class="data"><thead><tr>${headers.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>${rows.join("")}</tbody></table>`;
}

function section(label: string, count: number, body: string): string {
  return `<details class="section"${count > 0 ? " open" : ""}><summary>${esc(label)} <span class="count">${count}</span></summary><div class="body">${body}</div></details>`;
}

function renderActionsRow(client: ClientRow): string {
  const statusBtn = (target: string, label: string, cls: string, confirm: string | null) => {
    if (client.status === target)
      return `<button class="btn" disabled style="opacity:.5;cursor:not-allowed">${esc(label)} (current)</button>`;
    const onclick = confirm ? ` onclick="return confirm(${JSON.stringify(confirm)})"` : "";
    return `<form method="POST" action="/clients/${esc(client.client_id)}/status">
      <input type="hidden" name="status" value="${esc(target)}">
      <button class="btn ${cls}" type="submit"${onclick}>${esc(label)}</button>
    </form>`;
  };
  return `<div class="actions-row">
    <a class="btn btn-primary" href="/clients/${esc(client.client_id)}/edit">Edit config</a>
    <a class="btn" href="/clients/${esc(client.client_id)}/attest">Capture attestation</a>
    <form method="POST" action="/clients/${esc(client.client_id)}/cache-purge"><button class="btn" type="submit">Purge cache</button></form>
    ${statusBtn("active", "Activate", "btn-success", null)}
    ${statusBtn("paused", "Pause", "btn-warn", "Pause this client? The Worker will return 410 for all requests.")}
    ${statusBtn("terminated", "Terminate", "btn-danger", "Terminate is a one-way door per PRD §6.3. Requests will return 410 permanently. Are you sure?")}
  </div>`;
}

async function renderClientDetail(env: Env, id: string): Promise<string> {
  const client = await loadClient(env, id);
  if (!client)
    return `<div class="crumbs"><a href="/clients">← Clients</a></div><h1>Not found</h1><div class="empty">No client with that id.</div>`;
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
    (r, i) =>
      `<tr><td>${i}</td><td class="mono">${esc(r.match)}</td><td><span class="pill pill-neutral">${esc(r.type)}</span></td><td class="mono">${esc(r.origin ?? "")}</td><td class="mono">${esc((r.origin_auth as { type?: string } | undefined)?.type ?? "none")}</td></tr>`,
  );
  const staticRows = staticR.map(
    (r, i) =>
      `<tr><td>${i}</td><td class="mono">${esc(r.from)}</td><td class="mono">${esc(r.to)}</td><td class="mono">${esc(r.status ?? "301")}</td></tr>`,
  );
  const patternRows = patternR.map(
    (r, i) =>
      `<tr><td>${i}</td><td class="mono">${esc(r.pattern)}</td><td class="mono">${esc(r.replacement)}</td><td class="mono">${esc(r.status ?? "301")}</td></tr>`,
  );
  const conditionalRows = conditionalR.map(
    (r, i) =>
      `<tr><td>${i}</td><td class="mono">${esc(r.match)}</td><td class="mono" style="font-size:.8rem">${esc(JSON.stringify(r.conditions))}</td><td class="mono">${esc(r.to)}</td></tr>`,
  );
  const canonicalRows = arr("canonicals").map(
    (r, i) =>
      `<tr><td>${i}</td><td class="mono">${esc(r.match)}</td><td class="mono">${esc((r.strategy as { type?: string } | undefined)?.type)}</td></tr>`,
  );
  const schemaRows = arr("schema_injections").map(
    (r, i) =>
      `<tr><td>${i}</td><td class="mono">${esc(r.match)}</td><td class="mono">${esc(r.schema_type)}</td><td class="mono">${esc(r.position)}</td></tr>`,
  );
  const indexRows = arr("indexation").map(
    (r, i) =>
      `<tr><td>${i}</td><td class="mono">${esc(r.match)}</td><td class="mono">${esc(r.robots)}</td></tr>`,
  );
  const cacheRows = arr("caching").map(
    (r, i) =>
      `<tr><td>${i}</td><td class="mono">${esc(r.match)}</td><td class="mono">${esc(r.ttl_seconds)}</td></tr>`,
  );

  return `<div class="crumbs"><a href="/clients">← Clients</a></div>
    <h1>${esc(client.client_id)} ${statusPill(client.status)}</h1>
    <p class="subtitle"><span class="mono">${esc(client.proxy_domain)}</span> &nbsp;→&nbsp; <span class="mono">${esc(client.source_domain)}</span></p>
    ${renderActionsRow(client)}
    ${parseError ? `<div class="error-box">⚠ Config JSON parse error: ${esc(parseError)}</div>` : ""}
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

async function renderRedirects(env: Env): Promise<string> {
  const clients = await loadAllClients(env);
  const all: Array<{ client_id: string; layer: string; from: string; to: string; status: string }> =
    [];
  for (const c of clients) {
    let cfg: Record<string, unknown>;
    try {
      cfg = JSON.parse(c.config_json);
    } catch {
      continue;
    }
    const r = (cfg.redirects as Record<string, unknown> | undefined) ?? {};
    for (const x of (r.static as Array<Record<string, unknown>>) ?? []) {
      all.push({
        client_id: c.client_id,
        layer: "static",
        from: String(x.from),
        to: String(x.to),
        status: String(x.status ?? "301"),
      });
    }
    for (const x of (r.patterns as Array<Record<string, unknown>>) ?? []) {
      all.push({
        client_id: c.client_id,
        layer: "pattern",
        from: String(x.pattern),
        to: String(x.replacement),
        status: String(x.status ?? "301"),
      });
    }
    for (const x of (r.conditional as Array<Record<string, unknown>>) ?? []) {
      all.push({
        client_id: c.client_id,
        layer: "conditional",
        from: String(x.match),
        to: String(x.to),
        status: String(x.status ?? "302"),
      });
    }
  }
  if (all.length === 0)
    return `<h1>Redirect rules</h1><div class="empty">No redirects configured across any client.</div>`;
  const rows = all
    .map(
      (r) =>
        `<tr><td><a href="/clients/${esc(r.client_id)}" class="mono">${esc(r.client_id)}</a></td><td><span class="pill pill-neutral">${esc(r.layer)}</span></td><td class="mono">${esc(r.from)}</td><td class="mono">${esc(r.to)}</td><td class="mono">${esc(r.status)}</td></tr>`,
    )
    .join("");
  return `<h1>Redirect rules</h1><p class="subtitle">Across all clients, in §6.2 evaluation order.</p>
    <table class="data"><thead><tr><th>client</th><th>layer</th><th>from / pattern</th><th>to</th><th>status</th></tr></thead><tbody>${rows}</tbody></table>`;
}

async function renderAudit(env: Env): Promise<string> {
  const audit = await loadAuditLog(env);
  const attest = await loadAttestations(env);
  const auditRows = audit
    .map(
      (a) =>
        `<tr><td>${esc(a.id)}</td><td class="mono" style="color:var(--fg-muted)">${esc(a.occurred_at)}</td><td><a href="/clients/${esc(a.client_id)}" class="mono">${esc(a.client_id)}</a></td><td><span class="pill pill-neutral">${esc(a.event_type)}</span></td><td class="mono">${esc(a.actor_email)}</td><td class="mono" style="color:var(--fg-muted)">${esc(a.notes ?? "")}</td></tr>`,
    )
    .join("");
  const attestRows = attest
    .map(
      (a) =>
        `<tr><td>${esc(a.id)}</td><td class="mono" style="color:var(--fg-muted)">${esc(a.attested_at)}</td><td><a href="/clients/${esc(a.client_id)}" class="mono">${esc(a.client_id)}</a></td><td class="mono">${esc(a.proxy_domain)}</td><td class="mono">${esc(a.source_domain)}</td><td class="mono">${esc(a.attested_by_email)}</td><td class="mono">${esc(a.scope)}</td></tr>`,
    )
    .join("");
  return `<h1>Audit log</h1><p class="subtitle">Append-only records of config changes and attestations.</p>
    <h2>Audit events</h2>${auditRows ? `<table class="data"><thead><tr><th>id</th><th>at</th><th>client</th><th>event</th><th>actor</th><th>notes</th></tr></thead><tbody>${auditRows}</tbody></table>` : `<div class="empty">No audit events recorded.</div>`}
    <h2>Attestations</h2>${attestRows ? `<table class="data"><thead><tr><th>id</th><th>at</th><th>client</th><th>proxy</th><th>source</th><th>by</th><th>scope</th></tr></thead><tbody>${attestRows}</tbody></table>` : `<div class="empty">No attestations recorded.</div>`}`;
}

async function renderKv(env: Env): Promise<string> {
  const keys = await listKv(env);
  if (keys.length === 0) return `<h1>KV browser</h1><div class="empty">KV is empty.</div>`;
  const rows = keys
    .map(
      (k) =>
        `<tr><td class="kv-key">${esc(k.name)}</td><td class="mono" style="color:var(--fg-muted)">${k.expiration ? esc(new Date(Number(k.expiration) * 1000).toISOString()) : "∞"}</td><td><a href="/kv/${encodeURIComponent(k.name)}" class="mono">view</a></td></tr>`,
    )
    .join("");
  return `<h1>KV browser</h1><p class="subtitle">All keys in <code>CONFIG_KV</code>. Click to view.</p>
    <table class="data"><thead><tr><th>key</th><th>expiration</th><th></th></tr></thead><tbody>${rows}</tbody></table>`;
}

async function renderKvDetail(env: Env, key: string): Promise<string> {
  const value = await env.CONFIG_KV.get(key);
  if (value === null) return `<div class="crumbs"><a href="/kv">← KV</a></div><h1>Not found</h1>`;
  let json: unknown = null;
  try {
    json = JSON.parse(value);
  } catch {
    /* not JSON */
  }
  return `<div class="crumbs"><a href="/kv">← KV browser</a></div>
    <h1 class="mono" style="font-size:1.05rem">${esc(key)}</h1>
    <p class="subtitle">${value.length} bytes</p>
    ${json !== null ? `<div class="json-block">${jsonHtml(json)}</div>` : `<pre class="json-block" style="white-space:pre-wrap">${esc(value)}</pre>`}`;
}

/* ─── Pages: write surface ─── */

const NEW_CLIENT_TEMPLATE = `{
  "client_id": "your-client-id",
  "proxy_domain": "REPLACE_WITH_PROXY_HOST",
  "source_domain": "REPLACE_WITH_SOURCE_HOST",
  "authorization": {
    "attested_by_email": "you@example.com",
    "attested_at": "${new Date().toISOString().replace(/\.\d+/, "")}",
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
  "meta_rewrites": [],
  "indexation": [{ "match": "^/.*", "robots": "noindex,follow", "additional_directives": [] }],
  "caching": [{ "match": "^/.*", "ttl_seconds": 600, "cache_key_includes_cookies": [], "bypass_on_cookie": [] }],
  "forms": [],
  "schema_version": 1
}`;

/**
 * Renders the structured form body shared by /clients/new and /clients/:id/edit.
 *
 * Layout: three sections of structured input fields (Identity, Permission
 * attestation, Primary route) above a raw JSON textarea. The textarea is the
 * canonical submitted value — form fields are convenience for the most-edited
 * scalar values, and an inline script keeps the textarea and form fields in
 * two-way sync. Anything not covered by the form fields (canonicals, schema
 * injections, redirects, etc.) is edited directly in the JSON textarea.
 *
 * Why textarea-as-source-of-truth: keeps the server handler unchanged
 * (single `config_json` form field, same Zod validation), and lossless for
 * advanced fields the form doesn't know about.
 */
function renderStructuredFormBody(opts: {
  prefilledJson: string;
  /** When true, client_id is rendered readonly (rename via edit not supported). */
  isEdit: boolean;
}): string {
  const idAttrs = opts.isEdit ? "readonly" : 'required pattern="[a-z0-9_-]+"';
  return `
    <div class="form-section">
      <h2>Identity</h2>
      <div class="form-grid">
        <div>
          <label for="f_client_id">client_id</label>
          <input id="f_client_id" type="text" ${idAttrs}>
          <div class="field-hint">${opts.isEdit ? "cannot be changed via edit" : "lowercase letters, digits, _ or -"}</div>
        </div>
        <div>
          <label for="f_status">status</label>
          <select id="f_status">
            <option value="active">active</option>
            <option value="paused">paused</option>
            <option value="terminated">terminated</option>
          </select>
        </div>
        <div>
          <label for="f_proxy_domain">proxy_domain</label>
          <input id="f_proxy_domain" type="text" required>
          <div class="field-hint">the host the platform serves under (e.g. yoursite.com)</div>
        </div>
        <div>
          <label for="f_source_domain">source_domain</label>
          <input id="f_source_domain" type="text" required>
          <div class="field-hint">the upstream the platform fetches from</div>
        </div>
      </div>
    </div>

    <div class="form-section">
      <h2>Permission attestation</h2>
      <div class="form-grid">
        <div>
          <label for="f_attested_by_email">attested_by_email</label>
          <input id="f_attested_by_email" type="email" required>
        </div>
        <div>
          <label for="f_attested_ip">attested_ip</label>
          <input id="f_attested_ip" type="text" placeholder="0.0.0.0">
        </div>
        <div>
          <label for="f_scope">scope</label>
          <select id="f_scope">
            <option value="full_site">full_site</option>
            <option value="specified_paths">specified_paths</option>
          </select>
        </div>
        <div>
          <label for="f_scope_paths">scope_paths (CSV)</label>
          <input id="f_scope_paths" type="text" placeholder="/blog,/landing">
          <div class="field-hint">used only when scope = specified_paths</div>
        </div>
      </div>
    </div>

    <div class="form-section">
      <h2>Primary route</h2>
      <div class="form-grid">
        <div class="full-width">
          <label for="f_origin">routing[0].origin</label>
          <input id="f_origin" type="text" placeholder="https://example.com">
          <div class="field-hint">URL the proxy fetches from for the default route. For multiple routes, custom_pages, origin_auth, or strip_prefix, edit the JSON below.</div>
        </div>
      </div>
    </div>

    <div class="form-section">
      <h2>Raw <code>ClientConfig</code> JSON</h2>
      <p class="field-hint" style="margin-bottom:.6rem">Source of truth on submit. Form fields above sync into this textarea on every keystroke. Edit the JSON directly for advanced fields (canonicals, schema_injections, redirects, link_rewrites, content_injections, etc.).</p>
      <textarea id="config_json" name="config_json" spellcheck="false" autocomplete="off">${esc(opts.prefilledJson)}</textarea>
    </div>

    <script>
    (function () {
      var ta = document.getElementById('config_json');
      if (!ta) return;
      var scalarFields = {
        f_client_id: ['client_id'],
        f_proxy_domain: ['proxy_domain'],
        f_source_domain: ['source_domain'],
        f_status: ['status'],
        f_attested_by_email: ['authorization', 'attested_by_email'],
        f_attested_ip: ['authorization', 'attested_ip'],
        f_scope: ['authorization', 'scope']
      };
      function get(obj, path) {
        for (var i = 0; i < path.length; i++) {
          if (obj == null) return undefined;
          obj = obj[path[i]];
        }
        return obj;
      }
      function setPath(obj, path, val) {
        for (var i = 0; i < path.length - 1; i++) {
          var k = path[i];
          if (obj[k] == null || typeof obj[k] !== 'object') obj[k] = {};
          obj = obj[k];
        }
        obj[path[path.length - 1]] = val;
      }
      function safeParse() {
        try { return JSON.parse(ta.value); } catch (e) { return null; }
      }
      function syncFromJson() {
        var json = safeParse();
        if (!json) return;
        Object.keys(scalarFields).forEach(function (id) {
          var el = document.getElementById(id);
          if (!el) return;
          var v = get(json, scalarFields[id]);
          el.value = v == null ? '' : String(v);
        });
        var sp = get(json, ['authorization', 'scope_paths']);
        var spEl = document.getElementById('f_scope_paths');
        if (spEl) spEl.value = Array.isArray(sp) ? sp.join(', ') : '';
        var origin = get(json, ['routing', 0, 'origin']);
        var oEl = document.getElementById('f_origin');
        if (oEl) oEl.value = origin || '';
      }
      function syncToJson() {
        var json = safeParse();
        if (!json) return;
        Object.keys(scalarFields).forEach(function (id) {
          var el = document.getElementById(id);
          if (!el) return;
          if (el.value !== '') setPath(json, scalarFields[id], el.value);
        });
        var spEl = document.getElementById('f_scope_paths');
        var scopeEl = document.getElementById('f_scope');
        if (json.authorization == null || typeof json.authorization !== 'object') json.authorization = {};
        if (scopeEl && scopeEl.value === 'specified_paths' && spEl && spEl.value.trim() !== '') {
          json.authorization.scope_paths = spEl.value.split(',').map(function (s) { return s.trim(); }).filter(Boolean);
        } else {
          delete json.authorization.scope_paths;
        }
        var oEl = document.getElementById('f_origin');
        if (oEl && oEl.value !== '') {
          if (!Array.isArray(json.routing)) json.routing = [];
          if (json.routing[0] == null || typeof json.routing[0] !== 'object') {
            json.routing[0] = { match: '^/.*', type: 'proxy', origin_auth: { type: 'none' } };
          }
          json.routing[0].origin = oEl.value;
        }
        ta.value = JSON.stringify(json, null, 2);
      }
      var ids = Object.keys(scalarFields).concat(['f_scope_paths', 'f_origin']);
      ids.forEach(function (id) {
        var el = document.getElementById(id);
        if (el) el.addEventListener('input', syncToJson);
      });
      ta.addEventListener('input', syncFromJson);
      syncFromJson();
    })();
    </script>`;
}

function renderNewClientForm(prefilledJson: string, error: string | null): string {
  return `<div class="crumbs"><a href="/clients">← Clients</a></div>
    <h1>New client</h1>
    <p class="subtitle">Fill the structured fields below or edit the JSON directly. Validates against the same Zod schema the Worker uses at load time.</p>
    ${error ? `<div class="error-box">${esc(error)}</div>` : ""}
    <form class="editor" method="POST" action="/clients/new">
      ${renderStructuredFormBody({ prefilledJson, isEdit: false })}
      <div class="hint">After save: D1 INSERT, KV primed with the new config under <code>config:&lt;id&gt;</code> and <code>domain:&lt;proxy_domain&gt;</code>, audit_log entry written.</div>
      <div class="form-actions">
        <button class="btn btn-primary" type="submit">Create client</button>
        <a class="btn" href="/clients">Cancel</a>
      </div>
    </form>`;
}

function renderEditClientForm(
  client: ClientRow,
  prefilledJson: string,
  error: string | null,
): string {
  return `<div class="crumbs"><a href="/clients/${esc(client.client_id)}">← ${esc(client.client_id)}</a></div>
    <h1>Edit ${esc(client.client_id)}</h1>
    <p class="subtitle">Editing the full <code>ClientConfig</code>. <code>client_id</code> cannot change via this form.</p>
    ${error ? `<div class="error-box">${esc(error)}</div>` : ""}
    <form class="editor" method="POST" action="/clients/${esc(client.client_id)}/edit">
      ${renderStructuredFormBody({ prefilledJson, isEdit: true })}
      <div class="hint">On save: D1 UPDATE, KV invalidated for <code>config:${esc(client.client_id)}</code> and <code>domain:${esc(client.proxy_domain)}</code>, audit_log entry written.</div>
      <div class="form-actions">
        <button class="btn btn-primary" type="submit">Save</button>
        <a class="btn" href="/clients/${esc(client.client_id)}">Cancel</a>
      </div>
    </form>`;
}

function renderAttestForm(client: ClientRow, error: string | null): string {
  return `<div class="crumbs"><a href="/clients/${esc(client.client_id)}">← ${esc(client.client_id)}</a></div>
    <h1>Capture attestation — ${esc(client.client_id)}</h1>
    <p class="subtitle">Append a permission record to the <code>attestations</code> table per spec §6.8. Append-only.</p>
    ${error ? `<div class="error-box">${esc(error)}</div>` : ""}
    <form class="editor" method="POST" action="/clients/${esc(client.client_id)}/attest">
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
        <a class="btn" href="/clients/${esc(client.client_id)}">Cancel</a>
      </div>
    </form>`;
}

/* ─── Handlers ─── */

async function handleNewClientPost(
  request: Request,
  env: Env,
  url: URL,
  actor: Actor,
  clients: ClientRow[],
  flash: FlashMessage | null,
): Promise<Response> {
  const csrf = checkCsrf(request, url);
  if (csrf) return csrf;
  const form = await request.formData();
  const raw = String(form.get("config_json") ?? "");
  const validation = validateConfigJson(raw);
  const respondForm = (errorMsg: string) =>
    new Response(
      layout({
        title: "New client",
        content: renderNewClientForm(raw, errorMsg),
        activeNav: "clients:new",
        clients,
        flash,
      }),
      { status: 400, headers: htmlHeaders() },
    );
  if (!validation.ok) return respondForm(validation.error);

  const cfg = validation.config;
  const existing = await loadClient(env, cfg.client_id);
  if (existing) return respondForm(`A client with id "${cfg.client_id}" already exists.`);

  const json = JSON.stringify(cfg);
  await env.CONFIG_DB.prepare(
    `INSERT INTO clients
       (client_id, proxy_domain, source_domain, status, config_json, schema_version)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(cfg.client_id, cfg.proxy_domain, cfg.source_domain, cfg.status, json, cfg.schema_version)
    .run();
  await Promise.all([
    env.CONFIG_KV.put(`config:${cfg.client_id}`, json),
    env.CONFIG_KV.put(`domain:${cfg.proxy_domain}`, cfg.client_id),
  ]);
  await writeAudit(env, {
    client_id: cfg.client_id,
    actor_email: actor.email,
    actor_ip: actor.ip,
    event_type: "config_create",
    before_hash: null,
    after_hash: fnvHash(json),
    previous_status: null,
    new_status: cfg.status,
    notes: null,
  });
  return flashRedirect(`/clients/${cfg.client_id}`, {
    text: `Created ${cfg.client_id}.`,
    kind: "ok",
  });
}

async function handleEditClientPost(
  request: Request,
  env: Env,
  url: URL,
  clientId: string,
  actor: Actor,
  clients: ClientRow[],
  flash: FlashMessage | null,
): Promise<Response> {
  const csrf = checkCsrf(request, url);
  if (csrf) return csrf;
  const client = await loadClient(env, clientId);
  if (!client) return new Response("Not found", { status: 404 });

  const form = await request.formData();
  const raw = String(form.get("config_json") ?? "");
  const validation = validateConfigJson(raw);
  const respondForm = (errorMsg: string) =>
    new Response(
      layout({
        title: `Edit ${clientId}`,
        content: renderEditClientForm(client, raw, errorMsg),
        activeNav: `client:${clientId}`,
        clients,
        flash,
      }),
      { status: 400, headers: htmlHeaders() },
    );
  if (!validation.ok) return respondForm(validation.error);

  const cfg = validation.config;
  if (cfg.client_id !== clientId)
    return respondForm(
      `client_id in JSON ("${cfg.client_id}") doesn't match the URL ("${clientId}"). Renaming via edit is not supported.`,
    );

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
  // If proxy_domain changed, also invalidate the new domain key (will be
  // repopulated on next request).
  if (cfg.proxy_domain !== client.proxy_domain) {
    await env.CONFIG_KV.delete(`domain:${cfg.proxy_domain}`);
  }
  await writeAudit(env, {
    client_id: clientId,
    actor_email: actor.email,
    actor_ip: actor.ip,
    event_type: "config_update",
    before_hash: beforeHash,
    after_hash: afterHash,
    previous_status: client.status,
    new_status: cfg.status,
    notes: null,
  });
  return flashRedirect(`/clients/${clientId}`, {
    text: `Saved. before=${beforeHash} → after=${afterHash}`,
    kind: "ok",
  });
}

async function handleStatusPost(
  request: Request,
  env: Env,
  url: URL,
  clientId: string,
  actor: Actor,
): Promise<Response> {
  const csrf = checkCsrf(request, url);
  if (csrf) return csrf;
  const client = await loadClient(env, clientId);
  if (!client) return new Response("Not found", { status: 404 });

  const form = await request.formData();
  const target = String(form.get("status") ?? "");
  if (target !== "active" && target !== "paused" && target !== "terminated") {
    return flashRedirect(`/clients/${clientId}`, {
      text: `Invalid status target: ${target}`,
      kind: "err",
    });
  }
  if (client.status === target) {
    return flashRedirect(`/clients/${clientId}`, {
      text: `Already ${target}.`,
      kind: "warn",
    });
  }
  if (client.status === "terminated") {
    return flashRedirect(`/clients/${clientId}`, {
      text: "Terminated is a one-way door per PRD §6.3 — cannot be reversed.",
      kind: "err",
    });
  }

  // Mirror the new status into config_json.status so the cached config and
  // the row column never drift.
  let parsedCfg: Record<string, unknown>;
  try {
    parsedCfg = JSON.parse(client.config_json);
  } catch (e) {
    return flashRedirect(`/clients/${clientId}`, {
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
  await writeAudit(env, {
    client_id: clientId,
    actor_email: actor.email,
    actor_ip: actor.ip,
    event_type: target === "terminated" ? "revocation" : "status_change",
    before_hash: fnvHash(client.config_json),
    after_hash: fnvHash(newJson),
    previous_status: client.status,
    new_status: target,
    notes: null,
  });
  return flashRedirect(`/clients/${clientId}`, {
    text: `Status: ${client.status} → ${target}.`,
    kind: target === "terminated" ? "warn" : "ok",
  });
}

async function handleCachePurgePost(
  request: Request,
  env: Env,
  url: URL,
  clientId: string,
  actor: Actor,
): Promise<Response> {
  const csrf = checkCsrf(request, url);
  if (csrf) return csrf;
  const client = await loadClient(env, clientId);
  if (!client) return new Response("Not found", { status: 404 });

  await invalidateKv(env, clientId, client.proxy_domain);
  await writeAudit(env, {
    client_id: clientId,
    actor_email: actor.email,
    actor_ip: actor.ip,
    event_type: "config_update",
    before_hash: null,
    after_hash: null,
    previous_status: client.status,
    new_status: client.status,
    notes: "manual cache purge (KV invalidate)",
  });
  return flashRedirect(`/clients/${clientId}`, {
    text: `Purged config:${clientId} and domain:${client.proxy_domain} from KV.`,
    kind: "ok",
  });
}

async function handleAttestPost(
  request: Request,
  env: Env,
  url: URL,
  clientId: string,
  actor: Actor,
  clients: ClientRow[],
  flash: FlashMessage | null,
): Promise<Response> {
  const csrf = checkCsrf(request, url);
  if (csrf) return csrf;
  const client = await loadClient(env, clientId);
  if (!client) return new Response("Not found", { status: 404 });

  const form = await request.formData();
  const email = String(form.get("attested_by_email") ?? "").trim();
  const ipRaw = String(form.get("attested_ip") ?? "").trim();
  const scope = String(form.get("scope") ?? "");
  const scopePathsRaw = String(form.get("scope_paths") ?? "").trim();
  const uaRaw = String(form.get("user_agent") ?? "").trim();

  const respondForm = (errorMsg: string) =>
    new Response(
      layout({
        title: `Attest ${clientId}`,
        content: renderAttestForm(client, errorMsg),
        activeNav: `client:${clientId}`,
        clients,
        flash,
      }),
      { status: 400, headers: htmlHeaders() },
    );

  if (!email || !email.includes("@")) return respondForm("attested_by_email is required.");
  if (scope !== "full_site" && scope !== "specified_paths")
    return respondForm("scope must be full_site or specified_paths.");
  let scopePathsJson: string | null = null;
  if (scope === "specified_paths") {
    const paths = scopePathsRaw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    if (paths.length === 0)
      return respondForm("scope_paths is required when scope = specified_paths.");
    scopePathsJson = JSON.stringify(paths);
  }
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
    actor_email: actor.email,
    actor_ip: actor.ip,
    event_type: "authorization_update",
    before_hash: null,
    after_hash: null,
    previous_status: null,
    new_status: null,
    notes: `attestation by ${email} (scope=${scope})`,
  });
  return flashRedirect(`/clients/${clientId}`, {
    text: `Attestation recorded for ${email}.`,
    kind: "ok",
  });
}

function htmlHeaders(): Record<string, string> {
  return { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" };
}

/* ─── Router ─── */

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const auth = checkAuth(request, env);
    if (auth instanceof Response) return auth;
    const actor: Actor = {
      email: auth,
      ip: request.headers.get("cf-connecting-ip") ?? "0.0.0.0",
    };

    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method.toUpperCase();
    try {
      const clients = await loadAllClients(env);
      const flash = readFlash(url);
      const respond = (title: string, content: string, activeNav: string) =>
        new Response(layout({ title, content, activeNav, clients, flash }), {
          headers: htmlHeaders(),
        });

      // GET routes
      if (method === "GET") {
        if (path === "/" || path === "")
          return respond("Overview", await renderOverview(env), "home");
        if (path === "/clients") return respond("Clients", await renderClientsList(env), "clients");
        if (path === "/clients/new")
          return respond(
            "New client",
            renderNewClientForm(NEW_CLIENT_TEMPLATE, null),
            "clients:new",
          );
        if (path === "/redirects")
          return respond("Redirects", await renderRedirects(env), "redirects");
        if (path === "/audit") return respond("Audit log", await renderAudit(env), "audit");
        if (path === "/kv") return respond("KV browser", await renderKv(env), "kv");
        if (path.startsWith("/kv/")) {
          const k = decodeURIComponent(path.slice("/kv/".length));
          return respond(k, await renderKvDetail(env, k), "kv");
        }
        if (path.startsWith("/clients/")) {
          const rest = path.slice("/clients/".length);
          const slash = rest.indexOf("/");
          const id = decodeURIComponent(slash === -1 ? rest : rest.slice(0, slash));
          const sub = slash === -1 ? "" : rest.slice(slash + 1);
          if (sub === "edit") {
            const client = await loadClient(env, id);
            if (!client) return respond(id, "<h1>Not found</h1>", `client:${id}`);
            const pretty = JSON.stringify(JSON.parse(client.config_json), null, 2);
            return respond(
              `Edit ${id}`,
              renderEditClientForm(client, pretty, null),
              `client:${id}`,
            );
          }
          if (sub === "attest") {
            const client = await loadClient(env, id);
            if (!client) return respond(id, "<h1>Not found</h1>", `client:${id}`);
            return respond(`Attest ${id}`, renderAttestForm(client, null), `client:${id}`);
          }
          if (sub === "") {
            return respond(id, await renderClientDetail(env, id), `client:${id}`);
          }
        }
        return respond("Not found", "<h1>Not found</h1>", "");
      }

      // POST routes — all CSRF-checked inside the handler.
      if (method === "POST") {
        if (path === "/clients/new")
          return await handleNewClientPost(request, env, url, actor, clients, flash);
        if (path.startsWith("/clients/")) {
          const rest = path.slice("/clients/".length);
          const slash = rest.indexOf("/");
          if (slash !== -1) {
            const id = decodeURIComponent(rest.slice(0, slash));
            const sub = rest.slice(slash + 1);
            if (sub === "edit")
              return await handleEditClientPost(request, env, url, id, actor, clients, flash);
            if (sub === "status") return await handleStatusPost(request, env, url, id, actor);
            if (sub === "cache-purge")
              return await handleCachePurgePost(request, env, url, id, actor);
            if (sub === "attest")
              return await handleAttestPost(request, env, url, id, actor, clients, flash);
          }
        }
        return new Response("Not found", { status: 404 });
      }

      return new Response("Method not allowed", {
        status: 405,
        headers: { allow: "GET, POST" },
      });
    } catch (e) {
      return new Response(
        `<h1>Admin error</h1><pre>${esc((e as Error).stack ?? String(e))}</pre>`,
        {
          status: 500,
          headers: { "content-type": "text/html; charset=utf-8" },
        },
      );
    }
  },
} satisfies ExportedHandler<Env>;
