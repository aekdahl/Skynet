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

const { app, BrowserWindow, shell, dialog, nativeImage } = require("electron");
const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const path = require("node:path");
const fs = require("node:fs");
const http = require("node:http");

// Name the app before anything reads it — fixes notifications and the per-user
// data dir (…/Skynet instead of …/Electron) in dev. The packaged build already
// gets "Skynet" from electron-builder's productName.
app.setName("Skynet");

// A fixed loopback port keeps the SPA's same-origin API/WS calls simple. If you
// run two copies at once the second will fail to bind — acceptable for a
// single-user desktop app.
const PORT = Number(process.env.SKYNET_DESKTOP_PORT) || 8099;
const HOST = "127.0.0.1";

// Dev (hot reload): the `desktop:dev` launcher runs the server (watch) + Vite
// (HMR) externally, so the window loads Vite and we don't spawn/serve anything.
const DEV = process.env.SKYNET_DEV === "1";
// Match Vite's default bind (localhost) so the window connects on macOS where
// `localhost` may resolve to IPv6.
const DEV_URL = process.env.SKYNET_DEV_URL || "http://localhost:5173";

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

/**
 * A stable per-install master key (32 bytes, base64) for the encrypted secret
 * store, persisted in the user-data dir. Without it the in-app key Settings
 * can't store anything. Generated once on first run.
 */
function ensureMasterKey() {
  const file = path.join(app.getPath("userData"), "skynet-master.key");
  try {
    const existing = fs.readFileSync(file, "utf8").trim();
    if (existing) return existing;
  } catch {
    /* first run */
  }
  const key = crypto.randomBytes(32).toString("base64");
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, key, { mode: 0o600 });
  } catch {
    /* non-fatal: secrets just won't persist this run */
  }
  return key;
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
    // Enable the encrypted secret store so in-app key Settings work.
    SKYNET_MASTER_KEY: process.env.SKYNET_MASTER_KEY || userEnv.SKYNET_MASTER_KEY || ensureMasterKey(),
    WEB_DIST: webDist, // tell the server where the built SPA is
    PORT: String(PORT),
    HOST,
    // RUNNER is intentionally NOT set here: the backend is chosen per agent from
    // the fleet runner's provider. A provider key comes from the in-app secret
    // store or skynet.env (e.g. ANTHROPIC_API_KEY). skynet.env may still set
    // RUNNER as a global override (e.g. RUNNER=mock for a no-key demo); spread
    // above carries it through.
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
  const mac = process.platform === "darwin";
  win = new BrowserWindow({
    width: 1320,
    height: 880,
    minWidth: 940,
    minHeight: 600,
    backgroundColor: "#000000",
    title: "Skynet",
    autoHideMenuBar: true,
    // Drop the native title bar so the app's own bar is the only one. Keep the
    // real, working window controls: traffic lights on macOS (overlaid on our
    // bar), an overlaid control strip on Windows. The app's bar is 40px tall.
    titleBarStyle: mac ? "hiddenInset" : "hidden",
    ...(mac
      ? { trafficLightPosition: { x: 14, y: 13 } }
      : { titleBarOverlay: { color: "#000000", symbolColor: "#9aa4b2", height: 40 } }),
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });

  // Open external links (docs, provider sites) in the real browser, not in-app.
  // Anything on our own loopback host (server or the dev Vite port) stays in-app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http") && !url.includes("127.0.0.1") && !url.includes("localhost")) {
      shell.openExternal(url);
      return { action: "deny" };
    }
    return { action: "allow" };
  });

  win.loadURL(DEV ? DEV_URL : `http://${HOST}:${PORT}/`);
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
    // Dev only: show our icon in the dock (packaged builds carry the real icon).
    if (!app.isPackaged && process.platform === "darwin" && app.dock) {
      try {
        const img = nativeImage.createFromPath(path.join(__dirname, "build-assets", "icon.png"));
        if (!img.isEmpty()) app.dock.setIcon(img);
      } catch {
        /* non-fatal */
      }
    }

    if (DEV) {
      // Server + Vite are run by the `desktop:dev` launcher; just open the window.
      createWindow();
    } else {
      startServer();
      try {
        await waitForServer();
        createWindow();
        checkForUpdates();
      } catch (err) {
        dialog.showErrorBox("Skynet failed to start", String((err && err.message) || err));
        app.quit();
      }
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
