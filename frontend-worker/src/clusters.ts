/**
 * Clusters — Slice A.
 *
 * A cluster is a labeled grouping of 1–25 proxied sites that share a
 * theme — either a topic (`type='topical'`, e.g. "Plumbing") or a
 * geographic identity (`type='geo'`, e.g. "San Diego, CA"). Sites can
 * belong to multiple clusters, including multiple of the same type.
 *
 * Slice A (this file) covers data + CRUD only — clusters don't yet
 * affect runtime behavior. Future slices will wire clusters into
 * link-project bulk-apply, schema injection, cross-linking, etc.
 *
 * Multi-tenancy mirrors clients + link_projects: rows scoped by
 * owner_id; super-admin sees all. Member sites must come from the
 * operator's visible client_id set.
 *
 * Terminology: the existing `clients` table holds proxied sites. In
 * the cluster UI we call them "sites" because "client" implies a
 * customer relationship and a cluster is about content/geo
 * relatedness, not who's paying. The internal FK column is still
 * `client_id` for consistency with the rest of the schema.
 */
import type { AppEnv, ClientRow, FlashMessage } from "./app.js";
import { canSeeAllClients, esc, loadVisibleClients } from "./app.js";
import type { User } from "./auth.js";

export type ClusterType = "topical" | "geo";
export const CLUSTER_TYPES: readonly ClusterType[] = ["topical", "geo"];

export type ClusterStatus = "active" | "archived";
export const CLUSTER_STATUSES: readonly ClusterStatus[] = ["active", "archived"];

export const MIN_CLUSTER_MEMBERS = 1;
export const MAX_CLUSTER_MEMBERS = 25;
const MAX_LABEL_LENGTH = 200;
const MAX_DESCRIPTION_LENGTH = 4000;
const CLIENT_ID_PATTERN = /^[a-z0-9-]+$/;

/** Row shape mirroring the `clusters` table. */
export interface ClusterRow {
  id: number;
  owner_id: number;
  type: ClusterType;
  label: string;
  description: string | null;
  status: ClusterStatus;
  /** Slice C: when 1, every member site gets a "Related sites" footer
   *  block linking to the other members. Stored as INTEGER in SQLite
   *  (0 / 1) — the worker converts to boolean at synthesis time. */
  cross_link_enabled: number;
  created_at: string;
  updated_at: string;
}

/** Row shape mirroring the `cluster_members` table. */
export interface ClusterMemberRow {
  cluster_id: number;
  /** Internal FK column. UI calls this a "site". */
  client_id: string;
  notes: string | null;
  added_at: string;
}

export interface ClusterInput {
  type: ClusterType;
  label: string;
  description: string | null;
  status: ClusterStatus;
  cross_link_enabled: number;
}

/**
 * Validate raw form input for a cluster create/edit. Member-list
 * validation is separate (validateMemberList) since member changes
 * also flow through dedicated add/remove handlers.
 */
export function validateClusterInput(
  raw: Record<string, string>,
): { ok: true; value: ClusterInput } | { ok: false; errors: string[] } {
  const errors: string[] = [];

  const typeRaw = (raw.type ?? "").trim();
  let type: ClusterType = "topical";
  if (typeRaw.length === 0) {
    errors.push("type is required");
  } else if (!(CLUSTER_TYPES as readonly string[]).includes(typeRaw)) {
    errors.push(`type must be one of: ${CLUSTER_TYPES.join(", ")}`);
  } else {
    type = typeRaw as ClusterType;
  }

  const label = (raw.label ?? "").trim();
  if (label.length === 0) {
    errors.push(
      type === "geo"
        ? 'label is required (e.g. "San Diego, CA")'
        : 'label is required (e.g. "Plumbing")',
    );
  } else if (label.length > MAX_LABEL_LENGTH) {
    errors.push(`label must be ${MAX_LABEL_LENGTH} characters or fewer`);
  }

  const descRaw = (raw.description ?? "").trim();
  let description: string | null = null;
  if (descRaw.length > MAX_DESCRIPTION_LENGTH) {
    errors.push(`description must be ${MAX_DESCRIPTION_LENGTH} characters or fewer`);
  } else if (descRaw.length > 0) {
    description = descRaw;
  }

  const statusRaw = (raw.status ?? "active").trim();
  let status: ClusterStatus = "active";
  if (!(CLUSTER_STATUSES as readonly string[]).includes(statusRaw)) {
    errors.push(`status must be one of: ${CLUSTER_STATUSES.join(", ")}`);
  } else {
    status = statusRaw as ClusterStatus;
  }

  // Checkbox parses as "1" when checked, absent (undefined) when unchecked.
  // Treat any non-"0" truthy string as enabled to be forgiving with manual
  // form submissions.
  const crossLinkRaw = raw.cross_link_enabled ?? "";
  const cross_link_enabled = crossLinkRaw === "1" || crossLinkRaw === "on" ? 1 : 0;

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: { type, label, description, status, cross_link_enabled },
  };
}

/**
 * Validate a list of site_ids (from form `client_ids[]`) against the
 * operator's visible site set + the 1–25 cap.
 *
 * Returns the deduped, filtered, ordered list of valid site IDs on
 * success.
 */
export function validateMemberList(
  rawIds: readonly string[],
  validClientIds: ReadonlySet<string>,
): { ok: true; value: string[] } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const dedup = new Set<string>();
  for (const id of rawIds) {
    const trimmed = id.trim();
    if (trimmed.length === 0) continue;
    if (!CLIENT_ID_PATTERN.test(trimmed)) continue;
    if (!validClientIds.has(trimmed)) continue;
    dedup.add(trimmed);
  }
  const ids = Array.from(dedup);
  if (ids.length < MIN_CLUSTER_MEMBERS) {
    errors.push(`Pick at least ${MIN_CLUSTER_MEMBERS} site to belong to this cluster`);
  } else if (ids.length > MAX_CLUSTER_MEMBERS) {
    errors.push(
      `Cluster has ${ids.length} sites — cap is ${MAX_CLUSTER_MEMBERS}. Drop some, or split into multiple clusters.`,
    );
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: ids };
}

/* ─── DB helpers ─── */

export async function loadVisibleClusters(env: AppEnv, user: User): Promise<ClusterRow[]> {
  if (canSeeAllClients(user)) {
    const r = await env.CONFIG_DB.prepare(
      "SELECT * FROM clusters ORDER BY id DESC",
    ).all<ClusterRow>();
    return r.results ?? [];
  }
  const r = await env.CONFIG_DB.prepare(
    "SELECT * FROM clusters WHERE owner_id = ? ORDER BY id DESC",
  )
    .bind(user.id)
    .all<ClusterRow>();
  return r.results ?? [];
}

export async function loadVisibleCluster(
  env: AppEnv,
  user: User,
  id: number,
): Promise<ClusterRow | null> {
  if (canSeeAllClients(user)) {
    return env.CONFIG_DB.prepare("SELECT * FROM clusters WHERE id = ? LIMIT 1")
      .bind(id)
      .first<ClusterRow>();
  }
  return env.CONFIG_DB.prepare("SELECT * FROM clusters WHERE id = ? AND owner_id = ? LIMIT 1")
    .bind(id, user.id)
    .first<ClusterRow>();
}

export async function loadClusterMembers(
  env: AppEnv,
  clusterId: number,
): Promise<ClusterMemberRow[]> {
  const r = await env.CONFIG_DB.prepare(
    "SELECT * FROM cluster_members WHERE cluster_id = ? ORDER BY client_id",
  )
    .bind(clusterId)
    .all<ClusterMemberRow>();
  return r.results ?? [];
}

/** Aggregate member-count per cluster — used by the list page for a "size" column. */
export async function loadClusterMemberCounts(
  env: AppEnv,
  clusterIds: readonly number[],
): Promise<Map<number, number>> {
  const out = new Map<number, number>();
  if (clusterIds.length === 0) return out;
  // Build a `?,?,?` placeholder list and bind in order.
  const placeholders = clusterIds.map(() => "?").join(",");
  const r = await env.CONFIG_DB.prepare(
    `SELECT cluster_id, COUNT(*) as n FROM cluster_members
     WHERE cluster_id IN (${placeholders})
     GROUP BY cluster_id`,
  )
    .bind(...clusterIds)
    .all<{ cluster_id: number; n: number }>();
  for (const row of r.results ?? []) out.set(row.cluster_id, row.n);
  return out;
}

/**
 * Load the full set of (cluster_id → client_id[]) members for a list
 * of clusters in one query. Used by the link-project bulk-apply
 * "Pre-fill from cluster" picker so the JS can additively check the
 * member sites without a server round-trip per cluster pick.
 *
 * Returned map is dense — every cluster_id in the input gets an
 * entry, defaulting to [] when the cluster has no members.
 */
export async function loadAllClusterMembersByCluster(
  env: AppEnv,
  clusterIds: readonly number[],
): Promise<Map<number, string[]>> {
  const out = new Map<number, string[]>();
  for (const id of clusterIds) out.set(id, []);
  if (clusterIds.length === 0) return out;
  const placeholders = clusterIds.map(() => "?").join(",");
  const r = await env.CONFIG_DB.prepare(
    `SELECT cluster_id, client_id FROM cluster_members
     WHERE cluster_id IN (${placeholders})
     ORDER BY cluster_id, client_id`,
  )
    .bind(...clusterIds)
    .all<{ cluster_id: number; client_id: string }>();
  for (const row of r.results ?? []) {
    const list = out.get(row.cluster_id);
    if (list) list.push(row.client_id);
  }
  return out;
}

async function insertCluster(env: AppEnv, ownerId: number, input: ClusterInput): Promise<number> {
  const result = await env.CONFIG_DB.prepare(
    `INSERT INTO clusters (owner_id, type, label, description, status, cross_link_enabled)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      ownerId,
      input.type,
      input.label,
      input.description,
      input.status,
      input.cross_link_enabled,
    )
    .run();
  const meta = (result as unknown as { meta?: { last_row_id?: number } }).meta;
  if (meta?.last_row_id != null) return meta.last_row_id;
  const row = await env.CONFIG_DB.prepare(
    "SELECT id FROM clusters WHERE owner_id = ? ORDER BY id DESC LIMIT 1",
  )
    .bind(ownerId)
    .first<{ id: number }>();
  return row?.id ?? 0;
}

async function updateClusterRow(env: AppEnv, id: number, input: ClusterInput): Promise<void> {
  await env.CONFIG_DB.prepare(
    `UPDATE clusters
       SET type = ?, label = ?, description = ?, status = ?, cross_link_enabled = ?,
           updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
  )
    .bind(input.type, input.label, input.description, input.status, input.cross_link_enabled, id)
    .run();
}

async function setClusterStatusRow(env: AppEnv, id: number, status: ClusterStatus): Promise<void> {
  await env.CONFIG_DB.prepare(
    "UPDATE clusters SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
  )
    .bind(status, id)
    .run();
}

/**
 * Replace the entire member list for a cluster with the supplied IDs.
 * Atomic-ish: we do a DELETE + INSERTs in sequence. D1 doesn't expose
 * BEGIN/COMMIT to user code, but the worst case (partial) is recoverable
 * by re-saving — better than the alternative of write-amplifying diff
 * logic to add/remove just the changes.
 */
async function replaceClusterMembers(
  env: AppEnv,
  clusterId: number,
  clientIds: readonly string[],
): Promise<void> {
  await env.CONFIG_DB.prepare("DELETE FROM cluster_members WHERE cluster_id = ?")
    .bind(clusterId)
    .run();
  for (const cid of clientIds) {
    await env.CONFIG_DB.prepare("INSERT INTO cluster_members (cluster_id, client_id) VALUES (?, ?)")
      .bind(clusterId, cid)
      .run();
  }
}

/* ─── CSRF + flash (mirrors link-projects pattern) ─── */

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

function flashRedirect(location: string, flash: FlashMessage): Response {
  const sep = location.includes("?") ? "&" : "?";
  const target = `${location}${sep}flash=${encodeURIComponent(flash.text)}&flash_kind=${flash.kind}`;
  return new Response(null, { status: 303, headers: { location: target } });
}

/* ─── Renderers ─── */

function statusPill(status: ClusterStatus): string {
  return `<span class="pill ${status === "active" ? "pill-active" : "pill-terminated"}">${esc(status)}</span>`;
}

function typePill(type: ClusterType): string {
  // topical = neutral (default UI); geo = amber-ish to differentiate at a glance
  const cls = type === "geo" ? "pill-paused" : "pill-neutral";
  return `<span class="pill ${cls}">${esc(type)}</span>`;
}

export function renderClustersList(
  rows: ClusterRow[],
  memberCounts: Map<number, number>,
  user: User,
): string {
  const ownership =
    user.role === "super_admin"
      ? "Showing all clusters across the platform (super-admin)."
      : `Showing ${rows.length} cluster${rows.length === 1 ? "" : "s"} you own.`;
  if (rows.length === 0) {
    return `<h1>Clusters</h1>
      <p class="subtitle">${ownership} A cluster is a labeled grouping of 1–${MAX_CLUSTER_MEMBERS} proxied sites that share a theme — a topic ("Plumbing", "Senior Living") or a geo ("San Diego, CA"). Sites can belong to multiple clusters.</p>
      <p style="margin-bottom:1rem"><a class="btn btn-primary" href="/app/clusters/new">+ New cluster</a></p>
      <div class="empty">No clusters yet. Create one to start grouping your sites.</div>`;
  }
  const tbody = rows
    .map(
      (r) => `<tr>
      <td><a href="/app/clusters/${r.id}" class="mono">${esc(r.label)}</a></td>
      <td>${typePill(r.type)}</td>
      <td>${memberCounts.get(r.id) ?? 0} <span style="color:var(--fg-muted);font-size:.8rem">/ ${MAX_CLUSTER_MEMBERS}</span></td>
      <td>${statusPill(r.status)}</td>
      <td class="mono" style="color:var(--fg-muted)">${esc(r.updated_at)}</td>
    </tr>`,
    )
    .join("");
  return `<h1>Clusters</h1>
    <p class="subtitle">${ownership} A cluster is a labeled grouping of 1–${MAX_CLUSTER_MEMBERS} proxied sites that share a theme — a topic ("Plumbing") or a geo ("San Diego, CA"). Sites can belong to multiple clusters.</p>
    <p style="margin-bottom:1rem"><a class="btn btn-primary" href="/app/clusters/new">+ New cluster</a></p>
    <table class="data">
      <thead><tr><th>Label</th><th>Type</th><th>Sites</th><th>Status</th><th>Updated</th></tr></thead>
      <tbody>${tbody}</tbody>
    </table>
    <p class="subtitle" style="margin-top:1rem;font-size:.85rem">Slice A — registry only. Subsequent slices will let clusters drive link-project bulk-apply, auto-schema injection, and cross-linking between member sites.</p>`;
}

interface ClusterFormPrefill {
  type: ClusterType;
  label: string;
  description: string;
  status: ClusterStatus;
  cross_link_enabled: number;
  /** Selected member site IDs (client_id values). */
  selected: readonly string[];
}

function emptyClusterPrefill(): ClusterFormPrefill {
  return {
    type: "topical",
    label: "",
    description: "",
    status: "active",
    cross_link_enabled: 0,
    selected: [],
  };
}

function clusterRowToPrefill(
  row: ClusterRow,
  members: readonly ClusterMemberRow[],
): ClusterFormPrefill {
  return {
    type: row.type,
    label: row.label,
    description: row.description ?? "",
    status: row.status,
    cross_link_enabled: row.cross_link_enabled,
    selected: members.map((m) => m.client_id),
  };
}

function rawToClusterPrefill(
  raw: Record<string, string>,
  selectedIds: readonly string[],
): ClusterFormPrefill {
  const type = (CLUSTER_TYPES as readonly string[]).includes(raw.type ?? "")
    ? (raw.type as ClusterType)
    : "topical";
  const status = (CLUSTER_STATUSES as readonly string[]).includes(raw.status ?? "")
    ? (raw.status as ClusterStatus)
    : "active";
  const crossLinkRaw = raw.cross_link_enabled ?? "";
  const cross_link_enabled = crossLinkRaw === "1" || crossLinkRaw === "on" ? 1 : 0;
  return {
    type,
    label: raw.label ?? "",
    description: raw.description ?? "",
    status,
    cross_link_enabled,
    selected: selectedIds,
  };
}

function renderClusterForm(opts: {
  action: string;
  submitLabel: string;
  prefill: ClusterFormPrefill;
  visibleClients: ClientRow[];
  errors: string[];
}): string {
  const errBox =
    opts.errors.length > 0 ? `<div class="error-box">${opts.errors.map(esc).join("\n")}</div>` : "";
  const typeOptions = CLUSTER_TYPES.map(
    (t) =>
      `<option value="${esc(t)}"${t === opts.prefill.type ? " selected" : ""}>${esc(t)}</option>`,
  ).join("");
  const statusOptions = CLUSTER_STATUSES.map(
    (s) =>
      `<option value="${esc(s)}"${s === opts.prefill.status ? " selected" : ""}>${esc(s)}</option>`,
  ).join("");
  const selectedSet = new Set(opts.prefill.selected);
  const siteCheckboxes =
    opts.visibleClients.length === 0
      ? `<p class="field-hint" style="margin:0">You don't have any sites yet. Create one at <a href="/app/clients/new">/app/clients/new</a> first.</p>`
      : opts.visibleClients
          .map(
            (
              c,
            ) => `<label class="checkbox-inline" style="display:flex;gap:.4rem;align-items:center">
            <input type="checkbox" name="client_ids" value="${esc(c.client_id)}"${selectedSet.has(c.client_id) ? " checked" : ""}>
            <span class="mono" style="font-size:.85rem">${esc(c.client_id)}</span>
            <span style="color:var(--fg-muted);font-size:.7rem">${esc(c.proxy_domain)}</span>
          </label>`,
          )
          .join("");
  return `${errBox}
    <form class="editor" method="POST" action="${esc(opts.action)}">
      <div class="form-section">
        <h2 style="margin-top:0">Cluster</h2>
        <div class="form-grid">
          <div>
            <label for="cl_type">type</label>
            <select id="cl_type" name="type">${typeOptions}</select>
            <div class="field-hint"><strong>topical</strong> = sites about the same subject ("Plumbing", "Senior Living"). <strong>geo</strong> = sites about the same geographic area ("San Diego, CA").</div>
          </div>
          <div>
            <label for="cl_status">status</label>
            <select id="cl_status" name="status">${statusOptions}</select>
            <div class="field-hint">archived clusters stop appearing in selectors and reports but are kept for history.</div>
          </div>
          <div class="full-width">
            <label for="cl_label">label</label>
            <input id="cl_label" name="label" type="text" required maxlength="200" value="${esc(opts.prefill.label)}" placeholder="e.g. Plumbing — or — San Diego, CA">
            <div class="field-hint">Human-readable name. The topic for topical clusters, the place for geo clusters.</div>
          </div>
          <div class="full-width">
            <label for="cl_description">description <span style="color:var(--fg-muted);font-weight:400">(optional)</span></label>
            <textarea id="cl_description" name="description" rows="3" maxlength="4000" style="font-size:.9rem;width:100%;padding:.5rem .65rem;border:1px solid var(--border-strong);border-radius:var(--radius);background:var(--bg-elevated);color:var(--fg)">${esc(opts.prefill.description)}</textarea>
          </div>
        </div>
      </div>
      <div class="form-section">
        <h2 style="margin-top:0">Member sites <span style="color:var(--fg-muted);font-size:.8rem;font-weight:400">(${MIN_CLUSTER_MEMBERS}–${MAX_CLUSTER_MEMBERS})</span></h2>
        <p class="field-hint" style="margin:0 0 .6rem">Pick the proxied sites that belong to this cluster. A site can belong to multiple clusters.</p>
        <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:.4rem">${siteCheckboxes}</div>
      </div>
      <div class="form-section">
        <h2 style="margin-top:0">Cross-linking</h2>
        <label class="checkbox-inline" style="display:flex;gap:.5rem;align-items:flex-start">
          <input type="checkbox" name="cross_link_enabled" value="1"${opts.prefill.cross_link_enabled === 1 ? " checked" : ""} style="margin-top:.2rem">
          <span>
            <strong>Inject "Related sites" footer on every member</strong>
            <div class="field-hint" style="margin-top:.2rem">When on, every member site gets an HTML block before <code>&lt;/body&gt;</code> linking to the other members of this cluster — PBN-style internal linking. Off by default; only turn on for clusters where the sites should reciprocally link.</div>
          </span>
        </label>
      </div>
      <div class="form-actions">
        <button class="btn btn-primary" type="submit">${esc(opts.submitLabel)}</button>
        <a class="btn" href="/app/clusters">Cancel</a>
      </div>
    </form>`;
}

export function renderNewClusterForm(
  prefill: ClusterFormPrefill | null,
  visibleClients: ClientRow[],
  errors: string[] = [],
): string {
  return `<div class="crumbs"><a href="/app/clusters">← Clusters</a></div>
    <h1>New cluster</h1>
    <p class="subtitle">A cluster groups 1–${MAX_CLUSTER_MEMBERS} of your proxied sites by topic or geo. Sites can belong to multiple clusters.</p>
    ${renderClusterForm({
      action: "/app/clusters/new",
      submitLabel: "Create cluster",
      prefill: prefill ?? emptyClusterPrefill(),
      visibleClients,
      errors,
    })}`;
}

export function renderEditClusterForm(
  row: ClusterRow,
  members: ClusterMemberRow[],
  prefill: ClusterFormPrefill | null,
  visibleClients: ClientRow[],
  errors: string[] = [],
): string {
  return `<div class="crumbs"><a href="/app/clusters/${row.id}">← ${esc(row.label)}</a></div>
    <h1>Edit cluster</h1>
    ${renderClusterForm({
      action: `/app/clusters/${row.id}/edit`,
      submitLabel: "Save",
      prefill: prefill ?? clusterRowToPrefill(row, members),
      visibleClients,
      errors,
    })}`;
}

export function renderClusterDetail(
  row: ClusterRow,
  members: ClusterMemberRow[],
  visibleClients: ClientRow[],
): string {
  const visibleIds = new Set(visibleClients.map((c) => c.client_id));
  const visibleClientById = new Map(visibleClients.map((c) => [c.client_id, c]));
  const memberRows = members
    .map((m) => {
      const orphan = !visibleIds.has(m.client_id);
      const client = visibleClientById.get(m.client_id);
      const labelCell = orphan
        ? `<span class="mono" style="color:var(--fg-muted)" title="site not visible to you or deleted">${esc(m.client_id)} ⚠</span>`
        : `<a class="mono" href="/app/clients/${esc(m.client_id)}">${esc(m.client_id)}</a>`;
      const proxyCell = client
        ? `<span class="mono" style="color:var(--fg-muted);font-size:.8rem">${esc(client.proxy_domain)}</span>`
        : "";
      return `<tr><td>${labelCell}</td><td>${proxyCell}</td><td class="mono" style="font-size:.8rem;color:var(--fg-muted)">${esc(m.added_at)}</td></tr>`;
    })
    .join("");
  const statusActions = CLUSTER_STATUSES.filter((s) => s !== row.status)
    .map((s) => {
      const cls = s === "archived" ? "btn-danger" : "btn-success";
      const confirmText = s === "archived" ? "Archive this cluster?" : null;
      const onclick = confirmText
        ? ` onclick="return confirm(${JSON.stringify(confirmText)})"`
        : "";
      return `<form method="POST" action="/app/clusters/${row.id}/status" style="display:inline">
        <input type="hidden" name="status" value="${esc(s)}">
        <button class="btn ${cls}" type="submit"${onclick}>Set ${esc(s)}</button>
      </form>`;
    })
    .join(" ");
  const crossLinkPill =
    row.cross_link_enabled === 1
      ? `<span class="pill pill-active" title="Members cross-link to each other via a 'Related sites' footer block injected into rendered HTML">cross-linking on</span>`
      : "";
  return `<div class="crumbs"><a href="/app/clusters">← Clusters</a></div>
    <h1>${esc(row.label)}</h1>
    <p class="subtitle">${typePill(row.type)} ${statusPill(row.status)} ${crossLinkPill} <span style="color:var(--fg-muted);margin-left:.5rem">id ${row.id} · ${members.length} of ${MAX_CLUSTER_MEMBERS} sites · created ${esc(row.created_at)} · updated ${esc(row.updated_at)}</span></p>
    <div class="actions-row">
      <a class="btn btn-primary" href="/app/clusters/${row.id}/edit">Edit</a>
      <a class="btn" href="/app/clients/bulk-new?cluster_id=${row.id}" title="Open the bulk-create form with this cluster pre-selected — every site you create joins this cluster">+ Bulk-create sites for this cluster</a>
      ${statusActions}
    </div>
    ${
      row.description
        ? `<div class="card"><h2 style="margin-top:0">Description</h2><p style="white-space:pre-wrap;margin:0">${esc(row.description)}</p></div>`
        : ""
    }
    <div class="card">
      <h2 style="margin-top:0">Member sites</h2>
      ${
        members.length === 0
          ? `<div class="empty">No sites in this cluster yet. <a href="/app/clusters/${row.id}/edit">Edit</a> to add some.</div>`
          : `<table class="data">
              <thead><tr><th>Site</th><th>Proxy domain</th><th>Added</th></tr></thead>
              <tbody>${memberRows}</tbody>
            </table>`
      }
    </div>
    <p class="subtitle" style="font-size:.85rem;margin-top:1.5rem">Slice A — registry only. Subsequent slices will let this cluster drive link-project bulk-apply, auto-schema injection, and cross-linking between member sites.</p>`;
}

/* ─── POST handlers ─── */

function readForm(form: FormData): { raw: Record<string, string>; selected: string[] } {
  const raw: Record<string, string> = {};
  const selected: string[] = [];
  for (const [k, v] of form.entries()) {
    if (typeof v !== "string") continue;
    if (k === "client_ids") selected.push(v);
    else raw[k] = v;
  }
  return { raw, selected };
}

export async function handleNewClusterPost(
  request: Request,
  env: AppEnv,
  url: URL,
  user: User,
): Promise<{
  response?: Response;
  rerenderError?: { errors: string[]; prefill: ClusterFormPrefill; visibleClients: ClientRow[] };
}> {
  const csrf = checkCsrf(request, url);
  if (csrf) return { response: csrf };
  const form = await request.formData();
  const { raw, selected } = readForm(form);
  const visibleClients = await loadVisibleClients(env, user);
  const validIds = new Set(visibleClients.map((c) => c.client_id));
  const validation = validateClusterInput(raw);
  const memberValidation = validateMemberList(selected, validIds);
  if (!validation.ok || !memberValidation.ok) {
    const errors = [
      ...(validation.ok ? [] : validation.errors),
      ...(memberValidation.ok ? [] : memberValidation.errors),
    ];
    return {
      rerenderError: {
        errors,
        prefill: rawToClusterPrefill(raw, selected),
        visibleClients,
      },
    };
  }
  const id = await insertCluster(env, user.id, validation.value);
  await replaceClusterMembers(env, id, memberValidation.value);
  // Cross-linking is opt-in (cross_link_enabled). Compile only when on
  // — saves an unnecessary KV round-trip per member otherwise.
  if (validation.value.cross_link_enabled === 1) {
    await invalidateAfterClusterChange(env, memberValidation.value);
  }
  return {
    response: flashRedirect(`/app/clusters/${id}`, {
      text: `Created cluster "${validation.value.label}" with ${memberValidation.value.length} site${memberValidation.value.length === 1 ? "" : "s"}.`,
      kind: "ok",
    }),
  };
}

export async function handleEditClusterPost(
  request: Request,
  env: AppEnv,
  url: URL,
  user: User,
  id: number,
): Promise<{
  response?: Response;
  rerenderError?: {
    row: ClusterRow;
    members: ClusterMemberRow[];
    errors: string[];
    prefill: ClusterFormPrefill;
    visibleClients: ClientRow[];
  };
}> {
  const csrf = checkCsrf(request, url);
  if (csrf) return { response: csrf };
  const row = await loadVisibleCluster(env, user, id);
  if (!row) return { response: new Response("Not found", { status: 404 }) };
  const form = await request.formData();
  const { raw, selected } = readForm(form);
  const visibleClients = await loadVisibleClients(env, user);
  const validIds = new Set(visibleClients.map((c) => c.client_id));
  const validation = validateClusterInput(raw);
  const memberValidation = validateMemberList(selected, validIds);
  if (!validation.ok || !memberValidation.ok) {
    const members = await loadClusterMembers(env, id);
    const errors = [
      ...(validation.ok ? [] : validation.errors),
      ...(memberValidation.ok ? [] : memberValidation.errors),
    ];
    return {
      rerenderError: {
        row,
        members,
        errors,
        prefill: rawToClusterPrefill(raw, selected),
        visibleClients,
      },
    };
  }
  // Compute the union of currently-and-newly-affected clients BEFORE
  // we replace the member list. Members removed by this edit lose
  // cross-link rules from this cluster and need recompile too.
  // Toggling cross_link_enabled OFF also affects every previous
  // member (their KV should drop the rules from this cluster).
  const previousCrossLinkEnabled = row.cross_link_enabled === 1;
  const newCrossLinkEnabled = validation.value.cross_link_enabled === 1;
  const affected =
    previousCrossLinkEnabled || newCrossLinkEnabled
      ? await affectedClientsForClusterChange(env, id, memberValidation.value)
      : [];
  await updateClusterRow(env, id, validation.value);
  await replaceClusterMembers(env, id, memberValidation.value);
  await invalidateAfterClusterChange(env, affected);
  return {
    response: flashRedirect(`/app/clusters/${id}`, {
      text: `Saved cluster "${validation.value.label}".`,
      kind: "ok",
    }),
  };
}

export async function handleClusterStatusPost(
  request: Request,
  env: AppEnv,
  url: URL,
  user: User,
  id: number,
): Promise<Response> {
  const csrf = checkCsrf(request, url);
  if (csrf) return csrf;
  const row = await loadVisibleCluster(env, user, id);
  if (!row) return new Response("Not found", { status: 404 });
  const form = await request.formData();
  const requested = String(form.get("status") ?? "");
  if (!(CLUSTER_STATUSES as readonly string[]).includes(requested)) {
    return flashRedirect(`/app/clusters/${id}`, {
      text: `Invalid status: ${requested}`,
      kind: "err",
    });
  }
  await setClusterStatusRow(env, id, requested as ClusterStatus);
  // Status flip from active→archived (or back) changes whether the
  // cross-link rules render. Recompile every member when this cluster
  // had cross-linking enabled.
  if (row.cross_link_enabled === 1) {
    const memberRows = await loadClusterMembers(env, id);
    await invalidateAfterClusterChange(
      env,
      memberRows.map((m) => m.client_id),
    );
  }
  return flashRedirect(`/app/clusters/${id}`, {
    text: `Status set to ${requested}.`,
    kind: "ok",
  });
}

/** Convenience loader for the detail-page route. */
export async function loadClusterPageData(
  env: AppEnv,
  user: User,
  clusterId: number,
): Promise<{
  cluster: ClusterRow;
  members: ClusterMemberRow[];
  visibleClients: ClientRow[];
} | null> {
  const cluster = await loadVisibleCluster(env, user, clusterId);
  if (!cluster) return null;
  const [members, visibleClients] = await Promise.all([
    loadClusterMembers(env, clusterId),
    loadVisibleClients(env, user),
  ]);
  return { cluster, members, visibleClients };
}

/* ─── Slice C: cross-linking between cluster members ─── */

/**
 * Synthesized rule shape mirroring `ContentInjectRule` in src/config/schema.ts.
 * Defined locally (not imported) so this module owns the KV format.
 */
export interface SynthesizedCrossLinkRule {
  match: string;
  selector: string;
  position: "append";
  html: string;
}

/** KV value written to `cluster_links:<client_id>`. */
export interface ClusterLinksKvValue {
  compiled_at: string;
  /** ContentInjectRule entries the worker merges into config.content_injections. */
  content_injections: SynthesizedCrossLinkRule[];
}

/** HTML escape — same character set as app.ts esc(). Inlined so this
 *  module's KV writes don't depend on app.ts at runtime (avoids
 *  circular import). */
function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      case "'":
        return "&#39;";
      default:
        return c;
    }
  });
}

/**
 * Build the "Related sites" content_injection for a single member of a
 * cross-linked cluster.
 *
 * @param cluster the cluster the rule belongs to
 * @param forClientId the member whose pages this rule will run on
 *   (reserved for future per-site customization; currently unused)
 * @param siblings the other members of the cluster
 * @returns one SynthesizedCrossLinkRule, or null when the cluster has
 *   no siblings (1-member cluster has nothing to cross-link to)
 *
 * The rule injects on every page (`^/.*` match) at body+append. The
 * wrapping div carries `data-cluster-related="<cluster_id>"` so an
 * operator can trace the block back to its source cluster, and the
 * existing content-injector idempotence (data-edge-seo-rule marker)
 * prevents double-injection on revisit.
 */
export function synthesizeClusterCrossLink(
  cluster: ClusterRow,
  forClientId: string,
  siblings: ReadonlyArray<{ client_id: string; proxy_domain: string }>,
): SynthesizedCrossLinkRule | null {
  void forClientId;
  if (siblings.length === 0) return null;
  const linkItems = siblings
    .map(
      (s) =>
        `<li><a href="https://${escapeHtml(s.proxy_domain)}/" rel="noopener">${escapeHtml(s.proxy_domain)}</a></li>`,
    )
    .join("");
  const html = `<div data-cluster-related="${cluster.id}" style="margin:2rem 0;padding:1rem;border-top:1px solid #ddd;font-size:.85rem"><h4 style="margin:0 0 .5rem;font-size:.95rem">Related sites — ${escapeHtml(cluster.label)}</h4><ul style="margin:0;padding-left:1.2rem">${linkItems}</ul></div>`;
  return {
    match: "^/.*",
    selector: "body",
    position: "append",
    html,
  };
}

/**
 * Re-compile the `cluster_links:<client_id>` KV entry for a single
 * member site. Reads every cross-link-enabled, active cluster the
 * site belongs to, builds one synthesized rule per cluster (linking
 * to the OTHER members), writes the aggregated envelope to KV.
 *
 * Empty result deletes the KV entry so the loader's fast path skips
 * the merge.
 */
export async function compileClusterLinksForClient(
  env: AppEnv,
  clientId: string,
): Promise<{ written: boolean; ruleCount: number }> {
  // One JOIN over (clusters × member-self × siblings × siblings' clients)
  // gives every (cluster, sibling) pair the focal site needs links for.
  const r = await env.CONFIG_DB.prepare(
    `SELECT
       c.id as cluster_id, c.owner_id as cluster_owner_id, c.type as cluster_type,
       c.label as cluster_label, c.description as cluster_description,
       c.status as cluster_status, c.cross_link_enabled as cluster_cross_link_enabled,
       c.created_at as cluster_created_at, c.updated_at as cluster_updated_at,
       sib.client_id as sibling_client_id,
       sib_client.proxy_domain as sibling_proxy_domain
     FROM clusters c
     JOIN cluster_members me ON me.cluster_id = c.id
     JOIN cluster_members sib ON sib.cluster_id = c.id AND sib.client_id != me.client_id
     JOIN clients sib_client ON sib_client.client_id = sib.client_id
     WHERE c.cross_link_enabled = 1
       AND c.status = 'active'
       AND me.client_id = ?
     ORDER BY c.id, sib.client_id`,
  )
    .bind(clientId)
    .all<{
      cluster_id: number;
      cluster_owner_id: number;
      cluster_type: ClusterType;
      cluster_label: string;
      cluster_description: string | null;
      cluster_status: ClusterStatus;
      cluster_cross_link_enabled: number;
      cluster_created_at: string;
      cluster_updated_at: string;
      sibling_client_id: string;
      sibling_proxy_domain: string;
    }>();
  // Group siblings by cluster_id so we synthesize one rule per cluster.
  const grouped = new Map<
    number,
    { cluster: ClusterRow; siblings: { client_id: string; proxy_domain: string }[] }
  >();
  for (const row of r.results ?? []) {
    let entry = grouped.get(row.cluster_id);
    if (!entry) {
      entry = {
        cluster: {
          id: row.cluster_id,
          owner_id: row.cluster_owner_id,
          type: row.cluster_type,
          label: row.cluster_label,
          description: row.cluster_description,
          status: row.cluster_status,
          cross_link_enabled: row.cluster_cross_link_enabled,
          created_at: row.cluster_created_at,
          updated_at: row.cluster_updated_at,
        },
        siblings: [],
      };
      grouped.set(row.cluster_id, entry);
    }
    entry.siblings.push({
      client_id: row.sibling_client_id,
      proxy_domain: row.sibling_proxy_domain,
    });
  }
  const synthesized: SynthesizedCrossLinkRule[] = [];
  for (const { cluster, siblings } of grouped.values()) {
    const rule = synthesizeClusterCrossLink(cluster, clientId, siblings);
    if (rule) synthesized.push(rule);
  }
  const key = `cluster_links:${clientId}`;
  if (synthesized.length === 0) {
    await env.CONFIG_KV.delete(key);
    return { written: false, ruleCount: 0 };
  }
  const value: ClusterLinksKvValue = {
    compiled_at: new Date().toISOString(),
    content_injections: synthesized,
  };
  await env.CONFIG_KV.put(key, JSON.stringify(value));
  return { written: true, ruleCount: synthesized.length };
}

/**
 * Best-effort Cloudflare HTTP cache purge for a client's proxy_domain.
 * Mirrors the helper in link-projects.ts. Lazy-imports cloudflare-api
 * + proxy-zone helpers to keep the unit-test graph clean.
 */
async function bestEffortHttpCachePurgeForCluster(env: AppEnv, clientId: string): Promise<void> {
  if (!env.CF_API_TOKEN) return;
  try {
    const row = await env.CONFIG_DB.prepare(
      "SELECT proxy_domain FROM clients WHERE client_id = ? LIMIT 1",
    )
      .bind(clientId)
      .first<{ proxy_domain: string }>();
    if (!row) return;
    const proxy = row.proxy_domain;
    const { matchProxyZone } = await import("../../src/config/proxy-zone.js");
    const knownZone = matchProxyZone(proxy);
    const zoneName = knownZone ?? proxy.replace(/^www\./i, "");
    const { findZoneByName, purgeCacheByHosts } = await import("./cloudflare-api.js");
    const zone = await findZoneByName(env.CF_API_TOKEN, zoneName);
    if (!zone) return;
    await purgeCacheByHosts(env.CF_API_TOKEN, zone.id, [proxy]);
  } catch (e) {
    console.warn("clusters: HTTP cache purge failed", e);
  }
}

/**
 * Recompile cluster_links KV + purge CF cache for every client_id
 * given. Used by cluster create/edit/status handlers. KV writes run
 * in parallel; cache purges run sequentially to avoid hammering CF.
 */
export async function invalidateAfterClusterChange(
  env: AppEnv,
  clientIds: readonly string[],
): Promise<void> {
  if (clientIds.length === 0) return;
  await Promise.all(clientIds.map((c) => compileClusterLinksForClient(env, c)));
  for (const c of clientIds) {
    await bestEffortHttpCachePurgeForCluster(env, c);
  }
}

/**
 * Compute the union of currently-and-previously-affected client_ids
 * for a cluster change. Members removed by an edit still need a
 * recompile (their cluster_links should drop the rules from this
 * cluster); members added by an edit also need one (they gain rules).
 *
 * Call BEFORE replacing the member list, passing the new member set.
 */
export async function affectedClientsForClusterChange(
  env: AppEnv,
  clusterId: number,
  newMemberIds: readonly string[],
): Promise<string[]> {
  const r = await env.CONFIG_DB.prepare(
    "SELECT client_id FROM cluster_members WHERE cluster_id = ?",
  )
    .bind(clusterId)
    .all<{ client_id: string }>();
  const before = new Set((r.results ?? []).map((row) => row.client_id));
  const after = new Set(newMemberIds);
  const union = new Set<string>();
  for (const id of before) union.add(id);
  for (const id of after) union.add(id);
  return Array.from(union);
}
