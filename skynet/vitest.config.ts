import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Single root Vitest project for the monorepo's first tests (W10). Tests live
// under tests/ so they never land in any package's tsc build/typecheck. We alias
// @skynet/shared to its source so `pnpm test` doesn't depend on a prior build.
const sharedSrc = fileURLToPath(new URL("./packages/shared/src/index.ts", import.meta.url));

export default defineConfig({
  resolve: {
    alias: { "@skynet/shared": sharedSrc },
  },
  test: {
    environment: "node",
    // Line/branch coverage, emitted as a machine-readable summary the
    // per-project Coverage panel reads (server/quality/scan.ts) — it never
    // runs the suite itself. `enabled: false` keeps the default `pnpm test`
    // fast; produce a summary with `pnpm test -- --coverage`.
    coverage: {
      enabled: false,
      provider: "v8",
      reporter: ["text-summary", "json-summary"],
      reportsDirectory: "./coverage",
      include: ["apps/**/src/**/*.ts", "apps/**/src/**/*.tsx", "packages/**/src/**/*.ts"],
    },
    include: ["tests/**/*.test.ts"],
    // Merge-engine tests spawn git in temp repos; give them headroom.
    testTimeout: 20_000,
  },
});
