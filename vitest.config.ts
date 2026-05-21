// Vitest config for Luma. Pure-unit tests live alongside the
// modules they test (e.g. lib/production/metrics.test.ts).
//
// We deliberately avoid running tests that hit a real database in
// the default test run — the metric tests target the pure helper
// functions exported from lib/production/metrics.ts. Database-
// integration tests (Phase C+) get their own config.

import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
    },
  },
  test: {
    include: ["lib/**/*.test.ts", "components/**/*.test.ts", "app/**/*.test.ts"],
    environment: "node",
    globals: false,
    // The metric API imports the live db client; we mock it per-
    // test if needed. Suite default is no DB access — tests that
    // bring their own mock-db handle that explicitly.
    pool: "forks",
  },
});
