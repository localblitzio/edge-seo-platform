/**
 * Link Projects — Slices 1 + 2A.
 *
 * A link project is the planning surface for a backlink campaign:
 *   - target_url: the money URL (https://xyz.com/services)
 *   - anchor_options: JSON array of anchor variations
 *   - status: draft / active / paused / archived
 *
 * Slice 1 (read-only registry, migration 0003) is the CRUD on
 * link_projects rows.
 *
 * Slice 2A (placements registry, migration 0004) adds
 * link_project_placements: per-(project × client) rows that say
 * "inject a link to this target on these pages of this client."
 * Phase A covers data + admin UI only.
 *
 * Slice 2B (worker integration, future) compiles active placements to
 * KV at admin-write time and synthesizes content_injections at
 * request time so the proxy worker injects the link into HTML.
 *
 * Multi-tenancy is identical to the clients module: rows scoped by
 * owner_id; super-admin sees all. Placements inherit visibility from
 * the parent link_project (a placement is visible iff its project is).
 */
import type { AppEnv, ClientRow, FlashMessage } from "./app.js";
import { canSeeAllClients, esc, loadVisibleClients, writeAudit } from "./app.js";
import type { User } from "./auth.js";
import {
  type ClusterRow,
  loadAllClusterMembersByCluster,
  loadVisibleClusters,
} from "./clusters.js";

export type LinkProjectStatus = "draft" | "active" | "paused" | "archived";

export const LINK_PROJECT_STATUSES: readonly LinkProjectStatus[] = [
  "draft",
  "active",
  "paused",
  "archived",
];

/** Row shape mirroring the link_projects table (migration 0003). */
export interface LinkProjectRow {
  id: number;
  owner_id: number;
  label: string;
  target_url: string;
  /** JSON-encoded array of strings; parse with `parseAnchorOptions`. */
  anchor_options: string;
  status: LinkProjectStatus;
  notes: string | null;
  created_at: string;
  updated_at: string;
}

/** Form-level shape — what `validateLinkProjectInput` returns on success. */
export interface LinkProjectInput {
  label: string;
  target_url: string;
  anchor_options: string[];
  status: LinkProjectStatus;
  notes: string | null;
}

const MAX_LABEL_LENGTH = 200;
const MAX_TARGET_URL_LENGTH = 2048;
const MAX_ANCHOR_LENGTH = 200;
const MAX_ANCHOR_OPTIONS = 10;
const MAX_NOTES_LENGTH = 4000;

/**
 * Parse the JSON-encoded `anchor_options` column, returning a defensive
 * copy. Falls back to `[]` on any parse error or shape mismatch — the
 * UI shouldn't crash if a row was hand-edited in D1 to something wonky.
 */
export function parseAnchorOptions(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((s): s is string => typeof s === "string");
  } catch {
    return [];
  }
}

/**
 * Validate raw form input for a Link Project create/edit submission.
 *
 * - label: 1..MAX_LABEL_LENGTH chars after trim.
 * - target_url: must parse as an http(s):// absolute URL.
 * - anchor_options: line-separated string from a textarea; each line
 *   trimmed, blanks dropped, length-capped, count-capped.
 * - status: one of the four enum values.
 * - notes: optional, length-capped.
 *
 * Returns `{ ok: true, value }` or `{ ok: false, errors }` (errors is a
 * list of field-level messages so the form can render all at once).
 */
export function validateLinkProjectInput(
  raw: Record<string, string>,
): { ok: true; value: LinkProjectInput } | { ok: false; errors: string[] } {
  const errors: string[] = [];

  const label = (raw.label ?? "").trim();
  if (label.length === 0) {
    errors.push("label is required");
  } else if (label.length > MAX_LABEL_LENGTH) {
    errors.push(`label must be ${MAX_LABEL_LENGTH} characters or fewer`);
  }

  const targetUrlRaw = (raw.target_url ?? "").trim();
  let parsedTargetUrl: URL | null = null;
  if (targetUrlRaw.length === 0) {
    errors.push("target_url is required");
  } else if (targetUrlRaw.length > MAX_TARGET_URL_LENGTH) {
    errors.push(`target_url must be ${MAX_TARGET_URL_LENGTH} characters or fewer`);
  } else {
    try {
      parsedTargetUrl = new URL(targetUrlRaw);
      if (parsedTargetUrl.protocol !== "http:" && parsedTargetUrl.protocol !== "https:") {
        errors.push("target_url must use http:// or https://");
        parsedTargetUrl = null;
      }
    } catch {
      errors.push("target_url is not a valid URL");
    }
  }

  // anchor_options arrives as a textarea — newline-separated. We also
  // accept comma-separated for operators who paste from a spreadsheet.
  const anchorRaw = raw.anchor_options ?? "";
  const anchors = anchorRaw
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (anchors.length > MAX_ANCHOR_OPTIONS) {
    errors.push(`anchor_options must have at most ${MAX_ANCHOR_OPTIONS} entries`);
  }
  for (const a of anchors) {
    if (a.length > MAX_ANCHOR_LENGTH) {
      errors.push(`anchor option "${a.slice(0, 30)}…" exceeds ${MAX_ANCHOR_LENGTH} chars`);
      break;
    }
  }

  const statusRaw = (raw.status ?? "").trim();
  let status: LinkProjectStatus = "draft";
  if (statusRaw.length > 0) {
    if (!(LINK_PROJECT_STATUSES as readonly string[]).includes(statusRaw)) {
      errors.push(`status must be one of: ${LINK_PROJECT_STATUSES.join(", ")}`);
    } else {
      status = statusRaw as LinkProjectStatus;
    }
  }

  const notesRaw = (raw.notes ?? "").trim();
  let notes: string | null = null;
  if (notesRaw.length > MAX_NOTES_LENGTH) {
    errors.push(`notes must be ${MAX_NOTES_LENGTH} characters or fewer`);
  } else if (notesRaw.length > 0) {
    notes = notesRaw;
  }

  if (errors.length > 0 || !parsedTargetUrl) {
    return { ok: false, errors };
  }
  return {
    ok: true,
    value: {
      label,
      target_url: parsedTargetUrl.toString(),
      anchor_options: anchors,
      status,
      notes,
    },
  };
}

/* ─── DB helpers ─── */

export async function loadVisibleLinkProjects(env: AppEnv, user: User): Promise<LinkProjectRow[]> {
  if (canSeeAllClients(user)) {
    const r = await env.CONFIG_DB.prepare(
      "SELECT * FROM link_projects ORDER BY id DESC",
    ).all<LinkProjectRow>();
    return r.results ?? [];
  }
  const r = await env.CONFIG_DB.prepare(
    "SELECT * FROM link_projects WHERE owner_id = ? ORDER BY id DESC",
  )
    .bind(user.id)
    .all<LinkProjectRow>();
  return r.results ?? [];
}

export async function loadVisibleLinkProject(
  env: AppEnv,
  user: User,
  id: number,
): Promise<LinkProjectRow | null> {
  if (canSeeAllClients(user)) {
    return env.CONFIG_DB.prepare("SELECT * FROM link_projects WHERE id = ? LIMIT 1")
      .bind(id)
      .first<LinkProjectRow>();
  }
  return env.CONFIG_DB.prepare("SELECT * FROM link_projects WHERE id = ? AND owner_id = ? LIMIT 1")
    .bind(id, user.id)
    .first<LinkProjectRow>();
}

async function insertLinkProject(
  env: AppEnv,
  ownerId: number,
  input: LinkProjectInput,
): Promise<number> {
  const result = await env.CONFIG_DB.prepare(
    `INSERT INTO link_projects
       (owner_id, label, target_url, anchor_options, status, notes)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      ownerId,
      input.label,
      input.target_url,
      JSON.stringify(input.anchor_options),
      input.status,
      input.notes,
    )
    .run();
  // D1's insert result types vary by adapter version; fall back to a
  // SELECT last_insert_rowid if meta isn't present.
  const meta = (result as unknown as { meta?: { last_row_id?: number } }).meta;
  if (meta?.last_row_id != null) return meta.last_row_id;
  const row = await env.CONFIG_DB.prepare(
    "SELECT id FROM link_projects WHERE owner_id = ? ORDER BY id DESC LIMIT 1",
  )
    .bind(ownerId)
    .first<{ id: number }>();
  return row?.id ?? 0;
}

async function updateLinkProjectRow(
  env: AppEnv,
  id: number,
  input: LinkProjectInput,
): Promise<void> {
  await env.CONFIG_DB.prepare(
    `UPDATE link_projects
       SET label = ?, target_url = ?, anchor_options = ?, status = ?, notes = ?,
           updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
  )
    .bind(
      input.label,
      input.target_url,
      JSON.stringify(input.anchor_options),
      input.status,
      input.notes,
      id,
    )
    .run();
}

async function setLinkProjectStatus(
  env: AppEnv,
  id: number,
  status: LinkProjectStatus,
): Promise<void> {
  await env.CONFIG_DB.prepare(
    "UPDATE link_projects SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
  )
    .bind(status, id)
    .run();
}

/* ─── CSRF + flash (mirrors app.ts helpers — kept private here) ─── */

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

function actorIp(request: Request): string {
  return request.headers.get("cf-connecting-ip") ?? "0.0.0.0";
}

/**
 * Write a `config_update` audit entry for a link-project placement event.
 *
 * We piggy-back on the existing `audit_log` table rather than introduce
 * a new one (or a migration to widen its event_type CHECK) — placements
 * materially affect what the worker injects on the client's pages, so
 * "config_update" is a fair conceptual fit. The `notes` column carries
 * the link-project-specific context (project id, page_match, action).
 *
 * Best-effort: any DB error is swallowed so an audit failure can't take
 * down a placement edit.
 */
async function writeLinkProjectAudit(
  env: AppEnv,
  user: User,
  request: Request,
  clientId: string,
  notes: string,
): Promise<void> {
  try {
    await writeAudit(env, {
      client_id: clientId,
      actor_email: user.email,
      actor_ip: actorIp(request),
      event_type: "config_update",
      before_hash: null,
      after_hash: null,
      previous_status: null,
      new_status: null,
      notes,
    });
  } catch (e) {
    console.warn("link-projects: audit write failed", e);
  }
}

function flashRedirect(location: string, flash: FlashMessage): Response {
  const sep = location.includes("?") ? "&" : "?";
  const target = `${location}${sep}flash=${encodeURIComponent(flash.text)}&flash_kind=${flash.kind}`;
  return new Response(null, { status: 303, headers: { location: target } });
}

/* ─── Renderers ─── */

function statusPill(status: LinkProjectStatus): string {
  const cls =
    status === "active"
      ? "pill-active"
      : status === "paused"
        ? "pill-paused"
        : status === "archived"
          ? "pill-terminated"
          : "pill-neutral";
  return `<span class="pill ${cls}">${esc(status)}</span>`;
}

function anchorOptionsPreview(raw: string): string {
  const list = parseAnchorOptions(raw);
  if (list.length === 0) return '<span style="color:var(--fg-muted)">—</span>';
  const head = list.slice(0, 2).map(esc).join(", ");
  const more =
    list.length > 2 ? ` <span style="color:var(--fg-muted)">+${list.length - 2}</span>` : "";
  return `${head}${more}`;
}

export function renderLinkProjectsList(rows: LinkProjectRow[], user: User): string {
  const ownership =
    user.role === "super_admin"
      ? "Showing all link projects across the platform (super-admin)."
      : `Showing ${rows.length} link project${rows.length === 1 ? "" : "s"} you own.`;
  if (rows.length === 0) {
    return `<h1>Link projects</h1>
      <p class="subtitle">${ownership}</p>
      <p style="margin-bottom:1rem"><a class="btn btn-primary" href="/app/link-projects/new">+ New link project</a></p>
      <div class="empty">No link projects yet. Create one to start tracking pushes to a money site.</div>`;
  }
  const tbody = rows
    .map(
      (r) => `<tr>
      <td><a href="/app/link-projects/${r.id}" class="mono">${esc(r.label)}</a></td>
      <td class="mono"><a href="${esc(r.target_url)}" target="_blank" rel="noopener noreferrer">${esc(r.target_url)}</a></td>
      <td>${anchorOptionsPreview(r.anchor_options)}</td>
      <td>${statusPill(r.status)}</td>
      <td class="mono" style="color:var(--fg-muted)">${esc(r.updated_at)}</td>
    </tr>`,
    )
    .join("");
  return `<h1>Link projects</h1>
    <p class="subtitle">${ownership} Each project tracks one money URL plus the anchor variations and notes used to push it from your proxied client sites.</p>
    <p style="margin-bottom:1rem"><a class="btn btn-primary" href="/app/link-projects/new">+ New link project</a></p>
    <table class="data">
      <thead><tr><th>Label</th><th>Target URL</th><th>Anchors</th><th>Status</th><th>Updated</th></tr></thead>
      <tbody>${tbody}</tbody>
    </table>
    <p class="subtitle" style="margin-top:1rem;font-size:.85rem">Open a project to add placements — per-(client × page-match) rules that the worker uses to inject the link at request time.</p>`;
}

export function renderLinkProjectDetail(
  row: LinkProjectRow,
  placements: LinkProjectPlacementRow[],
  visibleClients: ClientRow[],
  visibleClusters: readonly ClusterRow[] = [],
  clusterMembers: ReadonlyMap<number, readonly string[]> = new Map(),
): string {
  const anchors = parseAnchorOptions(row.anchor_options);
  const stats = aggregateProjectStats(placements);
  const anchorList =
    anchors.length === 0
      ? '<span style="color:var(--fg-muted)">No anchor options yet — edit to add some. With multiple options, the synthesizer rotates across them deterministically per (placement, page-match).</span>'
      : `<ul style="margin:0;padding-left:1.2rem">${anchors.map((a) => `<li class="mono">${esc(a)}</li>`).join("")}</ul>`;
  const statusActions = LINK_PROJECT_STATUSES.filter((s) => s !== row.status)
    .map((s) => {
      const cls =
        s === "active"
          ? "btn-success"
          : s === "paused"
            ? "btn-warn"
            : s === "archived"
              ? "btn-danger"
              : "";
      const confirmText = s === "archived" ? "Archive this link project?" : null;
      const onclick = confirmText
        ? ` onclick="return confirm(${JSON.stringify(confirmText)})"`
        : "";
      return `<form method="POST" action="/app/link-projects/${row.id}/status" style="display:inline">
        <input type="hidden" name="status" value="${esc(s)}">
        <button class="btn ${cls}" type="submit"${onclick}>Set ${esc(s)}</button>
      </form>`;
    })
    .join(" ");
  // Stat-card row, mirroring the client-detail "stats" pattern. Numbers
  // come from aggregateProjectStats, which is a pure derivation off the
  // placements list — no extra DB roundtrip.
  const statCard = (label: string, value: number | string, hint?: string) =>
    `<div class="stat"><div class="label">${esc(label)}</div><div class="value">${esc(value)}</div>${hint ? `<div class="field-hint" style="margin-top:.2rem">${esc(hint)}</div>` : ""}</div>`;
  const clientsHint =
    stats.distinctClients.length === 0
      ? "no placements yet"
      : stats.distinctClients.slice(0, 3).join(", ") +
        (stats.distinctClients.length > 3 ? ` +${stats.distinctClients.length - 3} more` : "");
  return `<div class="crumbs"><a href="/app/link-projects">← Link projects</a></div>
    <h1>${esc(row.label)}</h1>
    <p class="subtitle">${statusPill(row.status)} <span style="color:var(--fg-muted);margin-left:.5rem">id ${row.id} · created ${esc(row.created_at)} · updated ${esc(row.updated_at)}</span></p>
    <div class="actions-row">
      <a class="btn btn-primary" href="/app/link-projects/${row.id}/edit">Edit</a>
      ${statusActions}
    </div>
    <div class="stats">
      ${statCard("Placements", stats.totalPlacements)}
      ${statCard("Active", stats.activePlacements, stats.pausedPlacements > 0 ? `${stats.pausedPlacements} paused` : undefined)}
      ${statCard("Clients reached", stats.distinctClientCount, clientsHint)}
      ${statCard("Anchor options", anchors.length, anchors.length > 1 ? "rotation enabled" : anchors.length === 1 ? "single anchor (no rotation)" : "none — using target_url")}
    </div>
    <div class="card">
      <h2 style="margin-top:0;display:flex;justify-content:space-between;align-items:center">
        <span>Target</span>
        <form method="POST" action="/app/link-projects/${row.id}/check-target" style="margin:0">
          <button class="btn" type="submit" title="Probe target_url to verify it's still reachable. GETs the URL, follows redirects up to 10 hops, reports the final status.">Check target URL</button>
        </form>
      </h2>
      <dl class="kv">
        <dt>target_url</dt><dd><a href="${esc(row.target_url)}" target="_blank" rel="noopener noreferrer">${esc(row.target_url)}</a></dd>
        <dt>status</dt><dd>${statusPill(row.status)}</dd>
      </dl>
    </div>
    <div class="card">
      <h2 style="margin-top:0">Anchor options</h2>
      <p class="field-hint" style="font-size:.85rem;color:var(--fg-muted);margin:.2rem 0 .6rem">When multiple options are set, the synthesizer rotates deterministically per (placement, page-match) so the same URL always shows the same anchor. <code>anchor_override</code> on a placement still pins a specific one.</p>
      ${anchorList}
    </div>
    ${
      row.notes
        ? `<div class="card"><h2 style="margin-top:0">Notes</h2><p style="white-space:pre-wrap;margin:0">${esc(row.notes)}</p></div>`
        : ""
    }
    ${renderPlacementsSection(row, placements, visibleClients, visibleClusters, clusterMembers)}`;
}

interface FormPrefill {
  label: string;
  target_url: string;
  /** Newline-separated anchor list as it appears in the textarea. */
  anchor_options_text: string;
  status: LinkProjectStatus;
  notes: string;
}

function emptyFormPrefill(): FormPrefill {
  return { label: "", target_url: "", anchor_options_text: "", status: "draft", notes: "" };
}

function rowToFormPrefill(row: LinkProjectRow): FormPrefill {
  return {
    label: row.label,
    target_url: row.target_url,
    anchor_options_text: parseAnchorOptions(row.anchor_options).join("\n"),
    status: row.status,
    notes: row.notes ?? "",
  };
}

function rawToFormPrefill(raw: Record<string, string>): FormPrefill {
  const status = LINK_PROJECT_STATUSES.includes((raw.status ?? "") as LinkProjectStatus)
    ? (raw.status as LinkProjectStatus)
    : "draft";
  return {
    label: raw.label ?? "",
    target_url: raw.target_url ?? "",
    anchor_options_text: raw.anchor_options ?? "",
    status,
    notes: raw.notes ?? "",
  };
}

function renderLinkProjectForm(opts: {
  action: string;
  submitLabel: string;
  prefill: FormPrefill;
  errors: string[];
}): string {
  const errBox =
    opts.errors.length > 0 ? `<div class="error-box">${opts.errors.map(esc).join("\n")}</div>` : "";
  const statusOptions = LINK_PROJECT_STATUSES.map(
    (s) =>
      `<option value="${esc(s)}"${s === opts.prefill.status ? " selected" : ""}>${esc(s)}</option>`,
  ).join("");
  return `${errBox}
    <form class="editor" method="POST" action="${esc(opts.action)}">
      <div class="form-section">
        <h2 style="margin-top:0">Target</h2>
        <div class="form-grid">
          <div class="full-width">
            <label for="lp_label">label</label>
            <input id="lp_label" name="label" type="text" required maxlength="200" value="${esc(opts.prefill.label)}" placeholder="e.g. Push xyz.com — Q2 2026">
            <div class="field-hint">Human-readable name for this push. Shown in the sidebar and project list.</div>
          </div>
          <div class="full-width">
            <label for="lp_target_url">target_url</label>
            <input id="lp_target_url" name="target_url" type="url" required maxlength="2048" value="${esc(opts.prefill.target_url)}" placeholder="https://xyz.com/services">
            <div class="field-hint">The exact URL that placements will link to. Use a deep URL when pushing a specific landing page, not the apex.</div>
          </div>
          <div>
            <label for="lp_status">status</label>
            <select id="lp_status" name="status">${statusOptions}</select>
            <div class="field-hint">draft = not yet placing links; active = placements run; paused = placements skipped; archived = historical only.</div>
          </div>
        </div>
      </div>
      <div class="form-section">
        <h2 style="margin-top:0">Anchor options</h2>
        <p class="field-hint" style="margin:0 0 .6rem">One per line (or comma-separated). First entry is the default; later slices will let placements pick others. Max 10, 200 chars each.</p>
        <textarea id="lp_anchor_options" name="anchor_options" rows="6" style="font-family:var(--mono);font-size:.85rem;width:100%;padding:.5rem .65rem;border:1px solid var(--border-strong);border-radius:var(--radius);background:var(--bg-elevated);color:var(--fg)" placeholder="visit our services\nlearn more\nxyz.com">${esc(opts.prefill.anchor_options_text)}</textarea>
      </div>
      <div class="form-section">
        <h2 style="margin-top:0">Notes</h2>
        <p class="field-hint" style="margin:0 0 .6rem">Operator scratchpad — campaign goals, source of the push, anything you want future-you to remember.</p>
        <textarea id="lp_notes" name="notes" rows="4" maxlength="4000" style="font-size:.9rem;width:100%;padding:.5rem .65rem;border:1px solid var(--border-strong);border-radius:var(--radius);background:var(--bg-elevated);color:var(--fg)">${esc(opts.prefill.notes)}</textarea>
      </div>
      <div class="form-actions">
        <button class="btn btn-primary" type="submit">${esc(opts.submitLabel)}</button>
        <a class="btn" href="/app/link-projects">Cancel</a>
      </div>
    </form>`;
}

export function renderNewLinkProjectForm(
  prefill: FormPrefill | null,
  errors: string[] = [],
): string {
  return `<div class="crumbs"><a href="/app/link-projects">← Link projects</a></div>
    <h1>New link project</h1>
    <p class="subtitle">Register a target URL you want to push from your proxied client sites. Slice 2 will let you select which clients place the link.</p>
    ${renderLinkProjectForm({
      action: "/app/link-projects/new",
      submitLabel: "Create link project",
      prefill: prefill ?? emptyFormPrefill(),
      errors,
    })}`;
}

export function renderEditLinkProjectForm(
  row: LinkProjectRow,
  prefill: FormPrefill | null,
  errors: string[] = [],
): string {
  return `<div class="crumbs"><a href="/app/link-projects/${row.id}">← ${esc(row.label)}</a></div>
    <h1>Edit link project</h1>
    <p class="subtitle">Updating won't move existing placements — Slice 2 placements pick up label/anchor changes on next request.</p>
    ${renderLinkProjectForm({
      action: `/app/link-projects/${row.id}/edit`,
      submitLabel: "Save",
      prefill: prefill ?? rowToFormPrefill(row),
      errors,
    })}`;
}

/* ─── POST handlers ─── */

export async function handleNewLinkProjectPost(
  request: Request,
  env: AppEnv,
  url: URL,
  user: User,
): Promise<{ response?: Response; rerenderError?: { errors: string[]; prefill: FormPrefill } }> {
  const csrf = checkCsrf(request, url);
  if (csrf) return { response: csrf };
  const form = await request.formData();
  const raw: Record<string, string> = {};
  for (const [k, v] of form.entries()) {
    if (typeof v === "string") raw[k] = v;
  }
  const validation = validateLinkProjectInput(raw);
  if (!validation.ok) {
    return { rerenderError: { errors: validation.errors, prefill: rawToFormPrefill(raw) } };
  }
  const id = await insertLinkProject(env, user.id, validation.value);
  return {
    response: flashRedirect(`/app/link-projects/${id}`, {
      text: `Created link project "${validation.value.label}".`,
      kind: "ok",
    }),
  };
}

export async function handleEditLinkProjectPost(
  request: Request,
  env: AppEnv,
  url: URL,
  user: User,
  id: number,
): Promise<{
  response?: Response;
  rerenderError?: { errors: string[]; prefill: FormPrefill; row: LinkProjectRow };
}> {
  const csrf = checkCsrf(request, url);
  if (csrf) return { response: csrf };
  const row = await loadVisibleLinkProject(env, user, id);
  if (!row) return { response: new Response("Not found", { status: 404 }) };
  const form = await request.formData();
  const raw: Record<string, string> = {};
  for (const [k, v] of form.entries()) {
    if (typeof v === "string") raw[k] = v;
  }
  const validation = validateLinkProjectInput(raw);
  if (!validation.ok) {
    return {
      rerenderError: { errors: validation.errors, prefill: rawToFormPrefill(raw), row },
    };
  }
  await updateLinkProjectRow(env, id, validation.value);
  // anchor_options + status changes ripple through every client with a
  // placement on this project, since the synthesized HTML embeds the
  // anchor text and the status gates whether the rule renders at all.
  await invalidateAfterProjectChange(env, id);
  return {
    response: flashRedirect(`/app/link-projects/${id}`, {
      text: `Saved "${validation.value.label}".`,
      kind: "ok",
    }),
  };
}

export async function handleLinkProjectStatusPost(
  request: Request,
  env: AppEnv,
  url: URL,
  user: User,
  id: number,
): Promise<Response> {
  const csrf = checkCsrf(request, url);
  if (csrf) return csrf;
  const row = await loadVisibleLinkProject(env, user, id);
  if (!row) return new Response("Not found", { status: 404 });
  const form = await request.formData();
  const requested = String(form.get("status") ?? "");
  if (!(LINK_PROJECT_STATUSES as readonly string[]).includes(requested)) {
    return flashRedirect(`/app/link-projects/${id}`, {
      text: `Invalid status: ${requested}`,
      kind: "err",
    });
  }
  await setLinkProjectStatus(env, id, requested as LinkProjectStatus);
  // Status flip changes whether the project's placements render — every
  // client with a placement on this project needs a KV recompile.
  await invalidateAfterProjectChange(env, id);
  return flashRedirect(`/app/link-projects/${id}`, {
    text: `Status set to ${requested}.`,
    kind: "ok",
  });
}

/* ─── Placements (Slices 2A + 3) ─── */

export type LinkProjectPlacementStrategy = "footer" | "selector";
export const LINK_PROJECT_PLACEMENT_STRATEGIES: readonly LinkProjectPlacementStrategy[] = [
  "footer",
  "selector",
];

export type LinkProjectPlacementPosition = "before" | "after" | "prepend" | "append";
export const LINK_PROJECT_PLACEMENT_POSITIONS: readonly LinkProjectPlacementPosition[] = [
  "before",
  "after",
  "prepend",
  "append",
];

export type LinkProjectPlacementStatus = "active" | "paused";
export const LINK_PROJECT_PLACEMENT_STATUSES: readonly LinkProjectPlacementStatus[] = [
  "active",
  "paused",
];

/** Common rel-attribute presets the form offers. Free-form values are
 *  also accepted via validation (length-capped, whitespace-collapsed). */
export const REL_PRESETS: readonly string[] = [
  "noopener",
  "noopener nofollow",
  "noopener sponsored",
  "noopener ugc",
  "noopener noreferrer",
];

/** Row shape mirroring the link_project_placements table (migrations 0004 + 0005). */
export interface LinkProjectPlacementRow {
  id: number;
  link_project_id: number;
  client_id: string;
  page_match: string;
  strategy: LinkProjectPlacementStrategy;
  /** CSS selector for `selector` strategy. NULL for `footer`. */
  target_selector: string | null;
  /** Position relative to target_selector for `selector` strategy. NULL for `footer`. */
  position: LinkProjectPlacementPosition | null;
  anchor_override: string | null;
  rel_attribute: string;
  status: LinkProjectPlacementStatus;
  created_at: string;
  updated_at: string;
}

export interface LinkProjectPlacementInput {
  client_id: string;
  page_match: string;
  strategy: LinkProjectPlacementStrategy;
  target_selector: string | null;
  position: LinkProjectPlacementPosition | null;
  anchor_override: string | null;
  rel_attribute: string;
  status: LinkProjectPlacementStatus;
}

const MAX_PAGE_MATCH_LENGTH = 512;
const MAX_ANCHOR_OVERRIDE_LENGTH = 200;
const MAX_REL_LENGTH = 100;
const MAX_TARGET_SELECTOR_LENGTH = 256;
const CLIENT_ID_PATTERN = /^[a-z0-9-]+$/;

/**
 * Validate raw form input for a placement create/edit. Returns parsed
 * input on success, list of field-level error strings on failure.
 *
 * `validClientIds` is the set of client_ids the operator can see —
 * used to enforce that placements only target clients the user owns
 * (super-admins still constrained to existing client_ids since the
 * FK doesn't cascade on client_id).
 */
export function validateLinkProjectPlacementInput(
  raw: Record<string, string>,
  validClientIds: ReadonlySet<string>,
): { ok: true; value: LinkProjectPlacementInput } | { ok: false; errors: string[] } {
  const errors: string[] = [];

  const clientId = (raw.client_id ?? "").trim();
  if (clientId.length === 0) {
    errors.push("client_id is required");
  } else if (!CLIENT_ID_PATTERN.test(clientId)) {
    errors.push("client_id must be lowercase letters, digits, or hyphens");
  } else if (!validClientIds.has(clientId)) {
    errors.push(`client_id "${clientId}" not found or not visible to you`);
  }

  // page_match — default to "all pages" if blank. Compile-check the
  // regex so we surface invalid patterns at admin-time, not request-time.
  let pageMatch = (raw.page_match ?? "").trim();
  if (pageMatch.length === 0) pageMatch = "^/.*";
  if (pageMatch.length > MAX_PAGE_MATCH_LENGTH) {
    errors.push(`page_match must be ${MAX_PAGE_MATCH_LENGTH} characters or fewer`);
  } else {
    try {
      new RegExp(pageMatch);
    } catch (e) {
      errors.push(`page_match is not a valid regex: ${(e as Error).message}`);
    }
  }

  const strategyRaw = (raw.strategy ?? "footer").trim();
  if (!(LINK_PROJECT_PLACEMENT_STRATEGIES as readonly string[]).includes(strategyRaw)) {
    errors.push(`strategy must be one of: ${LINK_PROJECT_PLACEMENT_STRATEGIES.join(", ")}`);
  }
  const strategy = strategyRaw as LinkProjectPlacementStrategy;

  // target_selector + position are required when strategy='selector',
  // ignored when strategy='footer' (which always uses body+append).
  let targetSelector: string | null = null;
  let position: LinkProjectPlacementPosition | null = null;
  if (strategy === "selector") {
    const sel = (raw.target_selector ?? "").trim();
    if (sel.length === 0) {
      errors.push("target_selector is required when strategy is 'selector'");
    } else if (sel.length > MAX_TARGET_SELECTOR_LENGTH) {
      errors.push(`target_selector must be ${MAX_TARGET_SELECTOR_LENGTH} characters or fewer`);
    } else {
      targetSelector = sel;
    }
    const posRaw = (raw.position ?? "").trim();
    if (posRaw.length === 0) {
      errors.push("position is required when strategy is 'selector'");
    } else if (!(LINK_PROJECT_PLACEMENT_POSITIONS as readonly string[]).includes(posRaw)) {
      errors.push(`position must be one of: ${LINK_PROJECT_PLACEMENT_POSITIONS.join(", ")}`);
    } else {
      position = posRaw as LinkProjectPlacementPosition;
    }
  }
  // For strategy='footer', target_selector/position stay null and the
  // synthesizer plugs in body+append at render time.

  const anchorOverrideRaw = (raw.anchor_override ?? "").trim();
  let anchorOverride: string | null = null;
  if (anchorOverrideRaw.length > MAX_ANCHOR_OVERRIDE_LENGTH) {
    errors.push(`anchor_override must be ${MAX_ANCHOR_OVERRIDE_LENGTH} characters or fewer`);
  } else if (anchorOverrideRaw.length > 0) {
    anchorOverride = anchorOverrideRaw;
  }

  // rel_attribute — collapse whitespace, length-cap. Don't restrict to
  // a fixed enum (HTML's link types are open-ended and search engines
  // honour combinations like "nofollow sponsored ugc").
  const relRaw = (raw.rel_attribute ?? "").trim().replace(/\s+/g, " ");
  const relAttribute = relRaw.length === 0 ? "noopener" : relRaw;
  if (relAttribute.length > MAX_REL_LENGTH) {
    errors.push(`rel_attribute must be ${MAX_REL_LENGTH} characters or fewer`);
  }

  const statusRaw = (raw.status ?? "active").trim();
  if (!(LINK_PROJECT_PLACEMENT_STATUSES as readonly string[]).includes(statusRaw)) {
    errors.push(`status must be one of: ${LINK_PROJECT_PLACEMENT_STATUSES.join(", ")}`);
  }
  const status = statusRaw as LinkProjectPlacementStatus;

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      client_id: clientId,
      page_match: pageMatch,
      strategy,
      target_selector: targetSelector,
      position,
      anchor_override: anchorOverride,
      rel_attribute: relAttribute,
      status,
    },
  };
}

export async function loadPlacementsForProject(
  env: AppEnv,
  linkProjectId: number,
): Promise<LinkProjectPlacementRow[]> {
  const r = await env.CONFIG_DB.prepare(
    "SELECT * FROM link_project_placements WHERE link_project_id = ? ORDER BY id DESC",
  )
    .bind(linkProjectId)
    .all<LinkProjectPlacementRow>();
  return r.results ?? [];
}

async function loadPlacement(
  env: AppEnv,
  linkProjectId: number,
  placementId: number,
): Promise<LinkProjectPlacementRow | null> {
  return env.CONFIG_DB.prepare(
    "SELECT * FROM link_project_placements WHERE id = ? AND link_project_id = ? LIMIT 1",
  )
    .bind(placementId, linkProjectId)
    .first<LinkProjectPlacementRow>();
}

async function insertPlacement(
  env: AppEnv,
  linkProjectId: number,
  input: LinkProjectPlacementInput,
): Promise<void> {
  await env.CONFIG_DB.prepare(
    `INSERT INTO link_project_placements
       (link_project_id, client_id, page_match, strategy, target_selector,
        position, anchor_override, rel_attribute, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      linkProjectId,
      input.client_id,
      input.page_match,
      input.strategy,
      input.target_selector,
      input.position,
      input.anchor_override,
      input.rel_attribute,
      input.status,
    )
    .run();
}

async function updatePlacement(
  env: AppEnv,
  linkProjectId: number,
  placementId: number,
  input: LinkProjectPlacementInput,
): Promise<void> {
  await env.CONFIG_DB.prepare(
    `UPDATE link_project_placements
       SET client_id = ?, page_match = ?, strategy = ?, target_selector = ?,
           position = ?, anchor_override = ?, rel_attribute = ?, status = ?,
           updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND link_project_id = ?`,
  )
    .bind(
      input.client_id,
      input.page_match,
      input.strategy,
      input.target_selector,
      input.position,
      input.anchor_override,
      input.rel_attribute,
      input.status,
      placementId,
      linkProjectId,
    )
    .run();
}

async function deletePlacement(
  env: AppEnv,
  linkProjectId: number,
  placementId: number,
): Promise<void> {
  await env.CONFIG_DB.prepare(
    "DELETE FROM link_project_placements WHERE id = ? AND link_project_id = ?",
  )
    .bind(placementId, linkProjectId)
    .run();
}

/* ─── Placement renderers ─── */

interface PlacementFormPrefill {
  client_id: string;
  page_match: string;
  strategy: LinkProjectPlacementStrategy;
  target_selector: string;
  position: LinkProjectPlacementPosition;
  anchor_override: string;
  rel_attribute: string;
  status: LinkProjectPlacementStatus;
}

function emptyPlacementPrefill(): PlacementFormPrefill {
  return {
    client_id: "",
    page_match: "^/.*",
    strategy: "footer",
    target_selector: "",
    position: "after",
    anchor_override: "",
    rel_attribute: "noopener",
    status: "active",
  };
}

function placementRowToPrefill(row: LinkProjectPlacementRow): PlacementFormPrefill {
  return {
    client_id: row.client_id,
    page_match: row.page_match,
    strategy: row.strategy,
    target_selector: row.target_selector ?? "",
    position: row.position ?? "after",
    anchor_override: row.anchor_override ?? "",
    rel_attribute: row.rel_attribute,
    status: row.status,
  };
}

function rawToPlacementPrefill(raw: Record<string, string>): PlacementFormPrefill {
  const strategy = (LINK_PROJECT_PLACEMENT_STRATEGIES as readonly string[]).includes(
    raw.strategy ?? "",
  )
    ? (raw.strategy as LinkProjectPlacementStrategy)
    : "footer";
  const position = (LINK_PROJECT_PLACEMENT_POSITIONS as readonly string[]).includes(
    raw.position ?? "",
  )
    ? (raw.position as LinkProjectPlacementPosition)
    : "after";
  const status = (LINK_PROJECT_PLACEMENT_STATUSES as readonly string[]).includes(raw.status ?? "")
    ? (raw.status as LinkProjectPlacementStatus)
    : "active";
  return {
    client_id: raw.client_id ?? "",
    page_match: raw.page_match ?? "^/.*",
    strategy,
    target_selector: raw.target_selector ?? "",
    position,
    anchor_override: raw.anchor_override ?? "",
    rel_attribute: raw.rel_attribute ?? "noopener",
    status,
  };
}

function placementStatusPill(status: LinkProjectPlacementStatus): string {
  return `<span class="pill ${status === "active" ? "pill-active" : "pill-paused"}">${esc(status)}</span>`;
}

function renderPlacementForm(opts: {
  action: string;
  submitLabel: string;
  prefill: PlacementFormPrefill;
  visibleClients: ClientRow[];
  errors: string[];
  isEdit: boolean;
}): string {
  const errBox =
    opts.errors.length > 0 ? `<div class="error-box">${opts.errors.map(esc).join("\n")}</div>` : "";
  const clientOptions = opts.visibleClients
    .map(
      (c) =>
        `<option value="${esc(c.client_id)}"${c.client_id === opts.prefill.client_id ? " selected" : ""}>${esc(c.client_id)}</option>`,
    )
    .join("");
  const strategyOptions = LINK_PROJECT_PLACEMENT_STRATEGIES.map(
    (s) =>
      `<option value="${esc(s)}"${s === opts.prefill.strategy ? " selected" : ""}>${esc(s)}</option>`,
  ).join("");
  const positionOptions = LINK_PROJECT_PLACEMENT_POSITIONS.map(
    (p) =>
      `<option value="${esc(p)}"${p === opts.prefill.position ? " selected" : ""}>${esc(p)}</option>`,
  ).join("");
  const statusOptions = LINK_PROJECT_PLACEMENT_STATUSES.map(
    (s) =>
      `<option value="${esc(s)}"${s === opts.prefill.status ? " selected" : ""}>${esc(s)}</option>`,
  ).join("");
  const relDatalistOptions = REL_PRESETS.map((r) => `<option value="${esc(r)}">`).join("");
  // Selector-strategy fields hide when strategy=footer. Initial display
  // is set inline so the form doesn't flash the wrong state on render;
  // the inline JS below toggles on change.
  const selectorFieldsDisplay = opts.prefill.strategy === "selector" ? "" : "display:none;";
  return `${errBox}
    <form class="editor" method="POST" action="${esc(opts.action)}">
      <div class="form-section">
        <h2 style="margin-top:0">${opts.isEdit ? "Edit placement" : "New placement"}</h2>
        <div class="form-grid">
          <div>
            <label for="lpp_client_id">site</label>
            <select id="lpp_client_id" name="client_id" required>
              <option value="">— pick a site —</option>
              ${clientOptions}
            </select>
            <div class="field-hint">Which proxied site this placement runs on. Only sites you own are listed.</div>
          </div>
          <div>
            <label for="lpp_status">status</label>
            <select id="lpp_status" name="status">${statusOptions}</select>
            <div class="field-hint">A placement runs only when its parent project AND the placement itself are active.</div>
          </div>
          <div class="full-width">
            <label for="lpp_page_match">page_match</label>
            <input id="lpp_page_match" name="page_match" type="text" value="${esc(opts.prefill.page_match)}" placeholder="^/.*">
            <div class="field-hint">Regex tested against the request path. Default <code>^/.*</code> matches every page. Use <code>^/$</code> for homepage only or <code>^/blog/.*</code> for /blog and below.</div>
          </div>
          <div>
            <label for="lpp_strategy">strategy</label>
            <select id="lpp_strategy" name="strategy">${strategyOptions}</select>
            <div class="field-hint"><strong>footer:</strong> appends to <code>&lt;body&gt;</code>, link sits at the very bottom of the page. <strong>selector:</strong> custom CSS selector + position — for inline contextual links (after first paragraph, inside footer, etc.).</div>
          </div>
          <div>
            <label for="lpp_rel_attribute">rel attribute</label>
            <input id="lpp_rel_attribute" name="rel_attribute" type="text" list="lpp_rel_presets" value="${esc(opts.prefill.rel_attribute)}" maxlength="100">
            <datalist id="lpp_rel_presets">${relDatalistOptions}</datalist>
            <div class="field-hint">Space-separated link types. Default <code>noopener</code> for security; add <code>nofollow</code> or <code>sponsored</code> when SEO context calls for it.</div>
          </div>
          <div class="full-width lpp-selector-fields" style="${selectorFieldsDisplay}">
            <label for="lpp_target_selector">target_selector <span style="color:var(--fg-muted);font-weight:400">(required for strategy=selector)</span></label>
            <input id="lpp_target_selector" name="target_selector" type="text" value="${esc(opts.prefill.target_selector)}" maxlength="256" placeholder="article p:first-of-type">
            <div class="field-hint">CSS selector for the element this placement injects relative to. Use the inspector on the source page to find selectors that survive across edits.</div>
          </div>
          <div class="lpp-selector-fields" style="${selectorFieldsDisplay}">
            <label for="lpp_position">position</label>
            <select id="lpp_position" name="position">${positionOptions}</select>
            <div class="field-hint"><strong>after:</strong> sibling after the matched element (most common for "link after first paragraph"). <strong>before:</strong> sibling before. <strong>append/prepend:</strong> last/first child <em>inside</em> the matched element.</div>
          </div>
          <div class="full-width">
            <label for="lpp_anchor_override">anchor_override <span style="color:var(--fg-muted);font-weight:400">(optional)</span></label>
            <input id="lpp_anchor_override" name="anchor_override" type="text" value="${esc(opts.prefill.anchor_override)}" maxlength="200" placeholder="leave blank to rotate through the project's anchor_options">
            <div class="field-hint">If set, this placement uses this exact anchor text. If blank, the synthesizer rotates across the project's <code>anchor_options</code> deterministically by placement+page (same URL always shows the same anchor).</div>
          </div>
        </div>
        <script>
        (function(){
          var s = document.getElementById('lpp_strategy');
          if (!s) return;
          var fields = document.querySelectorAll('.lpp-selector-fields');
          function sync(){
            for (var i = 0; i < fields.length; i++) {
              fields[i].style.display = s.value === 'selector' ? '' : 'none';
            }
          }
          s.addEventListener('change', sync);
          sync();
        })();
        </script>
      </div>
      <div class="form-actions">
        <button class="btn btn-primary" type="submit">${esc(opts.submitLabel)}</button>
      </div>
    </form>`;
}

function renderPlacementsSection(
  project: LinkProjectRow,
  placements: LinkProjectPlacementRow[],
  visibleClients: ClientRow[],
  visibleClusters: readonly ClusterRow[] = [],
  clusterMembers: ReadonlyMap<number, readonly string[]> = new Map(),
): string {
  const visibleIds = new Set(visibleClients.map((c) => c.client_id));
  const projectAnchors = parseAnchorOptions(project.anchor_options);
  const rows = placements
    .map((p) => {
      const orphan = !visibleIds.has(p.client_id);
      const clientCell = orphan
        ? `<span class="mono" style="color:var(--fg-muted)" title="client not visible to you">${esc(p.client_id)} ⚠</span>`
        : `<a class="mono" href="/app/clients/${esc(p.client_id)}">${esc(p.client_id)}</a>`;
      const anchorCell = p.anchor_override
        ? `<span class="mono">${esc(p.anchor_override)}</span>`
        : `<span style="color:var(--fg-muted);font-style:italic">rotated</span>`;
      // For selector strategy, show "selector @ position" instead of
      // bare strategy name so the table tells the operator where the
      // link will land at a glance.
      const strategyCell =
        p.strategy === "selector" && p.target_selector && p.position
          ? `<span class="mono" style="font-size:.8rem">${esc(p.target_selector)} <span style="color:var(--fg-muted)">@ ${esc(p.position)}</span></span>`
          : esc(p.strategy);
      return `<tr>
        <td>${clientCell}</td>
        <td class="mono">${esc(p.page_match)}</td>
        <td>${strategyCell}</td>
        <td>${anchorCell}</td>
        <td class="mono" style="font-size:.8rem">${esc(p.rel_attribute)}</td>
        <td>${placementStatusPill(p.status)}</td>
        <td style="white-space:nowrap">
          <a class="btn-link" href="/app/link-projects/${project.id}/placements/${p.id}/edit">Edit</a>
          <form method="POST" action="/app/link-projects/${project.id}/placements/${p.id}/delete" style="display:inline" onclick="return confirm('Delete this placement?')">
            <button type="submit" class="btn-link" style="color:var(--red);background:none;border:none;cursor:pointer;font:inherit;padding:0;margin-left:.5rem">Delete</button>
          </form>
        </td>
      </tr>`;
    })
    .join("");
  const tableOrEmpty =
    placements.length === 0
      ? `<div class="empty">No placements yet. Add one below to start tracking which proxied client sites should push this target.</div>`
      : `<table class="data" style="margin-bottom:1rem">
          <thead><tr><th>Client</th><th>page_match</th><th>strategy / selector</th><th>anchor</th><th>rel</th><th>status</th><th></th></tr></thead>
          <tbody>${rows}</tbody>
        </table>`;
  if (visibleClients.length === 0) {
    return `<div class="card">
      <h2 style="margin-top:0">Placements</h2>
      <p class="field-hint" style="margin:0">You don't have any clients to attach placements to yet. Create a client first.</p>
    </div>`;
  }
  const anchorBlurb =
    projectAnchors.length === 0
      ? `Default anchor will be the target URL itself <span style="color:var(--fg-muted)">(no <code>anchor_options</code> set on this project — add some to use anchor rotation)</span>.`
      : projectAnchors.length === 1
        ? `Default anchor will be <code>${esc(projectAnchors[0] ?? "")}</code>.`
        : `Anchors rotate across the project's <strong>${projectAnchors.length}</strong> options deterministically (same URL always shows the same anchor; diversity emerges across placements). Set <code>anchor_override</code> on a placement to pin a specific anchor.`;
  // Bulk apply lives in a collapsed <details> block so it doesn't
  // clutter the single-add path. The form structure mirrors the single-
  // add form one section at a time, with a checkbox grid replacing the
  // single client picker.
  const placedClients = new Set(placements.map((p) => p.client_id));
  const bulkClientCheckboxes = visibleClients
    .map((c) => {
      const already = placedClients.has(c.client_id);
      const note = already
        ? ` <span style="color:var(--fg-muted);font-size:.7rem">(already has placement)</span>`
        : "";
      // Pre-check clients that DON'T already have a placement — that's
      // usually what the operator wants when bulk-applying. They can
      // still uncheck individuals.
      const checked = already ? "" : " checked";
      return `<label class="checkbox-inline" style="display:flex;gap:.4rem;align-items:center">
        <input type="checkbox" name="client_ids" value="${esc(c.client_id)}"${checked}>
        <span class="mono" style="font-size:.85rem">${esc(c.client_id)}</span>${note}
      </label>`;
    })
    .join("");
  const bulkPositionOptions = LINK_PROJECT_PLACEMENT_POSITIONS.map(
    (p) => `<option value="${esc(p)}"${p === "after" ? " selected" : ""}>${esc(p)}</option>`,
  ).join("");
  const bulkStrategyOptions = LINK_PROJECT_PLACEMENT_STRATEGIES.map(
    (s) => `<option value="${esc(s)}"${s === "footer" ? " selected" : ""}>${esc(s)}</option>`,
  ).join("");
  const bulkRelDatalist = REL_PRESETS.map((r) => `<option value="${esc(r)}">`).join("");
  // Cluster picker — pre-fills the checkbox grid with a cluster's
  // member sites. Additive: picking another cluster adds its members
  // to the current selection. Operator can still uncheck individuals.
  const clusterOptions = visibleClusters
    .filter((c) => c.status === "active")
    .map((c) => {
      const memberCount = clusterMembers.get(c.id)?.length ?? 0;
      return `<option value="${c.id}">${esc(c.label)} (${esc(c.type)}, ${memberCount} site${memberCount === 1 ? "" : "s"})</option>`;
    })
    .join("");
  // Embed the (cluster_id → member_ids) map as JSON so the inline JS
  // doesn't need a server round-trip per cluster pick. JSON.stringify
  // a plain object built from the Map.
  const clusterMembersJson = JSON.stringify(
    Object.fromEntries(Array.from(clusterMembers.entries())),
  );
  const clusterPickerHtml =
    visibleClusters.length === 0
      ? ""
      : `<div style="display:flex;gap:.5rem;align-items:end;flex-wrap:wrap;margin-bottom:.75rem">
          <div style="flex:1;min-width:240px">
            <label for="bulk_cluster_picker" style="font-weight:600;font-size:.78rem;display:block;margin-bottom:.2rem">Use a cluster's sites</label>
            <select id="bulk_cluster_picker" style="font:inherit;font-size:.88rem;padding:.4rem .55rem;border:1px solid var(--border-strong);border-radius:var(--radius);background:var(--bg);color:var(--fg);width:100%">
              <option value="">— pick a cluster —</option>
              ${clusterOptions}
            </select>
          </div>
          <button type="button" id="bulk_cluster_use" class="btn btn-primary">Use this cluster</button>
          <button type="button" id="bulk_cluster_add" class="btn" title="Add this cluster's members on top of the current selection (don't replace)">+ Add to selection</button>
        </div>
        <p class="field-hint" style="margin:0 0 .6rem"><strong>Use this cluster</strong> replaces the current selection with the cluster's member sites. <strong>+ Add to selection</strong> layers a cluster on top of what's already checked (useful when combining clusters).</p>`;
  const bulkSection =
    visibleClients.length < 2
      ? "" // single-client owner — no point offering bulk
      : `<details style="margin-top:1.25rem;background:var(--bg-elevated);border:1px solid var(--border);border-radius:var(--radius);padding:.75rem 1rem">
          <summary style="cursor:pointer;font-weight:600">Bulk apply — create placements on multiple clients at once</summary>
          <p class="field-hint" style="margin:.6rem 0 .8rem">Same defaults are applied to every selected site. Sites that already have a placement on this project are listed but unchecked by default — you can still re-add (each becomes its own row, useful for different page_matches).</p>
          <form class="editor" method="POST" action="/app/link-projects/${project.id}/placements/bulk-new">
            <div class="form-section">
              <h2 style="margin-top:0">Clients</h2>
              ${clusterPickerHtml}
              <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:.4rem">${bulkClientCheckboxes}</div>
            </div>
            <div class="form-section">
              <h2 style="margin-top:0">Shared defaults</h2>
              <div class="form-grid">
                <div>
                  <label for="bulk_strategy">strategy</label>
                  <select id="bulk_strategy" name="strategy">${bulkStrategyOptions}</select>
                </div>
                <div>
                  <label for="bulk_status">status</label>
                  <select id="bulk_status" name="status"><option value="active" selected>active</option><option value="paused">paused</option></select>
                </div>
                <div class="full-width">
                  <label for="bulk_page_match">page_match</label>
                  <input id="bulk_page_match" name="page_match" type="text" value="^/.*">
                </div>
                <div class="full-width bulk-selector-fields" style="display:none">
                  <label for="bulk_target_selector">target_selector</label>
                  <input id="bulk_target_selector" name="target_selector" type="text" maxlength="256" placeholder="article p:first-of-type">
                </div>
                <div class="bulk-selector-fields" style="display:none">
                  <label for="bulk_position">position</label>
                  <select id="bulk_position" name="position">${bulkPositionOptions}</select>
                </div>
                <div>
                  <label for="bulk_rel">rel attribute</label>
                  <input id="bulk_rel" name="rel_attribute" type="text" list="bulk_rel_presets" value="noopener" maxlength="100">
                  <datalist id="bulk_rel_presets">${bulkRelDatalist}</datalist>
                </div>
                <div class="full-width">
                  <label for="bulk_anchor_override">anchor_override <span style="color:var(--fg-muted);font-weight:400">(optional — leave blank for rotation)</span></label>
                  <input id="bulk_anchor_override" name="anchor_override" type="text" maxlength="200" placeholder="leave blank to rotate across the project's anchor_options">
                </div>
              </div>
            </div>
            <div class="form-actions">
              <button class="btn btn-primary" type="submit">Create placements</button>
            </div>
          </form>
          <script>
          (function(){
            var s = document.getElementById('bulk_strategy');
            if (s) {
              var fields = document.querySelectorAll('.bulk-selector-fields');
              function syncStrategy(){
                for (var i = 0; i < fields.length; i++) {
                  fields[i].style.display = s.value === 'selector' ? '' : 'none';
                }
              }
              s.addEventListener('change', syncStrategy);
              syncStrategy();
            }
            // Cluster picker — two modes:
            //   "Use this cluster"   = REPLACE selection with cluster members
            //   "+ Add to selection" = ADD cluster members on top of current
            // Both share the same per-id matching logic; the replace mode
            // first unchecks everything, then runs the add path.
            var picker = document.getElementById('bulk_cluster_picker');
            var useBtn = document.getElementById('bulk_cluster_use');
            var addBtn = document.getElementById('bulk_cluster_add');
            if (picker && (useBtn || addBtn)) {
              var members = ${clusterMembersJson};
              function applyCluster(replace, btn, defaultLabel) {
                var clusterId = picker.value;
                if (!clusterId) return;
                var ids = members[clusterId] || [];
                var checks = document.querySelectorAll('input[name="client_ids"]');
                if (replace) {
                  for (var k = 0; k < checks.length; k++) checks[k].checked = false;
                }
                var checkedNow = 0;
                var missing = [];
                for (var i = 0; i < ids.length; i++) {
                  var id = ids[i];
                  var found = false;
                  for (var j = 0; j < checks.length; j++) {
                    if (checks[j].value === id) {
                      if (!checks[j].checked) {
                        checks[j].checked = true;
                      }
                      checkedNow += 1;
                      found = true;
                      break;
                    }
                  }
                  if (!found) missing.push(id);
                }
                var msg = (replace ? checkedNow : '+' + checkedNow) + ' checked';
                if (missing.length > 0) msg += ' (' + missing.length + ' not visible: ' + missing.join(', ') + ')';
                btn.textContent = msg;
                setTimeout(function(){ btn.textContent = defaultLabel; }, 3000);
              }
              if (useBtn) useBtn.addEventListener('click', function(){
                applyCluster(true, useBtn, 'Use this cluster');
              });
              if (addBtn) addBtn.addEventListener('click', function(){
                applyCluster(false, addBtn, '+ Add to selection');
              });
            }
          })();
          </script>
        </details>`;
  return `<div class="card">
    <h2 style="margin-top:0">Placements</h2>
    <p class="field-hint" style="margin:.2rem 0 .8rem">Each placement says "inject a link to <code>${esc(project.target_url)}</code> on this site's pages matching the regex." ${anchorBlurb}</p>
    ${tableOrEmpty}
    ${renderPlacementForm({
      action: `/app/link-projects/${project.id}/placements/new`,
      submitLabel: "Add placement",
      prefill: emptyPlacementPrefill(),
      visibleClients,
      errors: [],
      isEdit: false,
    })}
    ${bulkSection}
  </div>`;
}

export function renderEditPlacementPage(
  project: LinkProjectRow,
  placement: LinkProjectPlacementRow,
  visibleClients: ClientRow[],
  prefill: PlacementFormPrefill | null,
  errors: string[] = [],
): string {
  return `<div class="crumbs"><a href="/app/link-projects/${project.id}">← ${esc(project.label)}</a></div>
    <h1>Edit placement</h1>
    <p class="subtitle">Editing placement ${placement.id} on link project <strong>${esc(project.label)}</strong>.</p>
    ${renderPlacementForm({
      action: `/app/link-projects/${project.id}/placements/${placement.id}/edit`,
      submitLabel: "Save",
      prefill: prefill ?? placementRowToPrefill(placement),
      visibleClients,
      errors,
      isEdit: true,
    })}`;
}

/* ─── Placement POST handlers ─── */

async function visibleClientIdSet(env: AppEnv, user: User): Promise<Set<string>> {
  const clients = await loadVisibleClients(env, user);
  return new Set(clients.map((c) => c.client_id));
}

export async function handleNewPlacementPost(
  request: Request,
  env: AppEnv,
  url: URL,
  user: User,
  linkProjectId: number,
): Promise<Response> {
  const csrf = checkCsrf(request, url);
  if (csrf) return csrf;
  const project = await loadVisibleLinkProject(env, user, linkProjectId);
  if (!project) return new Response("Not found", { status: 404 });
  const form = await request.formData();
  const raw: Record<string, string> = {};
  for (const [k, v] of form.entries()) {
    if (typeof v === "string") raw[k] = v;
  }
  const validIds = await visibleClientIdSet(env, user);
  const validation = validateLinkProjectPlacementInput(raw, validIds);
  if (!validation.ok) {
    return flashRedirect(`/app/link-projects/${linkProjectId}`, {
      text: `Could not add placement: ${validation.errors.join("; ")}`,
      kind: "err",
    });
  }
  await insertPlacement(env, linkProjectId, validation.value);
  await invalidateAfterPlacementChange(env, [validation.value.client_id]);
  await writeLinkProjectAudit(
    env,
    user,
    request,
    validation.value.client_id,
    `link_project_placement_create: project=${linkProjectId} match=${validation.value.page_match} strategy=${validation.value.strategy} status=${validation.value.status}`,
  );
  return flashRedirect(`/app/link-projects/${linkProjectId}`, {
    text: `Added placement on ${validation.value.client_id}.`,
    kind: "ok",
  });
}

export async function handleEditPlacementPost(
  request: Request,
  env: AppEnv,
  url: URL,
  user: User,
  linkProjectId: number,
  placementId: number,
): Promise<{
  response?: Response;
  rerenderError?: {
    project: LinkProjectRow;
    placement: LinkProjectPlacementRow;
    prefill: PlacementFormPrefill;
    errors: string[];
    visibleClients: ClientRow[];
  };
}> {
  const csrf = checkCsrf(request, url);
  if (csrf) return { response: csrf };
  const project = await loadVisibleLinkProject(env, user, linkProjectId);
  if (!project) return { response: new Response("Not found", { status: 404 }) };
  const placement = await loadPlacement(env, linkProjectId, placementId);
  if (!placement) return { response: new Response("Not found", { status: 404 }) };
  const form = await request.formData();
  const raw: Record<string, string> = {};
  for (const [k, v] of form.entries()) {
    if (typeof v === "string") raw[k] = v;
  }
  const visibleClients = await loadVisibleClients(env, user);
  const validIds = new Set(visibleClients.map((c) => c.client_id));
  const validation = validateLinkProjectPlacementInput(raw, validIds);
  if (!validation.ok) {
    return {
      rerenderError: {
        project,
        placement,
        prefill: rawToPlacementPrefill(raw),
        errors: validation.errors,
        visibleClients,
      },
    };
  }
  await updatePlacement(env, linkProjectId, placementId, validation.value);
  // If the operator moved the placement to a different client, BOTH
  // need re-compile: the source loses a rule, the target gains one.
  // Dedupe in case it didn't change.
  const affected = Array.from(new Set([placement.client_id, validation.value.client_id]));
  await invalidateAfterPlacementChange(env, affected);
  // Audit on each affected client. Two entries when the placement
  // moved between clients (one "left" the source, one "arrived" on
  // the target) — distinct enough that the audit log shows both halves.
  if (placement.client_id === validation.value.client_id) {
    await writeLinkProjectAudit(
      env,
      user,
      request,
      validation.value.client_id,
      `link_project_placement_update: project=${linkProjectId} placement=${placementId} match=${validation.value.page_match} strategy=${validation.value.strategy} status=${validation.value.status}`,
    );
  } else {
    await writeLinkProjectAudit(
      env,
      user,
      request,
      placement.client_id,
      `link_project_placement_moved_out: placement=${placementId} → client=${validation.value.client_id}`,
    );
    await writeLinkProjectAudit(
      env,
      user,
      request,
      validation.value.client_id,
      `link_project_placement_moved_in: project=${linkProjectId} placement=${placementId} from=${placement.client_id} match=${validation.value.page_match}`,
    );
  }
  return {
    response: flashRedirect(`/app/link-projects/${linkProjectId}`, {
      text: `Saved placement ${placementId}.`,
      kind: "ok",
    }),
  };
}

export async function handleDeletePlacementPost(
  request: Request,
  env: AppEnv,
  url: URL,
  user: User,
  linkProjectId: number,
  placementId: number,
): Promise<Response> {
  const csrf = checkCsrf(request, url);
  if (csrf) return csrf;
  const project = await loadVisibleLinkProject(env, user, linkProjectId);
  if (!project) return new Response("Not found", { status: 404 });
  const placement = await loadPlacement(env, linkProjectId, placementId);
  if (!placement) {
    return flashRedirect(`/app/link-projects/${linkProjectId}`, {
      text: "Placement not found (already deleted?)",
      kind: "warn",
    });
  }
  await deletePlacement(env, linkProjectId, placementId);
  await invalidateAfterPlacementChange(env, [placement.client_id]);
  await writeLinkProjectAudit(
    env,
    user,
    request,
    placement.client_id,
    `link_project_placement_delete: project=${linkProjectId} placement=${placementId} match=${placement.page_match}`,
  );
  return flashRedirect(`/app/link-projects/${linkProjectId}`, {
    text: `Deleted placement on ${placement.client_id}.`,
    kind: "ok",
  });
}

/**
 * POST handler for the "Check target URL" button. Probes target_url,
 * formats a one-line summary as flash, and redirects back to the
 * detail page. Result isn't persisted — clicking again re-checks.
 */
export async function handleCheckTargetPost(
  request: Request,
  env: AppEnv,
  url: URL,
  user: User,
  linkProjectId: number,
): Promise<Response> {
  const csrf = checkCsrf(request, url);
  if (csrf) return csrf;
  const project = await loadVisibleLinkProject(env, user, linkProjectId);
  if (!project) return new Response("Not found", { status: 404 });
  const result = await checkTargetUrl(project.target_url);
  const summary = formatCheckResult(result, project.target_url);
  const kind: FlashMessage["kind"] = result.reachable
    ? "ok"
    : result.error || result.status >= 400
      ? "err"
      : "warn";
  return flashRedirect(`/app/link-projects/${linkProjectId}`, { text: summary, kind });
}

/** Format a target-check result as a flash-friendly one-line summary. */
function formatCheckResult(result: TargetUrlCheckResult, requestedUrl: string): string {
  if (result.error) {
    return `Target check failed: ${result.error} (${result.durationMs}ms)`;
  }
  const ms = result.durationMs;
  const hops = result.redirectCount;
  const hopSuffix =
    hops === 0 ? "" : ` after ${hops} redirect${hops === 1 ? "" : "s"} → ${result.finalUrl}`;
  if (result.reachable) {
    return `Target check: ${result.status} OK${hopSuffix} (${ms}ms)`;
  }
  return `Target check: HTTP ${result.status}${hopSuffix} — not 2xx (${ms}ms, requested ${requestedUrl})`;
}

/**
 * POST handler for bulk-apply. Validates shared fields, then iterates
 * over the selected client_ids creating one placement per client. KV
 * compile + cache purge run once per affected client at the end.
 *
 * Skips clients that already have a placement on this project with the
 * SAME page_match — adding the same placement twice would be a no-op
 * at injection time but creates clutter in the table. Different
 * page_match is fine (the operator might want one placement on the
 * homepage and another on /blog/.*).
 */
export async function handleBulkPlacementPost(
  request: Request,
  env: AppEnv,
  url: URL,
  user: User,
  linkProjectId: number,
): Promise<Response> {
  const csrf = checkCsrf(request, url);
  if (csrf) return csrf;
  const project = await loadVisibleLinkProject(env, user, linkProjectId);
  if (!project) return new Response("Not found", { status: 404 });
  const form = await request.formData();
  const raw: Record<string, string> = {};
  const selectedClientIds: string[] = [];
  for (const [k, v] of form.entries()) {
    if (typeof v !== "string") continue;
    if (k === "client_ids") {
      selectedClientIds.push(v);
    } else {
      raw[k] = v;
    }
  }
  const visibleClients = await loadVisibleClients(env, user);
  const validIds = new Set(visibleClients.map((c) => c.client_id));
  const validation = validateBulkPlacementInput(raw, selectedClientIds, validIds);
  if (!validation.ok) {
    return flashRedirect(`/app/link-projects/${linkProjectId}`, {
      text: `Bulk apply failed: ${validation.errors.join("; ")}`,
      kind: "err",
    });
  }
  // Skip client+page_match pairs that already exist (idempotent re-apply
  // friendly). Lookup is one query against the in-memory placements list
  // since we just loaded it would be cleaner — but bulk apply is rare,
  // so a small targeted query is fine.
  const existing = await env.CONFIG_DB.prepare(
    "SELECT client_id FROM link_project_placements WHERE link_project_id = ? AND page_match = ?",
  )
    .bind(linkProjectId, validation.value.page_match)
    .all<{ client_id: string }>();
  const skipSet = new Set((existing.results ?? []).map((r) => r.client_id));
  const toCreate = validation.value.client_ids.filter((c) => !skipSet.has(c));
  if (toCreate.length === 0) {
    return flashRedirect(`/app/link-projects/${linkProjectId}`, {
      text: `No new placements created — every selected site already has a placement on this project for page_match "${validation.value.page_match}".`,
      kind: "warn",
    });
  }
  // Sequential inserts keep autoincrement IDs predictable in the
  // audit log and avoid hammering D1 with parallel writes for what's
  // typically a small N (<20 clients). KV compile happens once per
  // client AFTER all inserts complete.
  for (const clientId of toCreate) {
    await insertPlacement(env, linkProjectId, {
      client_id: clientId,
      page_match: validation.value.page_match,
      strategy: validation.value.strategy,
      target_selector: validation.value.target_selector,
      position: validation.value.position,
      anchor_override: validation.value.anchor_override,
      rel_attribute: validation.value.rel_attribute,
      status: validation.value.status,
    });
  }
  await invalidateAfterPlacementChange(env, toCreate);
  // One audit entry per client created — useful when scanning the audit
  // log for "what changed on client X". The bulk-apply origin is encoded
  // in the notes prefix so they're searchable.
  for (const clientId of toCreate) {
    await writeLinkProjectAudit(
      env,
      user,
      request,
      clientId,
      `link_project_placement_bulk_create: project=${linkProjectId} match=${validation.value.page_match} strategy=${validation.value.strategy} batch_size=${toCreate.length}`,
    );
  }
  const skippedNote =
    skipSet.size > 0
      ? ` (skipped ${skipSet.size} clients that already had a placement for that page_match)`
      : "";
  return flashRedirect(`/app/link-projects/${linkProjectId}`, {
    text: `Created ${toCreate.length} placement${toCreate.length === 1 ? "" : "s"}: ${toCreate.join(", ")}${skippedNote}.`,
    kind: "ok",
  });
}

/** Loader used by the detail-page route — convenience wrapper. */
export async function loadProjectPageData(
  env: AppEnv,
  user: User,
  linkProjectId: number,
): Promise<{
  project: LinkProjectRow;
  placements: LinkProjectPlacementRow[];
  visibleClients: ClientRow[];
  /** Clusters the operator owns — used to populate the "Pre-fill from cluster" picker. */
  visibleClusters: ClusterRow[];
  /** cluster_id → list of member client_ids. Drives the inline JS that
   *  additively checks placement-form checkboxes when a cluster is picked. */
  clusterMembers: Map<number, string[]>;
} | null> {
  const project = await loadVisibleLinkProject(env, user, linkProjectId);
  if (!project) return null;
  const [placements, visibleClients, visibleClusters] = await Promise.all([
    loadPlacementsForProject(env, linkProjectId),
    loadVisibleClients(env, user),
    loadVisibleClusters(env, user),
  ]);
  const clusterMembers = await loadAllClusterMembersByCluster(
    env,
    visibleClusters.map((c) => c.id),
  );
  return { project, placements, visibleClients, visibleClusters, clusterMembers };
}

/* ─── Slice 4: reporting + broken-link check + bulk apply ─── */

export interface ProjectStats {
  totalPlacements: number;
  activePlacements: number;
  pausedPlacements: number;
  /** Distinct client_ids appearing in placements (regardless of status). */
  distinctClientCount: number;
  /** Same set, as a sorted list — handy for the UI summary. */
  distinctClients: string[];
}

/**
 * Aggregate placement stats for a project. Pure derivation from the
 * placements list, kept as a separate function so the detail-page
 * route can compute it without re-querying D1 and so unit tests can
 * exercise it directly.
 */
export function aggregateProjectStats(
  placements: readonly LinkProjectPlacementRow[],
): ProjectStats {
  let active = 0;
  let paused = 0;
  const clients = new Set<string>();
  for (const p of placements) {
    clients.add(p.client_id);
    if (p.status === "active") active += 1;
    else if (p.status === "paused") paused += 1;
  }
  return {
    totalPlacements: placements.length,
    activePlacements: active,
    pausedPlacements: paused,
    distinctClientCount: clients.size,
    distinctClients: Array.from(clients).sort(),
  };
}

export interface TargetUrlCheckResult {
  /** Final HTTP status after redirects, or 0 on network error. */
  status: number;
  /** True when status is 2xx and the redirect chain didn't loop. */
  reachable: boolean;
  /** Final URL after following redirects (== requested URL when no redirect). */
  finalUrl: string;
  /** Hop count (excludes the first request). 0 on direct hit. */
  redirectCount: number;
  /** Set when fetch threw or timed out. */
  error: string | null;
  /** Wall-clock duration in ms. */
  durationMs: number;
}

const TARGET_CHECK_TIMEOUT_MS = 8_000;
const TARGET_CHECK_MAX_REDIRECTS = 10;

/**
 * Probe the project's target URL to see if it's still reachable.
 *
 * Uses GET (not HEAD) because many CDNs and origins return 405 / 403
 * for HEAD even when the resource is fine on GET. Follows redirects
 * up to TARGET_CHECK_MAX_REDIRECTS hops, recording the final URL and
 * hop count so the operator can see "redirects to https://other.com".
 *
 * Bounded by TARGET_CHECK_TIMEOUT_MS via AbortController so a slow
 * origin can't pin a worker request. The handler treats a timeout as
 * `reachable: false, error: "timeout"` rather than throwing.
 *
 * NOT cached — the operator clicks the button when they want a fresh
 * check, and the result is shown via flash on the next page render.
 */
export async function checkTargetUrl(targetUrl: string): Promise<TargetUrlCheckResult> {
  const start = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TARGET_CHECK_TIMEOUT_MS);
  try {
    let currentUrl = targetUrl;
    let redirectCount = 0;
    let lastResponse: Response | null = null;
    // Manual redirect loop so we can count hops + detect cycles. Native
    // `redirect: 'follow'` doesn't expose the chain.
    const visited = new Set<string>([currentUrl]);
    while (redirectCount <= TARGET_CHECK_MAX_REDIRECTS) {
      const resp = await fetch(currentUrl, {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
        headers: {
          // Identify the worker so origin operators can recognise the
          // probe in their logs (some block unknown bots aggressively).
          "user-agent": "EdgeSEO-Platform/link-project-target-check (+https://edgeseo.app)",
        },
      });
      lastResponse = resp;
      if (resp.status >= 300 && resp.status < 400) {
        const loc = resp.headers.get("location");
        if (!loc) break; // 3xx without Location — treat as terminal.
        const next = new URL(loc, currentUrl).toString();
        if (visited.has(next)) {
          // Redirect loop. Stop and report the loop status verbatim.
          break;
        }
        visited.add(next);
        currentUrl = next;
        redirectCount += 1;
        continue;
      }
      break;
    }
    clearTimeout(timer);
    const status = lastResponse?.status ?? 0;
    return {
      status,
      reachable: status >= 200 && status < 300,
      finalUrl: currentUrl,
      redirectCount,
      error: null,
      durationMs: Date.now() - start,
    };
  } catch (e) {
    clearTimeout(timer);
    const message =
      e instanceof Error ? (e.name === "AbortError" ? "timeout" : e.message) : "unknown error";
    return {
      status: 0,
      reachable: false,
      finalUrl: targetUrl,
      redirectCount: 0,
      error: message,
      durationMs: Date.now() - start,
    };
  }
}

export interface BulkPlacementInput {
  /** client_ids to create placements on. Validated against owner's visible set. */
  client_ids: string[];
  /** Shared defaults applied to every new placement. */
  page_match: string;
  strategy: LinkProjectPlacementStrategy;
  target_selector: string | null;
  position: LinkProjectPlacementPosition | null;
  anchor_override: string | null;
  rel_attribute: string;
  status: LinkProjectPlacementStatus;
}

/**
 * Validate raw form input for the bulk-apply submission.
 *
 * The shared fields go through the same validation as the single-add
 * path (target_selector + position required when strategy=selector,
 * regex compile-check on page_match, etc.) — we just iterate the
 * checked client_ids on top.
 *
 * `selectedClientIds` is whatever the form submitted under the
 * `client_ids[]` (or `client_id` repeated) name. We dedupe + filter
 * against `validClientIds` to keep super-admins from accidentally
 * targeting orphaned client rows.
 */
export function validateBulkPlacementInput(
  raw: Record<string, string | string[]>,
  selectedClientIds: readonly string[],
  validClientIds: ReadonlySet<string>,
): { ok: true; value: BulkPlacementInput } | { ok: false; errors: string[] } {
  const errors: string[] = [];

  // Filter + dedupe the selected client list.
  const dedupe = new Set<string>();
  for (const id of selectedClientIds) {
    const trimmed = id.trim();
    if (trimmed.length === 0) continue;
    if (!validClientIds.has(trimmed)) continue;
    dedupe.add(trimmed);
  }
  const clientIds = Array.from(dedupe);
  if (clientIds.length === 0) {
    errors.push("Pick at least one client to apply this placement to");
  }

  // Run the shared-field validation by reusing the single-input
  // validator with a dummy client_id (so the client_id check passes).
  // The single validator's client_id is then ignored — we use clientIds
  // above as the authoritative list.
  const dummyRaw: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === "string") dummyRaw[k] = v;
  }
  // Inject any first valid client_id so the visibility check passes.
  // `clientIds[0]` is guaranteed valid since we filtered against validClientIds.
  dummyRaw.client_id = clientIds[0] ?? Array.from(validClientIds)[0] ?? "x";
  const single = validateLinkProjectPlacementInput(dummyRaw, validClientIds);
  if (!single.ok) {
    errors.push(...single.errors);
  }

  if (errors.length > 0 || !single.ok) return { ok: false, errors };
  return {
    ok: true,
    value: {
      client_ids: clientIds,
      page_match: single.value.page_match,
      strategy: single.value.strategy,
      target_selector: single.value.target_selector,
      position: single.value.position,
      anchor_override: single.value.anchor_override,
      rel_attribute: single.value.rel_attribute,
      status: single.value.status,
    },
  };
}

/* ─── Slice 2B: KV compile + worker pipeline integration ─── */

/**
 * Synthesized rule shape that mirrors `ContentInjectRule` from the
 * shared schema. Defined locally to avoid a frontend-worker → src/
 * import chain (and so the KV format is one place we control).
 *
 * `position` widened in Slice 3 to support the `selector` strategy
 * (operator-defined CSS selector + position). Footer strategy still
 * always emits position: "append".
 */
export interface SynthesizedContentInjection {
  match: string;
  selector: string;
  position: "before" | "after" | "prepend" | "append";
  html: string;
}

/** KV value written to `placements:<client_id>` — list of synthesized rules. */
export interface PlacementsKvValue {
  /** ISO timestamp of last compile, for debugging. */
  compiled_at: string;
  /** ContentInjectRule entries the worker merges into config.content_injections. */
  content_injections: SynthesizedContentInjection[];
}

/** HTML escape — replicates the helper in app.ts so this module can be
 *  unit-tested without pulling app.ts into the test graph. Same character
 *  set as `esc()` to keep behavior identical. */
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
 * Stable hash of a string into a non-negative 32-bit integer. Used by
 * the anchor rotator to pick a deterministic anchor for a given
 * (placement, page_match) pair without per-row state.
 *
 * FNV-1a 32-bit — same algorithm as `fnvHash` in app.ts but kept
 * private here so this module has no app.ts dependency at runtime.
 */
function stableUintHash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * Pick the anchor text for a placement.
 *
 * Resolution order:
 *   1. Per-placement override — exact text the operator typed.
 *   2. Rotation across the project's anchor_options — picks one entry
 *      deterministically based on a stable hash of the placement id +
 *      page_match. Same placement on the same page-match always shows
 *      the same anchor (rank-trackers stay consistent), but anchor
 *      diversity emerges naturally across the placement set.
 *   3. Fallback to the project's first anchor.
 *   4. Final fallback to the target URL itself (if the project has no
 *      anchors and the operator didn't override).
 *
 * Exported separately from synthesizePlacement so the unit test can
 * drive it directly without constructing a full SynthesizedContentInjection.
 */
export function pickAnchor(
  placement: Pick<LinkProjectPlacementRow, "id" | "page_match" | "anchor_override">,
  project: Pick<LinkProjectRow, "target_url" | "anchor_options">,
): string {
  if (placement.anchor_override) return placement.anchor_override;
  const anchors = parseAnchorOptions(project.anchor_options);
  if (anchors.length === 0) return project.target_url;
  if (anchors.length === 1) return anchors[0] ?? project.target_url;
  // Stable per (placement.id, page_match): same URL always shows the
  // same anchor. Including page_match in the hash means a placement
  // that covers multiple page-matches (i.e. one row per match) gets
  // its own deterministic pick per match, not the same one for all.
  const idx = stableUintHash(`${placement.id}:${placement.page_match}`) % anchors.length;
  return anchors[idx] ?? project.target_url;
}

/**
 * Synthesize a `ContentInjectRule`-shaped object for a single placement.
 *
 * Two strategies supported:
 *   - `footer` — fixed `body + append`. Inserts the link as the last
 *     child of `<body>`, just before `</body>`.
 *   - `selector` — operator-defined CSS selector + position (before /
 *     after / prepend / append). Used for inline contextual links —
 *     after the first paragraph, inside a footer element, etc.
 *
 * The wrapping `<div>` carries `data-lp-placement="<id>"` so an operator
 * inspecting the rendered HTML can trace a link back to its placement
 * row. Anchor text + target_url + rel_attribute are HTML-escaped before
 * interpolation.
 *
 * Returns null if the strategy isn't supported (future-proofing for
 * strategies a future migration may add before this code knows about
 * them) or if a `selector` placement is missing its required fields
 * (defense-in-depth — admin-time validation should already block this).
 */
export function synthesizePlacement(
  placement: LinkProjectPlacementRow,
  project: LinkProjectRow,
): SynthesizedContentInjection | null {
  const anchorText = pickAnchor(placement, project);
  const safeHref = escapeHtml(project.target_url);
  const safeRel = escapeHtml(placement.rel_attribute);
  const safeAnchor = escapeHtml(anchorText);
  const html = `<div data-lp-placement="${placement.id}"><a href="${safeHref}" rel="${safeRel}">${safeAnchor}</a></div>`;
  if (placement.strategy === "footer") {
    return {
      match: placement.page_match,
      selector: "body",
      position: "append",
      html,
    };
  }
  if (placement.strategy === "selector") {
    if (!placement.target_selector || !placement.position) return null;
    return {
      match: placement.page_match,
      selector: placement.target_selector,
      position: placement.position,
      html,
    };
  }
  return null;
}

/**
 * Re-compile the `placements:<client_id>` KV entry for a single client.
 *
 * Reads every active placement on this client whose parent project is
 * also active, synthesizes one ContentInjectRule per placement, and
 * writes the result to KV.
 *
 * If the client ends up with zero active placements, the KV entry is
 * DELETED (not written empty) so the loader's fast path returns early
 * with no merge work.
 */
export async function compilePlacementsForClient(
  env: AppEnv,
  clientId: string,
): Promise<{ written: boolean; ruleCount: number }> {
  const r = await env.CONFIG_DB.prepare(
    `SELECT p.id, p.link_project_id, p.client_id, p.page_match, p.strategy,
            p.target_selector, p.position,
            p.anchor_override, p.rel_attribute, p.status,
            p.created_at, p.updated_at,
            lp.id as lp_id, lp.owner_id as lp_owner_id, lp.label as lp_label,
            lp.target_url as lp_target_url, lp.anchor_options as lp_anchor_options,
            lp.status as lp_status, lp.notes as lp_notes,
            lp.created_at as lp_created_at, lp.updated_at as lp_updated_at
       FROM link_project_placements p
       JOIN link_projects lp ON lp.id = p.link_project_id
      WHERE p.client_id = ?
        AND p.status = 'active'
        AND lp.status = 'active'`,
  )
    .bind(clientId)
    .all<{
      id: number;
      link_project_id: number;
      client_id: string;
      page_match: string;
      strategy: LinkProjectPlacementStrategy;
      target_selector: string | null;
      position: LinkProjectPlacementPosition | null;
      anchor_override: string | null;
      rel_attribute: string;
      status: LinkProjectPlacementStatus;
      created_at: string;
      updated_at: string;
      lp_id: number;
      lp_owner_id: number;
      lp_label: string;
      lp_target_url: string;
      lp_anchor_options: string;
      lp_status: LinkProjectStatus;
      lp_notes: string | null;
      lp_created_at: string;
      lp_updated_at: string;
    }>();
  const rows = r.results ?? [];
  const synthesized: SynthesizedContentInjection[] = [];
  for (const row of rows) {
    const placement: LinkProjectPlacementRow = {
      id: row.id,
      link_project_id: row.link_project_id,
      client_id: row.client_id,
      page_match: row.page_match,
      strategy: row.strategy,
      target_selector: row.target_selector,
      position: row.position,
      anchor_override: row.anchor_override,
      rel_attribute: row.rel_attribute,
      status: row.status,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
    const project: LinkProjectRow = {
      id: row.lp_id,
      owner_id: row.lp_owner_id,
      label: row.lp_label,
      target_url: row.lp_target_url,
      anchor_options: row.lp_anchor_options,
      status: row.lp_status,
      notes: row.lp_notes,
      created_at: row.lp_created_at,
      updated_at: row.lp_updated_at,
    };
    const rule = synthesizePlacement(placement, project);
    if (rule) synthesized.push(rule);
  }
  const key = `placements:${clientId}`;
  if (synthesized.length === 0) {
    await env.CONFIG_KV.delete(key);
    return { written: false, ruleCount: 0 };
  }
  const value: PlacementsKvValue = {
    compiled_at: new Date().toISOString(),
    content_injections: synthesized,
  };
  await env.CONFIG_KV.put(key, JSON.stringify(value));
  return { written: true, ruleCount: synthesized.length };
}

/**
 * Best-effort Cloudflare HTTP cache purge for a client's proxy_domain.
 *
 * Without this, KV updates take effect on next D1-fallback (TTL 60s)
 * and CF's HTTP cache continues serving stale HTML for whatever its
 * cache-control headers said. We want changes to land immediately
 * after the operator clicks Save.
 *
 * Swallows errors: the KV write already covers correctness; this is
 * a "make changes visible NOW" nicety. Imports cloudflare-api lazily
 * to avoid pulling it into the test graph.
 */
async function bestEffortHttpCachePurge(env: AppEnv, clientId: string): Promise<void> {
  if (!env.CF_API_TOKEN) return;
  try {
    const row = await env.CONFIG_DB.prepare(
      "SELECT proxy_domain FROM clients WHERE client_id = ? LIMIT 1",
    )
      .bind(clientId)
      .first<{ proxy_domain: string }>();
    if (!row) return;
    const proxy = row.proxy_domain;
    // Derive zone name: for clients on a registered proxy zone (e.g.
    // `acme.localpage.us.com`), the zone IS that registered zone. For
    // in_place clients on their own apex (e.g. `404-media.com`), the
    // zone IS the apex itself (modulo a leading "www."). This mirrors
    // the logic in handleCachePurgePost which is known to work.
    const { matchProxyZone } = await import("../../src/config/proxy-zone.js");
    const knownZone = matchProxyZone(proxy);
    const zoneName = knownZone ?? proxy.replace(/^www\./i, "");
    const { findZoneByName, purgeCacheByHosts } = await import("./cloudflare-api.js");
    const zone = await findZoneByName(env.CF_API_TOKEN, zoneName);
    if (!zone) {
      console.warn(`link-projects: zone "${zoneName}" not found via CF API for client ${clientId}`);
      return;
    }
    await purgeCacheByHosts(env.CF_API_TOKEN, zone.id, [proxy]);
  } catch (e) {
    console.warn("link-projects: HTTP cache purge failed", e);
  }
}

/**
 * Combined invalidation: re-compile KV for the affected client(s) AND
 * best-effort flush the CF HTTP cache so changes propagate to live
 * traffic. Designed to be called from any handler that mutates
 * placements (one or two known client_ids).
 */
export async function invalidateAfterPlacementChange(
  env: AppEnv,
  clientIds: readonly string[],
): Promise<void> {
  await Promise.all(clientIds.map((c) => compilePlacementsForClient(env, c)));
  // HTTP cache purge is sequential to avoid hammering the CF API on a
  // project edit that touches many clients. Worst case: a few seconds
  // for an N-client edit, which is fine for a foreground admin action.
  for (const c of clientIds) {
    await bestEffortHttpCachePurge(env, c);
  }
}

/**
 * Invalidate every client with a placement on the given project. Used
 * when the project itself changes (anchor_options edit, status flip)
 * since both ripple to every dependent client.
 */
export async function invalidateAfterProjectChange(
  env: AppEnv,
  linkProjectId: number,
): Promise<{ clientCount: number }> {
  const r = await env.CONFIG_DB.prepare(
    "SELECT DISTINCT client_id FROM link_project_placements WHERE link_project_id = ?",
  )
    .bind(linkProjectId)
    .all<{ client_id: string }>();
  const clients = (r.results ?? []).map((row) => row.client_id);
  await invalidateAfterPlacementChange(env, clients);
  return { clientCount: clients.length };
}
