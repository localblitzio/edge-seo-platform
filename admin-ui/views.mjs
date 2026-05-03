/**
 * View renderers — server-side HTML for each page.
 * Returns plain HTML strings; no template engine, no client-side framework.
 */

const HTML_ENTITIES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (c) => HTML_ENTITIES[c] ?? c);
}

function statusPill(status) {
  const cls =
    status === "active" ? "pill-active" : status === "paused" ? "pill-paused" : "pill-terminated";
  return `<span class="pill ${cls}">${esc(status)}</span>`;
}

function layerPill(layer) {
  return `<span class="pill pill-${esc(layer)}">${esc(layer)}</span>`;
}

function jsonHtml(value) {
  if (value === null) return `<span class="json-null">null</span>`;
  if (typeof value === "boolean") return `<span class="json-boolean">${value}</span>`;
  if (typeof value === "number") return `<span class="json-number">${value}</span>`;
  if (typeof value === "string") return `<span class="json-string">"${esc(value)}"</span>`;
  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    const items = value.map((v) => `<div style="padding-left:1.5em">${jsonHtml(v)},</div>`).join("");
    return `[<div>${items}</div>]`;
  }
  if (typeof value === "object") {
    const keys = Object.keys(value);
    if (keys.length === 0) return "{}";
    const items = keys
      .map(
        (k) =>
          `<div style="padding-left:1.5em"><span class="json-key">"${esc(k)}"</span>: ${jsonHtml(
            value[k],
          )},</div>`,
      )
      .join("");
    return `{<div>${items}</div>}`;
  }
  return esc(String(value));
}

export function layout({ title, content, activeNav, clients = [], stale = false }) {
  const navLinks = [
    { href: "/", id: "home", label: "Overview" },
    { href: "/clients", id: "clients", label: "Clients" },
    { href: "/redirects", id: "redirects", label: "Redirect rules" },
    { href: "/audit", id: "audit", label: "Audit log" },
    { href: "/kv", id: "kv", label: "KV browser" },
  ]
    .map(
      (l) =>
        `<a href="${l.href}" class="${activeNav === l.id ? "active" : ""}">${esc(l.label)}</a>`,
    )
    .join("");
  const clientList = clients
    .map(
      (c) =>
        `<a href="/clients/${esc(c.client_id)}" class="${
          activeNav === `client:${c.client_id}` ? "active" : ""
        }" style="padding-left:1.25rem;font-size:0.85rem;">${esc(c.client_id)}</a>`,
    )
    .join("");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>${esc(title)} — Edge SEO Inspector</title>
  <link rel="stylesheet" href="/static/style.css">
</head>
<body>
  <header class="topbar">
    <div class="brand">
      <span class="logo"></span>
      <strong>Edge SEO Platform</strong>
      <span class="env">local inspector</span>
    </div>
    <div class="actions">
      <span class="meta">read-only · Phase 1 dev tool</span>
      <button onclick="location.reload()" class="btn">Refresh</button>
    </div>
  </header>
  <div class="layout">
    <nav class="sidebar">
      ${navLinks}
      ${
        clients.length > 0
          ? `<div class="sidebar-section">Configured clients</div>${clientList}`
          : ""
      }
      <div class="sidebar-foot">
        <strong>Phase 1 read-only.</strong>
        Phase 2 admin UI (PRD §7.12) replaces this with a full editor + workflow.
      </div>
    </nav>
    <main class="main">
      ${stale ? `<div class="banner">Local store is empty — run <code>npm run demo:seed</code> to populate it.</div>` : ""}
      ${content}
    </main>
  </div>
</body>
</html>`;
}

/* ─── Pages ───────────────────────────────────────────────────────── */

export function overviewView({ d1, kv }) {
  const clients = d1.clients ?? [];
  let totalRoutes = 0;
  let totalStatic = 0;
  let totalPattern = 0;
  let totalConditional = 0;
  for (const c of clients) {
    try {
      const cfg = JSON.parse(String(c.config_json));
      totalRoutes += cfg.routing?.length ?? 0;
      totalStatic += cfg.redirects?.static?.length ?? 0;
      totalPattern += cfg.redirects?.patterns?.length ?? 0;
      totalConditional += cfg.redirects?.conditional?.length ?? 0;
    } catch {
      /* parse errors surfaced on the client detail page */
    }
  }
  const stat = (label, value) =>
    `<div class="stat"><div class="label">${esc(label)}</div><div class="value">${esc(
      String(value),
    )}</div></div>`;
  const clientRows = clients
    .map((c) => {
      let routes = 0;
      let redirects = 0;
      try {
        const cfg = JSON.parse(String(c.config_json));
        routes = cfg.routing?.length ?? 0;
        redirects =
          (cfg.redirects?.static?.length ?? 0) +
          (cfg.redirects?.patterns?.length ?? 0) +
          (cfg.redirects?.conditional?.length ?? 0);
      } catch {
        /* leave at 0 */
      }
      return `<tr>
        <td><a href="/clients/${esc(c.client_id)}" class="mono">${esc(c.client_id)}</a></td>
        <td class="mono">${esc(c.proxy_domain)}</td>
        <td class="mono">${esc(c.source_domain)}</td>
        <td>${statusPill(c.status)}</td>
        <td>${routes}</td>
        <td>${redirects}</td>
        <td class="mono" style="color:var(--fg-muted)">${esc(c.updated_at ?? c.created_at ?? "")}</td>
      </tr>`;
    })
    .join("");
  const kvCount = kv.length;
  return `
    <h1>Overview</h1>
    <p class="subtitle">Local Miniflare state for the Edge SEO Worker.</p>
    <div class="stats">
      ${stat("Clients", clients.length)}
      ${stat("Routes", totalRoutes)}
      ${stat("Static redirects", totalStatic)}
      ${stat("Pattern redirects", totalPattern)}
      ${stat("Conditional redirects", totalConditional)}
      ${stat("KV entries", kvCount)}
    </div>
    ${
      clients.length === 0
        ? `<div class="empty">No clients configured yet.</div>`
        : `
    <h2>Clients</h2>
    <table class="data">
      <thead><tr><th>client_id</th><th>proxy_domain</th><th>source_domain</th><th>status</th><th>routes</th><th>redirects</th><th>updated</th></tr></thead>
      <tbody>${clientRows}</tbody>
    </table>`
    }
  `;
}

export function clientsView({ d1 }) {
  const rows = (d1.clients ?? [])
    .map(
      (c) =>
        `<tr>
          <td><a href="/clients/${esc(c.client_id)}" class="mono">${esc(c.client_id)}</a></td>
          <td class="mono">${esc(c.proxy_domain)}</td>
          <td class="mono">${esc(c.source_domain)}</td>
          <td>${statusPill(c.status)}</td>
          <td>v${esc(c.schema_version)}</td>
          <td class="mono" style="color:var(--fg-muted)">${esc(c.created_at ?? "")}</td>
        </tr>`,
    )
    .join("");
  return `
    <h1>Clients</h1>
    <p class="subtitle">All rows from the <code>clients</code> table in <code>CONFIG_DB</code>.</p>
    ${
      rows
        ? `<table class="data">
          <thead><tr><th>client_id</th><th>proxy_domain</th><th>source_domain</th><th>status</th><th>schema</th><th>created</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>`
        : `<div class="empty">No clients configured yet.</div>`
    }
  `;
}

function section(label, count, body) {
  return `<details class="section"${count > 0 ? " open" : ""}>
    <summary>${esc(label)} <span class="count">${count}</span></summary>
    <div class="body">${body}</div>
  </details>`;
}

function rulesTable(headers, rows) {
  if (rows.length === 0) return `<div class="empty">none configured</div>`;
  return `<table class="data">
    <thead><tr>${headers.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead>
    <tbody>${rows.join("")}</tbody>
  </table>`;
}

export function clientDetailView({ client }) {
  if (!client) {
    return `<div class="crumbs"><a href="/clients">← Clients</a></div>
      <h1>Not found</h1>
      <div class="empty">No client with that id.</div>`;
  }
  const cfg = client.parsed_config ?? {};
  const auth = cfg.authorization ?? {};

  const routesRows = (cfg.routing ?? []).map(
    (r, i) =>
      `<tr>
        <td class="mono">${i}</td>
        <td class="mono">${esc(r.match)}</td>
        <td><span class="pill pill-neutral">${esc(r.type)}</span></td>
        <td class="mono">${esc(r.origin ?? "")}</td>
        <td class="mono">${esc(r.origin_auth?.type ?? "none")}</td>
        <td class="mono">${esc(r.strip_prefix ?? "")}</td>
        <td class="mono">${esc(r.custom_page_key ?? "")}</td>
      </tr>`,
  );
  const staticRows = (cfg.redirects?.static ?? []).map(
    (r, i) =>
      `<tr>
        <td class="mono">${i}</td>
        <td class="mono">${esc(r.from)}</td>
        <td class="mono">${esc(r.to)}</td>
        <td class="mono">${esc(r.status)}</td>
        <td>${r.preserve_query ? "✓" : "—"}</td>
      </tr>`,
  );
  const patternRows = (cfg.redirects?.patterns ?? []).map(
    (r, i) =>
      `<tr>
        <td class="mono">${i}</td>
        <td class="mono">${esc(r.pattern)}</td>
        <td class="mono">${esc(r.replacement)}</td>
        <td class="mono">${esc(r.status)}</td>
      </tr>`,
  );
  const conditionalRows = (cfg.redirects?.conditional ?? []).map(
    (r, i) =>
      `<tr>
        <td class="mono">${i}</td>
        <td class="mono">${esc(r.match)}</td>
        <td class="mono" style="font-size:0.8rem">${esc(JSON.stringify(r.conditions))}</td>
        <td class="mono">${esc(r.to)}</td>
        <td class="mono">${esc(r.status)}</td>
      </tr>`,
  );
  const canonicalRows = (cfg.canonicals ?? []).map(
    (r, i) =>
      `<tr>
        <td class="mono">${i}</td>
        <td class="mono">${esc(r.match)}</td>
        <td class="mono">${esc(r.strategy?.type)}</td>
        <td class="mono">${esc(r.strategy?.url ?? "")}</td>
      </tr>`,
  );
  const schemaRows = (cfg.schema_injections ?? []).map(
    (r, i) =>
      `<tr>
        <td class="mono">${i}</td>
        <td class="mono">${esc(r.match)}</td>
        <td class="mono">${esc(r.schema_type)}</td>
        <td class="mono">${esc(r.position)}</td>
      </tr>`,
  );
  const indexRows = (cfg.indexation ?? []).map(
    (r, i) =>
      `<tr>
        <td class="mono">${i}</td>
        <td class="mono">${esc(r.match)}</td>
        <td class="mono">${esc(r.robots)}</td>
        <td class="mono">${esc((r.additional_directives ?? []).join(", "))}</td>
      </tr>`,
  );
  const cacheRows = (cfg.caching ?? []).map(
    (r, i) =>
      `<tr>
        <td class="mono">${i}</td>
        <td class="mono">${esc(r.match)}</td>
        <td class="mono">${esc(r.ttl_seconds)}</td>
        <td class="mono">${esc((r.cache_key_includes_cookies ?? []).join(", "))}</td>
        <td class="mono">${esc((r.bypass_on_cookie ?? []).join(", "))}</td>
      </tr>`,
  );
  const formRows = (cfg.forms ?? []).map(
    (r, i) =>
      `<tr>
        <td class="mono">${i}</td>
        <td class="mono">${esc(r.match_action)}</td>
        <td class="mono">${esc(r.forward_to)}</td>
        <td>${r.capture_to_d1 ? "✓" : "—"}</td>
      </tr>`,
  );

  return `
    <div class="crumbs"><a href="/clients">← Clients</a></div>
    <h1>${esc(client.client_id)} ${statusPill(client.status)}</h1>
    <p class="subtitle">
      <span class="mono">${esc(client.proxy_domain)}</span>
      &nbsp;→&nbsp;
      <span class="mono">${esc(client.source_domain)}</span>
    </p>

    ${
      client.parse_error
        ? `<div class="banner"><strong>Config JSON parse error:</strong> ${esc(
            client.parse_error,
          )}</div>`
        : ""
    }

    <div class="card">
      <h2 style="margin-top:0">Authorization</h2>
      <dl class="kv">
        <dt>Attested by</dt><dd>${esc(auth.attested_by_email ?? "")}</dd>
        <dt>Attested at</dt><dd>${esc(auth.attested_at ?? "")}</dd>
        <dt>Attested IP</dt><dd>${esc(auth.attested_ip ?? "")}</dd>
        <dt>Scope</dt><dd>${esc(auth.scope ?? "")} ${
          auth.scope_paths ? `(${esc((auth.scope_paths ?? []).join(", "))})` : ""
        }</dd>
        <dt>Expires at</dt><dd>${
          auth.expires_at === null ? "—" : esc(auth.expires_at ?? "")
        }</dd>
        <dt>Schema version</dt><dd>${esc(client.schema_version)}</dd>
      </dl>
    </div>

    ${section(
      "Routing",
      routesRows.length,
      rulesTable(
        ["#", "match", "type", "origin", "auth", "strip_prefix", "custom_page_key"],
        routesRows,
      ),
    )}
    ${section(
      "Static redirects",
      staticRows.length,
      rulesTable(["#", "from", "to", "status", "preserve_query"], staticRows),
    )}
    ${section(
      "Pattern redirects",
      patternRows.length,
      rulesTable(["#", "pattern", "replacement", "status"], patternRows),
    )}
    ${section(
      "Conditional redirects",
      conditionalRows.length,
      rulesTable(["#", "match", "conditions", "to", "status"], conditionalRows),
    )}
    ${section(
      "Canonicals",
      canonicalRows.length,
      rulesTable(["#", "match", "strategy", "url"], canonicalRows),
    )}
    ${section(
      "Schema injections",
      schemaRows.length,
      rulesTable(["#", "match", "schema_type", "position"], schemaRows),
    )}
    ${section(
      "Indexation",
      indexRows.length,
      rulesTable(["#", "match", "robots", "additional"], indexRows),
    )}
    ${section(
      "Caching",
      cacheRows.length,
      rulesTable(
        ["#", "match", "ttl_seconds", "cache_key_includes_cookies", "bypass_on_cookie"],
        cacheRows,
      ),
    )}
    ${section(
      "Forms",
      formRows.length,
      rulesTable(["#", "match_action", "forward_to", "capture_to_d1"], formRows),
    )}

    <details class="section">
      <summary>Raw ClientConfig <span class="count">json</span></summary>
      <div class="body">
        <div class="json-block">${jsonHtml(cfg)}</div>
      </div>
    </details>
  `;
}

export function redirectsView({ d1 }) {
  const all = [];
  for (const c of d1.clients ?? []) {
    let cfg = null;
    try {
      cfg = JSON.parse(String(c.config_json));
    } catch {
      continue;
    }
    for (const [i, r] of (cfg.redirects?.static ?? []).entries()) {
      all.push({ client_id: c.client_id, layer: "static", index: i, from: r.from, to: r.to, status: r.status });
    }
    for (const [i, r] of (cfg.redirects?.patterns ?? []).entries()) {
      all.push({
        client_id: c.client_id,
        layer: "pattern",
        index: i,
        from: r.pattern,
        to: r.replacement,
        status: r.status,
      });
    }
    for (const [i, r] of (cfg.redirects?.conditional ?? []).entries()) {
      all.push({
        client_id: c.client_id,
        layer: "conditional",
        index: i,
        from: r.match,
        to: r.to,
        status: r.status,
      });
    }
  }
  if (all.length === 0) {
    return `<h1>Redirect rules</h1><div class="empty">No redirects configured across any client.</div>`;
  }
  const rows = all
    .map(
      (r) => `<tr>
        <td><a href="/clients/${esc(r.client_id)}" class="mono">${esc(r.client_id)}</a></td>
        <td>${layerPill(r.layer)}</td>
        <td class="mono">${esc(r.index)}</td>
        <td class="mono">${esc(r.from)}</td>
        <td class="mono">${esc(r.to)}</td>
        <td class="mono">${esc(r.status)}</td>
      </tr>`,
    )
    .join("");
  return `
    <h1>Redirect rules</h1>
    <p class="subtitle">All redirects across all clients, in spec §6.2 evaluation order (static → pattern → conditional).</p>
    <table class="data">
      <thead><tr><th>client</th><th>layer</th><th>idx</th><th>from / pattern</th><th>to / replacement</th><th>status</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

export function auditView({ d1 }) {
  const auditRows = (d1.audit_log ?? [])
    .map(
      (a) => `<tr>
        <td class="mono">${esc(a.id)}</td>
        <td class="mono" style="color:var(--fg-muted)">${esc(a.occurred_at)}</td>
        <td><a href="/clients/${esc(a.client_id)}" class="mono">${esc(a.client_id)}</a></td>
        <td><span class="pill pill-neutral">${esc(a.event_type)}</span></td>
        <td class="mono">${esc(a.actor_email)}</td>
        <td class="mono">${esc(a.actor_ip)}</td>
        <td class="mono">${esc(a.previous_status ?? "")} → ${esc(a.new_status ?? "")}</td>
      </tr>`,
    )
    .join("");
  const attestRows = (d1.attestations ?? [])
    .map(
      (a) => `<tr>
        <td class="mono">${esc(a.id)}</td>
        <td class="mono" style="color:var(--fg-muted)">${esc(a.attested_at)}</td>
        <td><a href="/clients/${esc(a.client_id)}" class="mono">${esc(a.client_id)}</a></td>
        <td class="mono">${esc(a.proxy_domain)}</td>
        <td class="mono">${esc(a.source_domain)}</td>
        <td class="mono">${esc(a.attested_by_email)}</td>
        <td class="mono">${esc(a.attested_ip)}</td>
        <td class="mono">${esc(a.scope)}</td>
      </tr>`,
    )
    .join("");
  return `
    <h1>Audit log</h1>
    <p class="subtitle">Append-only records of config writes, status changes, and attestations.</p>

    <h2>Audit events</h2>
    ${
      auditRows
        ? `<table class="data">
            <thead><tr><th>id</th><th>occurred_at</th><th>client</th><th>event</th><th>actor</th><th>ip</th><th>status delta</th></tr></thead>
            <tbody>${auditRows}</tbody>
          </table>`
        : `<div class="empty">No audit events recorded yet.</div>`
    }

    <h2>Attestations</h2>
    ${
      attestRows
        ? `<table class="data">
            <thead><tr><th>id</th><th>attested_at</th><th>client</th><th>proxy_domain</th><th>source_domain</th><th>attested_by</th><th>ip</th><th>scope</th></tr></thead>
            <tbody>${attestRows}</tbody>
          </table>`
        : `<div class="empty">No attestations recorded yet.</div>`
    }
  `;
}

export function kvView({ kv, value }) {
  const rows = kv
    .map((e) => {
      const v = (value && value[e.key]) ?? "";
      const preview = v.length > 200 ? `${v.slice(0, 200)}…` : v;
      const ttl =
        e.expiration === null || e.expiration === undefined
          ? "∞"
          : new Date(Number(e.expiration)).toISOString();
      return `<tr>
        <td class="kv-key">${esc(e.key)}</td>
        <td class="mono" style="color:var(--fg-muted)">${esc(ttl)}</td>
        <td class="kv-preview"><a href="/kv/${encodeURIComponent(e.key)}" class="mono">${esc(
          preview,
        )}</a></td>
      </tr>`;
    })
    .join("");
  return `
    <h1>KV browser</h1>
    <p class="subtitle">All keys in <code>CONFIG_KV</code>. Click a row to view the full value.</p>
    ${
      rows
        ? `<table class="data">
            <thead><tr><th>key</th><th>expiration</th><th>preview</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>`
        : `<div class="empty">KV is empty.</div>`
    }
  `;
}

export function kvDetailView({ key, value }) {
  if (value === null) {
    return `<div class="crumbs"><a href="/kv">← KV browser</a></div>
      <h1>Not found</h1>
      <div class="empty">No KV entry under <code>${esc(key)}</code>.</div>`;
  }
  let json;
  try {
    json = JSON.parse(value);
  } catch {
    json = null;
  }
  return `
    <div class="crumbs"><a href="/kv">← KV browser</a></div>
    <h1 class="mono" style="font-size:1.05rem">${esc(key)}</h1>
    <p class="subtitle">${esc(value.length)} bytes</p>
    ${
      json !== null
        ? `<div class="json-block">${jsonHtml(json)}</div>`
        : `<pre class="json-block" style="white-space:pre-wrap">${esc(value)}</pre>`
    }
  `;
}
