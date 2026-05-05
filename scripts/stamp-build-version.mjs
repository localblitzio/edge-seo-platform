#!/usr/bin/env node
/**
 * Rewrites frontend-worker/src/build-version.ts with the current
 * git short SHA + ISO timestamp so the value rendered in the app
 * sidebar matches what was actually deployed.
 *
 * Run before `wrangler deploy`. Idempotent — safe to invoke twice.
 */
import { execSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const target = resolve(here, "..", "frontend-worker", "src", "build-version.ts");

const sha = execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
const ts = new Date().toISOString().slice(0, 16).replace("T", " ");
const value = `${sha} (${ts}Z)`;

const body = `/**
 * Build identifier shown in the app sidebar so operators can verify a
 * deploy actually shipped. Rewritten by \`scripts/stamp-build-version.mjs\`
 * before \`wrangler deploy\` — the value below is just a placeholder for
 * local dev.
 */
export const BUILD_VERSION = ${JSON.stringify(value)};
`;

writeFileSync(target, body);
console.log(`Stamped BUILD_VERSION = ${value}`);
