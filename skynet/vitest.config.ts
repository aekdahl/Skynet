import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Single root Vitest project for the monorepo's first tests (W10). Tests live
// under tests/ so they never land in any package's tsc build/typecheck. We alias
// @skynet/shared to its source so `pnpm test` doesn't depend on a prior build.
const sharedSrc = fileURLToPath(new URL("./packages/shared/src/index.ts", import.meta.url));
// Same reasoning for runner-sdk's claude subpath: aliased straight to source so
// `vi.mock("@skynet/runner-sdk/claude", ...)` reliably intercepts the module a
// test-under-test imports (the package's built dist/exports indirection made
// that mock silently miss and fall through to a REAL oneShotText call in
// tests/primer-draft.test.ts — this fixes it at the resolution layer, same as
// @skynet/shared above, rather than papering over it per-test).
const runnerSdkClaudeSrc = fileURLToPath(new URL("./packages/runner-sdk/src/claude.ts", import.meta.url));

export default defineConfig({
  resolve: {
    alias: { "@skynet/shared": sharedSrc, "@skynet/runner-sdk/claude": runnerSdkClaudeSrc },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // Merge-engine tests spawn git in temp repos; give them headroom.
    testTimeout: 20_000,
  },
});
