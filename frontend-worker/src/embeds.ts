/**
 * Embeds library + bulk-apply.
 *
 * An embed is a named, reusable HTML block (typically an <iframe>:
 * Google Maps, YouTube, social widget). Operators author one HTML
 * block on /app/embeds and "apply" it to a cluster — for each member
 * site we:
 *
 *   1. Append a content_injection rule (idempotent — marked with
 *      `data-edge-seo-rule="embed:<id>"` in the rule_id so re-apply
 *      replaces the previous version of this embed).
 *   2. Upsert a wildcard canonical rule with `strategy: self`.
 *   3. Upsert a wildcard indexation rule with `robots: "index,follow"`.
 *   4. Bump cache via KV write + audit log entry.
 *   5. (Optional) fire operator-selected indexers for the site's
 *      seed paths (homepage fallback).
 *
 * The SEO mutations (canonical=self + index,follow) are part of the
 * "make these sites compete in search" intent — embeds without
 * indexable canonicalized hosts are useless for the SEO use case
 * driving this feature.
 *
 * Multi-tenancy mirrors clusters + link_projects: rows scoped by
 * owner_id; super-admin sees all.
 */
import type { ClientConfig } from "../../src/config/schema.js";
import { pingSelectedIndexers } from "../../src/secrets/indexer-registry.js";
import { collectSitemapUrls } from "../../src/sitemap/generator.js";
import type { AppEnv, ClientRow, FlashMessage } from "./app.js";
import { canSeeAllClients, esc, fnvHash, writeAudit } from "./app.js";
import type { User } from "./auth.js";
import {
  type ClusterRow,
  loadAllClusterMembersByCluster,
  loadVisibleClusters,
} from "./clusters.js";

export type EmbedKind = "iframe" | "google_maps_embed";
export const EMBED_KINDS: readonly EmbedKind[] = ["iframe", "google_maps_embed"];

export type EmbedPosition = "middle" | "bottom";
export const EMBED_POSITIONS: readonly EmbedPosition[] = ["middle", "bottom"];

const MAX_NAME_LENGTH = 200;
const MAX_HTML_LENGTH = 8000;
const IFRAME_TAG_REGEX = /<iframe\b[^>]*>/i;
// Google Maps embed iframe src — the modern form is
//   https://www.google.com/maps/embed?pb=<long blob>
// (note `?` query, not a `/` path). The optional `(?:[/?][^"']*)?`
// allows either path or query string after `/embed`.
const GOOGLE_MAPS_SRC_REGEX =
  /<iframe\b[^>]*\bsrc\s*=\s*["']https:\/\/(?:www\.)?google\.com\/maps\/embed(?:[/?][^"']*)?["'][^>]*>/i;

/** Row shape mirroring the `embeds` table. */
export interface EmbedRow {
  id: number;
  owner_id: number;
  name: string;
  kind: EmbedKind;
  html: string;
  default_position: EmbedPosition;
  created_at: string;
  updated_at: string;
}

/** Row shape mirroring the `embed_placements` table. */
export interface EmbedPlacementRow {
  embed_id: number;
  client_id: string;
  position: EmbedPosition;
  source_cluster_id: number | null;
  applied_at: string;
  applied_by_email: string;
}

export interface EmbedInput {
  name: string;
  kind: EmbedKind;
  html: string;
  default_position: EmbedPosition;
}

/* ─── Validation ─── */

/**
 * Validate the embed form. `kind: "google_maps_embed"` requires the
 * HTML to contain an <iframe src="https://...google.com/maps/embed..."
 * — keeps operators from pasting random HTML into the Maps slot.
 * `kind: "iframe"` requires only that an <iframe> tag exists.
 */
export function validateEmbedInput(
  raw: Record<string, string>,
): { ok: true; value: EmbedInput } | { ok: false; errors: string[] } {
  const errors: string[] = [];

  const name = (raw.name ?? "").trim();
  if (name.length === 0) errors.push("name is required");
  if (name.length > MAX_NAME_LENGTH) {
    errors.push(`name must be ≤ ${MAX_NAME_LENGTH} chars`);
  }

  const kindRaw = (raw.kind ?? "").trim();
  let kind: EmbedKind = "iframe";
  if (!(EMBED_KINDS as readonly string[]).includes(kindRaw)) {
    errors.push(`kind must be one of: ${EMBED_KINDS.join(", ")}`);
  } else {
    kind = kindRaw as EmbedKind;
  }

  const html = (raw.html ?? "").trim();
  if (html.length === 0) {
    errors.push("html is required");
  } else if (html.length > MAX_HTML_LENGTH) {
    errors.push(`html must be ≤ ${MAX_HTML_LENGTH} chars`);
  } else if (!IFRAME_TAG_REGEX.test(html)) {
    errors.push("html must contain an <iframe> tag");
  } else if (kind === "google_maps_embed" && !GOOGLE_MAPS_SRC_REGEX.test(html)) {
    errors.push('google_maps_embed requires an <iframe src="https://...google.com/maps/embed...">');
  }

  const positionRaw = (raw.default_position ?? "bottom").trim();
  let default_position: EmbedPosition = "bottom";
  if (!(EMBED_POSITIONS as readonly string[]).includes(positionRaw)) {
    errors.push(`default_position must be one of: ${EMBED_POSITIONS.join(", ")}`);
  } else {
    default_position = positionRaw as EmbedPosition;
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, value: { name, kind, html, default_position } };
}

/* ─── CRUD ─── */

/**
 * Load all embeds visible to the operator. Super-admin sees all;
 * regular users see only their own.
 */
export async function loadVisibleEmbeds(env: AppEnv, user: User): Promise<EmbedRow[]> {
  const sql = canSeeAllClients(user)
    ? "SELECT * FROM embeds ORDER BY name"
    : "SELECT * FROM embeds WHERE owner_id = ? ORDER BY name";
  const stmt = env.CONFIG_DB.prepare(sql);
  const bound = canSeeAllClients(user) ? stmt : stmt.bind(user.id);
  const result = await bound.all<EmbedRow>();
  return result.results ?? [];
}

/** Single embed by id, scoped by visibility. */
export async function loadVisibleEmbed(
  env: AppEnv,
  user: User,
  id: number,
): Promise<EmbedRow | null> {
  const sql = canSeeAllClients(user)
    ? "SELECT * FROM embeds WHERE id = ?"
    : "SELECT * FROM embeds WHERE id = ? AND owner_id = ?";
  const stmt = env.CONFIG_DB.prepare(sql);
  const bound = canSeeAllClients(user) ? stmt.bind(id) : stmt.bind(id, user.id);
  return bound.first<EmbedRow>();
}

/** All placements for an embed (any client). */
export async function loadPlacementsForEmbed(
  env: AppEnv,
  embedId: number,
): Promise<EmbedPlacementRow[]> {
  const result = await env.CONFIG_DB.prepare(
    "SELECT * FROM embed_placements WHERE embed_id = ? ORDER BY applied_at DESC",
  )
    .bind(embedId)
    .all<EmbedPlacementRow>();
  return result.results ?? [];
}

/**
 * Joined placement row — what the analytics page actually wants to
 * display. Pulls embed name/kind + client proxy_domain + cluster
 * label in one query so the renderer doesn't have to fan out.
 *
 * `client_proxy_domain` / `cluster_label` are nullable: a placement
 * row survives client deletion (FK is TEXT, no cascade) and cluster
 * deletion (ON DELETE SET NULL on source_cluster_id), so the joins
 * can miss.
 */
export interface PlacementListRow {
  embed_id: number;
  client_id: string;
  position: EmbedPosition;
  source_cluster_id: number | null;
  applied_at: string;
  applied_by_email: string;
  embed_name: string;
  embed_kind: EmbedKind;
  client_proxy_domain: string | null;
  cluster_label: string | null;
}

export interface PlacementFilters {
  /** When set, only placements for this embed id. */
  embed_id?: number;
  /** When set, only placements applied under this cluster context. */
  cluster_id?: number;
  /** When set, free-text match against client_id (substring, case-insensitive). */
  client_search?: string;
}

/**
 * Load placements visible to the operator with optional filters.
 *
 * Visibility: regular users see only placements on clients they own;
 * super-admins see all. The owner check uses the same SQL semantics
 * as `loadVisibleClients` so a user can't see placements on sites
 * they can't otherwise see.
 */
export async function loadVisiblePlacements(
  env: AppEnv,
  user: User,
  filters: PlacementFilters = {},
): Promise<PlacementListRow[]> {
  const where: string[] = [];
  const params: Array<string | number> = [];
  if (!canSeeAllClients(user)) {
    where.push("c.owner_id = ?");
    params.push(user.id);
  }
  if (filters.embed_id != null) {
    where.push("p.embed_id = ?");
    params.push(filters.embed_id);
  }
  if (filters.cluster_id != null) {
    where.push("p.source_cluster_id = ?");
    params.push(filters.cluster_id);
  }
  if (filters.client_search && filters.client_search.trim().length > 0) {
    where.push("LOWER(p.client_id) LIKE ?");
    params.push(`%${filters.client_search.trim().toLowerCase()}%`);
  }
  const whereSql = where.length > 0 ? `WHERE ${where.join(" AND ")}` : "";
  const sql = `
    SELECT p.embed_id, p.client_id, p.position, p.source_cluster_id,
           p.applied_at, p.applied_by_email,
           e.name AS embed_name, e.kind AS embed_kind,
           c.proxy_domain AS client_proxy_domain,
           cl.label AS cluster_label
    FROM embed_placements p
    JOIN embeds e ON e.id = p.embed_id
    LEFT JOIN clients c ON c.client_id = p.client_id
    LEFT JOIN clusters cl ON cl.id = p.source_cluster_id
    ${whereSql}
    ORDER BY p.applied_at DESC
  `;
  const stmt = env.CONFIG_DB.prepare(sql);
  const bound = params.length > 0 ? stmt.bind(...params) : stmt;
  const result = await bound.all<PlacementListRow>();
  return result.results ?? [];
}

/**
 * Remove an embed from a single client. Mirror-image of the apply
 * mutation — strips any content_injection rules whose html carries
 * the `data-edge-seo-rule="embed:<id>"` marker, writes the new
 * config to D1 + KV, deletes the placement row, audits as
 * `embed_remove`. Canonical + indexation rules are LEFT IN PLACE —
 * removing an embed shouldn't silently put a noindex back on a site
 * the operator deliberately made indexable.
 *
 * @returns `{ ok: true }` on success, `{ ok: false, error }` on
 *   failure (config not found, parse error, etc.). Never throws.
 */
export async function removeEmbedFromClient(
  env: AppEnv,
  user: User,
  embedId: number,
  clientId: string,
  actorIpStr: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const client = await env.CONFIG_DB.prepare("SELECT * FROM clients WHERE client_id = ?")
    .bind(clientId)
    .first<ClientRow>();
  if (!client) return { ok: false, error: "Client not found." };

  let config: Record<string, unknown>;
  try {
    config = JSON.parse(client.config_json);
  } catch (e) {
    return {
      ok: false,
      error: `Could not parse config_json: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  const marker = `data-edge-seo-rule="embed:${embedId}"`;
  const existing = Array.isArray(config.content_injections)
    ? (config.content_injections as Array<Record<string, unknown>>)
    : [];
  const filtered = existing.filter((r) => {
    const html = typeof r.html === "string" ? r.html : "";
    return !html.includes(marker);
  });
  config.content_injections = filtered;

  const beforeHash = fnvHash(client.config_json);
  const newJson = JSON.stringify(config);
  const afterHash = fnvHash(newJson);

  try {
    await env.CONFIG_DB.prepare(
      "UPDATE clients SET config_json = ?, updated_at = CURRENT_TIMESTAMP WHERE client_id = ?",
    )
      .bind(newJson, clientId)
      .run();
    await env.CONFIG_KV.put(`config:${clientId}`, newJson);
  } catch (e) {
    return {
      ok: false,
      error: `Update failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  try {
    await env.CONFIG_DB.prepare("DELETE FROM embed_placements WHERE embed_id = ? AND client_id = ?")
      .bind(embedId, clientId)
      .run();
  } catch (e) {
    console.warn("embed: placement delete failed", e);
  }

  try {
    await writeAudit(env, {
      client_id: clientId,
      actor_email: user.email,
      actor_ip: actorIpStr,
      event_type: "embed_remove",
      before_hash: beforeHash,
      after_hash: afterHash,
      previous_status: null,
      new_status: null,
      notes: `embed_id=${embedId}`,
    });
  } catch (e) {
    console.warn("embed: audit write failed", e);
  }

  return { ok: true };
}

/* ─── Apply: build the per-rule structures ─── */

/**
 * Build the content_injection rule for an embed applied at `position`.
 * Returns a plain object matching the `ContentInjectRule` schema
 * (validated downstream by `validateConfigJson`).
 *
 * Position semantics:
 *   - `bottom`: append at end of <main> (selector `main`,
 *     position `append`)
 *   - `middle`: after `main > p:nth-of-type(2)` (heuristic — works on
 *     content-shaped pages; will silently no-op on landers without
 *     two paragraphs)
 *
 * The injected HTML is wrapped in a <div data-edge-seo-rule="embed:N">
 * so the worker's idempotency check (per CLAUDE.md / §6.4) replaces
 * the previous version of THIS embed on re-apply rather than stacking.
 */
export function buildEmbedContentInjection(
  embed: EmbedRow,
  position: EmbedPosition,
): Record<string, unknown> {
  const wrappedHtml = `<div data-edge-seo-rule="embed:${embed.id}" data-edge-seo-embed-name="${embed.name.replace(/[<>"]/g, "")}">${embed.html}</div>`;
  if (position === "middle") {
    return {
      match: "^/.*",
      selector: "main > p:nth-of-type(2)",
      position: "after",
      html: wrappedHtml,
    };
  }
  return {
    match: "^/.*",
    selector: "main",
    position: "append",
    html: wrappedHtml,
  };
}

/**
 * Mutate a parsed config JSON in-place:
 *   - Drop any existing content_injections whose html contains
 *     `data-edge-seo-rule="embed:<id>"` (re-apply idempotency).
 *   - Append the new injection.
 *   - Upsert wildcard canonical → self.
 *   - Upsert wildcard indexation → index,follow.
 *
 * Returns the mutated config (same reference for caller's
 * convenience). Caller is responsible for re-stringifying + writing.
 */
export function applyEmbedToConfig(
  config: Record<string, unknown>,
  embed: EmbedRow,
  position: EmbedPosition,
): Record<string, unknown> {
  const marker = `data-edge-seo-rule="embed:${embed.id}"`;
  // content_injections: drop any prior version of THIS embed, append new.
  const existing = Array.isArray(config.content_injections)
    ? (config.content_injections as Array<Record<string, unknown>>)
    : [];
  const filtered = existing.filter((r) => {
    const html = typeof r.html === "string" ? r.html : "";
    return !html.includes(marker);
  });
  filtered.push(buildEmbedContentInjection(embed, position));
  config.content_injections = filtered;

  // canonicals: upsert wildcard self. If a wildcard rule already
  // exists (any strategy), replace its strategy. Otherwise prepend.
  const canonicals = Array.isArray(config.canonicals)
    ? (config.canonicals as Array<Record<string, unknown>>)
    : [];
  const wildcardIdx = canonicals.findIndex((r) => r.match === "^/.*");
  const selfCanonical = {
    match: "^/.*",
    strategy: { type: "self" },
    sync_og_url: true,
    sync_twitter_url: true,
    sync_jsonld_url: true,
  };
  if (wildcardIdx >= 0) {
    canonicals[wildcardIdx] = selfCanonical;
  } else {
    canonicals.unshift(selfCanonical);
  }
  config.canonicals = canonicals;

  // indexation: upsert wildcard index,follow.
  const indexation = Array.isArray(config.indexation)
    ? (config.indexation as Array<Record<string, unknown>>)
    : [];
  const indexationIdx = indexation.findIndex((r) => r.match === "^/.*");
  const indexableRule = {
    match: "^/.*",
    robots: "index,follow",
    additional_directives: [],
  };
  if (indexationIdx >= 0) {
    indexation[indexationIdx] = indexableRule;
  } else {
    indexation.unshift(indexableRule);
  }
  config.indexation = indexation;

  return config;
}

/* ─── Apply orchestration ─── */

/**
 * Per-site outcome surfaced to the operator after a bulk apply.
 */
export interface ApplySiteResult {
  client_id: string;
  proxy_domain: string;
  /** True when the config was updated and KV primed; false on any error. */
  ok: boolean;
  /** Per-indexer fan-out outcomes, only present when ok and indexers were selected. */
  indexer_results?: Array<{ label: string; ok: boolean; message: string }>;
  /** Set on failure — the operator-facing reason. */
  error?: string;
}

/**
 * Apply an embed to an explicit list of clients.
 *
 * Use this when the operator picked a subset of sites (e.g. checked
 * 3 of 8 cluster members in the apply picker). The `sourceClusterId`
 * is recorded on each placement for audit / "which cluster did this
 * apply originate from" — pass null for a direct/ad-hoc apply.
 *
 * @param env Cloudflare bindings.
 * @param user authenticated operator (used for audit + scope).
 * @param embed the embed to apply (already loaded + visibility-checked).
 * @param clientIds explicit list of client_ids to apply to (must be
 *   non-empty; caller is responsible for visibility scoping).
 * @param sourceClusterId cluster context the apply originated from,
 *   recorded on each placement row. `null` for direct ad-hoc apply.
 * @param position position chosen for THIS apply (may differ from embed.default_position).
 * @param selectedIndexerSlots subset of indexer slot keys to fire after each apply.
 * @param actorIp operator's request IP (for audit).
 */
export async function applyEmbedToClients(
  env: AppEnv,
  user: User,
  embed: EmbedRow,
  clientIds: readonly string[],
  sourceClusterId: number | null,
  position: EmbedPosition,
  selectedIndexerSlots: readonly string[],
  actorIp: string,
): Promise<ApplySiteResult[]> {
  if (clientIds.length === 0) return [];

  // Load every target client row in one query.
  const placeholders = clientIds.map(() => "?").join(", ");
  const clients = await env.CONFIG_DB.prepare(
    `SELECT * FROM clients WHERE client_id IN (${placeholders})`,
  )
    .bind(...clientIds)
    .all<ClientRow>();

  const out: ApplySiteResult[] = [];
  for (const client of clients.results ?? []) {
    const result = await applyEmbedToSingleClient(
      env,
      user,
      embed,
      client,
      sourceClusterId,
      position,
      selectedIndexerSlots,
      actorIp,
    );
    out.push(result);
  }
  return out;
}

/**
 * Apply an embed to every member of a cluster. Thin wrapper around
 * `applyEmbedToClients` — preserved for the standalone "apply to
 * whole cluster" path. The per-site picker (Phase A) calls
 * `applyEmbedToClients` directly.
 */
export async function applyEmbedToCluster(
  env: AppEnv,
  user: User,
  embed: EmbedRow,
  cluster: ClusterRow,
  position: EmbedPosition,
  selectedIndexerSlots: readonly string[],
  actorIp: string,
): Promise<ApplySiteResult[]> {
  const membersByCluster = await loadAllClusterMembersByCluster(env, [cluster.id]);
  const memberClientIds = membersByCluster.get(cluster.id) ?? [];
  return applyEmbedToClients(
    env,
    user,
    embed,
    memberClientIds,
    cluster.id,
    position,
    selectedIndexerSlots,
    actorIp,
  );
}

async function applyEmbedToSingleClient(
  env: AppEnv,
  user: User,
  embed: EmbedRow,
  client: ClientRow,
  sourceClusterId: number | null,
  position: EmbedPosition,
  selectedIndexerSlots: readonly string[],
  actorIp: string,
): Promise<ApplySiteResult> {
  let config: Record<string, unknown>;
  try {
    config = JSON.parse(client.config_json);
  } catch (e) {
    return {
      client_id: client.client_id,
      proxy_domain: client.proxy_domain,
      ok: false,
      error: `Could not parse config_json: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  const beforeHash = fnvHash(client.config_json);
  applyEmbedToConfig(config, embed, position);
  const newJson = JSON.stringify(config);
  const afterHash = fnvHash(newJson);

  try {
    await env.CONFIG_DB.prepare(
      "UPDATE clients SET config_json = ?, updated_at = CURRENT_TIMESTAMP WHERE client_id = ?",
    )
      .bind(newJson, client.client_id)
      .run();
    // Prime KV so the worker reads the new config on next request.
    await env.CONFIG_KV.put(`config:${client.client_id}`, newJson);
  } catch (e) {
    return {
      client_id: client.client_id,
      proxy_domain: client.proxy_domain,
      ok: false,
      error: `Update failed: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  // Upsert placement row.
  try {
    await env.CONFIG_DB.prepare(
      `INSERT INTO embed_placements
         (embed_id, client_id, position, source_cluster_id, applied_at, applied_by_email)
       VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP, ?)
       ON CONFLICT (embed_id, client_id) DO UPDATE SET
         position = excluded.position,
         source_cluster_id = excluded.source_cluster_id,
         applied_at = CURRENT_TIMESTAMP,
         applied_by_email = excluded.applied_by_email`,
    )
      .bind(embed.id, client.client_id, position, sourceClusterId, user.email)
      .run();
  } catch (e) {
    console.warn("embed: placement upsert failed", e);
  }

  // Audit.
  try {
    await writeAudit(env, {
      client_id: client.client_id,
      actor_email: user.email,
      actor_ip: actorIp,
      event_type: "embed_apply",
      before_hash: beforeHash,
      after_hash: afterHash,
      previous_status: null,
      new_status: null,
      notes: `embed_id=${embed.id} name="${embed.name}" position=${position}${sourceClusterId !== null ? ` cluster_id=${sourceClusterId}` : ""}`,
    });
  } catch (e) {
    console.warn("embed: audit write failed", e);
  }

  const out: ApplySiteResult = {
    client_id: client.client_id,
    proxy_domain: client.proxy_domain,
    ok: true,
  };

  // Optional indexer fan-out.
  if (selectedIndexerSlots.length > 0) {
    try {
      // Use the just-mutated config to derive the URL list. The cast is
      // safe: this object was Zod-validated at admin-write time + we
      // only mutated rule arrays, not the structural fields. Falls back
      // to the homepage when no eligible URLs surface (e.g. wildcard
      // proxy with no seed_paths).
      let urls: string[] = [];
      try {
        urls = collectSitemapUrls(config as unknown as ClientConfig);
      } catch {
        urls = [];
      }
      const targetUrls = urls.length > 0 ? urls : [`https://${client.proxy_domain}/`];
      const indexerResults = await pingSelectedIndexers(
        env as unknown as Parameters<typeof pingSelectedIndexers>[0],
        targetUrls,
        { proxyDomain: client.proxy_domain },
        selectedIndexerSlots,
      );
      out.indexer_results = indexerResults.map((r) => ({
        label: r.label,
        ok: r.result.ok,
        message: r.result.message,
      }));
    } catch (e) {
      out.indexer_results = [
        {
          label: "(error)",
          ok: false,
          message: `Indexer fan-out threw: ${e instanceof Error ? e.message : String(e)}`,
        },
      ];
    }
  }

  return out;
}

/* ─── CSRF + flash (mirrors clusters.ts) ─── */

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

function actorIp(request: Request): string {
  return request.headers.get("cf-connecting-ip") ?? "0.0.0.0";
}

/* ─── Renderers ─── */

export function renderEmbedsList(rows: EmbedRow[], user: User): string {
  const ownership =
    user.role === "super_admin"
      ? "Showing all embeds across the platform (super-admin)."
      : `Showing ${rows.length} embed${rows.length === 1 ? "" : "s"} you own.`;
  if (rows.length === 0) {
    return `<h1>Embeds</h1>
      <p class="subtitle">${ownership} Embeds are reusable HTML blocks (iframes, Google Maps) you can bulk-apply across a cluster. Applying also forces canonical=self + index,follow for SEO competitiveness.</p>
      <p style="margin-bottom:1rem"><a class="btn btn-primary" href="/app/embeds/new">+ New embed</a> <a class="btn" href="/app/embeds/placements">View placements →</a></p>
      <div class="empty">No embeds yet. Create one to start bulk-applying.</div>`;
  }
  const tbody = rows
    .map(
      (r) => `<tr>
      <td><a href="/app/embeds/${r.id}" class="mono">${esc(r.name)}</a></td>
      <td><code>${esc(r.kind)}</code></td>
      <td><code>${esc(r.default_position)}</code></td>
      <td class="mono" style="color:var(--fg-muted);font-size:.85rem">${esc(r.updated_at)}</td>
    </tr>`,
    )
    .join("");
  return `<h1>Embeds</h1>
    <p class="subtitle">${ownership}</p>
    <p style="margin-bottom:1rem"><a class="btn btn-primary" href="/app/embeds/new">+ New embed</a> <a class="btn" href="/app/embeds/placements">View placements →</a></p>
    <table class="data">
      <thead><tr><th>Name</th><th>Kind</th><th>Default position</th><th>Updated</th></tr></thead>
      <tbody>${tbody}</tbody>
    </table>`;
}

export function renderEmbedForm(opts: {
  prefill: Partial<EmbedInput> & { id?: number };
  errors: string[];
  mode: "new" | "edit";
}): string {
  const action = opts.mode === "new" ? "/app/embeds/new" : `/app/embeds/${opts.prefill.id}/edit`;
  const heading = opts.mode === "new" ? "New embed" : "Edit embed";
  const errBox =
    opts.errors.length > 0 ? `<div class="error-box">${opts.errors.map(esc).join("\n")}</div>` : "";
  const kindOptions = EMBED_KINDS.map(
    (k) =>
      `<option value="${esc(k)}"${opts.prefill.kind === k ? " selected" : ""}>${esc(k)}</option>`,
  ).join("");
  const positionOptions = EMBED_POSITIONS.map(
    (p) =>
      `<option value="${esc(p)}"${(opts.prefill.default_position ?? "bottom") === p ? " selected" : ""}>${esc(p)}</option>`,
  ).join("");
  const deleteForm =
    opts.mode === "edit"
      ? `<form method="POST" action="/app/embeds/${opts.prefill.id}/delete" style="display:inline;margin-left:.6rem" onsubmit="return confirm('Delete this embed? Existing placements stay in place — this only removes the library entry.');">
          <button type="submit" class="btn" style="color:var(--red)">Delete embed</button>
        </form>`
      : "";
  return `<div class="crumbs"><a href="/app/embeds">← Embeds</a></div>
    <h1>${heading}</h1>
    ${errBox}
    <form class="editor" method="POST" action="${esc(action)}">
      <div class="form-section">
        <label for="embed_name">name</label>
        <input id="embed_name" name="name" type="text" required maxlength="${MAX_NAME_LENGTH}" value="${esc(opts.prefill.name ?? "")}" placeholder="Mountain View Maps">
      </div>
      <div class="form-section">
        <label for="embed_kind">kind</label>
        <select id="embed_kind" name="kind">${kindOptions}</select>
        <div class="field-hint"><code>iframe</code>: any &lt;iframe&gt; HTML. <code>google_maps_embed</code>: requires an &lt;iframe&gt; whose <code>src</code> is on <code>google.com/maps/embed</code>.</div>
      </div>
      <div class="form-section">
        <label for="embed_html">html</label>
        <textarea id="embed_html" name="html" rows="8" required maxlength="${MAX_HTML_LENGTH}" placeholder='&lt;iframe src="https://www.google.com/maps/embed?pb=..." width="600" height="450" loading="lazy"&gt;&lt;/iframe&gt;' style="width:100%;font-family:var(--mono);font-size:.85rem;padding:.5rem">${esc(opts.prefill.html ?? "")}</textarea>
        <div class="field-hint">Pasted verbatim into the page wrapped in <code>&lt;div data-edge-seo-rule="embed:N"&gt;...&lt;/div&gt;</code> for idempotent replacement on re-apply.</div>
      </div>
      <div class="form-section">
        <label for="embed_position">default position</label>
        <select id="embed_position" name="default_position">${positionOptions}</select>
        <div class="field-hint"><code>bottom</code>: append at the end of &lt;main&gt;. <code>middle</code>: after the 2nd &lt;p&gt; inside &lt;main&gt;.</div>
      </div>
      <div class="form-actions">
        <button class="btn btn-primary" type="submit">${opts.mode === "new" ? "Create embed" : "Save changes"}</button>
        <a class="btn" href="/app/embeds">Cancel</a>
        ${deleteForm}
      </div>
    </form>`;
}

interface IndexerOption {
  slotKey: string;
  label: string;
  color: string;
  /** True when the slot's secret is bound (operator can actually use it). */
  available: boolean;
}

export function renderPlacementsList(opts: {
  rows: readonly PlacementListRow[];
  embeds: readonly EmbedRow[];
  clusters: readonly ClusterRow[];
  filters: PlacementFilters;
  user: User;
}): string {
  const ownership =
    opts.user.role === "super_admin"
      ? "Showing all placements across the platform (super-admin)."
      : `Showing ${opts.rows.length} placement${opts.rows.length === 1 ? "" : "s"} on sites you own.`;
  const embedOptions = [
    `<option value="">— all embeds —</option>`,
    ...opts.embeds.map(
      (e) =>
        `<option value="${e.id}"${opts.filters.embed_id === e.id ? " selected" : ""}>${esc(e.name)}</option>`,
    ),
  ].join("");
  const clusterOptions = [
    `<option value="">— all clusters —</option>`,
    ...opts.clusters.map(
      (c) =>
        `<option value="${c.id}"${opts.filters.cluster_id === c.id ? " selected" : ""}>${esc(c.label)}</option>`,
    ),
  ].join("");
  const uniqEmbeds = new Set(opts.rows.map((r) => r.embed_id)).size;
  const uniqClients = new Set(opts.rows.map((r) => r.client_id)).size;
  const summary = `<p class="subtitle"><strong>${opts.rows.length}</strong> placement${opts.rows.length === 1 ? "" : "s"} across <strong>${uniqEmbeds}</strong> embed${uniqEmbeds === 1 ? "" : "s"} on <strong>${uniqClients}</strong> site${uniqClients === 1 ? "" : "s"}.</p>`;
  const tbody =
    opts.rows.length === 0
      ? `<tr><td colspan="6" style="color:var(--fg-muted);font-style:italic;text-align:center;padding:1rem">No placements match these filters.</td></tr>`
      : opts.rows
          .map((r) => {
            const clientCell = r.client_proxy_domain
              ? `<a class="mono" href="/app/clients/${esc(r.client_id)}">${esc(r.client_id)}</a><div class="mono" style="font-size:.75rem;color:var(--fg-muted)">${esc(r.client_proxy_domain)}</div>`
              : `<span class="mono" style="color:var(--fg-muted)" title="client row missing — site may have been deleted">${esc(r.client_id)} ⚠</span>`;
            const clusterCell =
              r.source_cluster_id !== null
                ? r.cluster_label
                  ? `<a href="/app/clusters/${r.source_cluster_id}">${esc(r.cluster_label)}</a>`
                  : `<span style="color:var(--fg-muted)">deleted (#${r.source_cluster_id})</span>`
                : `<span style="color:var(--fg-muted)">—</span>`;
            return `<tr>
              <td><a href="/app/embeds/${r.embed_id}">${esc(r.embed_name)}</a> <code style="font-size:.7rem;color:var(--fg-muted)">${esc(r.embed_kind)}</code></td>
              <td>${clientCell}</td>
              <td><code>${esc(r.position)}</code></td>
              <td>${clusterCell}</td>
              <td class="mono" style="color:var(--fg-muted);font-size:.78rem">${esc(r.applied_at)}<div style="font-size:.7rem">by ${esc(r.applied_by_email)}</div></td>
              <td>
                <form method="POST" action="/app/embeds/${r.embed_id}/remove/${esc(r.client_id)}" style="display:inline" onsubmit="return confirm('Remove embed &quot;${esc(r.embed_name).replace(/'/g, "&#39;")}&quot; from ${esc(r.client_id)}?\\n\\nStrips the content_injection rule. Canonical + indexation rules are left in place. Audit log records embed_remove.');">
                  <button type="submit" class="btn" style="font-size:.75rem;padding:.2rem .5rem;color:var(--red)">Remove</button>
                </form>
              </td>
            </tr>`;
          })
          .join("");
  return `<h1>Embed placements</h1>
    <p class="subtitle">${ownership}</p>
    ${summary}
    <form method="GET" action="/app/embeds/placements" class="editor" style="margin-bottom:1rem">
      <div class="form-grid" style="gap:.6rem">
        <div>
          <label for="filter_embed" style="font-size:.8rem">embed</label>
          <select id="filter_embed" name="embed_id">${embedOptions}</select>
        </div>
        <div>
          <label for="filter_cluster" style="font-size:.8rem">applied from cluster</label>
          <select id="filter_cluster" name="cluster_id">${clusterOptions}</select>
        </div>
        <div>
          <label for="filter_search" style="font-size:.8rem">site search</label>
          <input id="filter_search" name="client_search" type="text" placeholder="substring match on client_id" value="${esc(opts.filters.client_search ?? "")}">
        </div>
      </div>
      <div class="form-actions" style="margin-top:.6rem">
        <button class="btn btn-primary" type="submit">Filter</button>
        <a class="btn" href="/app/embeds/placements">Clear</a>
      </div>
    </form>
    <table class="data">
      <thead><tr><th>Embed</th><th>Site</th><th>Position</th><th>From cluster</th><th>Applied</th><th></th></tr></thead>
      <tbody>${tbody}</tbody>
    </table>`;
}

export async function handlePlacementRemovePost(
  request: Request,
  env: AppEnv,
  url: URL,
  user: User,
  embedId: number,
  clientId: string,
): Promise<Response> {
  const csrf = checkCsrf(request, url);
  if (csrf) return csrf;
  // Visibility check: operator must be able to see the embed AND the
  // client (super-admin bypasses both checks via canSeeAllClients).
  const embed = await loadVisibleEmbed(env, user, embedId);
  if (!embed) return new Response("Embed not found or not visible", { status: 404 });
  if (!canSeeAllClients(user)) {
    const ownClient = await env.CONFIG_DB.prepare(
      "SELECT client_id FROM clients WHERE client_id = ? AND owner_id = ?",
    )
      .bind(clientId, user.id)
      .first<{ client_id: string }>();
    if (!ownClient) {
      return new Response("Client not visible to you", { status: 404 });
    }
  }
  const result = await removeEmbedFromClient(env, user, embedId, clientId, actorIp(request));
  if (!result.ok) {
    return flashRedirect("/app/embeds/placements", { text: result.error, kind: "err" });
  }
  return flashRedirect("/app/embeds/placements", {
    text: `Removed "${embed.name}" from ${clientId}. Canonical + indexation rules left in place.`,
    kind: "ok",
  });
}

export function renderEmbedApplyForm(opts: {
  embed: EmbedRow;
  visibleClusters: readonly ClusterRow[];
  indexerOptions: readonly IndexerOption[];
  errors: string[];
}): string {
  const errBox =
    opts.errors.length > 0 ? `<div class="error-box">${opts.errors.map(esc).join("\n")}</div>` : "";
  const clusterOptions =
    opts.visibleClusters.length === 0
      ? `<option value="">— no clusters available — create one first —</option>`
      : [
          `<option value="">— pick a cluster —</option>`,
          ...opts.visibleClusters.map(
            (c) => `<option value="${c.id}">${esc(c.label)} (${esc(c.type)})</option>`,
          ),
        ].join("");
  const positionOptions = EMBED_POSITIONS.map(
    (p) =>
      `<option value="${esc(p)}"${opts.embed.default_position === p ? " selected" : ""}>${esc(p)}</option>`,
  ).join("");
  const indexerCheckboxes = opts.indexerOptions
    .map(
      (
        i,
      ) => `<label class="proxy-radio" style="border-left:4px solid ${esc(i.color)};padding-left:.55rem">
        <input type="checkbox" name="indexer_${esc(i.slotKey)}" value="1"${i.available ? "" : " disabled"}>
        <span><strong>${esc(i.label)}</strong>${i.available ? "" : ` <span style="color:var(--fg-muted);font-size:.75rem">(no API key — set on <a href="/app/settings/api-keys">Settings</a>)</span>`}</span>
      </label>`,
    )
    .join("");
  return `<div class="crumbs"><a href="/app/embeds/${opts.embed.id}">← ${esc(opts.embed.name)}</a></div>
    <h1>Apply embed: ${esc(opts.embed.name)}</h1>
    <p class="subtitle">For each selected site, this appends a content_injection rule, sets the canonical strategy to <code>self</code>, and sets <code>indexation</code> to <code>index,follow</code>. Re-applying replaces the previous version of this embed (idempotent by <code>embed:${opts.embed.id}</code> marker).</p>
    ${errBox}
    <form class="editor" method="POST" action="/app/embeds/${opts.embed.id}/apply">
      <div class="form-section">
        <label for="apply_cluster">target cluster</label>
        <select id="apply_cluster" name="cluster_id" required>${clusterOptions}</select>
        <div class="field-hint">Next step lets you pick which member sites to apply to (defaults to all).</div>
      </div>
      <div class="form-section">
        <label for="apply_position">position</label>
        <select id="apply_position" name="position">${positionOptions}</select>
        <div class="field-hint">Defaults to the embed's <code>${esc(opts.embed.default_position)}</code>; override here for this apply only (embed default is unchanged).</div>
      </div>
      <div class="form-section">
        <label style="display:block;font-weight:500;margin-bottom:.4rem">Submit to indexers on completion <span style="color:var(--fg-muted);font-weight:400">(optional — each costs credits/quota)</span></label>
        <div class="proxy-mode" style="flex-direction:column;align-items:flex-start;gap:.45rem">${indexerCheckboxes}</div>
        <div class="field-hint">All unchecked by default to protect your credits. Indexers without a configured API key are disabled.</div>
      </div>
      <div class="form-actions">
        <button class="btn btn-primary" type="submit">Next: pick sites →</button>
        <a class="btn" href="/app/embeds/${opts.embed.id}">Cancel</a>
      </div>
    </form>`;
}

/**
 * Step-2 picker: shown after the operator picks a cluster + position
 * + indexers on the step-1 form. Lists every cluster member as a
 * checkbox row (all checked by default) and carries the step-1 state
 * through hidden inputs so the final POST has everything it needs.
 */
export function renderEmbedApplyPicker(opts: {
  embed: EmbedRow;
  cluster: ClusterRow;
  members: readonly { client_id: string; proxy_domain: string; status: string }[];
  position: EmbedPosition;
  selectedIndexerSlots: readonly string[];
  errors: string[];
}): string {
  const errBox =
    opts.errors.length > 0 ? `<div class="error-box">${opts.errors.map(esc).join("\n")}</div>` : "";
  const indexerHidden = opts.selectedIndexerSlots
    .map((s) => `<input type="hidden" name="indexer_${esc(s)}" value="1">`)
    .join("");
  const rows = opts.members
    .map(
      (m) => `<tr>
        <td><input type="checkbox" name="client_id" value="${esc(m.client_id)}" checked></td>
        <td><a class="mono" href="/app/clients/${esc(m.client_id)}">${esc(m.client_id)}</a></td>
        <td class="mono" style="font-size:.8rem;color:var(--fg-muted)">${esc(m.proxy_domain)}</td>
        <td><span class="pill ${m.status === "active" ? "pill-active" : "pill-paused"}">${esc(m.status)}</span></td>
      </tr>`,
    )
    .join("");
  const indexerSummary =
    opts.selectedIndexerSlots.length === 0
      ? "no indexers will fire on completion"
      : `indexers on completion: <code>${opts.selectedIndexerSlots.map((s) => esc(s)).join("</code>, <code>")}</code>`;
  return `<div class="crumbs"><a href="/app/embeds/${opts.embed.id}/apply">← back to step 1</a></div>
    <h1>Pick sites — ${esc(opts.embed.name)}</h1>
    <p class="subtitle">Cluster <code>${esc(opts.cluster.label)}</code> · position <code>${esc(opts.position)}</code> · ${indexerSummary}</p>
    ${errBox}
    <form class="editor" method="POST" action="/app/embeds/${opts.embed.id}/apply/confirm">
      <input type="hidden" name="cluster_id" value="${opts.cluster.id}">
      <input type="hidden" name="position" value="${esc(opts.position)}">
      ${indexerHidden}
      <div class="form-section">
        <p class="field-hint" style="margin:0 0 .6rem">Uncheck sites you don't want to apply to. All ${opts.members.length} members are selected by default. Use the header checkbox to toggle all.</p>
        <table class="data" style="margin:0">
          <thead><tr>
            <th style="width:2.5rem"><input type="checkbox" id="embed-pick-all" checked title="Select / deselect all"></th>
            <th>Site</th>
            <th>Proxy domain</th>
            <th>Status</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
      <div class="form-actions">
        <button class="btn btn-primary" type="submit">Apply to selected</button>
        <a class="btn" href="/app/embeds/${opts.embed.id}/apply">← Back</a>
      </div>
    </form>
    <script>
      (function() {
        var master = document.getElementById('embed-pick-all');
        if (!master) return;
        function pickBoxes() {
          return Array.prototype.slice.call(
            document.querySelectorAll('input[type=checkbox][name="client_id"]')
          );
        }
        function syncMaster() {
          var boxes = pickBoxes();
          if (boxes.length === 0) return;
          var checkedCount = boxes.filter(function(b) { return b.checked; }).length;
          master.checked = checkedCount === boxes.length;
          master.indeterminate = checkedCount > 0 && checkedCount < boxes.length;
        }
        master.addEventListener('change', function() {
          pickBoxes().forEach(function(b) { b.checked = master.checked; });
          master.indeterminate = false;
        });
        pickBoxes().forEach(function(b) { b.addEventListener('change', syncMaster); });
        syncMaster();
      })();
    </script>`;
}

export function renderEmbedDetail(opts: {
  embed: EmbedRow;
  placements: readonly EmbedPlacementRow[];
  indexerOptions: readonly IndexerOption[];
}): string {
  const placementsRows =
    opts.placements.length === 0
      ? `<tr><td colspan="4" style="color:var(--fg-muted);font-style:italic">No placements yet — click "Apply to cluster" to get started.</td></tr>`
      : opts.placements
          .map(
            (p) => `<tr>
        <td><a href="/app/clients/${esc(p.client_id)}" class="mono">${esc(p.client_id)}</a></td>
        <td><code>${esc(p.position)}</code></td>
        <td>${p.source_cluster_id !== null ? `<a href="/app/clusters/${p.source_cluster_id}">${p.source_cluster_id}</a>` : '<span style="color:var(--fg-muted)">—</span>'}</td>
        <td class="mono" style="color:var(--fg-muted);font-size:.85rem">${esc(p.applied_at)} <span style="color:var(--fg-muted)">by ${esc(p.applied_by_email)}</span></td>
      </tr>`,
          )
          .join("");
  const reapplyDisabled = opts.placements.length === 0;
  const indexerCheckboxes = opts.indexerOptions
    .map(
      (
        i,
      ) => `<label class="proxy-radio" style="border-left:4px solid ${esc(i.color)};padding-left:.55rem">
        <input type="checkbox" name="indexer_${esc(i.slotKey)}" value="1"${i.available ? "" : " disabled"}>
        <span><strong>${esc(i.label)}</strong>${i.available ? "" : ` <span style="color:var(--fg-muted);font-size:.75rem">(no API key)</span>`}</span>
      </label>`,
    )
    .join("");
  return `<div class="crumbs"><a href="/app/embeds">← Embeds</a></div>
    <h1>${esc(opts.embed.name)}</h1>
    <p class="subtitle">
      Kind: <code>${esc(opts.embed.kind)}</code> · Default position: <code>${esc(opts.embed.default_position)}</code> · Created: ${esc(opts.embed.created_at)}
    </p>
    <div class="actions-row" style="display:flex;gap:.5rem;margin-bottom:1rem">
      <a class="btn btn-primary" href="/app/embeds/${opts.embed.id}/apply">Apply to cluster</a>
      <a class="btn" href="/app/embeds/${opts.embed.id}/edit">Edit</a>
    </div>
    <details style="margin-bottom:1.5rem">
      <summary>Show HTML</summary>
      <pre class="mono" style="background:var(--bg-elevated,var(--bg));border:1px dashed var(--border);padding:.6rem;border-radius:var(--radius);overflow:auto;white-space:pre-wrap;word-break:break-all;font-size:.82rem">${esc(opts.embed.html)}</pre>
    </details>
    <h2 style="font-size:1rem">Placements (${opts.placements.length})</h2>
    <table class="data" style="margin-bottom:1rem">
      <thead><tr><th>Site</th><th>Position</th><th>From cluster</th><th>Applied</th></tr></thead>
      <tbody>${placementsRows}</tbody>
    </table>
    <form method="POST" action="/app/embeds/${opts.embed.id}/reapply" class="editor" ${reapplyDisabled ? 'style="opacity:.5;pointer-events:none"' : ""}>
      <div class="form-section">
        <h3 style="margin-top:0;font-size:.95rem">Reapply to all placements</h3>
        <p class="field-hint" style="margin:0 0 .6rem">Re-runs apply for every row above using each placement's saved position. Use after editing the HTML to propagate.</p>
        <div class="proxy-mode" style="flex-direction:column;align-items:flex-start;gap:.45rem">${indexerCheckboxes}</div>
        <div class="field-hint" style="margin-top:.4rem">Optional: submit to selected indexers after each site is re-applied.</div>
      </div>
      <div class="form-actions">
        <button class="btn" type="submit"${reapplyDisabled ? " disabled" : ""}>Reapply to all (${opts.placements.length})</button>
      </div>
    </form>`;
}

export function renderEmbedApplyResult(opts: {
  embed: EmbedRow;
  cluster: ClusterRow | null;
  results: readonly ApplySiteResult[];
}): string {
  const okCount = opts.results.filter((r) => r.ok).length;
  const failCount = opts.results.length - okCount;
  const summary = `<p class="subtitle">${okCount}/${opts.results.length} sites updated${failCount > 0 ? `, ${failCount} failed` : ""}${opts.cluster ? ` in cluster <code>${esc(opts.cluster.label)}</code>` : ""}.</p>`;
  const tbody = opts.results
    .map((r) => {
      const indexerCell = r.indexer_results
        ? r.indexer_results
            .map(
              (ir) =>
                `<div style="font-size:.78rem;color:${ir.ok ? "var(--green)" : "var(--red)"}">${esc(ir.label)}: ${esc(ir.message)}</div>`,
            )
            .join("")
        : `<span style="color:var(--fg-muted);font-size:.78rem">no indexers selected</span>`;
      return `<tr>
        <td><a href="/app/clients/${esc(r.client_id)}" class="mono">${esc(r.client_id)}</a></td>
        <td>${r.ok ? '<span class="pill pill-active">applied</span>' : '<span class="pill pill-terminated">failed</span>'}</td>
        <td>${r.error ? `<span style="color:var(--red);font-size:.85rem">${esc(r.error)}</span>` : indexerCell}</td>
      </tr>`;
    })
    .join("");
  return `<div class="crumbs"><a href="/app/embeds/${opts.embed.id}">← ${esc(opts.embed.name)}</a></div>
    <h1>Apply result — ${esc(opts.embed.name)}</h1>
    ${summary}
    <table class="data">
      <thead><tr><th>Site</th><th>Status</th><th>Indexer outcomes</th></tr></thead>
      <tbody>${tbody}</tbody>
    </table>
    <div class="actions-row" style="margin-top:1rem;display:flex;gap:.5rem">
      <a class="btn btn-primary" href="/app/embeds/${opts.embed.id}">Back to embed</a>
      <a class="btn" href="/app/embeds">All embeds</a>
    </div>`;
}

/* ─── POST handlers ─── */

export async function handleEmbedNewPost(
  request: Request,
  env: AppEnv,
  url: URL,
  user: User,
): Promise<{ redirect: Response } | { errors: string[]; prefill: Partial<EmbedInput> }> {
  const csrf = checkCsrf(request, url);
  if (csrf) return { redirect: csrf };
  const form = await request.formData();
  const raw: Record<string, string> = {};
  for (const [k, v] of form.entries()) {
    if (typeof v === "string") raw[k] = v;
  }
  const validation = validateEmbedInput(raw);
  if (!validation.ok) {
    const prefill: Partial<EmbedInput> = {};
    if (raw.name !== undefined) prefill.name = raw.name;
    if ((EMBED_KINDS as readonly string[]).includes(raw.kind ?? "")) {
      prefill.kind = raw.kind as EmbedKind;
    }
    if (raw.html !== undefined) prefill.html = raw.html;
    if ((EMBED_POSITIONS as readonly string[]).includes(raw.default_position ?? "")) {
      prefill.default_position = raw.default_position as EmbedPosition;
    }
    return { errors: validation.errors, prefill };
  }
  const v = validation.value;
  try {
    await env.CONFIG_DB.prepare(
      "INSERT INTO embeds (owner_id, name, kind, html, default_position) VALUES (?, ?, ?, ?, ?)",
    )
      .bind(user.id, v.name, v.kind, v.html, v.default_position)
      .run();
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    const friendly =
      message.includes("UNIQUE") && message.includes("name")
        ? `An embed named "${v.name}" already exists. Pick a different name.`
        : `DB error: ${message}`;
    return { errors: [friendly], prefill: v };
  }
  return {
    redirect: flashRedirect("/app/embeds", { text: `Created embed "${v.name}".`, kind: "ok" }),
  };
}

export async function handleEmbedEditPost(
  request: Request,
  env: AppEnv,
  url: URL,
  user: User,
  id: number,
): Promise<
  { redirect: Response } | { errors: string[]; prefill: Partial<EmbedInput> & { id: number } }
> {
  const csrf = checkCsrf(request, url);
  if (csrf) return { redirect: csrf };
  const embed = await loadVisibleEmbed(env, user, id);
  if (!embed) {
    return { redirect: new Response("Embed not found", { status: 404 }) };
  }
  const form = await request.formData();
  const raw: Record<string, string> = {};
  for (const [k, v] of form.entries()) {
    if (typeof v === "string") raw[k] = v;
  }
  const validation = validateEmbedInput(raw);
  if (!validation.ok) {
    const prefill: Partial<EmbedInput> & { id: number } = { id };
    if (raw.name !== undefined) prefill.name = raw.name;
    if ((EMBED_KINDS as readonly string[]).includes(raw.kind ?? "")) {
      prefill.kind = raw.kind as EmbedKind;
    }
    if (raw.html !== undefined) prefill.html = raw.html;
    if ((EMBED_POSITIONS as readonly string[]).includes(raw.default_position ?? "")) {
      prefill.default_position = raw.default_position as EmbedPosition;
    }
    return { errors: validation.errors, prefill };
  }
  const v = validation.value;
  try {
    await env.CONFIG_DB.prepare(
      "UPDATE embeds SET name = ?, kind = ?, html = ?, default_position = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
    )
      .bind(v.name, v.kind, v.html, v.default_position, id)
      .run();
  } catch (e) {
    return {
      errors: [`DB error: ${e instanceof Error ? e.message : String(e)}`],
      prefill: { id, ...v },
    };
  }
  return {
    redirect: flashRedirect(`/app/embeds/${id}`, { text: `Saved embed "${v.name}".`, kind: "ok" }),
  };
}

export async function handleEmbedDeletePost(
  request: Request,
  env: AppEnv,
  url: URL,
  user: User,
  id: number,
): Promise<Response> {
  const csrf = checkCsrf(request, url);
  if (csrf) return csrf;
  const embed = await loadVisibleEmbed(env, user, id);
  if (!embed) return new Response("Embed not found", { status: 404 });
  // Note: placement rows stay (ON DELETE CASCADE drops them, but the
  // injected HTML stays in each affected config_json — operators can
  // edit per-site to remove). Future: a "Remove from all sites"
  // server action that strips the content_injection rule.
  await env.CONFIG_DB.prepare("DELETE FROM embeds WHERE id = ?").bind(id).run();
  return flashRedirect("/app/embeds", {
    text: `Deleted embed "${embed.name}". Existing placements stay live — edit each site to remove.`,
    kind: "warn",
  });
}

/**
 * Parse the indexer checkbox group out of a form. Each checkbox is
 * named `indexer_<SLOT_KEY>`; the value is `"1"` when checked. Returns
 * the list of slot keys the operator selected.
 */
export function parseSelectedIndexers(raw: Record<string, string>): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(raw)) {
    if (!k.startsWith("indexer_")) continue;
    if (v !== "1") continue;
    out.push(k.slice("indexer_".length));
  }
  return out;
}

/**
 * Step-1 POST handler — operator picked cluster + position +
 * indexers. We validate, load the cluster's members, and return the
 * picker payload so the route renders step 2 (per-site checkboxes).
 * No mutation happens here; the actual apply waits for step 2.
 */
export async function handleEmbedApplyPost(
  request: Request,
  env: AppEnv,
  url: URL,
  user: User,
  embedId: number,
): Promise<
  | {
      picker: {
        embed: EmbedRow;
        cluster: ClusterRow;
        members: Array<{ client_id: string; proxy_domain: string; status: string }>;
        position: EmbedPosition;
        selectedIndexerSlots: string[];
      };
    }
  | { response: Response }
> {
  const csrf = checkCsrf(request, url);
  if (csrf) return { response: csrf };
  const embed = await loadVisibleEmbed(env, user, embedId);
  if (!embed) return { response: new Response("Embed not found", { status: 404 }) };
  const form = await request.formData();
  const raw: Record<string, string> = {};
  for (const [k, v] of form.entries()) {
    if (typeof v === "string") raw[k] = v;
  }
  const clusterId = Number.parseInt((raw.cluster_id ?? "").trim(), 10);
  if (!Number.isFinite(clusterId) || clusterId <= 0) {
    return {
      response: flashRedirect(`/app/embeds/${embedId}/apply`, {
        text: "Pick a cluster.",
        kind: "err",
      }),
    };
  }
  const visibleClusters = await loadVisibleClusters(env, user);
  const cluster = visibleClusters.find((c) => c.id === clusterId);
  if (!cluster) {
    return {
      response: flashRedirect(`/app/embeds/${embedId}/apply`, {
        text: "Cluster not found or not visible to you.",
        kind: "err",
      }),
    };
  }
  const positionRaw = (raw.position ?? embed.default_position).trim();
  const position: EmbedPosition = (EMBED_POSITIONS as readonly string[]).includes(positionRaw)
    ? (positionRaw as EmbedPosition)
    : embed.default_position;
  const selectedIndexers = parseSelectedIndexers(raw);

  // Load the cluster's members + their proxy_domain/status for the
  // picker table. We don't apply yet — that's step 2.
  const membersByCluster = await loadAllClusterMembersByCluster(env, [cluster.id]);
  const memberClientIds = membersByCluster.get(cluster.id) ?? [];
  let members: Array<{ client_id: string; proxy_domain: string; status: string }> = [];
  if (memberClientIds.length > 0) {
    const placeholders = memberClientIds.map(() => "?").join(", ");
    const rows = await env.CONFIG_DB.prepare(
      `SELECT client_id, proxy_domain, status FROM clients
       WHERE client_id IN (${placeholders})
       ORDER BY client_id`,
    )
      .bind(...memberClientIds)
      .all<{ client_id: string; proxy_domain: string; status: string }>();
    members = rows.results ?? [];
  }
  if (members.length === 0) {
    return {
      response: flashRedirect(`/app/embeds/${embedId}/apply`, {
        text: `Cluster "${cluster.label}" has no member sites — add some first.`,
        kind: "warn",
      }),
    };
  }
  return {
    picker: {
      embed,
      cluster,
      members,
      position,
      selectedIndexerSlots: selectedIndexers,
    },
  };
}

/**
 * Step-2 confirm handler — operator picked specific client_ids on
 * the picker page. Validates the selected ids against the cluster's
 * current membership (so a stale picker can't apply to non-members)
 * and runs the actual apply via `applyEmbedToClients`.
 */
export async function handleEmbedApplyConfirmPost(
  request: Request,
  env: AppEnv,
  url: URL,
  user: User,
  embedId: number,
): Promise<
  | { result: { embed: EmbedRow; cluster: ClusterRow | null; results: ApplySiteResult[] } }
  | { response: Response }
> {
  const csrf = checkCsrf(request, url);
  if (csrf) return { response: csrf };
  const embed = await loadVisibleEmbed(env, user, embedId);
  if (!embed) return { response: new Response("Embed not found", { status: 404 }) };
  const form = await request.formData();
  const raw: Record<string, string> = {};
  const checkedClientIds: string[] = [];
  for (const [k, v] of form.entries()) {
    if (typeof v !== "string") continue;
    if (k === "client_id") checkedClientIds.push(v);
    else raw[k] = v;
  }
  const clusterId = Number.parseInt((raw.cluster_id ?? "").trim(), 10);
  if (!Number.isFinite(clusterId) || clusterId <= 0) {
    return {
      response: flashRedirect(`/app/embeds/${embedId}/apply`, {
        text: "Lost cluster context — start over from the apply form.",
        kind: "err",
      }),
    };
  }
  const visibleClusters = await loadVisibleClusters(env, user);
  const cluster = visibleClusters.find((c) => c.id === clusterId);
  if (!cluster) {
    return {
      response: flashRedirect(`/app/embeds/${embedId}/apply`, {
        text: "Cluster not found or not visible to you.",
        kind: "err",
      }),
    };
  }
  // Validate every picked client_id belongs to this cluster (defence
  // against a tampered form submission applying to arbitrary sites).
  const membersByCluster = await loadAllClusterMembersByCluster(env, [cluster.id]);
  const memberSet = new Set(membersByCluster.get(cluster.id) ?? []);
  const validClientIds = checkedClientIds.filter((id) => memberSet.has(id));
  if (validClientIds.length === 0) {
    return {
      response: flashRedirect(`/app/embeds/${embedId}/apply`, {
        text: "No sites selected. Pick at least one and try again.",
        kind: "warn",
      }),
    };
  }
  const positionRaw = (raw.position ?? embed.default_position).trim();
  const position: EmbedPosition = (EMBED_POSITIONS as readonly string[]).includes(positionRaw)
    ? (positionRaw as EmbedPosition)
    : embed.default_position;
  const selectedIndexers = parseSelectedIndexers(raw);
  const results = await applyEmbedToClients(
    env,
    user,
    embed,
    validClientIds,
    cluster.id,
    position,
    selectedIndexers,
    actorIp(request),
  );
  return { result: { embed, cluster, results } };
}

/**
 * Standalone "Submit cluster to indexers" — decoupled from embed
 * apply. For each member site, collect URLs (sitemap or homepage
 * fallback) and fan out to the operator-selected indexers.
 *
 * Used by the button on the cluster detail page; no config mutation.
 */
export async function submitClusterToIndexers(
  env: AppEnv,
  cluster: ClusterRow,
  selectedIndexerSlots: readonly string[],
): Promise<ApplySiteResult[]> {
  if (selectedIndexerSlots.length === 0) return [];
  const membersByCluster = await loadAllClusterMembersByCluster(env, [cluster.id]);
  const memberClientIds = membersByCluster.get(cluster.id) ?? [];
  if (memberClientIds.length === 0) return [];
  const placeholders = memberClientIds.map(() => "?").join(", ");
  const clients = await env.CONFIG_DB.prepare(
    `SELECT * FROM clients WHERE client_id IN (${placeholders})`,
  )
    .bind(...memberClientIds)
    .all<ClientRow>();
  const out: ApplySiteResult[] = [];
  for (const client of clients.results ?? []) {
    try {
      let urls: string[] = [];
      try {
        const parsed = JSON.parse(client.config_json) as ClientConfig;
        urls = collectSitemapUrls(parsed);
      } catch {
        urls = [];
      }
      const targetUrls = urls.length > 0 ? urls : [`https://${client.proxy_domain}/`];
      const indexerResults = await pingSelectedIndexers(
        env as unknown as Parameters<typeof pingSelectedIndexers>[0],
        targetUrls,
        { proxyDomain: client.proxy_domain },
        selectedIndexerSlots,
      );
      out.push({
        client_id: client.client_id,
        proxy_domain: client.proxy_domain,
        ok: true,
        indexer_results: indexerResults.map((r) => ({
          label: r.label,
          ok: r.result.ok,
          message: r.result.message,
        })),
      });
    } catch (e) {
      out.push({
        client_id: client.client_id,
        proxy_domain: client.proxy_domain,
        ok: false,
        error: `Indexer fan-out threw: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  }
  return out;
}

export async function handleClusterSubmitIndexersPost(
  request: Request,
  env: AppEnv,
  url: URL,
  cluster: ClusterRow,
): Promise<{ results: ApplySiteResult[] } | { response: Response }> {
  const csrf = checkCsrf(request, url);
  if (csrf) return { response: csrf };
  const form = await request.formData();
  const raw: Record<string, string> = {};
  for (const [k, v] of form.entries()) {
    if (typeof v === "string") raw[k] = v;
  }
  const selected = parseSelectedIndexers(raw);
  if (selected.length === 0) {
    return {
      response: flashRedirect(`/app/clusters/${cluster.id}`, {
        text: "Pick at least one indexer.",
        kind: "warn",
      }),
    };
  }
  const results = await submitClusterToIndexers(env, cluster, selected);
  return { results };
}

export function renderClusterSubmitResult(opts: {
  cluster: ClusterRow;
  results: readonly ApplySiteResult[];
}): string {
  const okCount = opts.results.filter((r) => r.ok).length;
  const tbody = opts.results
    .map((r) => {
      const indexerCell = r.indexer_results
        ? r.indexer_results
            .map(
              (ir) =>
                `<div style="font-size:.78rem;color:${ir.ok ? "var(--green)" : "var(--red)"}">${esc(ir.label)}: ${esc(ir.message)}</div>`,
            )
            .join("")
        : `<span style="color:var(--fg-muted);font-size:.78rem">no result</span>`;
      return `<tr>
        <td><a href="/app/clients/${esc(r.client_id)}" class="mono">${esc(r.client_id)}</a></td>
        <td>${r.ok ? '<span class="pill pill-active">ok</span>' : '<span class="pill pill-terminated">failed</span>'}</td>
        <td>${r.error ? `<span style="color:var(--red);font-size:.85rem">${esc(r.error)}</span>` : indexerCell}</td>
      </tr>`;
    })
    .join("");
  return `<div class="crumbs"><a href="/app/clusters/${opts.cluster.id}">← ${esc(opts.cluster.label)}</a></div>
    <h1>Indexer submission — ${esc(opts.cluster.label)}</h1>
    <p class="subtitle">${okCount}/${opts.results.length} sites submitted to selected indexers.</p>
    <table class="data">
      <thead><tr><th>Site</th><th>Status</th><th>Indexer outcomes</th></tr></thead>
      <tbody>${tbody}</tbody>
    </table>
    <div class="actions-row" style="margin-top:1rem">
      <a class="btn btn-primary" href="/app/clusters/${opts.cluster.id}">Back to cluster</a>
    </div>`;
}

/**
 * Render the indexer-checkbox form inline on the cluster detail page.
 * No standalone page — the form POSTs to the cluster submit-indexers
 * endpoint and the route handler renders the result page.
 */
export function renderClusterSubmitIndexersFormBlock(opts: {
  clusterId: number;
  indexerOptions: readonly IndexerOption[];
}): string {
  const indexerCheckboxes = opts.indexerOptions
    .map(
      (
        i,
      ) => `<label class="proxy-radio" style="border-left:4px solid ${esc(i.color)};padding-left:.55rem">
        <input type="checkbox" name="indexer_${esc(i.slotKey)}" value="1"${i.available ? "" : " disabled"}>
        <span><strong>${esc(i.label)}</strong>${i.available ? "" : ` <span style="color:var(--fg-muted);font-size:.75rem">(no API key)</span>`}</span>
      </label>`,
    )
    .join("");
  return `<div class="card">
    <h2 style="margin-top:0">Submit cluster to indexers</h2>
    <p class="field-hint" style="margin:0 0 .6rem">Pick which indexers to fire for every member site's seed URLs (sitemap or homepage if none). Doesn't change config — just submits URLs.</p>
    <form method="POST" action="/app/clusters/${opts.clusterId}/submit-indexers">
      <div class="proxy-mode" style="flex-direction:column;align-items:flex-start;gap:.45rem;margin-bottom:.6rem">${indexerCheckboxes}</div>
      <button class="btn btn-primary" type="submit">Submit to selected indexers</button>
    </form>
  </div>`;
}

export async function handleEmbedReapplyPost(
  request: Request,
  env: AppEnv,
  url: URL,
  user: User,
  embedId: number,
): Promise<
  | { result: { embed: EmbedRow; cluster: ClusterRow | null; results: ApplySiteResult[] } }
  | { response: Response }
> {
  const csrf = checkCsrf(request, url);
  if (csrf) return { response: csrf };
  const embed = await loadVisibleEmbed(env, user, embedId);
  if (!embed) return { response: new Response("Embed not found", { status: 404 }) };
  const form = await request.formData();
  const raw: Record<string, string> = {};
  for (const [k, v] of form.entries()) {
    if (typeof v === "string") raw[k] = v;
  }
  const selectedIndexers = parseSelectedIndexers(raw);
  const placements = await loadPlacementsForEmbed(env, embedId);
  if (placements.length === 0) {
    return {
      response: flashRedirect(`/app/embeds/${embedId}`, {
        text: "No placements to reapply.",
        kind: "warn",
      }),
    };
  }
  // Load each client row once.
  const clientIds = placements.map((p) => p.client_id);
  const placeholders = clientIds.map(() => "?").join(", ");
  const clients = await env.CONFIG_DB.prepare(
    `SELECT * FROM clients WHERE client_id IN (${placeholders})`,
  )
    .bind(...clientIds)
    .all<ClientRow>();
  const clientById = new Map<string, ClientRow>(
    (clients.results ?? []).map((c) => [c.client_id, c]),
  );

  const results: ApplySiteResult[] = [];
  for (const placement of placements) {
    const client = clientById.get(placement.client_id);
    if (!client) {
      results.push({
        client_id: placement.client_id,
        proxy_domain: "",
        ok: false,
        error: "Client row not found (deleted?). Skipping.",
      });
      continue;
    }
    // Use the placement's saved position (not the embed's current
    // default) so the operator's per-apply override is preserved.
    const result = await applyEmbedToSingleClient(
      env,
      user,
      embed,
      client,
      placement.source_cluster_id,
      placement.position,
      selectedIndexers,
      actorIp(request),
    );
    results.push(result);
  }
  return { result: { embed, cluster: null, results } };
}
