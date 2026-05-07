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
import { canSeeAllClients, esc, loadVisibleClients } from "./app.js";
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
    <p class="subtitle" style="margin-top:1rem;font-size:.85rem">Open a project to add placements — per-(client × page-match) rules that the worker uses to inject the link at request time.</p>`;
}

export function renderLinkProjectDetail(
  row: LinkProjectRow,
  placements: LinkProjectPlacementRow[],
  visibleClients: ClientRow[],
): string {
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
    ${renderPlacementsSection(row, placements, visibleClients)}
    <p class="subtitle" style="font-size:.85rem;margin-top:1.5rem">Worker-side link injection lands in Slice 2B — placements created here become metadata until that ships.</p>`;
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

/* ─── Placements (Slice 2A) ─── */

export type LinkProjectPlacementStrategy = "footer";
export const LINK_PROJECT_PLACEMENT_STRATEGIES: readonly LinkProjectPlacementStrategy[] = [
  "footer",
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

/** Row shape mirroring the link_project_placements table (migration 0004). */
export interface LinkProjectPlacementRow {
  id: number;
  link_project_id: number;
  client_id: string;
  page_match: string;
  strategy: LinkProjectPlacementStrategy;
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
  anchor_override: string | null;
  rel_attribute: string;
  status: LinkProjectPlacementStatus;
}

const MAX_PAGE_MATCH_LENGTH = 512;
const MAX_ANCHOR_OVERRIDE_LENGTH = 200;
const MAX_REL_LENGTH = 100;
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
       (link_project_id, client_id, page_match, strategy, anchor_override, rel_attribute, status)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      linkProjectId,
      input.client_id,
      input.page_match,
      input.strategy,
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
       SET client_id = ?, page_match = ?, strategy = ?, anchor_override = ?,
           rel_attribute = ?, status = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND link_project_id = ?`,
  )
    .bind(
      input.client_id,
      input.page_match,
      input.strategy,
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
  anchor_override: string;
  rel_attribute: string;
  status: LinkProjectPlacementStatus;
}

function emptyPlacementPrefill(): PlacementFormPrefill {
  return {
    client_id: "",
    page_match: "^/.*",
    strategy: "footer",
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
  const status = (LINK_PROJECT_PLACEMENT_STATUSES as readonly string[]).includes(raw.status ?? "")
    ? (raw.status as LinkProjectPlacementStatus)
    : "active";
  return {
    client_id: raw.client_id ?? "",
    page_match: raw.page_match ?? "^/.*",
    strategy,
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
  const statusOptions = LINK_PROJECT_PLACEMENT_STATUSES.map(
    (s) =>
      `<option value="${esc(s)}"${s === opts.prefill.status ? " selected" : ""}>${esc(s)}</option>`,
  ).join("");
  const relDatalistOptions = REL_PRESETS.map((r) => `<option value="${esc(r)}">`).join("");
  return `${errBox}
    <form class="editor" method="POST" action="${esc(opts.action)}">
      <div class="form-section">
        <h2 style="margin-top:0">${opts.isEdit ? "Edit placement" : "New placement"}</h2>
        <div class="form-grid">
          <div>
            <label for="lpp_client_id">client</label>
            <select id="lpp_client_id" name="client_id" required>
              <option value="">— pick a client —</option>
              ${clientOptions}
            </select>
            <div class="field-hint">Which proxied client site this placement runs on. Only clients you own are listed.</div>
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
            <div class="field-hint">How the link is injected. Slice 2B ships footer (anchor before <code>&lt;/body&gt;</code>); more strategies follow.</div>
          </div>
          <div>
            <label for="lpp_rel_attribute">rel attribute</label>
            <input id="lpp_rel_attribute" name="rel_attribute" type="text" list="lpp_rel_presets" value="${esc(opts.prefill.rel_attribute)}" maxlength="100">
            <datalist id="lpp_rel_presets">${relDatalistOptions}</datalist>
            <div class="field-hint">Space-separated link types. Default <code>noopener</code> for security; add <code>nofollow</code> or <code>sponsored</code> when SEO context calls for it.</div>
          </div>
          <div class="full-width">
            <label for="lpp_anchor_override">anchor_override <span style="color:var(--fg-muted);font-weight:400">(optional)</span></label>
            <input id="lpp_anchor_override" name="anchor_override" type="text" value="${esc(opts.prefill.anchor_override)}" maxlength="200" placeholder="leave blank to use the project's default anchor">
            <div class="field-hint">If set, this placement uses this exact anchor text instead of the project's first <code>anchor_options</code> entry.</div>
          </div>
        </div>
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
): string {
  const visibleIds = new Set(visibleClients.map((c) => c.client_id));
  const projectAnchors = parseAnchorOptions(project.anchor_options);
  const defaultAnchor =
    projectAnchors[0] ?? "(no project anchor — set one or override per placement)";
  const rows = placements
    .map((p) => {
      const orphan = !visibleIds.has(p.client_id);
      const clientCell = orphan
        ? `<span class="mono" style="color:var(--fg-muted)" title="client not visible to you">${esc(p.client_id)} ⚠</span>`
        : `<a class="mono" href="/app/clients/${esc(p.client_id)}">${esc(p.client_id)}</a>`;
      const anchorCell = p.anchor_override
        ? `<span class="mono">${esc(p.anchor_override)}</span>`
        : `<span style="color:var(--fg-muted);font-style:italic">project default</span>`;
      return `<tr>
        <td>${clientCell}</td>
        <td class="mono">${esc(p.page_match)}</td>
        <td>${esc(p.strategy)}</td>
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
          <thead><tr><th>Client</th><th>page_match</th><th>strategy</th><th>anchor</th><th>rel</th><th>status</th><th></th></tr></thead>
          <tbody>${rows}</tbody>
        </table>`;
  if (visibleClients.length === 0) {
    return `<div class="card">
      <h2 style="margin-top:0">Placements</h2>
      <p class="field-hint" style="margin:0">You don't have any clients to attach placements to yet. Create a client first.</p>
    </div>`;
  }
  return `<div class="card">
    <h2 style="margin-top:0">Placements</h2>
    <p class="field-hint" style="margin:.2rem 0 .8rem">Each placement says "inject a link to <code>${esc(project.target_url)}</code> on this client's pages matching the regex." Default anchor will be <code>${esc(defaultAnchor)}</code> unless overridden.</p>
    ${tableOrEmpty}
    ${renderPlacementForm({
      action: `/app/link-projects/${project.id}/placements/new`,
      submitLabel: "Add placement",
      prefill: emptyPlacementPrefill(),
      visibleClients,
      errors: [],
      isEdit: false,
    })}
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
  return flashRedirect(`/app/link-projects/${linkProjectId}`, {
    text: `Deleted placement on ${placement.client_id}.`,
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
} | null> {
  const project = await loadVisibleLinkProject(env, user, linkProjectId);
  if (!project) return null;
  const [placements, visibleClients] = await Promise.all([
    loadPlacementsForProject(env, linkProjectId),
    loadVisibleClients(env, user),
  ]);
  return { project, placements, visibleClients };
}

/* ─── Slice 2B: KV compile + worker pipeline integration ─── */

/**
 * Synthesized rule shape that mirrors `ContentInjectRule` from the
 * shared schema. Defined locally to avoid a frontend-worker → src/
 * import chain (and so the KV format is one place we control).
 */
export interface SynthesizedContentInjection {
  match: string;
  selector: string;
  position: "append";
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
 * Synthesize a `ContentInjectRule`-shaped object for a single placement.
 *
 * The footer strategy injects a `<div>` with one `<a>` inside, appended
 * to `<body>` (i.e. inserted as the last child of body, just before
 * `</body>`). The wrapping div carries `data-lp-placement="<id>"` so an
 * operator inspecting the rendered HTML can trace a link back to its
 * placement row. Anchor text + target_url + rel_attribute are HTML-
 * escaped before interpolation.
 *
 * Returns null if the strategy isn't supported yet (future-proofing for
 * Slice 3 strategies that this function doesn't know about).
 */
export function synthesizePlacement(
  placement: LinkProjectPlacementRow,
  project: LinkProjectRow,
): SynthesizedContentInjection | null {
  if (placement.strategy !== "footer") return null;
  const projectAnchors = parseAnchorOptions(project.anchor_options);
  const anchorText = placement.anchor_override ?? projectAnchors[0] ?? project.target_url;
  const safeHref = escapeHtml(project.target_url);
  const safeRel = escapeHtml(placement.rel_attribute);
  const safeAnchor = escapeHtml(anchorText);
  const html = `<div data-lp-placement="${placement.id}"><a href="${safeHref}" rel="${safeRel}">${safeAnchor}</a></div>`;
  return {
    match: placement.page_match,
    selector: "body",
    position: "append",
    html,
  };
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
    const { findZoneByName, purgeCacheByHosts } = await import("./cloudflare-api.js");
    // Walk up parent labels so `foo.bar.example.com` matches a zone
    // named `bar.example.com` or `example.com`.
    const candidateZones = [row.proxy_domain];
    const labels = row.proxy_domain.split(".");
    for (let i = 1; i < labels.length - 1; i++) {
      candidateZones.push(labels.slice(i).join("."));
    }
    let zoneId: string | null = null;
    for (const candidate of candidateZones) {
      const zone = await findZoneByName(env.CF_API_TOKEN, candidate);
      if (zone) {
        zoneId = zone.id;
        break;
      }
    }
    if (!zoneId) return;
    await purgeCacheByHosts(env.CF_API_TOKEN, zoneId, [row.proxy_domain]);
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
