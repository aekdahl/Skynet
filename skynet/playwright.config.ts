import { defineConfig, devices } from "@playwright/test";

// First automated UI harness for the SPA (the Vitest suite is environment:node
// and never touches the browser). This drives the REAL built SPA served by the
// server — not the Vite dev server — so it exercises the same artifact the
// Docker image ships.
//
// The webServer below builds the workspace packages + web app, then boots the
// server pointed at the built SPA (apps/web/dist). Backends are all in-memory
// and the runner is mocked, so the run is hermetic and needs no external
// services or provider credentials. AUTH_REQUIRED=false + NODE_ENV=development
// keep the SPA's default dev token (`dev-cyberdyne`) valid.

const PORT = 8199;
const baseURL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL,
    trace: "on-first-retry",
  },
  projects: [
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
  ],
  webServer: {
    // Build packages + web, then serve the built SPA from the server. The
    // server's registerStatic() auto-mounts apps/web/dist when index.html
    // exists, with an SPA fallback for client routes.
    command:
      'pnpm -r --filter "./packages/**" build && pnpm --filter @skynet/web build && pnpm --filter @skynet/server build && pnpm --filter @skynet/server start',
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
    env: {
      STORE: "memory",
      BUS: "memory",
      SESSIONS: "memory",
      RUNNER: "mock",
      AUTH_REQUIRED: "false",
      NODE_ENV: "development",
      PORT: String(PORT),
    },
  },
});
