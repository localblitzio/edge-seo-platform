import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts", "src/**/types.ts"],
      thresholds: {
        // Per spec §12.1. Module-specific thresholds raised in their own
        // configs as those modules land.
        lines: 80,
        functions: 80,
        statements: 80,
        branches: 75,
      },
    },
  },
});
