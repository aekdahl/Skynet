import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";

// API/WS proxy target — the local server port. The desktop dev launcher points
// this at the desktop server (8099); plain `pnpm dev` uses the default 8080.
const apiPort = process.env.SKYNET_SERVER_PORT || "8080";

// Resolve @skynet/shared to its TypeScript SOURCE, not its built dist.
//
// Why: the web imports runtime values from @skynet/shared (the zod schemas —
// Snapshot.parse, AuditRecord, GithubConnection …), so Vite pre-bundles it into
// node_modules/.vite/deps. That cache is keyed off the lockfile, NOT the linked
// package's dist content — so after a `git pull` + package rebuild, Vite serves
// the STALE pre-bundled copy and your changes don't show. Reading from src means
// there's no dist and no dep-cache to go stale: Vite/esbuild compile the source
// directly and HMR picks up edits to the package too. (The server still uses the
// built dist via tsx, which has no such cache — the dev launcher rebuilds it.)
const sharedSrc = fileURLToPath(new URL("../../packages/shared/src/index.ts", import.meta.url));

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: [{ find: /^@skynet\/shared$/, replacement: sharedSrc }],
  },
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: `http://localhost:${apiPort}`,
        changeOrigin: true,
      },
      "/ws": {
        target: `ws://localhost:${apiPort}`,
        ws: true,
      },
    },
  },
});
