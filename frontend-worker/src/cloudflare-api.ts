/**
 * Thin Cloudflare API client used by the admin worker to automate
 * in_place onboarding: DNS record creation + Workers Route registration.
 *
 * Authentication: scoped API token, read from `env.CF_API_TOKEN`
 * (Worker secret). The token must have, on the customer's zone:
 *   - Zone:DNS:Edit (to create `origin.<domain>` records)
 *   - Zone:Workers Routes:Edit (to register the route)
 *
 * Idempotency: `findX` helpers are paired with `createX` so callers
 * can do a "create if not exists" pattern. We don't try to update
 * existing records — that's a future enhancement.
 */

const CF_API_BASE = "https://api.cloudflare.com/client/v4";

export class CloudflareApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly cfErrors: Array<{ code: number; message: string }>,
  ) {
    super(message);
    this.name = "CloudflareApiError";
  }
}

/**
 * Generic API call. Throws CloudflareApiError on non-2xx OR when the
 * response body has `success: false`. The `cfErrors` payload is
 * preserved so callers can switch on `code === 81057` ("record exists")
 * etc. for idempotency checks.
 */
async function callCf<T>(
  token: string,
  path: string,
  init?: { method?: string; body?: unknown },
): Promise<T> {
  const url = `${CF_API_BASE}${path}`;
  const resp = await fetch(url, {
    method: init?.method ?? "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: init?.body ? JSON.stringify(init.body) : undefined,
  });
  let json: { success?: boolean; result?: T; errors?: Array<{ code: number; message: string }> };
  try {
    json = await resp.json();
  } catch (_e) {
    throw new CloudflareApiError(
      `Cloudflare API returned non-JSON response (HTTP ${resp.status})`,
      resp.status,
      [],
    );
  }
  if (!resp.ok || json.success === false) {
    const errs = json.errors ?? [];
    const summary = errs.map((e) => `${e.code}: ${e.message}`).join("; ") || `HTTP ${resp.status}`;
    throw new CloudflareApiError(summary, resp.status, errs);
  }
  if (json.result === undefined) {
    throw new CloudflareApiError("response missing `result`", resp.status, []);
  }
  return json.result;
}

export interface CfZone {
  id: string;
  name: string;
}

/**
 * Look up a zone by exact name. Returns null if no zone matches (or
 * if the token can't see it).
 */
export async function findZoneByName(token: string, name: string): Promise<CfZone | null> {
  const result = await callCf<CfZone[]>(token, `/zones?name=${encodeURIComponent(name)}`);
  return result[0] ?? null;
}

export interface CfDnsRecord {
  id: string;
  name: string;
  type: string;
  content: string;
  proxied: boolean;
}

/**
 * Look up a DNS record by exact name on a zone. Cloudflare's records
 * endpoint accepts a `name` filter that does fully-qualified match.
 */
export async function findDnsRecord(
  token: string,
  zoneId: string,
  name: string,
): Promise<CfDnsRecord | null> {
  const result = await callCf<CfDnsRecord[]>(
    token,
    `/zones/${zoneId}/dns_records?name=${encodeURIComponent(name)}`,
  );
  return result[0] ?? null;
}

/**
 * Create a DNS record. Caller is expected to check existence first
 * (via `findDnsRecord`) — Cloudflare returns code 81057 if the same
 * name+type already exists.
 */
export async function createDnsRecord(
  token: string,
  zoneId: string,
  args: {
    type: "A" | "AAAA" | "CNAME";
    name: string;
    content: string;
    proxied: boolean;
    comment?: string;
  },
): Promise<CfDnsRecord> {
  return await callCf<CfDnsRecord>(token, `/zones/${zoneId}/dns_records`, {
    method: "POST",
    body: { ...args, ttl: 1 },
  });
}

export interface CfWorkersRoute {
  id: string;
  pattern: string;
  script: string;
}

/**
 * List Workers Routes on a zone. Used to detect an existing pattern
 * before attempting a duplicate registration.
 */
export async function listWorkersRoutes(token: string, zoneId: string): Promise<CfWorkersRoute[]> {
  return await callCf<CfWorkersRoute[]>(token, `/zones/${zoneId}/workers/routes`);
}

/**
 * Register a Workers Route mapping a URL pattern to a worker script.
 * The worker script must already be deployed to the same Cloudflare
 * account — this endpoint only creates the routing rule, not the
 * script.
 */
export async function createWorkersRoute(
  token: string,
  zoneId: string,
  args: { pattern: string; script: string },
): Promise<CfWorkersRoute> {
  return await callCf<CfWorkersRoute>(token, `/zones/${zoneId}/workers/routes`, {
    method: "POST",
    body: args,
  });
}
