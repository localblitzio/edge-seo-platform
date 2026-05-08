-- Migration: 0009_bot_hits
-- Per-(client × bot family × hour) aggregation table powering the
-- per-site Bot activity dashboard.
--
-- Population: the proxy worker calls `recordBotHit(env, ...)` via
-- `ctx.waitUntil` after every bot-classified request — fire-and-
-- forget so the D1 write doesn't add latency to the response. Human
-- traffic is NOT recorded here (different question, different
-- infrastructure). Operators who need full request analytics use
-- Workers Analytics Engine + Logpush.
--
-- Bucket size: 1 hour. UPSERT increments the `hits` counter for the
-- (client_id, bot_family, bucket_hour) row, so a site receiving
-- 1000 Googlebot hits in an hour produces ONE row, not 1000.
--
-- The taxonomy in src/observability/logger.ts is the source of truth
-- for `bot_family`. Adding a new family = updating the BOT_PATTERNS
-- table, no migration needed (rows just appear with the new value).
--
-- Forward-only. Never edit a deployed migration; add a new one instead.

CREATE TABLE bot_hits (
  client_id TEXT NOT NULL,
  /** Stable family identifier from classifyUserAgentDetailed (e.g.
   *  "googlebot", "gptbot", "perplexitybot", "facebookexternalhit"). */
  bot_family TEXT NOT NULL,
  /** Higher-level grouping for fast category-level queries. Mirrors
   *  BotCategory: search-engine | ai-training | ai-search | social |
   *  monitoring | other-bot. */
  bot_category TEXT NOT NULL,
  /** Unix epoch hour: floor(unix_seconds / 3600). 1h buckets keep
   *  the table compact (24 rows/site/family/day worst case). */
  bucket_hour INTEGER NOT NULL,
  hits INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (client_id, bot_family, bucket_hour)
);

-- Reverse-lookup index for the dashboard's "recent activity" query
-- (fetch the last N hours across all bots for one client).
CREATE INDEX idx_bot_hits_client_recent
  ON bot_hits (client_id, bucket_hour DESC);

-- Lookup index for the cross-site "which sites is bot X hitting" query.
CREATE INDEX idx_bot_hits_family_recent
  ON bot_hits (bot_family, bucket_hour DESC);
