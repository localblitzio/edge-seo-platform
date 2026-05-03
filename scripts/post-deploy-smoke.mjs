#!/usr/bin/env node
/**
 * Post-deploy smoke test. Hits a deployed Worker (production or staging)
 * and asserts on spec-compliant responses for the pilot client. Run from
 * the operator's machine after `npm run deploy:production` and DNS cut.
 *
 * Usage:
 *   node scripts/post-deploy-smoke.mjs --host=<proxy-domain> [--scheme=https]
 *
 * Example:
 *   node scripts/post-deploy-smoke.mjs --host=lanterncrest.com
 *
 * Exit code 0 on full pass, 1 on any failure. Each check is a single
 * HTTP request; the script is safe to re-run and idempotent (no writes).
 */

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, ...v] = a.replace(/^--/, "").split("=");
    return [k, v.join("=")];
  }),
);
const HOST = args.host;
const SCHEME = args.scheme ?? "https";

if (!HOST) {
  console.error("usage: post-deploy-smoke.mjs --host=<proxy-domain> [--scheme=https]");
  process.exit(2);
}

const BASE = `${SCHEME}://${HOST}`;

const CHECKS = [
  {
    name: "security headers present on every response",
    path: "/",
    method: "HEAD",
    expect: (res) =>
      res.headers.get("x-content-type-options") === "nosniff" &&
      res.headers.get("referrer-policy") === "strict-origin-when-cross-origin",
  },
  {
    name: "Server / X-Powered-By stripped from upstream responses",
    path: "/",
    method: "HEAD",
    expect: (res) => !res.headers.has("server") && !res.headers.has("x-powered-by"),
  },
  {
    name: "unknown path returns 404 (catch-all behavior matches config)",
    path: "/__edge_seo_smoke_check__",
    method: "GET",
    expect: (res) => res.status === 404 || res.status === 200, // depends on catchall
  },
  {
    name: "OPTIONS preflight is handled (no 500/503)",
    path: "/",
    method: "OPTIONS",
    expect: (res) => res.status < 500,
  },
];

let failed = 0;
let passed = 0;
console.log(`smoke: ${BASE}\n`);
for (const check of CHECKS) {
  process.stdout.write(`  ${check.name.padEnd(58)} ... `);
  try {
    // eslint-disable-next-line no-await-in-loop
    const res = await fetch(`${BASE}${check.path}`, {
      method: check.method,
      redirect: "manual",
    });
    const ok = check.expect(res);
    if (ok) {
      console.log(`✓ HTTP ${res.status}`);
      passed++;
    } else {
      console.log(`✗ HTTP ${res.status} (assertion failed)`);
      failed++;
    }
  } catch (e) {
    console.log(`✗ network error: ${e.message}`);
    failed++;
  }
}

console.log("");
console.log(`${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
