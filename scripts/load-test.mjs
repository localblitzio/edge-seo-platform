#!/usr/bin/env node
/**
 * Synthetic load test against a running Worker (defaults to local
 * `npm run dev` on http://localhost:8787). Measures p50 / p95 / p99
 * end-to-end response time per spec §11 budgets.
 *
 * Usage:
 *   node scripts/load-test.mjs [--target=http://localhost:8787] \
 *                              [--host=localhost:8787] \
 *                              [--requests=500] [--concurrency=20]
 *
 * Prints a status table per path. Exit code 1 if any p95 exceeds the
 * spec §11 budgets:
 *   - cache hit total          ≤  10 ms
 *   - HTML pipeline cache miss ≤  50 ms (local Miniflare; production
 *                                        adds origin RTT separately)
 *
 * On a cold/local environment the absolute numbers are dominated by
 * Node-loop overhead — treat this as a regression detector, not a
 * production-perf claim.
 */

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, ...v] = a.replace(/^--/, "").split("=");
    return [k, v.join("=")];
  }),
);
const TARGET = args.target ?? "http://localhost:8787";
const HOST = args.host ?? "localhost:8787";
const REQUESTS = Number(args.requests ?? 500);
const CONCURRENCY = Number(args.concurrency ?? 20);

const PATHS = [
  { path: "/welcome", expect: 200, label: "custom_page (HTML pipeline)" },
  { path: "/old", expect: 301, label: "static redirect" },
  { path: "/posts/42", expect: 301, label: "pattern redirect" },
  { path: "/gone", expect: 410, label: "static 410" },
];

// p95 ms CEILINGS for the LOCAL Miniflare environment. These are loose
// regression-detection budgets — Miniflare is single-process and ~10×
// slower than Cloudflare's production edge. Spec §11 production budgets
// (1ms redirect, 50ms HTML pipeline cache miss) are validated by
// production-side dashboards reading Analytics Engine, not this script.
const BUDGETS = {
  "static redirect": 150,
  "pattern redirect": 150,
  "static 410": 150,
  "custom_page (HTML pipeline)": 300,
};

function pct(sorted, q) {
  const i = Math.min(sorted.length - 1, Math.floor(sorted.length * q));
  return sorted[i];
}

async function fireOne(path, expect) {
  const t0 = performance.now();
  const res = await fetch(`${TARGET}${path}`, {
    headers: { Host: HOST, "User-Agent": "edge-seo-load-test/0.1" },
    redirect: "manual",
  });
  await res.arrayBuffer(); // drain body
  const ms = performance.now() - t0;
  return { ms, status: res.status, ok: res.status === expect };
}

async function runPath({ path, expect, label }) {
  const samples = [];
  let okCount = 0;
  let inFlight = 0;
  let next = 0;

  await new Promise((resolve) => {
    const tick = async () => {
      while (inFlight < CONCURRENCY && next < REQUESTS) {
        next++;
        inFlight++;
        fireOne(path, expect).then((r) => {
          samples.push(r.ms);
          if (r.ok) okCount++;
          inFlight--;
          if (samples.length === REQUESTS) resolve();
          else tick();
        });
      }
    };
    tick();
  });

  samples.sort((a, b) => a - b);
  return {
    path,
    label,
    samples: samples.length,
    ok: okCount,
    p50: pct(samples, 0.5),
    p95: pct(samples, 0.95),
    p99: pct(samples, 0.99),
    max: samples[samples.length - 1],
    budget: BUDGETS[label] ?? null,
  };
}

console.log(`load-test: ${TARGET}  Host=${HOST}  ${REQUESTS} reqs × ${CONCURRENCY} concurrent`);
console.log("");
const results = [];
for (const p of PATHS) {
  process.stdout.write(`  ${p.path.padEnd(15)} ... `);
  // eslint-disable-next-line no-await-in-loop
  const r = await runPath(p);
  results.push(r);
  process.stdout.write(`${r.ok}/${r.samples} ok\n`);
}

console.log("");
console.log("  PATH            p50    p95    p99    max    budget   verdict");
console.log("  ----            ----   ----   ----   ----   ------   -------");
let regressed = false;
for (const r of results) {
  const fmt = (n) => `${n.toFixed(1).padStart(5)}ms`;
  const budget = r.budget !== null ? `${r.budget}ms`.padStart(7) : "    n/a";
  let verdict;
  if (r.budget === null) {
    verdict = " ";
  } else if (r.p95 <= r.budget) {
    verdict = "✓";
  } else {
    verdict = "✗ over budget";
    regressed = true;
  }
  console.log(
    `  ${r.path.padEnd(15)} ${fmt(r.p50)} ${fmt(r.p95)} ${fmt(r.p99)} ${fmt(r.max)}  ${budget}   ${verdict}`,
  );
}

console.log("");
if (regressed) {
  console.log("✗ at least one path exceeded its p95 budget");
  process.exit(1);
}
console.log("✓ all paths within p95 budgets");
