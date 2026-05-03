#!/usr/bin/env node
/**
 * Seed the local Miniflare bindings with the demo config.
 *
 * What this does:
 *   1. Applies any pending D1 migrations to the local SQLite store.
 *   2. Inserts (or replaces) a `clients` row for the demo client.
 *   3. Writes the `domain:localhost:8787 → demo` lookup into the local KV.
 *   4. Writes the welcome page HTML into KV at `page:/welcome`.
 *
 * After seeding, run `npm run dev` and visit http://localhost:8787/welcome.
 */

import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PROJECT_ROOT = process.cwd();

function run(cmd) {
  console.log(`\n$ ${cmd}`);
  execSync(cmd, { stdio: "inherit", cwd: PROJECT_ROOT });
}

function escapeSqliteString(value) {
  return value.replace(/'/g, "''");
}

const config = JSON.parse(readFileSync(join(PROJECT_ROOT, "scripts", "demo-config.json"), "utf8"));
const welcomeHtml = readFileSync(join(PROJECT_ROOT, "scripts", "demo-welcome.html"), "utf8");

const tmp = mkdtempSync(join(tmpdir(), "edge-seo-seed-"));

// 1. Apply D1 migrations to the local SQLite store.
run("npx wrangler d1 migrations apply CONFIG_DB --local");

// 2. Insert / replace the demo client row.
const insertSql = `INSERT OR REPLACE INTO clients
  (client_id, proxy_domain, source_domain, status, config_json, schema_version)
VALUES (
  '${escapeSqliteString(config.client_id)}',
  '${escapeSqliteString(config.proxy_domain)}',
  '${escapeSqliteString(config.source_domain)}',
  '${escapeSqliteString(config.status)}',
  '${escapeSqliteString(JSON.stringify(config))}',
  ${Number(config.schema_version)}
);`;
const sqlPath = join(tmp, "seed.sql");
writeFileSync(sqlPath, insertSql);
run(`npx wrangler d1 execute CONFIG_DB --local --file="${sqlPath}"`);

// 3. KV: domain → client_id lookup.
//    The browser may send any of several Host header values for a local
//    dev server (localhost:8787, 127.0.0.1:8787, or bare localhost /
//    127.0.0.1 if the port is omitted). Seed all four aliases so the
//    demo works regardless of which URL the user types.
const hostAliases = [config.proxy_domain, "127.0.0.1:8787", "localhost", "127.0.0.1"];
for (const host of hostAliases) {
  run(`npx wrangler kv key put --binding=CONFIG_KV --local "domain:${host}" "${config.client_id}"`);
}

// 4. KV: full config cache (so the loader hits KV-fast-path, not D1 fallback).
const configKvPath = join(tmp, "config.json");
writeFileSync(configKvPath, JSON.stringify(config));
run(
  `npx wrangler kv key put --binding=CONFIG_KV --local "config:${config.client_id}" --path="${configKvPath}"`,
);

// 5. KV: welcome page content (custom_page route serves this).
const welcomeKvPath = join(tmp, "welcome.html");
writeFileSync(welcomeKvPath, welcomeHtml);
run(
  `npx wrangler kv key put --binding=CONFIG_KV --local "page:/welcome" --path="${welcomeKvPath}"`,
);

console.log("\n✅ Local bindings seeded. Start the dev server with:");
console.log("\n   npm run dev\n");
console.log("Then try:");
console.log("  http://localhost:8787/welcome      → custom page from KV");
console.log("  http://localhost:8787/old          → 301 to /new (static redirect)");
console.log("  http://localhost:8787/posts/42     → 301 to /posts/42/ (pattern redirect)");
console.log("  http://localhost:8787/gone         → 410 (status-only static)");
console.log("  http://localhost:8787/about        → proxied to https://example.com/about");
console.log("  http://localhost:8787/             → proxied to https://example.com/");
