#!/usr/bin/env tsx
/**
 * Validate a ClientConfig JSON file against the Zod schema AND the
 * load-time invariants from spec §4. Used in the admin pipeline before
 * INSERT into D1 (per spec §7: "must validate against the Zod
 * `ClientConfig` schema before INSERT or UPDATE on `clients.config_json`").
 *
 * Usage:
 *   npx tsx scripts/validate-config.ts <path-to-config.json>
 *
 * Exit code 0 on success, 1 on any validation failure.
 *
 * The script imports the same validators the Worker uses, so admin-time
 * and load-time validation can never disagree (which would trip spec §7's
 * "alert and refuse to populate KV" rule).
 */

import { readFileSync } from "node:fs";

import { ClientConfig } from "../src/config/schema.js";
import { assertConfigInvariants } from "../src/config/validator.js";

const args = process.argv.slice(2);
const path = args[0];
if (args.length !== 1 || !path) {
  console.error("usage: validate-config.ts <path-to-config.json>");
  process.exit(2);
}

let raw: unknown;
try {
  raw = JSON.parse(readFileSync(path, "utf8"));
} catch (e) {
  console.error(`✗ ${path}: not valid JSON — ${(e as Error).message}`);
  process.exit(1);
}

const parsed = ClientConfig.safeParse(raw);
if (!parsed.success) {
  console.error(`✗ ${path}: Zod schema validation failed`);
  for (const issue of parsed.error.issues) {
    console.error(`  - ${issue.path.join(".") || "(root)"}: ${issue.message}`);
  }
  process.exit(1);
}

try {
  assertConfigInvariants(parsed.data);
} catch (e) {
  console.error(`✗ ${path}: load-time invariant failed`);
  console.error(`  - ${(e as Error).message}`);
  process.exit(1);
}

const cfg = parsed.data;
const counts: Record<string, number> = {
  routes: cfg.routing.length,
  static_redirects: cfg.redirects.static.length,
  pattern_redirects: cfg.redirects.patterns.length,
  conditional_redirects: cfg.redirects.conditional.length,
  canonicals: cfg.canonicals.length,
  schema_injections: cfg.schema_injections.length,
  link_rewrites: cfg.link_rewrites.length,
  element_removals: cfg.element_removals.length,
  content_injections: cfg.content_injections.length,
  meta_rewrites: cfg.meta_rewrites.length,
  indexation: cfg.indexation.length,
  caching: cfg.caching.length,
  forms: cfg.forms.length,
};

console.log(`✓ ${path}: valid ClientConfig (schema_version ${cfg.schema_version})`);
console.log(`  client_id:     ${cfg.client_id}`);
console.log(`  proxy_domain:  ${cfg.proxy_domain}`);
console.log(`  source_domain: ${cfg.source_domain}`);
console.log(`  status:        ${cfg.status}`);
console.log(
  `  attested by:   ${cfg.authorization.attested_by_email} at ${cfg.authorization.attested_at}`,
);
console.log("  rule counts:");
for (const [k, v] of Object.entries(counts)) {
  if (v > 0) console.log(`    ${k.padEnd(22)} ${v}`);
}
process.exit(0);
