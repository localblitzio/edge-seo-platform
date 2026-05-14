/**
 * Platform-wide indexation overview (`/app/indexation`).
 *
 * Aggregates the per-URL indexation_checks data into:
 *   - Platform stat cards (total sites, URLs, indexed / not / unknown / unchecked)
 *   - Per-cluster rollup table
 *   - Per-site rollup table (filterable by cluster, status, search, last-check age)
 *   - Recent activity feed (last 50 checks across visible clients)
 *
 * Read-only — no mutations, no DataForSEO calls. Bulk-check actions
 * (Phase B + C) live on the cluster page and on this page's filter
 * toolbar respectively, but the data load below is pure read.
 *
 * Cost / scale notes:
 *   - The data load parses every visible client's config_json to
 *     derive URL lists via `computePathDiagnostics`. For ~50 sites
 *     that's <500ms; for 500+ a denormalized counter table would be
 *     needed (deferred until you actually hit that scale).
 *   - All filters apply to the rollup tables but NOT to the platform
 *     stat header (otherwise the totals would be misleading).
 */

import { ClientConfig } from "../../src/config/schema.js";
import { computePathDiagnostics } from "../../src/sitemap/diagnostics.js";
import type { AppEnv, ClientRow, FlashMessage } from "./app.js";
import { canSeeAllClients, esc } from "./app.js";
import type { User } from "./auth.js";
import type { ClusterRow } from "./clusters.js";
import {
  type BulkCheckRowResult,
  type BulkCheckTarget,
  type IndexationCheckRow,
  bulkCheckUrls,
  loadCheckedUrlSet,
  loadStaleTargets,
} from "./indexation-check.js";

export type IndexationStatus = "indexed" | "not_indexed" | "unknown" | "unchecked";

export const LAST_CHECK_AGE_FILTERS = ["any", "lt_24h", "lt_7d", "gt_7d", "never"] as const;
export type LastCheckAgeFilter = (typeof LAST_CHECK_AGE_FILTERS)[number];

export interface IndexationFilters {
  status?: IndexationStatus;
  cluster_id?: number;
  search?: string;
  last_check_age?: LastCheckAgeFilter;
}

export interface PlatformStats {
  site_count: number;
  url_count: number;
  indexed_count: number;
  not_indexed_count: number;
  unknown_count: number;
  unchecked_count: number;
}

export interface SiteRollup {
  client_id: string;
  proxy_domain: string;
  status: string;
  cluster_labels: readonly string[];
  url_count: number;
  indexed_count: number;
  not_indexed_count: number;
  unknown_count: number;
  unchecked_count: number;
  /** ISO timestamp of the most recent check across any URL on this site. Null when nothing checked. */
  latest_check_at: string | null;
  has_embed: boolean;
}

export interface ClusterRollup {
  cluster_id: number;
  label: string;
  type: string;
  member_count: number;
  url_count: number;
  indexed_count: number;
  not_indexed_count: number;
  unknown_count: number;
  unchecked_count: number;
  latest_check_at: string | null;
}

export interface RecentCheckRow extends IndexationCheckRow {
  /** Joined proxy_domain; null when the client row is gone. */
  proxy_domain: string | null;
}

export interface IndexationOverviewData {
  platform: PlatformStats;
  clusters: readonly ClusterRollup[];
  sites: readonly SiteRollup[];
  recent: readonly RecentCheckRow[];
  filters: IndexationFilters;
  /** Cluster list for the filter dropdown. */
  visibleClusters: readonly ClusterRow[];
  /** Useful when no filter narrows the result: hint operator there's nothing. */
  total_sites_before_filter: number;
}

/* ─── Pure helpers (tested) ─── */

/**
 * Bucket a single URL's latest check into one of four states.
 * `check` undefined means no check has ever run for this URL.
 */
export function statusForCheck(check: IndexationCheckRow | undefined): IndexationStatus {
  if (!check) return "unchecked";
  if (check.indexed === 1) return "indexed";
  if (check.indexed === 0) return "not_indexed";
  return "unknown";
}

/**
 * Apply the operator's status / search / last-check-age filters to a
 * pre-computed site rollup list. Cluster filtering happens upstream
 * (in the DB join) because it's cheaper there. Pure — no DB calls,
 * exercised by unit tests.
 *
 * `now` is injected so tests can pin a fixed instant for the age
 * comparisons. Production callers pass `Date.now()`.
 */
export function applySiteFilters(
  sites: readonly SiteRollup[],
  filters: IndexationFilters,
  now: number,
): SiteRollup[] {
  const search = (filters.search ?? "").trim().toLowerCase();
  return sites.filter((s) => {
    if (filters.status) {
      // "show me sites with at least one URL in this status"
      // (sites with mixed status appear under each matching filter).
      switch (filters.status) {
        case "indexed":
          if (s.indexed_count === 0) return false;
          break;
        case "not_indexed":
          if (s.not_indexed_count === 0) return false;
          break;
        case "unknown":
          if (s.unknown_count === 0) return false;
          break;
        case "unchecked":
          if (s.unchecked_count === 0) return false;
          break;
      }
    }
    if (search.length > 0) {
      const blob = `${s.client_id} ${s.proxy_domain}`.toLowerCase();
      if (!blob.includes(search)) return false;
    }
    if (filters.last_check_age && filters.last_check_age !== "any") {
      const last = s.latest_check_at ? Date.parse(s.latest_check_at) : Number.NaN;
      const ageMs = Number.isFinite(last) ? now - last : Number.POSITIVE_INFINITY;
      const day = 24 * 60 * 60 * 1000;
      switch (filters.last_check_age) {
        case "lt_24h":
          if (!(ageMs < day)) return false;
          break;
        case "lt_7d":
          if (!(ageMs < 7 * day)) return false;
          break;
        case "gt_7d":
          if (!(ageMs > 7 * day) && s.latest_check_at !== null) return false;
          // Sites that never checked have ageMs = Infinity, so they pass gt_7d.
          break;
        case "never":
          if (s.latest_check_at !== null) return false;
          break;
      }
    }
    return true;
  });
}

/**
 * Roll a site list up into platform totals. Pure — no DB.
 */
export function platformStatsFromSites(sites: readonly SiteRollup[]): PlatformStats {
  let urls = 0;
  let indexed = 0;
  let notIndexed = 0;
  let unknown = 0;
  let unchecked = 0;
  for (const s of sites) {
    urls += s.url_count;
    indexed += s.indexed_count;
    notIndexed += s.not_indexed_count;
    unknown += s.unknown_count;
    unchecked += s.unchecked_count;
  }
  return {
    site_count: sites.length,
    url_count: urls,
    indexed_count: indexed,
    not_indexed_count: notIndexed,
    unknown_count: unknown,
    unchecked_count: unchecked,
  };
}

/* ─── Data load ─── */

interface ClientWithDiagnostics {
  row: ClientRow;
  urls: string[];
}

async function loadVisibleClientsForOverview(
  env: AppEnv,
  user: User,
): Promise<ClientWithDiagnostics[]> {
  const sql = canSeeAllClients(user)
    ? "SELECT * FROM clients WHERE status != 'terminated' ORDER BY client_id"
    : "SELECT * FROM clients WHERE status != 'terminated' AND owner_id = ? ORDER BY client_id";
  const stmt = canSeeAllClients(user)
    ? env.CONFIG_DB.prepare(sql)
    : env.CONFIG_DB.prepare(sql).bind(user.id);
  const rows = await stmt.all<ClientRow>();
  const out: ClientWithDiagnostics[] = [];
  for (const row of rows.results ?? []) {
    let urls: string[] = [];
    try {
      const config = ClientConfig.parse(JSON.parse(row.config_json));
      urls = computePathDiagnostics(config).map((d) => d.url);
    } catch (e) {
      // Malformed config — log + skip diagnostics. Site still shows
      // with 0 URLs so the operator notices.
      console.warn(`overview: config parse failed for ${row.client_id}`, e);
      urls = [];
    }
    out.push({ row, urls });
  }
  return out;
}

/**
 * Load the latest indexation_check per URL across a list of URLs and
 * clients. Returns a Map keyed `client_id|url` for fast lookup during
 * rollup. Empty input → empty map (no SQL).
 */
async function loadLatestChecks(
  env: AppEnv,
  clients: readonly ClientWithDiagnostics[],
): Promise<Map<string, IndexationCheckRow>> {
  const out = new Map<string, IndexationCheckRow>();
  // Build a single query joining all client_ids; per-URL filter is
  // done in JS after to keep SQL simple.
  const clientIds = clients.map((c) => c.row.client_id);
  if (clientIds.length === 0) return out;
  const placeholders = clientIds.map(() => "?").join(", ");
  const sql = `
    SELECT t.* FROM indexation_checks t
    INNER JOIN (
      SELECT client_id, url, MAX(checked_at) AS max_at
      FROM indexation_checks
      WHERE client_id IN (${placeholders})
      GROUP BY client_id, url
    ) m ON m.client_id = t.client_id
       AND m.url = t.url
       AND m.max_at = t.checked_at
  `;
  const rows = await env.CONFIG_DB.prepare(sql)
    .bind(...clientIds)
    .all<IndexationCheckRow>();
  for (const r of rows.results ?? []) {
    out.set(`${r.client_id}|${r.url}`, r);
  }
  return out;
}

/**
 * Load cluster membership for the visible clients in a single
 * query. Returns:
 *   - membersByCluster: cluster_id → client_ids[]
 *   - clustersByClient: client_id → cluster_labels[]
 */
async function loadClusterMembershipForClients(
  env: AppEnv,
  clientIds: readonly string[],
  visibleClusters: readonly ClusterRow[],
): Promise<{
  membersByCluster: Map<number, string[]>;
  clustersByClient: Map<string, string[]>;
}> {
  const membersByCluster = new Map<number, string[]>();
  const clustersByClient = new Map<string, string[]>();
  if (clientIds.length === 0 || visibleClusters.length === 0) {
    return { membersByCluster, clustersByClient };
  }
  const clusterById = new Map<number, ClusterRow>(visibleClusters.map((c) => [c.id, c]));
  const clusterIds = Array.from(clusterById.keys());
  const clusterPlaceholders = clusterIds.map(() => "?").join(", ");
  const clientPlaceholders = clientIds.map(() => "?").join(", ");
  const rows = await env.CONFIG_DB.prepare(
    `SELECT cluster_id, client_id FROM cluster_members
     WHERE cluster_id IN (${clusterPlaceholders})
       AND client_id IN (${clientPlaceholders})`,
  )
    .bind(...clusterIds, ...clientIds)
    .all<{ cluster_id: number; client_id: string }>();
  for (const r of rows.results ?? []) {
    const list = membersByCluster.get(r.cluster_id) ?? [];
    list.push(r.client_id);
    membersByCluster.set(r.cluster_id, list);
    const labels = clustersByClient.get(r.client_id) ?? [];
    const c = clusterById.get(r.cluster_id);
    if (c) labels.push(c.label);
    clustersByClient.set(r.client_id, labels);
  }
  return { membersByCluster, clustersByClient };
}

/**
 * Compute the set of client_ids that have at least one embed
 * placement. Used to render the "📍" badge on site rollups.
 */
async function loadClientsWithEmbeds(
  env: AppEnv,
  clientIds: readonly string[],
): Promise<Set<string>> {
  const out = new Set<string>();
  if (clientIds.length === 0) return out;
  const placeholders = clientIds.map(() => "?").join(", ");
  const rows = await env.CONFIG_DB.prepare(
    `SELECT DISTINCT client_id FROM embed_placements WHERE client_id IN (${placeholders})`,
  )
    .bind(...clientIds)
    .all<{ client_id: string }>();
  for (const r of rows.results ?? []) {
    out.add(r.client_id);
  }
  return out;
}

/**
 * Load recent indexation_checks scoped to visible clients. Limit 50
 * — anything older is in the per-site history view.
 */
async function loadRecentChecks(
  env: AppEnv,
  clientIds: readonly string[],
  limit = 50,
): Promise<RecentCheckRow[]> {
  if (clientIds.length === 0) return [];
  const placeholders = clientIds.map(() => "?").join(", ");
  const sql = `
    SELECT ic.*, c.proxy_domain
    FROM indexation_checks ic
    LEFT JOIN clients c ON c.client_id = ic.client_id
    WHERE ic.client_id IN (${placeholders})
    ORDER BY ic.checked_at DESC
    LIMIT ?
  `;
  const rows = await env.CONFIG_DB.prepare(sql)
    .bind(...clientIds, limit)
    .all<RecentCheckRow>();
  return rows.results ?? [];
}

/**
 * Build the site rollup list given pre-loaded inputs. Pure (no DB) —
 * separated so we can unit-test the aggregation logic without a
 * mocked database. `latestChecks` is keyed `client_id|url`.
 */
export function rollUpSites(
  clients: readonly ClientWithDiagnostics[],
  latestChecks: Map<string, IndexationCheckRow>,
  clustersByClient: Map<string, string[]>,
  clientsWithEmbeds: Set<string>,
): SiteRollup[] {
  const out: SiteRollup[] = [];
  for (const c of clients) {
    let indexed = 0;
    let notIndexed = 0;
    let unknown = 0;
    let unchecked = 0;
    let latestCheckMs = Number.NEGATIVE_INFINITY;
    let latestCheckStr: string | null = null;
    for (const url of c.urls) {
      const check = latestChecks.get(`${c.row.client_id}|${url}`);
      switch (statusForCheck(check)) {
        case "indexed":
          indexed++;
          break;
        case "not_indexed":
          notIndexed++;
          break;
        case "unknown":
          unknown++;
          break;
        case "unchecked":
          unchecked++;
          break;
      }
      if (check) {
        const t = Date.parse(check.checked_at);
        if (Number.isFinite(t) && t > latestCheckMs) {
          latestCheckMs = t;
          latestCheckStr = check.checked_at;
        }
      }
    }
    out.push({
      client_id: c.row.client_id,
      proxy_domain: c.row.proxy_domain,
      status: c.row.status,
      cluster_labels: clustersByClient.get(c.row.client_id) ?? [],
      url_count: c.urls.length,
      indexed_count: indexed,
      not_indexed_count: notIndexed,
      unknown_count: unknown,
      unchecked_count: unchecked,
      latest_check_at: latestCheckStr,
      has_embed: clientsWithEmbeds.has(c.row.client_id),
    });
  }
  return out;
}

/**
 * Build cluster rollups by summing the site rollups of each member.
 * Pure (no DB).
 */
export function rollUpClusters(
  visibleClusters: readonly ClusterRow[],
  membersByCluster: Map<number, string[]>,
  siteById: Map<string, SiteRollup>,
): ClusterRollup[] {
  const out: ClusterRollup[] = [];
  for (const c of visibleClusters) {
    const members = membersByCluster.get(c.id) ?? [];
    let urls = 0;
    let indexed = 0;
    let notIndexed = 0;
    let unknown = 0;
    let unchecked = 0;
    let latestMs = Number.NEGATIVE_INFINITY;
    let latestStr: string | null = null;
    for (const clientId of members) {
      const site = siteById.get(clientId);
      if (!site) continue;
      urls += site.url_count;
      indexed += site.indexed_count;
      notIndexed += site.not_indexed_count;
      unknown += site.unknown_count;
      unchecked += site.unchecked_count;
      if (site.latest_check_at) {
        const t = Date.parse(site.latest_check_at);
        if (Number.isFinite(t) && t > latestMs) {
          latestMs = t;
          latestStr = site.latest_check_at;
        }
      }
    }
    out.push({
      cluster_id: c.id,
      label: c.label,
      type: c.type,
      member_count: members.length,
      url_count: urls,
      indexed_count: indexed,
      not_indexed_count: notIndexed,
      unknown_count: unknown,
      unchecked_count: unchecked,
      latest_check_at: latestStr,
    });
  }
  return out;
}

/**
 * Top-level data loader.
 *
 * @param env Cloudflare bindings.
 * @param user authenticated operator (scopes visibility).
 * @param filters from URL query params.
 * @param visibleClusters pre-loaded (caller already loads them for the nav).
 */
export async function loadIndexationOverview(
  env: AppEnv,
  user: User,
  filters: IndexationFilters,
  visibleClusters: readonly ClusterRow[],
): Promise<IndexationOverviewData> {
  const clients = await loadVisibleClientsForOverview(env, user);
  const clientIds = clients.map((c) => c.row.client_id);
  const [latestChecks, membership, clientsWithEmbeds, recent] = await Promise.all([
    loadLatestChecks(env, clients),
    loadClusterMembershipForClients(env, clientIds, visibleClusters),
    loadClientsWithEmbeds(env, clientIds),
    loadRecentChecks(env, clientIds),
  ]);
  const allSites = rollUpSites(
    clients,
    latestChecks,
    membership.clustersByClient,
    clientsWithEmbeds,
  );
  const siteById = new Map(allSites.map((s) => [s.client_id, s]));
  const platform = platformStatsFromSites(allSites); // unfiltered totals

  // Apply filters AFTER computing platform totals.
  let sites = allSites;
  if (filters.cluster_id != null) {
    const memberSet = new Set(membership.membersByCluster.get(filters.cluster_id) ?? []);
    sites = sites.filter((s) => memberSet.has(s.client_id));
  }
  sites = applySiteFilters(sites, filters, Date.now());

  const clusters = rollUpClusters(visibleClusters, membership.membersByCluster, siteById);

  return {
    platform,
    clusters,
    sites,
    recent,
    filters,
    visibleClusters,
    total_sites_before_filter: allSites.length,
  };
}

/* ─── Renderer ─── */

function statusPill(
  label: string,
  kind: "indexed" | "not_indexed" | "unknown" | "unchecked",
): string {
  const cls = `indexation-pill indexation-${kind === "not_indexed" ? "no" : kind === "indexed" ? "yes" : kind}`;
  return `<span class="${cls}">${esc(label)}</span>`;
}

const OVERVIEW_CSS = `
.idx-overview .stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(10rem,1fr));gap:1rem;margin-bottom:1.75rem}
.idx-overview .stats .card{padding:1rem 1.15rem;background:var(--bg-elevated);border:1px solid var(--border);border-radius:var(--radius-lg);box-shadow:var(--shadow-sm);transition:all .2s ease;position:relative;overflow:hidden;margin-bottom:0}
.idx-overview .stats .card:hover{transform:translateY(-2px);box-shadow:var(--shadow-md);border-color:color-mix(in srgb,var(--accent) 30%,var(--border))}
.idx-overview .stats .card::before{content:"";position:absolute;left:0;top:0;bottom:0;width:3px;background:var(--accent);opacity:.85}
.idx-overview .stats .card .label{font-size:.68rem;text-transform:uppercase;letter-spacing:.08em;color:var(--fg-muted);margin:0;font-weight:700}
.idx-overview .stats .card .value{font-size:1.85rem;font-weight:800;margin:.2rem 0 0;letter-spacing:-.025em;line-height:1}
.idx-overview .stats .card .pct{font-size:.7rem;color:var(--fg-muted);margin-top:.15rem;font-weight:500}
.idx-overview h2{font-size:1.05rem;margin:1.75rem 0 .6rem;font-weight:600;letter-spacing:-.005em}
.idx-overview .filter-strip{padding:.85rem 1rem;background:var(--bg-elevated);border:1px solid var(--border);border-radius:var(--radius-lg);margin-bottom:1.25rem;display:flex;gap:.75rem;flex-wrap:wrap;align-items:flex-end;box-shadow:var(--shadow-sm)}
.idx-overview .filter-strip label{display:block;font-size:.68rem;color:var(--fg-muted);text-transform:uppercase;letter-spacing:.08em;margin-bottom:.2rem;font-weight:700}
.idx-overview .filter-strip select,.idx-overview .filter-strip input{font:inherit;padding:.4rem .55rem;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--bg);color:var(--fg);font-size:.85rem;transition:border-color .15s,box-shadow .15s}
.idx-overview .filter-strip select:focus,.idx-overview .filter-strip input:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-bg)}
.idx-overview .filter-strip .grow{flex:1;min-width:10rem}
.idx-overview table.data td.num{text-align:right;font-variant-numeric:tabular-nums}
.idx-overview .activity{font-size:.85rem}
.idx-overview .activity li{margin-bottom:.4rem;padding:.5rem .75rem;background:var(--bg-elevated);border:1px solid var(--border);border-radius:var(--radius-sm)}
.idx-overview .embed-badge{display:inline-block;margin-left:.3rem;font-size:.7rem;color:var(--fg-muted)}
.idx-overview .recheck-row{display:flex;gap:.5rem;margin-top:.6rem;flex-wrap:wrap}
.indexation-pill{display:inline-flex;align-items:center;padding:.15rem .55rem;border-radius:9999px;font-size:.72rem;font-weight:600;line-height:1.3}
.indexation-yes{background:var(--green-bg);color:var(--green)}
.indexation-no{background:var(--red-bg);color:var(--red)}
.indexation-unknown{background:var(--amber-bg);color:var(--amber)}
.indexation-unchecked{background:var(--bg-elevated);color:var(--fg-muted);border:1px dashed var(--border)}
`;

function pct(n: number, total: number): string {
  if (total === 0) return "—";
  return `${Math.round((n / total) * 100)}%`;
}

function renderStatCards(p: PlatformStats): string {
  return `<div class="stats">
    <div class="card"><p class="label">Sites</p><p class="value">${p.site_count}</p></div>
    <div class="card"><p class="label">URLs tracked</p><p class="value">${p.url_count}</p></div>
    <div class="card"><p class="label">Indexed</p><p class="value">${p.indexed_count}</p><p class="pct">${pct(p.indexed_count, p.url_count)}</p></div>
    <div class="card"><p class="label">Not indexed</p><p class="value">${p.not_indexed_count}</p><p class="pct">${pct(p.not_indexed_count, p.url_count)}</p></div>
    <div class="card"><p class="label">Unchecked / Unknown</p><p class="value">${p.unchecked_count + p.unknown_count}</p><p class="pct">${pct(p.unchecked_count + p.unknown_count, p.url_count)}</p></div>
  </div>`;
}

function renderFilterStrip(d: IndexationOverviewData): string {
  const clusterOptions = [
    `<option value="">— all clusters —</option>`,
    ...d.visibleClusters.map(
      (c) =>
        `<option value="${c.id}"${d.filters.cluster_id === c.id ? " selected" : ""}>${esc(c.label)}</option>`,
    ),
  ].join("");
  const statusOptions = [
    `<option value="">any</option>`,
    ...(["indexed", "not_indexed", "unknown", "unchecked"] as const).map(
      (s) =>
        `<option value="${s}"${d.filters.status === s ? " selected" : ""}>${s.replace("_", " ")}</option>`,
    ),
  ].join("");
  const ageOptions = (
    [
      ["any", "any"],
      ["lt_24h", "checked < 24h"],
      ["lt_7d", "checked < 7d"],
      ["gt_7d", "stale > 7d"],
      ["never", "never checked"],
    ] as const
  )
    .map(
      ([v, lbl]) =>
        `<option value="${v}"${(d.filters.last_check_age ?? "any") === v ? " selected" : ""}>${esc(lbl)}</option>`,
    )
    .join("");
  return `<form method="GET" action="/app/indexation" class="filter-strip">
    <div><label for="f_cluster">cluster</label><select id="f_cluster" name="cluster_id">${clusterOptions}</select></div>
    <div><label for="f_status">URL status</label><select id="f_status" name="status">${statusOptions}</select></div>
    <div><label for="f_age">last check</label><select id="f_age" name="last_check_age">${ageOptions}</select></div>
    <div class="grow"><label for="f_search">search</label><input id="f_search" name="search" type="text" placeholder="client_id or proxy domain" value="${esc(d.filters.search ?? "")}"></div>
    <div><button class="btn btn-primary" type="submit">Filter</button> <a class="btn" href="/app/indexation">Clear</a></div>
  </form>`;
}

function renderClusterTable(d: IndexationOverviewData): string {
  if (d.clusters.length === 0) {
    return `<h2>Clusters</h2><div class="empty">No clusters yet.</div>`;
  }
  const tbody = d.clusters
    .map(
      (c) => `<tr>
      <td><a href="/app/clusters/${c.cluster_id}" class="mono">${esc(c.label)}</a> <code style="color:var(--fg-muted);font-size:.7rem">${esc(c.type)}</code></td>
      <td class="num">${c.member_count}</td>
      <td class="num">${c.url_count}</td>
      <td class="num">${c.indexed_count > 0 ? statusPill(String(c.indexed_count), "indexed") : '<span class="muted">0</span>'}</td>
      <td class="num">${c.not_indexed_count > 0 ? statusPill(String(c.not_indexed_count), "not_indexed") : '<span class="muted">0</span>'}</td>
      <td class="num">${c.unchecked_count + c.unknown_count > 0 ? statusPill(String(c.unchecked_count + c.unknown_count), "unchecked") : '<span class="muted">0</span>'}</td>
      <td class="mono" style="font-size:.78rem;color:var(--fg-muted)">${esc(c.latest_check_at ?? "—")}</td>
    </tr>`,
    )
    .join("");
  return `<h2>Clusters</h2>
    <table class="data">
      <thead><tr><th>Cluster</th><th class="num">Sites</th><th class="num">URLs</th><th class="num">Indexed</th><th class="num">Not</th><th class="num">Unchecked</th><th>Latest check</th></tr></thead>
      <tbody>${tbody}</tbody>
    </table>`;
}

function renderSiteTable(d: IndexationOverviewData): string {
  if (d.sites.length === 0) {
    const hint =
      d.total_sites_before_filter > 0
        ? "No sites match the filters above."
        : "No sites yet. Bulk-create or import some from the SERP flow to get started.";
    return `<h2>Sites</h2><div class="empty">${hint}</div>`;
  }
  const tbody = d.sites
    .map((s) => {
      const embedBadge = s.has_embed
        ? `<span class="embed-badge" title="At least one embed applied">📍</span>`
        : "";
      const clusterCell =
        s.cluster_labels.length === 0
          ? `<span style="color:var(--fg-muted);font-size:.78rem">—</span>`
          : `<span style="font-size:.78rem;color:var(--fg-muted)">${s.cluster_labels.map(esc).join(", ")}</span>`;
      return `<tr>
      <td><a href="/app/clients/${esc(s.client_id)}/indexing" class="mono">${esc(s.client_id)}</a>${embedBadge}<div class="mono" style="font-size:.72rem;color:var(--fg-muted)">${esc(s.proxy_domain)}</div></td>
      <td>${clusterCell}</td>
      <td class="num">${s.url_count}</td>
      <td class="num">${s.indexed_count > 0 ? statusPill(String(s.indexed_count), "indexed") : '<span class="muted">0</span>'}</td>
      <td class="num">${s.not_indexed_count > 0 ? statusPill(String(s.not_indexed_count), "not_indexed") : '<span class="muted">0</span>'}</td>
      <td class="num">${s.unchecked_count + s.unknown_count > 0 ? statusPill(String(s.unchecked_count + s.unknown_count), "unchecked") : '<span class="muted">0</span>'}</td>
      <td class="mono" style="font-size:.78rem;color:var(--fg-muted)">${esc(s.latest_check_at ?? "—")}</td>
    </tr>`;
    })
    .join("");
  return `<h2>Sites <span style="color:var(--fg-muted);font-size:.8rem;font-weight:400">(${d.sites.length} of ${d.total_sites_before_filter})</span></h2>
    <table class="data">
      <thead><tr><th>Site</th><th>Clusters</th><th class="num">URLs</th><th class="num">Indexed</th><th class="num">Not</th><th class="num">Unchecked</th><th>Latest check</th></tr></thead>
      <tbody>${tbody}</tbody>
    </table>`;
}

function renderRecent(d: IndexationOverviewData): string {
  if (d.recent.length === 0) {
    return `<h2>Recent activity</h2><div class="empty">No indexation checks yet. Run one from any site's Indexing page or use Recheck below.</div>`;
  }
  const items = d.recent
    .map((r) => {
      const status: IndexationStatus =
        r.indexed === 1 ? "indexed" : r.indexed === 0 ? "not_indexed" : "unknown";
      return `<li>
        ${statusPill(status === "not_indexed" ? "not indexed" : status, status)}
        <a class="mono" href="${esc(r.url)}" target="_blank" rel="noopener noreferrer">${esc(r.url)}</a>
        <span style="color:var(--fg-muted)">— ${esc(r.checked_at)} by ${esc(r.checked_by_email)}</span>
      </li>`;
    })
    .join("");
  return `<h2>Recent activity <span style="color:var(--fg-muted);font-size:.8rem;font-weight:400">(last ${d.recent.length})</span></h2>
    <ul class="activity" style="list-style:none;padding:0">${items}</ul>`;
}

/**
 * Render the bulk-recheck action buttons. Form action lives at
 * `/app/indexation/recheck` and takes a `scope` field (`unchecked`
 * or `stale`). Each one confirms count + cost before firing.
 */
function renderRecheckBlock(d: IndexationOverviewData): string {
  // We only know the unchecked / stale URL counts at render time
  // after a full URL × check join, which is expensive. Cheap proxy:
  // sum site rollups. Stale-count needs a separate pass — for now,
  // we show the count of unchecked URLs and let the operator click
  // "Recheck stale" to find out (the handler returns the count in
  // its confirmation page).
  const uncheckedTotal = d.sites.reduce((sum, s) => sum + s.unchecked_count, 0);
  const cost = (uncheckedTotal * 0.0006).toFixed(4);
  return `<div class="card" style="padding:.7rem .9rem;background:var(--bg-elevated);border:1px solid var(--border);border-radius:var(--radius);margin-top:1rem">
    <h3 style="margin:0 0 .25rem;font-size:.95rem">Bulk recheck</h3>
    <p style="margin:.1rem 0 .35rem;font-size:.85rem;color:var(--fg-muted)">${uncheckedTotal} URL${uncheckedTotal === 1 ? "" : "s"} unchecked across the platform. Estimated DataForSEO cost: ~$${cost}.</p>
    <div class="recheck-row">
      <form method="POST" action="/app/indexation/recheck">
        <input type="hidden" name="scope" value="unchecked">
        <button class="btn" type="submit"${uncheckedTotal === 0 ? " disabled" : ""} onclick="return confirm('Re-check ${uncheckedTotal} unchecked URL${uncheckedTotal === 1 ? "" : "s"}? Estimated cost ~$${cost}.');">Recheck unchecked (${uncheckedTotal})</button>
      </form>
      <form method="POST" action="/app/indexation/recheck">
        <input type="hidden" name="scope" value="stale">
        <button class="btn" type="submit" onclick="return confirm('Re-check every URL whose last check is older than 7 days. DataForSEO cost depends on how many qualify — confirm on next page.');">Recheck stale (>7d)</button>
      </form>
    </div>
  </div>`;
}

export function renderIndexationOverviewPage(d: IndexationOverviewData): string {
  return `<style>${OVERVIEW_CSS}</style>
<div class="idx-overview">
  <h1>Indexation</h1>
  <p class="subtitle">Live indexation status across every proxied site you own. Click a site to drill into per-URL detail.</p>
  ${renderStatCards(d.platform)}
  ${renderFilterStrip(d)}
  ${renderClusterTable(d)}
  ${renderSiteTable(d)}
  ${renderRecheckBlock(d)}
  ${renderRecent(d)}
</div>`;
}

/* ─── Bulk recheck handler (Phase C) ─── */

function flashRedirect(location: string, flash: FlashMessage): Response {
  const sep = location.includes("?") ? "&" : "?";
  const target = `${location}${sep}flash=${encodeURIComponent(flash.text)}&flash_kind=${flash.kind}`;
  return new Response(null, { status: 303, headers: { location: target } });
}

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

/**
 * Compute the list of "unchecked" `(client_id, url)` targets — URLs
 * in any visible client's diagnostics that have NO row in
 * `indexation_checks`. Used by the "Recheck unchecked" bulk action.
 */
async function loadUncheckedTargets(env: AppEnv, user: User): Promise<BulkCheckTarget[]> {
  const clients = await loadVisibleClientsForOverview(env, user);
  const clientIds = clients.map((c) => c.row.client_id);
  const checked = await loadCheckedUrlSet(env, clientIds);
  const out: BulkCheckTarget[] = [];
  for (const c of clients) {
    for (const url of c.urls) {
      if (!checked.has(`${c.row.client_id}|${url}`)) {
        out.push({ client_id: c.row.client_id, url });
      }
    }
  }
  return out;
}

const BULK_MAX_TARGETS = 200;

/**
 * Handle a POST to `/app/indexation/recheck`. The form carries one
 * field — `scope=unchecked|stale` — and we look up the matching
 * target list, then run sequential checks. Caps at 200 URLs per call
 * to keep the cost ceiling predictable; operator can re-run to drain
 * the queue.
 */
export async function handleBulkRecheck(
  request: Request,
  env: AppEnv,
  url: URL,
  user: User,
): Promise<{
  result?: { scope: string; results: BulkCheckRowResult[] };
  response?: Response;
}> {
  const csrf = checkCsrf(request, url);
  if (csrf) return { response: csrf };
  const form = await request.formData();
  const scope = String(form.get("scope") ?? "").trim();
  if (scope !== "unchecked" && scope !== "stale") {
    return {
      response: flashRedirect("/app/indexation", {
        text: "Invalid scope — must be 'unchecked' or 'stale'.",
        kind: "err",
      }),
    };
  }
  let targets: BulkCheckTarget[];
  if (scope === "unchecked") {
    targets = await loadUncheckedTargets(env, user);
  } else {
    const clients = await loadVisibleClientsForOverview(env, user);
    targets = await loadStaleTargets(
      env,
      clients.map((c) => c.row.client_id),
      7,
    );
  }
  if (targets.length === 0) {
    return {
      response: flashRedirect("/app/indexation", {
        text:
          scope === "unchecked"
            ? "Nothing to do — every URL has been checked at least once."
            : "Nothing to do — no checks older than 7 days.",
        kind: "ok",
      }),
    };
  }
  if (targets.length > BULK_MAX_TARGETS) {
    targets = targets.slice(0, BULK_MAX_TARGETS);
  }
  // For "stale" we want to bypass the 24h cache (operator intent).
  // For "unchecked" the URLs have no rows so force is moot — pass
  // false to keep the path consistent.
  const force = scope === "stale";
  const results = await bulkCheckUrls(env, targets, user.email, force);
  return { result: { scope, results } };
}

/**
 * Render the result page for a bulk recheck.
 */
export function renderBulkRecheckResult(opts: {
  scope: string;
  results: readonly BulkCheckRowResult[];
}): string {
  const okCount = opts.results.filter((r) => r.status === "indexed").length;
  const notCount = opts.results.filter((r) => r.status === "not_indexed").length;
  const unkCount = opts.results.filter((r) => r.status === "unknown").length;
  const tbody = opts.results
    .map((r) => {
      const pillKind: IndexationStatus =
        r.status === "indexed" ? "indexed" : r.status === "not_indexed" ? "not_indexed" : "unknown";
      return `<tr>
        <td><a class="mono" href="/app/clients/${esc(r.client_id)}/indexing">${esc(r.client_id)}</a></td>
        <td><a class="mono" href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.url)}</a></td>
        <td>${statusPill(pillKind === "not_indexed" ? "not indexed" : pillKind, pillKind)}</td>
        <td style="font-size:.78rem;color:var(--fg-muted)">${esc(r.message)}${r.cached ? " <em>(cached)</em>" : ""}</td>
      </tr>`;
    })
    .join("");
  return `<style>${OVERVIEW_CSS}</style>
<div class="idx-overview">
  <div class="crumbs"><a href="/app/indexation">← Indexation</a></div>
  <h1>Recheck result — ${esc(opts.scope)}</h1>
  <p class="subtitle">${opts.results.length} URL${opts.results.length === 1 ? "" : "s"} checked: ${okCount} indexed, ${notCount} not indexed, ${unkCount} unknown.</p>
  <table class="data">
    <thead><tr><th>Site</th><th>URL</th><th>Status</th><th>Message</th></tr></thead>
    <tbody>${tbody}</tbody>
  </table>
  <p style="margin-top:1rem"><a class="btn btn-primary" href="/app/indexation">Back to Indexation</a></p>
</div>`;
}

/* ─── Cluster bulk check (Phase B) ─── */

/**
 * Build the `(client_id, url)` target list for every URL in every
 * member site of a cluster. Used by the cluster page's
 * "Check indexation for whole cluster" button.
 */
export async function buildClusterTargets(
  env: AppEnv,
  user: User,
  clusterId: number,
): Promise<BulkCheckTarget[]> {
  // Reuse the overview loader (it already parses configs) — filter
  // to this cluster's members.
  const clients = await loadVisibleClientsForOverview(env, user);
  // Load membership for THIS cluster.
  const m = await env.CONFIG_DB.prepare(
    "SELECT client_id FROM cluster_members WHERE cluster_id = ?",
  )
    .bind(clusterId)
    .all<{ client_id: string }>();
  const memberSet = new Set((m.results ?? []).map((r) => r.client_id));
  const out: BulkCheckTarget[] = [];
  for (const c of clients) {
    if (!memberSet.has(c.row.client_id)) continue;
    for (const url of c.urls) {
      out.push({ client_id: c.row.client_id, url });
    }
  }
  return out;
}

export async function handleClusterBulkCheck(
  request: Request,
  env: AppEnv,
  url: URL,
  user: User,
  clusterId: number,
): Promise<{ result?: { results: BulkCheckRowResult[] }; response?: Response }> {
  const csrf = checkCsrf(request, url);
  if (csrf) return { response: csrf };
  const form = await request.formData();
  const force = String(form.get("force") ?? "") === "1";
  let targets = await buildClusterTargets(env, user, clusterId);
  if (targets.length === 0) {
    return {
      response: flashRedirect(`/app/clusters/${clusterId}`, {
        text: "No URLs to check — cluster has no member sites or no tracked paths.",
        kind: "warn",
      }),
    };
  }
  if (targets.length > BULK_MAX_TARGETS) {
    targets = targets.slice(0, BULK_MAX_TARGETS);
  }
  const results = await bulkCheckUrls(env, targets, user.email, force);
  return { result: { results } };
}
