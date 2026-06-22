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
    include: ["tests/**/*.test.ts"],
    // Merge-engine tests spawn git in temp repos; give them headroom.
    testTimeout: 20_000,
  },
});
