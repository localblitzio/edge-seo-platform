#!/usr/bin/env node
/**
 * Route drift check — compares D1 in_place clients against
 * `wrangler.toml` `[[env.staging.routes]]` entries and surfaces any
 * client whose `proxy_domain` isn't covered by a deployed route.
 *
 * Why this exists: the admin's auto-onboard form registers Workers
 * Routes via the Cloudflare API. Subsequent `wrangler deploy --env
 * staging` reconciles routes to whatever's listed in wrangler.toml,
 * silently DELETING any not-listed route. Result: every in_place
 * client must be persisted to wrangler.toml; otherwise the next
 * deploy clobbers it.
 *
 * Run as a predeploy check or on a cron. Exit codes:
 *   0 — no drift, safe to deploy
 *   1 — drift detected, abort deploy and add missing routes first
 *
 * Usage:
 *   node scripts/check-route-drift.mjs
 *   node scripts/check-route-drift.mjs --env staging   (default)
 *   node scripts/check-route-drift.mjs --strict        (also fail on
 *     wrangler.toml routes that don't have a matching D1 client)
 */
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

const args = process.argv.slice(2);
const envFlag = args.indexOf("--env");
const env = envFlag >= 0 ? (args[envFlag + 1] ?? "staging") : "staging";
const strict = args.includes("--strict");

// ─── 1. Read routes from wrangler.toml ──────────────────────────────

const wranglerPath = resolve(root, "wrangler.toml");
const wranglerToml = readFileSync(wranglerPath, "utf8");

/**
 * Cheap-and-cheerful TOML parser scoped to `[[env.<env>.routes]]`
 * blocks. We don't want a full TOML dep just for this check; the
 * shape we care about is well-defined:
 *
 *   [[env.staging.routes]]
 *   pattern = "..."
 *   zone_name = "..."
 */
function parseRoutes(toml, envName) {
  const routes = [];
  const section = `[[env.${envName}.routes]]`;
  const lines = toml.split(/\r?\n/);
  let inSection = false;
  let cur = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (line === section) {
      if (cur) routes.push(cur);
      inSection = true;
      cur = {};
      continue;
    }
    // Any other [[..]] or [...] header closes our section.
    if (line.startsWith("[")) {
      if (cur) routes.push(cur);
      inSection = false;
      cur = null;
      continue;
    }
    if (!inSection || !line || line.startsWith("#")) continue;
    const m = line.match(/^(pattern|zone_name)\s*=\s*"([^"]*)"/);
    if (m && cur) cur[m[1]] = m[2];
  }
  if (cur) routes.push(cur);
  return routes.filter((r) => r.pattern);
}

const wranglerRoutes = parseRoutes(wranglerToml, env);

// ─── 2. Query D1 for active in_place clients ────────────────────────

const d1Db = env === "staging" ? "edge-seo-platform-staging" : "edge-seo-platform-production";

let d1Output;
try {
  d1Output = execSync(
    `npx wrangler d1 execute ${d1Db} --remote --command="SELECT client_id, proxy_domain FROM clients WHERE status='active' AND json_extract(config_json, '$.mode') = 'in_place'" --json`,
    { cwd: root, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] },
  );
} catch (e) {
  console.error(`Failed to query D1 (${d1Db}):`, e.message);
  process.exit(2);
}

let d1Clients = [];
try {
  const parsed = JSON.parse(d1Output);
  d1Clients = parsed[0]?.results ?? [];
} catch (e) {
  console.error("Failed to parse D1 output:", e.message);
  process.exit(2);
}

// ─── 3. Compare ─────────────────────────────────────────────────────

/**
 * Match logic: a client's `proxy_domain` is covered if any wrangler
 * route's pattern matches it. We use a simple glob-to-regex conversion
 * so `*.localpage.us.com/*` correctly covers `foo.localpage.us.com`.
 */
function patternMatches(pattern, host) {
  const noPath = pattern.replace(/\/\*$/, "").replace(/\/$/, "");
  // Convert wrangler-style * (not regex) into a regex .*
  const re = new RegExp(`^${noPath.replace(/\./g, "\\.").replace(/\*/g, ".*")}$`);
  return re.test(host);
}

const missingClients = [];
for (const c of d1Clients) {
  const covered = wranglerRoutes.some((r) => patternMatches(r.pattern, c.proxy_domain));
  if (!covered) missingClients.push(c);
}

// Strict mode: routes pointing at zones with no matching client.
const orphanRoutes = strict
  ? wranglerRoutes.filter((r) => {
      const noPath = r.pattern.replace(/\/\*$/, "").replace(/\/$/, "");
      // Skip wildcard zones — those cover many clients dynamically.
      if (noPath.startsWith("*")) return false;
      return !d1Clients.some((c) => c.proxy_domain === noPath);
    })
  : [];

// ─── 4. Report ──────────────────────────────────────────────────────

console.log(`Environment: ${env}`);
console.log(`Wrangler routes: ${wranglerRoutes.length}`);
console.log(`Active in_place clients: ${d1Clients.length}`);
console.log("");

if (missingClients.length === 0 && orphanRoutes.length === 0) {
  console.log("✓ No drift — all in_place clients have a matching wrangler.toml route.");
  process.exit(0);
}

if (missingClients.length > 0) {
  console.log(`✗ ${missingClients.length} in_place client(s) missing from wrangler.toml:`);
  for (const c of missingClients) {
    console.log(`  - ${c.client_id} (proxy_domain: ${c.proxy_domain})`);
    console.log("");
    console.log(`    Add to wrangler.toml under [env.${env}]:`);
    console.log(`    [[env.${env}.routes]]`);
    console.log(`    pattern = "${c.proxy_domain}/*"`);
    console.log(`    zone_name = "${c.proxy_domain.replace(/^www\./, "")}"`);
    console.log("");
  }
}

if (orphanRoutes.length > 0) {
  console.log(`✗ ${orphanRoutes.length} wrangler.toml route(s) without a matching D1 client:`);
  for (const r of orphanRoutes) {
    console.log(`  - ${r.pattern} (zone: ${r.zone_name})`);
  }
}

process.exit(1);
