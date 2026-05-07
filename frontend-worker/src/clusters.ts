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

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: { type, label, description, status } };
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

async function insertCluster(env: AppEnv, ownerId: number, input: ClusterInput): Promise<number> {
  const result = await env.CONFIG_DB.prepare(
    `INSERT INTO clusters (owner_id, type, label, description, status)
     VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(ownerId, input.type, input.label, input.description, input.status)
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
       SET type = ?, label = ?, description = ?, status = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
  )
    .bind(input.type, input.label, input.description, input.status, id)
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
  /** Selected member site IDs (client_id values). */
  selected: readonly string[];
}

function emptyClusterPrefill(): ClusterFormPrefill {
  return { type: "topical", label: "", description: "", status: "active", selected: [] };
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
  return {
    type,
    label: raw.label ?? "",
    description: raw.description ?? "",
    status,
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
  return `<div class="crumbs"><a href="/app/clusters">← Clusters</a></div>
    <h1>${esc(row.label)}</h1>
    <p class="subtitle">${typePill(row.type)} ${statusPill(row.status)} <span style="color:var(--fg-muted);margin-left:.5rem">id ${row.id} · ${members.length} of ${MAX_CLUSTER_MEMBERS} sites · created ${esc(row.created_at)} · updated ${esc(row.updated_at)}</span></p>
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
  await updateClusterRow(env, id, validation.value);
  await replaceClusterMembers(env, id, memberValidation.value);
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
