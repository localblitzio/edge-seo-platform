/**
 * Edge SEO Admin — hosted dashboard for browsing the platform's
 * live state (clients, configs, KV entries, attestations, audit log).
 *
 * Read-only MVP. Edit capability is the next iteration; for now the
 * source of truth remains git + the seed-client CLI script.
 *
 * Auth: HTTP Basic against `ADMIN_USERNAME` / `ADMIN_PASSWORD` Worker
 * secrets. Set via:
 *   npx wrangler secret put ADMIN_USERNAME --config=admin-worker/wrangler.toml
 *   npx wrangler secret put ADMIN_PASSWORD --config=admin-worker/wrangler.toml
 *
 * For production, wrap this Worker behind Cloudflare Access for SSO.
 */

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
.btn{font:inherit;border:1px solid var(--border-strong);background:var(--bg-elevated);color:var(--fg);padding:.35rem .85rem;border-radius:var(--radius);cursor:pointer}.btn:hover{border-color:var(--accent);color:var(--accent)}
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
`;

function layout(opts: {
  title: string;
  content: string;
  activeNav: string;
  clients: ClientRow[];
}): string {
  const navLinks = [
    { href: "/", id: "home", label: "Overview" },
    { href: "/clients", id: "clients", label: "Clients" },
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
  }<div class="sidebar-foot">Phase-2 admin UI (read-only).<br>Edit configs via <code>npm run seed-client</code> for now.</div></nav><main class="main">${opts.content}</main></div></body></html>`;
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

async function listKv(env: Env): Promise<{ name: string; expiration?: number }[]> {
  const list = await env.CONFIG_KV.list();
  return list.keys.map((k) => ({ name: k.name, expiration: k.expiration ?? undefined }));
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

function checkAuth(request: Request, env: Env): Response | null {
  const username = env.ADMIN_USERNAME;
  const password = env.ADMIN_PASSWORD;
  if (!username || !password) {
    // Auth not configured — refuse all access. Setting both secrets is a
    // deployment requirement.
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
          return null;
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

/* ─── Pages ─── */

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
        ? `<div class="empty">No clients configured yet.</div>`
        : `<h2>Clients</h2><table class="data"><thead><tr><th>client_id</th><th>proxy</th><th>source</th><th>status</th><th>updated</th></tr></thead><tbody>${rows}</tbody></table>`
    }`;
}

async function renderClientsList(env: Env): Promise<string> {
  const clients = await loadAllClients(env);
  if (clients.length === 0)
    return `<h1>Clients</h1><div class="empty">No clients configured.</div>`;
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
  return `<h1>Clients</h1><p class="subtitle">All rows from the <code>clients</code> table in <code>CONFIG_DB</code>.</p>
    <table class="data"><thead><tr><th>client_id</th><th>proxy</th><th>source</th><th>status</th><th>schema</th><th>created</th></tr></thead><tbody>${rows}</tbody></table>`;
}

function rulesTable(headers: string[], rows: string[]): string {
  if (rows.length === 0) return `<div class="empty">none configured</div>`;
  return `<table class="data"><thead><tr>${headers.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>${rows.join("")}</tbody></table>`;
}

function section(label: string, count: number, body: string): string {
  return `<details class="section"${count > 0 ? " open" : ""}><summary>${esc(label)} <span class="count">${count}</span></summary><div class="body">${body}</div></details>`;
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
        `<tr><td>${esc(a.id)}</td><td class="mono" style="color:var(--fg-muted)">${esc(a.occurred_at)}</td><td><a href="/clients/${esc(a.client_id)}" class="mono">${esc(a.client_id)}</a></td><td><span class="pill pill-neutral">${esc(a.event_type)}</span></td><td class="mono">${esc(a.actor_email)}</td></tr>`,
    )
    .join("");
  const attestRows = attest
    .map(
      (a) =>
        `<tr><td>${esc(a.id)}</td><td class="mono" style="color:var(--fg-muted)">${esc(a.attested_at)}</td><td><a href="/clients/${esc(a.client_id)}" class="mono">${esc(a.client_id)}</a></td><td class="mono">${esc(a.proxy_domain)}</td><td class="mono">${esc(a.source_domain)}</td><td class="mono">${esc(a.attested_by_email)}</td><td class="mono">${esc(a.scope)}</td></tr>`,
    )
    .join("");
  return `<h1>Audit log</h1><p class="subtitle">Append-only records of config changes and attestations.</p>
    <h2>Audit events</h2>${auditRows ? `<table class="data"><thead><tr><th>id</th><th>at</th><th>client</th><th>event</th><th>actor</th></tr></thead><tbody>${auditRows}</tbody></table>` : `<div class="empty">No audit events recorded.</div>`}
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

/* ─── Router ─── */

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const authResp = checkAuth(request, env);
    if (authResp) return authResp;

    const url = new URL(request.url);
    const path = url.pathname;
    try {
      const clients = await loadAllClients(env);
      const respond = (title: string, content: string, activeNav: string) =>
        new Response(layout({ title, content, activeNav, clients }), {
          headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
        });

      if (path === "/" || path === "")
        return respond("Overview", await renderOverview(env), "home");
      if (path === "/clients") return respond("Clients", await renderClientsList(env), "clients");
      if (path.startsWith("/clients/")) {
        const id = decodeURIComponent(path.slice("/clients/".length));
        return respond(id, await renderClientDetail(env, id), `client:${id}`);
      }
      if (path === "/redirects")
        return respond("Redirects", await renderRedirects(env), "redirects");
      if (path === "/audit") return respond("Audit log", await renderAudit(env), "audit");
      if (path === "/kv") return respond("KV browser", await renderKv(env), "kv");
      if (path.startsWith("/kv/")) {
        const k = decodeURIComponent(path.slice("/kv/".length));
        return respond(k, await renderKvDetail(env, k), "kv");
      }
      return respond("Not found", "<h1>Not found</h1>", "");
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
