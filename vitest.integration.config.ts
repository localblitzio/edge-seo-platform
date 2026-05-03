import { defineWorkersProject } from "@cloudflare/vitest-pool-workers/config";

export default defineWorkersProject({
  test: {
    name: "integration",
    include: ["tests/integration/**/*.test.ts"],
    globals: true,
    // Each test file runs in its own isolated workerd worker. We avoid
    // `singleWorker: true` because the cache layer's `ctx.waitUntil` on
    // `caches.default.put` was racing the per-test KV reset and tripping
    // workerd's Cross-Request-Promise-Resolve check, which then rejects
    // an internal vitest-pool-workers IPC and crashes the runner.
    poolOptions: {
      workers: {
        wrangler: { configPath: "./wrangler.toml" },
        miniflare: {
          compatibilityDate: "2026-04-01",
          compatibilityFlags: ["nodejs_compat"],
        },
      },
    },
  },
});
