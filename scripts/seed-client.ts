#!/usr/bin/env tsx
/**
 * Seed or update a single client config in a target environment.
 *
 * Workflow:
 *   1. Read the config JSON file.
 *   2. Validate against Zod + load-time invariants (same as the worker).
 *   3. Generate an INSERT OR REPLACE SQL statement and run it against
 *      the target env's D1 (the source of truth, spec §7).
 *   4. Delete the matching KV cache entry so the next request triggers
 *      a fresh write-through from D1 (avoids serving the stale cache
 *      for the 60-second TTL window).
 *
 * Usage:
 *   npx tsx scripts/seed-client.ts --env=staging --config=config/lantern-crest-staging.json
 *
 * Or via npm:
 *   npm run seed-client -- --env=staging --config=config/lantern-crest-staging.json
 *
 * Exit code 0 on success, 1 on any failure.
 */

import { execSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ClientConfig } from "../src/config/schema.js";
import { assertConfigInvariants } from "../src/config/validator.js";

interface Args {
  env: "staging" | "production";
  config: string;
  skipKv: boolean;
}

function parseArgs(): Args {
  const args: Record<string, string> = {};
  let skipKv = false;
  for (const a of process.argv.slice(2)) {
    if (a === "--skip-kv") {
      skipKv = true;
      continue;
    }
    const m = a.match(/^--([^=]+)=(.*)$/);
    if (m?.[1] && m[2] !== undefined) args[m[1]] = m[2];
  }
  const env = args.env as Args["env"];
  if (env !== "staging" && env !== "production") {
    console.error("--env must be 'staging' or 'production'");
    process.exit(2);
  }
  if (!args.config) {
    console.error("--config=<path-to-config.json> is required");
    process.exit(2);
  }
  return { env, config: args.config, skipKv };
}

function run(cmd: string): void {
  console.log(`\n$ ${cmd}`);
  execSync(cmd, { stdio: "inherit" });
}

const { env, config: configPath, skipKv } = parseArgs();

// Step 1+2: validate.
let raw: unknown;
try {
  raw = JSON.parse(readFileSync(configPath, "utf8"));
} catch (e) {
  console.error(`✗ ${configPath}: not valid JSON — ${(e as Error).message}`);
  process.exit(1);
}
const parsed = ClientConfig.safeParse(raw);
if (!parsed.success) {
  console.error(`✗ ${configPath}: Zod validation failed`);
  for (const issue of parsed.error.issues) {
    console.error(`  - ${issue.path.join(".") || "(root)"}: ${issue.message}`);
  }
  process.exit(1);
}
try {
  assertConfigInvariants(parsed.data);
} catch (e) {
  console.error(`✗ ${configPath}: load-time invariant failed`);
  console.error(`  - ${(e as Error).message}`);
  process.exit(1);
}
const cfg = parsed.data;
console.log(`✓ ${configPath}: valid (client_id=${cfg.client_id}, ${env} env)`);

// Step 3: generate UPSERT SQL and run via wrangler d1 execute.
const tmp = mkdtempSync(join(tmpdir(), "edge-seo-seed-"));
const sqlPath = join(tmp, "upsert.sql");
const escapedJson = JSON.stringify(cfg).replace(/'/g, "''");
const escapedClientId = cfg.client_id.replace(/'/g, "''");
const escapedProxyDomain = cfg.proxy_domain.replace(/'/g, "''");
const escapedSourceDomain = cfg.source_domain.replace(/'/g, "''");
const escapedStatus = cfg.status.replace(/'/g, "''");
const sql = `INSERT OR REPLACE INTO clients
  (client_id, proxy_domain, source_domain, status, config_json, schema_version, updated_at)
VALUES (
  '${escapedClientId}',
  '${escapedProxyDomain}',
  '${escapedSourceDomain}',
  '${escapedStatus}',
  '${escapedJson}',
  ${cfg.schema_version},
  CURRENT_TIMESTAMP
);`;
writeFileSync(sqlPath, sql);

run(`npx wrangler d1 execute CONFIG_DB --env=${env} --remote --file=${sqlPath}`);

// Step 4: invalidate the KV cache entry so the next request loads fresh.
if (skipKv) {
  console.log("\n(skipping KV invalidation per --skip-kv)");
} else {
  const kvKey = `config:${cfg.client_id}`;
  // wrangler 3.x uses `kv:key delete` (colon syntax); 4.x uses `kv key delete`.
  // Try v3 first (the project-pinned version) and fall back to v4 syntax.
  console.log(`\n$ npx wrangler kv:key delete "${kvKey}" --binding=CONFIG_KV --env=${env}`);
  try {
    execSync(`npx wrangler kv:key delete "${kvKey}" --binding=CONFIG_KV --env=${env}`, {
      stdio: "inherit",
    });
  } catch {
    // v4 syntax fallback
    console.log("(retrying with wrangler 4 syntax)");
    execSync(`npx wrangler@4 kv key delete "${kvKey}" --binding=CONFIG_KV --env=${env} --remote`, {
      stdio: "inherit",
    });
  }
}

console.log(`\n✓ Seeded ${cfg.client_id} into ${env}`);
console.log(`  proxy_domain:  ${cfg.proxy_domain}`);
console.log(`  source_domain: ${cfg.source_domain}`);
console.log(`  status:        ${cfg.status}`);
console.log(`\nThe Worker's loader will pick up the new config on the next request.`);
