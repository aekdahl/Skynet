// ─── Skynet desktop (Electron main process) ────────────────────────────────
// Skynet is already a Node app, so the desktop shell just runs the same server
// locally and points a window at it. No SaaS, no Docker, no database: state
// lives in a JSON file under the OS per-user data dir (STORE=file).
//
//   • dev  (`pnpm dev`)  → runs the workspace server at apps/server/dist/index.js
//   • prod (packaged)    → runs the esbuild bundle at resources/server.cjs
//
// The server is spawned as a plain-Node child of this Electron binary
// (ELECTRON_RUN_AS_NODE=1) for crash isolation and so we don't ship a second
// Node runtime. We wait for /health, then load the SPA it serves.

const { app, BrowserWindow, shell, dialog } = require("electron");
const { spawn } = require("node:child_process");
const path = require("node:path");
const fs = require("node:fs");
const http = require("node:http");

// A fixed loopback port keeps the SPA's same-origin API/WS calls simple. If you
// run two copies at once the second will fail to bind — acceptable for a
// single-user desktop app.
const PORT = Number(process.env.SKYNET_DESKTOP_PORT) || 8099;
const HOST = "127.0.0.1";

let serverProc = null;
let win = null;

/** Where the bundled server entry and built SPA live (dev vs packaged). */
function resolvePaths() {
  if (app.isPackaged) {
    const res = process.resourcesPath;
    return { serverEntry: path.join(res, "server.cjs"), webDist: path.join(res, "web") };
  }
  // dev: apps/desktop → siblings apps/server, apps/web
  const apps = path.join(__dirname, "..");
  return {
    serverEntry: path.join(apps, "server", "dist", "index.js"),
    webDist: path.join(apps, "web", "dist"),
  };
}

/**
 * Optional `<userData>/skynet.env` (KEY=value lines) for provider keys and
 * overrides — a stop-gap until the in-app onboarding/settings screen lands.
 * e.g.  ANTHROPIC_API_KEY=sk-ant-...   RUNNER=claude
 */
function loadUserEnv() {
  const file = path.join(app.getPath("userData"), "skynet.env");
  const env = {};
  try {
    for (const line of fs.readFileSync(file, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (m && !line.trim().startsWith("#")) env[m[1]] = m[2];
    }
  } catch {
    /* no file → no overrides */
  }
  return env;
}

function startServer() {
  const { serverEntry, webDist } = resolvePaths();
  const userEnv = loadUserEnv();
  const dbPath = path.join(app.getPath("userData"), "skynet-data.json");

  const env = {
    ...process.env,
    ...userEnv,
    ELECTRON_RUN_AS_NODE: "1", // run the Electron binary as plain Node
    NODE_ENV: "production",
    STORE: "file", // zero-dependency JSON persistence
    SKYNET_DB_PATH: userEnv.SKYNET_DB_PATH || dbPath,
    WEB_DIST: webDist, // tell the server where the built SPA is
    PORT: String(PORT),
    HOST,
    // Default to the mock runner until the user configures a provider key; a
    // real runner is opt-in via skynet.env (RUNNER=claude + ANTHROPIC_API_KEY).
    RUNNER: userEnv.RUNNER || process.env.RUNNER || "mock",
  };

  serverProc = spawn(process.execPath, [serverEntry], { env, stdio: "inherit" });
  serverProc.on("exit", (code, signal) => {
    serverProc = null;
    if (!app.isQuitting) {
      dialog.showErrorBox(
        "Skynet server stopped",
        `The local Skynet server exited unexpectedly (code ${code ?? signal}). The app will close.`,
      );
      app.quit();
    }
  });
}

/** Poll /health until the server answers (or we give up). */
function waitForServer() {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 30_000;
    const tick = () => {
      const req = http.get({ host: HOST, port: PORT, path: "/health", timeout: 1000 }, (res) => {
        res.resume();
        if (res.statusCode === 200) return resolve();
        retry();
      });
      req.on("error", retry);
      req.on("timeout", () => req.destroy());
    };
    const retry = () => (Date.now() > deadline ? reject(new Error("server did not start")) : setTimeout(tick, 200));
    tick();
  });
}

function createWindow() {
  win = new BrowserWindow({
    width: 1320,
    height: 880,
    minWidth: 940,
    minHeight: 600,
    backgroundColor: "#0b0d11",
    title: "Skynet",
    autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });

  // Open external links (docs, provider sites) in the real browser, not in-app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http") && !url.includes(`${HOST}:${PORT}`)) {
      shell.openExternal(url);
      return { action: "deny" };
    }
    return { action: "allow" };
  });

  win.loadURL(`http://${HOST}:${PORT}/`);
}

function checkForUpdates() {
  if (!app.isPackaged) return;
  try {
    const { autoUpdater } = require("electron-updater");
    // mac auto-update needs a signed build; until signing lands this is a no-op
    // there and a working background update on Windows.
    autoUpdater.checkForUpdatesAndNotify().catch(() => {});
  } catch {
    /* electron-updater not present in this build */
  }
}

// Single instance — a second launch focuses the existing window.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(async () => {
    startServer();
    try {
      await waitForServer();
      createWindow();
      checkForUpdates();
    } catch (err) {
      dialog.showErrorBox("Skynet failed to start", String((err && err.message) || err));
      app.quit();
    }

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on("before-quit", () => {
    app.isQuitting = true;
    if (serverProc) serverProc.kill();
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}
