/**
 * Worker `Env` type — bindings declared in wrangler.toml.
 *
 * NOTE: This file is a temporary hand-written version. Once `wrangler types`
 * is run (`npm run wrangler:types`), it will generate `worker-configuration.d.ts`
 * with an authoritative `Env` interface that should be preferred. Per Cloudflare
 * docs: "Do not manually define Env — it drifts from your actual bindings."
 *
 * Once the generated type is available, this file should re-export from it:
 *
 *     export type { Env } from "../worker-configuration.js";
 *
 * The hand-written version below exists only so M0–M1 modules can typecheck
 * before the first `wrangler types` run.
 */

import type {
  AnalyticsEngineDataset,
  D1Database,
  KVNamespace,
  R2Bucket,
} from "@cloudflare/workers-types";

export interface Env {
  CONFIG_KV: KVNamespace;
  CONFIG_DB: D1Database;
  CONTENT_R2: R2Bucket;
  LOGS_R2: R2Bucket;
  METRICS: AnalyticsEngineDataset;

  // Legacy fallback secrets — preferred storage is the D1 `secrets`
  // table edited from the Settings → API keys admin page. The Worker
  // reads via `getSecret(env, KEY)` (src/secrets/store.ts) which
  // checks KV → D1 → these env bindings in that order, so any value
  // bound via `wrangler secret put` keeps working until the operator
  // pastes it into the new UI and unsets the Worker secret.
  INDEXNOW_KEY?: string;
  GSC_SERVICE_ACCOUNT_JSON?: string;
}
