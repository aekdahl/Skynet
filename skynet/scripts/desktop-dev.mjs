// Desktop dev with hot reload — no rebuilds, no relaunch.
//
//   • server: `@skynet/server` in watch mode (tsx) on :8099, file store + a dev
//     master key so persistence + the secret store work like the real app.
//   • web:    Vite dev server on :5273 with HMR, proxying /api + /ws → :8099.
//             A dedicated port (not Vite's crowded default 5173) + strictPort, so
//             we never silently bind a different project's dev server — if 5273 is
//             taken, Vite exits loudly instead of drifting to another port.
//   • app:    Electron loads http://localhost:5273 (SKYNET_DEV=1), so it does
//             NOT spawn its own server and picks up SPA edits instantly.
//
// Edit web → instant HMR in the window. Edit server → tsx restarts it. Run from
// the repo root (skynet/): `pnpm desktop:dev`. Uses only Node built-ins.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import http from "node:http";

const PORT = 8099;
// Dedicated Skynet port, NOT Vite's default 5173 — that default collides with any
// other Vite project you have running, and Vite would silently bump to another
// port while Electron still loaded 5173 (i.e. the other app). See `--strictPort`.
const VITE_PORT = 5273;
const devDir = ".skynet-dev";
mkdirSync(devDir, { recursive: true });

const pnpmBin = process.platform === "win32" ? "pnpm.cmd" : "pnpm";

// The server (tsx) and web (Vite) import @skynet/shared + runner-sdk from their
// built dist/, and this launcher doesn't watch them — so build the packages up
// front. Without this, a fresh checkout / a `git pull` that changed a package
// shows STALE behavior (the #1 "my changes aren't showing" gotcha).
console.log("[desktop:dev] building packages (shared, runner-sdk)…");
const build = spawnSync(pnpmBin, ["-r", "--filter", "./packages/*", "build"], { stdio: "inherit" });
if (build.status !== 0) {
  console.error("[desktop:dev] package build failed — did you run `pnpm install`?");
  process.exit(build.status ?? 1);
}
// Electron lives outside the workspace and installs standalone.
if (!existsSync("apps/desktop/node_modules/.bin/electron")) {
  console.error("[desktop:dev] Electron isn't installed. Run once:  cd apps/desktop && pnpm install --ignore-workspace");
  process.exit(1);
}

// Brand the dev app name. On macOS the application-menu title comes from the
// running bundle's CFBundleName — in dev that's the prebuilt Electron.app, so the
// menu reads "Electron" no matter what `app.setName()` does at runtime. Packaged
// builds already get "Skynet" from electron-builder's productName; this makes
// `desktop:dev` match by patching the local Electron.app's Info.plist. macOS-only,
// idempotent, best-effort (a failure just leaves the default name — never fatal).
function brandDevElectron() {
  if (process.platform !== "darwin") return;
  const plist = "apps/desktop/node_modules/electron/dist/Electron.app/Contents/Info.plist";
  if (!existsSync(plist)) return;
  for (const key of ["CFBundleName", "CFBundleDisplayName"]) {
    spawnSync("/usr/libexec/PlistBuddy", ["-c", `Set :${key} Skynet`, plist], { stdio: "ignore" });
  }
}
brandDevElectron();

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
// SKYNET_VITE_PORT makes vite.config bind OUR port with strictPort: it either
// gets 5273 or exits loudly (→ the launcher shuts down), never drifting onto
// whatever else is on 5173.
run("web", ["--filter", "@skynet/web", "dev"], { SKYNET_SERVER_PORT: String(PORT), SKYNET_VITE_PORT: String(VITE_PORT) });

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
        // Point Electron at OUR Vite port (main.cjs defaults to 5173 otherwise).
        SKYNET_DEV_URL: `http://localhost:${VITE_PORT}`,
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
