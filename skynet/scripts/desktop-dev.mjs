// Desktop dev with hot reload — no rebuilds, no relaunch.
//
//   • server: `@skynet/server` in watch mode (tsx) on :8099, file store + a dev
//     master key so persistence + the secret store work like the real app.
//   • web:    Vite dev server on :5173 with HMR, proxying /api + /ws → :8099.
//   • app:    Electron loads http://127.0.0.1:5173 (SKYNET_DEV=1), so it does
//             NOT spawn its own server and picks up SPA edits instantly.
//
// Edit web → instant HMR in the window. Edit server → tsx restarts it. Run from
// the repo root (skynet/): `pnpm desktop:dev`. Uses only Node built-ins.

import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import http from "node:http";

const PORT = 8099;
const VITE_PORT = 5173;
const devDir = ".skynet-dev";
mkdirSync(devDir, { recursive: true });

// Stable dev master key (throwaway, gitignored) so the secret store works.
const keyFile = `${devDir}/master.key`;
let masterKey;
try {
  masterKey = readFileSync(keyFile, "utf8").trim();
} catch {
  /* first run */
}
if (!masterKey) {
  masterKey = randomBytes(32).toString("base64");
  writeFileSync(keyFile, masterKey, { mode: 0o600 });
}

const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const kids = [];
let shuttingDown = false;

function run(name, args, env) {
  const p = spawn(pnpm, args, { stdio: "inherit", env: { ...process.env, ...env } });
  p.on("exit", (code) => {
    if (shuttingDown) return;
    console.log(`\n[desktop:dev] ${name} exited (${code}). Shutting down.`);
    shutdown();
  });
  kids.push(p);
  return p;
}

function shutdown() {
  shuttingDown = true;
  for (const k of kids) {
    try {
      k.kill();
    } catch {
      /* already gone */
    }
  }
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// 1. server (hot reload) with desktop-like env
run("server", ["--filter", "@skynet/server", "dev"], {
  STORE: "file",
  BUS: "memory",
  SESSIONS: "memory",
  SKYNET_DB_PATH: `${devDir}/skynet-data.json`,
  SKYNET_MASTER_KEY: masterKey,
  PORT: String(PORT),
  HOST: "127.0.0.1",
  NODE_ENV: "development",
});

// 2. web (Vite HMR), proxying API/WS to the server above
run("web", ["--filter", "@skynet/web", "dev"], { SKYNET_SERVER_PORT: String(PORT) });

// 3. wait for both, then launch Electron pointed at Vite
const ping = (port, path) =>
  new Promise((resolve) => {
    const r = http.get({ host: "localhost", port, path, timeout: 800 }, (res) => {
      res.resume();
      resolve(true);
    });
    r.on("error", () => resolve(false));
    r.on("timeout", () => {
      r.destroy();
      resolve(false);
    });
  });

(async () => {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline && !shuttingDown) {
    if ((await ping(PORT, "/health")) && (await ping(VITE_PORT, "/"))) {
      console.log("[desktop:dev] server + web up — launching Electron…");
      run("app", ["--dir", "apps/desktop", "exec", "electron", "."], {
        SKYNET_DEV: "1",
        SKYNET_DESKTOP_PORT: String(PORT),
      });
      return;
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  if (!shuttingDown) {
    console.error("[desktop:dev] server/web did not come up in time.");
    shutdown();
  }
})();
