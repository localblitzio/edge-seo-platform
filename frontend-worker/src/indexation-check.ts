/**
 * Live indexation probe — "is this URL actually indexed in Google?"
 *
 * Strategy: call DataForSEO live SERP with `keyword: site:<url>` and
 * inspect the organic items. If any item's URL matches the queried
 * URL (origin + path), the URL is indexed. If 0 organic items, not
 * indexed. On API error or unparseable response, "unknown" (never
 * cached as a definitive answer).
 *
 * Caching: 24h window keyed on `(client_id, url)`. Repeat checks
 * within the window read the last `indexation_checks` row instead
 * of burning another DataForSEO credit. Operator can override by
 * passing `force: true`.
 *
 * Notes:
 *   - `site:URL` is approximate. Google sometimes excludes indexed
 *     pages from `site:` results. For high-confidence answers, GSC
 *     is the right source — that integration is deferred (slot
 *     reserved in src/secrets/slots.ts).
 *   - Each check costs one DataForSEO SERP call (~$0.0006 standard).
 */

import { getSecret } from "../../src/secrets/store.js";
import type { AppEnv } from "./app.js";

const ENDPOINT = "https://api.dataforseo.com/v3/serp/google/organic/live/advanced";
const CACHE_TTL_HOURS = 24;

/** Discriminated result returned to callers. */
export type IndexationStatus = "indexed" | "not_indexed" | "unknown";

export interface IndexationCheckResult {
  status: IndexationStatus;
  /** Short human-readable summary (UI flash / inline text). */
  message: string;
  /** Compact JSON-serializable evidence — count of organic items, matched URL, etc. */
  evidence: Record<string, unknown>;
  /** True when the answer came from the 24h cache, false when freshly fetched. */
  cached: boolean;
  /** When the underlying check happened (now if not cached). */
  checked_at: string;
}

/** A single recorded check (rows from `indexation_checks`). */
export interface IndexationCheckRow {
  id: number;
  client_id: string;
  url: string;
  /** Stored as 0/1/null in SQLite; null = unknown. */
  indexed: number | null;
  evidence_json: string | null;
  checked_at: string;
  checked_by_email: string;
}

/**
 * Find the most recent check row for (client_id, url) inside the
 * cache window. Returns null if none in window.
 */
async function findCachedCheck(
  env: AppEnv,
  clientId: string,
  url: string,
): Promise<IndexationCheckRow | null> {
  // Sqlite datetime: rows are written with CURRENT_TIMESTAMP (UTC).
  // Compare against `datetime('now', '-N hours')`.
  const row = await env.CONFIG_DB.prepare(
    `SELECT * FROM indexation_checks
     WHERE client_id = ? AND url = ?
       AND checked_at > datetime('now', ?)
       AND indexed IS NOT NULL
     ORDER BY checked_at DESC LIMIT 1`,
  )
    .bind(clientId, url, `-${CACHE_TTL_HOURS} hours`)
    .first<IndexationCheckRow>();
  return row;
}

/**
 * Build the DataForSEO request body for a `site:URL` query.
 *
 * Depth 10 is enough — we only need to know if ANY organic result
 * matches. Higher depth wastes credits.
 *
 * Exported for unit testing.
 */
export function buildSiteQueryBody(url: string): string {
  return JSON.stringify([
    {
      keyword: `site:${url}`,
      location_code: 2840, // US — doesn't really matter for site: queries
      language_code: "en",
      device: "desktop",
      depth: 10,
    },
  ]);
}

/**
 * Inspect a DataForSEO `site:URL` response and decide indexed-ness.
 *
 * Logic:
 *   - 0 organic items → not_indexed
 *   - 1+ organic items, at least one URL matches the queried URL
 *     (case-insensitive, ignoring trailing slash) → indexed
 *   - 1+ organic items but none match the exact URL → indexed
 *     anyway (Google considers the site indexed; the specific URL
 *     may be present in a slightly different form). Evidence records
 *     what was found so operators can investigate.
 *   - Anything else (status_code error, malformed) → unknown
 *
 * Exported for unit testing.
 */
export function interpretSiteResponse(
  payload: unknown,
  queriedUrl: string,
): { status: IndexationStatus; evidence: Record<string, unknown> } {
  if (typeof payload !== "object" || payload === null) {
    return { status: "unknown", evidence: { reason: "no payload" } };
  }
  const root = payload as Record<string, unknown>;
  const apiStatus = typeof root.status_code === "number" ? root.status_code : null;
  if (apiStatus !== null && apiStatus >= 40000) {
    return {
      status: "unknown",
      evidence: {
        reason: "dataforseo error",
        status_code: apiStatus,
        status_message: typeof root.status_message === "string" ? root.status_message : null,
      },
    };
  }
  const tasks = Array.isArray(root.tasks) ? root.tasks : [];
  const organic: Array<{ url: string }> = [];
  for (const task of tasks) {
    if (typeof task !== "object" || task === null) continue;
    const result = (task as Record<string, unknown>).result;
    if (!Array.isArray(result)) continue;
    for (const r of result) {
      if (typeof r !== "object" || r === null) continue;
      const items = (r as Record<string, unknown>).items;
      if (!Array.isArray(items)) continue;
      for (const item of items) {
        if (typeof item !== "object" || item === null) continue;
        const obj = item as Record<string, unknown>;
        if (obj.type !== "organic") continue;
        const u = typeof obj.url === "string" ? obj.url : null;
        if (u) organic.push({ url: u });
      }
    }
  }
  if (organic.length === 0) {
    return {
      status: "not_indexed",
      evidence: { reason: "no organic results for site: query", organic_count: 0 },
    };
  }
  const normalized = normalizeUrl(queriedUrl);
  const exactMatch = organic.find((o) => normalizeUrl(o.url) === normalized);
  return {
    status: "indexed",
    evidence: {
      organic_count: organic.length,
      first_url: organic[0]?.url,
      exact_match: exactMatch?.url ?? null,
    },
  };
}

function normalizeUrl(u: string): string {
  try {
    const parsed = new URL(u);
    return `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`.toLowerCase();
  } catch {
    return u.replace(/\/+$/, "").toLowerCase();
  }
}

/**
 * Run a single indexation check. Uses the 24h cache unless `force`.
 *
 * Always records the result in `indexation_checks` (even cache
 * hits, when forced and re-fetched). Cache hits skip the write.
 *
 * @param env Cloudflare bindings.
 * @param clientId the proxied site owning this URL.
 * @param url the absolute URL to check (must include scheme + host).
 * @param checkerEmail operator email (for audit on the row).
 * @param force when true, bypass the 24h cache and re-query DataForSEO.
 */
export async function checkUrlIndexation(
  env: AppEnv,
  clientId: string,
  url: string,
  checkerEmail: string,
  force = false,
): Promise<IndexationCheckResult> {
  // 1. Cache hit?
  if (!force) {
    const cached = await findCachedCheck(env, clientId, url);
    if (cached) {
      return {
        status: cached.indexed === 1 ? "indexed" : cached.indexed === 0 ? "not_indexed" : "unknown",
        message: `Cached result from ${cached.checked_at} (${cached.indexed === 1 ? "indexed" : cached.indexed === 0 ? "not indexed" : "unknown"}).`,
        evidence: cached.evidence_json ? safeJsonParse(cached.evidence_json) : {},
        cached: true,
        checked_at: cached.checked_at,
      };
    }
  }

  // 2. Need DataForSEO creds.
  const sharedEnv = env as unknown as Parameters<typeof getSecret>[0];
  const [login, password] = await Promise.all([
    getSecret(sharedEnv, "DATAFORSEO_LOGIN"),
    getSecret(sharedEnv, "DATAFORSEO_PASSWORD"),
  ]);
  if (!login || !password) {
    return {
      status: "unknown",
      message:
        "DataForSEO credentials not configured. Set DATAFORSEO_LOGIN + DATAFORSEO_PASSWORD on Settings → API keys.",
      evidence: { reason: "missing credentials" },
      cached: false,
      checked_at: new Date().toISOString(),
    };
  }

  // 3. Fire the query.
  let interpretation: { status: IndexationStatus; evidence: Record<string, unknown> };
  try {
    const res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        authorization: `Basic ${btoa(`${login}:${password}`)}`,
        "content-type": "application/json",
      },
      body: buildSiteQueryBody(url),
    });
    if (!res.ok) {
      interpretation = {
        status: "unknown",
        evidence: {
          reason: `HTTP ${res.status}`,
          status_code: res.status,
        },
      };
    } else {
      const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
      interpretation = interpretSiteResponse(json, url);
    }
  } catch (e) {
    interpretation = {
      status: "unknown",
      evidence: {
        reason: "network error",
        message: e instanceof Error ? e.message : String(e),
      },
    };
  }

  // 4. Persist (also when unknown — we want a history row, but the
  // cache lookup filters those out via WHERE indexed IS NOT NULL).
  const checkedAt = new Date()
    .toISOString()
    .replace("T", " ")
    .replace(/\.\d{3}Z$/, "");
  const indexedInt =
    interpretation.status === "indexed" ? 1 : interpretation.status === "not_indexed" ? 0 : null;
  try {
    await env.CONFIG_DB.prepare(
      "INSERT INTO indexation_checks (client_id, url, indexed, evidence_json, checked_by_email) VALUES (?, ?, ?, ?, ?)",
    )
      .bind(clientId, url, indexedInt, JSON.stringify(interpretation.evidence), checkerEmail)
      .run();
  } catch (e) {
    console.warn("indexation-check: history write failed", e);
  }

  return {
    status: interpretation.status,
    message:
      interpretation.status === "indexed"
        ? `Indexed (Google ${typeof interpretation.evidence.organic_count === "number" ? `returned ${interpretation.evidence.organic_count} result${interpretation.evidence.organic_count === 1 ? "" : "s"}` : "found this URL"} for site:URL).`
        : interpretation.status === "not_indexed"
          ? "Not indexed (site:URL returned no results)."
          : `Unknown (${interpretation.evidence.reason ?? "API error"}).`,
    evidence: interpretation.evidence,
    cached: false,
    checked_at: checkedAt,
  };
}

/**
 * Load the recent check history for a single URL (newest first).
 * Used by the inline history toggle on the Indexing page.
 */
export async function loadCheckHistory(
  env: AppEnv,
  clientId: string,
  url: string,
  limit = 10,
): Promise<IndexationCheckRow[]> {
  const result = await env.CONFIG_DB.prepare(
    `SELECT * FROM indexation_checks
     WHERE client_id = ? AND url = ?
     ORDER BY checked_at DESC LIMIT ?`,
  )
    .bind(clientId, url, limit)
    .all<IndexationCheckRow>();
  return result.results ?? [];
}

/**
 * Load the latest check (any age) for every URL in a list. Returns
 * a Map keyed on URL for fast lookup. Used to render the Indexing
 * page with each URL's current known state.
 */
export async function loadLatestChecksForClient(
  env: AppEnv,
  clientId: string,
  urls: readonly string[],
): Promise<Map<string, IndexationCheckRow>> {
  const out = new Map<string, IndexationCheckRow>();
  if (urls.length === 0) return out;
  // SQLite's IN clause caps at 999 by default; chunk if we ever
  // exceed that. Practical site sizes don't (yet).
  const placeholders = urls.map(() => "?").join(", ");
  const sql = `
    SELECT t.* FROM indexation_checks t
    INNER JOIN (
      SELECT url, MAX(checked_at) AS max_at
      FROM indexation_checks
      WHERE client_id = ? AND url IN (${placeholders})
      GROUP BY url
    ) m ON m.url = t.url AND m.max_at = t.checked_at
    WHERE t.client_id = ?
  `;
  const rows = await env.CONFIG_DB.prepare(sql)
    .bind(clientId, ...urls, clientId)
    .all<IndexationCheckRow>();
  for (const row of rows.results ?? []) {
    out.set(row.url, row);
  }
  return out;
}

function safeJsonParse(s: string): Record<string, unknown> {
  try {
    const v = JSON.parse(s);
    return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * Run `checkUrlIndexation` for every `(client_id, url)` pair in
 * `targets`, sequentially. Returns a per-URL result list suitable
 * for rendering as a results table. Used by both the cluster bulk
 * check (Phase B) and the platform-wide recheck (Phase C).
 *
 * Sequential rather than parallel — DataForSEO has per-account rate
 * limits and a parallel burst can trip them. The 24h cache means
 * repeat calls within a window read from D1 and are effectively
 * free, so the loop only blocks on URLs that genuinely need an API
 * call.
 *
 * @param force when true, bypass the 24h cache for every URL.
 */
export interface BulkCheckTarget {
  client_id: string;
  url: string;
}

export interface BulkCheckRowResult {
  client_id: string;
  url: string;
  status: IndexationStatus;
  message: string;
  cached: boolean;
}

export async function bulkCheckUrls(
  env: AppEnv,
  targets: readonly BulkCheckTarget[],
  checkerEmail: string,
  force = false,
): Promise<BulkCheckRowResult[]> {
  const out: BulkCheckRowResult[] = [];
  for (const t of targets) {
    const result = await checkUrlIndexation(env, t.client_id, t.url, checkerEmail, force);
    out.push({
      client_id: t.client_id,
      url: t.url,
      status: result.status,
      message: result.message,
      cached: result.cached,
    });
  }
  return out;
}

/**
 * Return every `(client_id, url)` pair across `clientIds` that has
 * never been checked (no indexation_checks row). Used by Phase C's
 * "Recheck unchecked" bulk action — the caller pairs this with the
 * client's diagnostics to figure out which URLs are missing.
 *
 * Returns the set of URLs that HAVE been checked. Caller subtracts
 * from the diagnostics-derived URL list to find the unchecked set.
 */
export async function loadCheckedUrlSet(
  env: AppEnv,
  clientIds: readonly string[],
): Promise<Set<string>> {
  const out = new Set<string>();
  if (clientIds.length === 0) return out;
  const placeholders = clientIds.map(() => "?").join(", ");
  const rows = await env.CONFIG_DB.prepare(
    `SELECT DISTINCT client_id, url FROM indexation_checks WHERE client_id IN (${placeholders})`,
  )
    .bind(...clientIds)
    .all<{ client_id: string; url: string }>();
  for (const r of rows.results ?? []) {
    out.add(`${r.client_id}|${r.url}`);
  }
  return out;
}

/**
 * Return every (client_id, url) where the latest check is older than
 * `staleDays` (or has indexed=NULL, treated as needing re-check).
 * Used by Phase C's "Recheck stale" bulk action.
 */
export async function loadStaleTargets(
  env: AppEnv,
  clientIds: readonly string[],
  staleDays = 7,
): Promise<BulkCheckTarget[]> {
  if (clientIds.length === 0) return [];
  const placeholders = clientIds.map(() => "?").join(", ");
  const sql = `
    SELECT t.client_id, t.url FROM indexation_checks t
    INNER JOIN (
      SELECT client_id, url, MAX(checked_at) AS max_at
      FROM indexation_checks
      WHERE client_id IN (${placeholders})
      GROUP BY client_id, url
    ) m ON m.client_id = t.client_id AND m.url = t.url AND m.max_at = t.checked_at
    WHERE t.checked_at < datetime('now', ?)
       OR t.indexed IS NULL
  `;
  const rows = await env.CONFIG_DB.prepare(sql)
    .bind(...clientIds, `-${staleDays} days`)
    .all<BulkCheckTarget>();
  return rows.results ?? [];
}
