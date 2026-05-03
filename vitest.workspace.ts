import { defineWorkspace } from "vitest/config";

export default defineWorkspace([
  {
    test: {
      name: "unit",
      include: ["tests/unit/**/*.test.ts", "src/**/*.test.ts"],
      environment: "node",
      globals: true,
    },
  },
  // Integration tests — run inside workerd via @cloudflare/vitest-pool-workers.
  // These exercise the full §5 pipeline end-to-end against a Miniflare-backed
  // Worker bound to in-memory KV/D1/R2 fixtures.
  "./vitest.integration.config.ts",
]);
