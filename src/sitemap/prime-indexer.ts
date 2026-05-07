/**
 * Prime Indexer integration.
 * API docs: https://app.primeindexer.com/ (operator dashboard).
 *
 * Auth: `x-api-key: <key>` header on every request.
 * Endpoints used:
 *   - GET  /api/v1/balance              — credit balance + recent txns
 *   - POST /api/v1/projects             — create project with URLs (1-500)
 *
 * Credit model: each URL submission burns one credit. The platform
 * fires submissions on every config save (alongside IndexNow), so an
 * operator with 100 seed_paths who edits + saves uses 100 credits per
 * save. Operators can pause submissions by clearing the
 * PRIME_INDEXER_KEY in Settings → API keys.
 *
 * Best-effort: every helper here swallows network/HTTP errors and logs.
 * A failed submission shouldn't block an admin save.
 */

const PRIME_BASE = "https://app.primeindexer.com/api/v1";

/** URL cap per project per Prime Indexer's API spec. We chunk above. */
const MAX_URLS_PER_PROJECT = 500;

/**
 * Result of GET /balance. The API returns more (recentTransactions
 * array), but we only surface the balance number — anything else
 * belongs in the Prime Indexer dashboard, not the test panel.
 */
export interface PrimeBalance {
  balance: number;
  recentTransactionCount: number;
}

/**
 * Test the Prime Indexer API key by hitting GET /balance. This
 * doesn't burn credits — it's purely a read — so it's safe to call
 * on every Test click.
 *
 * Returns:
 *   - { ok: true, balance } when the key is valid
 *   - { ok: false, status, message } on any failure (401, 403,
 *     network error, malformed response)
 */
export async function checkPrimeBalance(
  key: string,
): Promise<{ ok: true; balance: PrimeBalance } | { ok: false; status: number; message: string }> {
  try {
    const resp = await fetch(`${PRIME_BASE}/balance`, {
      method: "GET",
      headers: {
        "x-api-key": key,
        accept: "application/json",
      },
    });
    if (resp.status !== 200) {
      const body = await resp.text().catch(() => "");
      return {
        ok: false,
        status: resp.status,
        message: body.slice(0, 512) || `HTTP ${resp.status}`,
      };
    }
    const data = (await resp.json()) as {
      balance?: number;
      recentTransactions?: Array<unknown>;
    };
    if (typeof data.balance !== "number") {
      return {
        ok: false,
        status: 200,
        message: "Response missing `balance` number — API contract may have changed.",
      };
    }
    return {
      ok: true,
      balance: {
        balance: data.balance,
        recentTransactionCount: Array.isArray(data.recentTransactions)
          ? data.recentTransactions.length
          : 0,
      },
    };
  } catch (e) {
    return { ok: false, status: 0, message: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Body shape for POST /projects per Prime Indexer's API spec.
 * `name` is freeform; we use `${proxy_domain} ${ISO timestamp}` so
 * each save creates a uniquely identifiable project in the operator's
 * Prime Indexer dashboard.
 */
export interface PrimeSubmission {
  name: string;
  urls: string[];
  dripfeed?: boolean;
  dripfeedDays?: number;
}

/**
 * Submit a single project to Prime Indexer. Caller is responsible for
 * keeping `urls.length <= 500` — use `pingPrimeIndexer` for automatic
 * chunking.
 *
 * Returns a structured result, never throws. The calling save flow
 * should treat this as best-effort (fire-and-forget).
 */
export async function submitToPrimeIndexer(
  key: string,
  body: PrimeSubmission,
): Promise<{ ok: boolean; status: number; projectId?: string; responseBody?: string }> {
  try {
    const resp = await fetch(`${PRIME_BASE}/projects`, {
      method: "POST",
      headers: {
        "x-api-key": key,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify(body),
    });
    const ok = resp.status === 200 || resp.status === 201;
    if (!ok) {
      const text = await resp.text().catch(() => "");
      return { ok: false, status: resp.status, responseBody: text.slice(0, 2048) };
    }
    const data = (await resp.json().catch(() => ({}))) as {
      projectId?: string;
      id?: string;
    };
    const projectId = data.projectId ?? data.id;
    return projectId
      ? { ok: true, status: resp.status, projectId }
      : { ok: true, status: resp.status };
  } catch (e) {
    console.warn("prime-indexer: submit failed", e);
    return { ok: false, status: 0 };
  }
}

/**
 * High-level convenience: submit a list of URLs to Prime Indexer,
 * chunking above MAX_URLS_PER_PROJECT and creating one project per
 * chunk. No-op when the key is empty or urls is empty.
 *
 * Each chunk is named `${projectName}` for chunks==1, or
 * `${projectName} (n/total)` when chunked, so operators see related
 * chunks grouped in the Prime Indexer dashboard.
 */
export async function pingPrimeIndexer(
  key: string,
  urls: readonly string[],
  projectName: string,
): Promise<{ submitted: number; ok: number; failed: number; projectIds: string[] }> {
  if (key.length === 0 || urls.length === 0) {
    return { submitted: 0, ok: 0, failed: 0, projectIds: [] };
  }
  const chunks: string[][] = [];
  for (let i = 0; i < urls.length; i += MAX_URLS_PER_PROJECT) {
    chunks.push([...urls.slice(i, i + MAX_URLS_PER_PROJECT)]);
  }
  let okCount = 0;
  let failed = 0;
  const projectIds: string[] = [];
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    if (!chunk) continue;
    const name = chunks.length === 1 ? projectName : `${projectName} (${i + 1}/${chunks.length})`;
    const result = await submitToPrimeIndexer(key, { name, urls: chunk });
    if (result.ok) {
      okCount += 1;
      if (result.projectId) projectIds.push(result.projectId);
    } else {
      failed += 1;
    }
  }
  return { submitted: chunks.length, ok: okCount, failed, projectIds };
}
