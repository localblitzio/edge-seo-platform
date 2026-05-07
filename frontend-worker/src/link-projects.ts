/**
 * Link Projects — Slice 1: read-only registry.
 *
 * Operator-defined "push this target URL" groupings. Each row is the
 * planning surface for a backlink campaign:
 *   - target_url: the money URL (https://xyz.com/services)
 *   - anchor_options: JSON array of anchor variations
 *   - status: draft / active / paused / archived
 *
 * Slice 1 (this file) covers CRUD + multi-tenant visibility only —
 * no placements, no worker pipeline integration. Slice 2 adds a
 * link_project_placements table and integrates with HTMLRewriter.
 *
 * Multi-tenancy is identical to the clients module: rows scoped by
 * owner_id; super-admin sees all.
 */
import type { AppEnv, FlashMessage } from "./app.js";
import { canSeeAllClients, esc } from "./app.js";
import type { User } from "./auth.js";

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
    <p class="subtitle" style="margin-top:1rem;font-size:.85rem">Slice 1 — registry only. Per-client placement controls land in Slice 2.</p>`;
}

export function renderLinkProjectDetail(row: LinkProjectRow): string {
  const anchors = parseAnchorOptions(row.anchor_options);
  const anchorList =
    anchors.length === 0
      ? '<span style="color:var(--fg-muted)">No anchor options yet — edit to add some.</span>'
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
  return `<div class="crumbs"><a href="/app/link-projects">← Link projects</a></div>
    <h1>${esc(row.label)}</h1>
    <p class="subtitle">${statusPill(row.status)} <span style="color:var(--fg-muted);margin-left:.5rem">id ${row.id} · created ${esc(row.created_at)} · updated ${esc(row.updated_at)}</span></p>
    <div class="actions-row">
      <a class="btn btn-primary" href="/app/link-projects/${row.id}/edit">Edit</a>
      ${statusActions}
    </div>
    <div class="card">
      <h2 style="margin-top:0">Target</h2>
      <dl class="kv">
        <dt>target_url</dt><dd><a href="${esc(row.target_url)}" target="_blank" rel="noopener noreferrer">${esc(row.target_url)}</a></dd>
        <dt>status</dt><dd>${statusPill(row.status)}</dd>
      </dl>
    </div>
    <div class="card">
      <h2 style="margin-top:0">Anchor options</h2>
      <p class="field-hint" style="font-size:.85rem;color:var(--fg-muted);margin:.2rem 0 .6rem">First entry is the default anchor for any placement that doesn't override it.</p>
      ${anchorList}
    </div>
    ${
      row.notes
        ? `<div class="card"><h2 style="margin-top:0">Notes</h2><p style="white-space:pre-wrap;margin:0">${esc(row.notes)}</p></div>`
        : ""
    }
    <p class="subtitle" style="font-size:.85rem;margin-top:1.5rem">Slice 2 will add per-client placements: pick which proxied sites push this target, on which page-matches, with which anchor.</p>`;
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
  return flashRedirect(`/app/link-projects/${id}`, {
    text: `Status set to ${requested}.`,
    kind: "ok",
  });
}
