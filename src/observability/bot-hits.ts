/**
 * Per-site bot activity recorder.
 *
 * Writes one D1 row per (client_id × bot_family × hour) bucket. The
 * proxy worker calls `recordBotHit` via `ctx.waitUntil` after every
 * bot-classified request so the write doesn't add latency to the
 * user-facing response.
 *
 * Schema lives in migration 0009_bot_hits.sql. Read path is in
 * `frontend-worker/src/bot-activity.ts` (the dashboard).
 */

import type { D1Database } from "@cloudflare/workers-types";

import { type BotCategory, classifyUserAgentDetailed } from "./logger.js";

/** Bucket the timestamp into the unix-epoch hour. */
export function bucketHour(timestampMs: number): number {
  return Math.floor(timestampMs / 1000 / 3600);
}

/**
 * Increment the hit counter for a single bot request.
 *
 * UPSERT: if the (client_id, bot_family, bucket_hour) row exists,
 * increment `hits`; otherwise insert with hits=1. Idempotent in the
 * "if it errors and retries" sense — the increment is best-effort.
 *
 * No-op when category is "human" — we deliberately don't count human
 * traffic here (different question, different infrastructure).
 *
 * Errors are caught + logged. The proxy worker calls this via
 * `ctx.waitUntil` so even a thrown error won't reach the user.
 */
export async function recordBotHit(
  db: D1Database,
  clientId: string,
  userAgent: string | null,
  now: number = Date.now(),
): Promise<void> {
  const { family, category } = classifyUserAgentDetailed(userAgent);
  if (category === "human") return;
  const bucket = bucketHour(now);
  try {
    await db
      .prepare(
        `INSERT INTO bot_hits (client_id, bot_family, bot_category, bucket_hour, hits)
         VALUES (?, ?, ?, ?, 1)
         ON CONFLICT(client_id, bot_family, bucket_hour) DO UPDATE SET
           hits = hits + 1`,
      )
      .bind(clientId, family, category, bucket)
      .run();
  } catch (e) {
    console.warn("bot-hits: D1 write failed", e);
  }
}

/** Row shape returned by the dashboard query. */
export interface BotHitRow {
  bot_family: string;
  bot_category: BotCategory;
  bucket_hour: number;
  hits: number;
}

/**
 * Query all bot hits for a client over the last `hoursAgo` hours.
 * Returns rows in time order (oldest first) so callers can build a
 * sparkline directly. Falls back to [] on D1 error.
 */
export async function loadBotHits(
  db: D1Database,
  clientId: string,
  hoursAgo: number,
  now: number = Date.now(),
): Promise<BotHitRow[]> {
  const sinceBucket = bucketHour(now) - hoursAgo + 1;
  try {
    const result = await db
      .prepare(
        `SELECT bot_family, bot_category, bucket_hour, hits
         FROM bot_hits
         WHERE client_id = ? AND bucket_hour >= ?
         ORDER BY bucket_hour ASC`,
      )
      .bind(clientId, sinceBucket)
      .all<BotHitRow>();
    return result.results ?? [];
  } catch (e) {
    console.warn("bot-hits: D1 read failed", e);
    return [];
  }
}
