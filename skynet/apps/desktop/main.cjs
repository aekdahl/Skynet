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
const { skynetUrlToHash, findSkynetUrlArg } = require("./deep-link.cjs");

// Name the app before anything reads it — fixes notifications and the per-user
// data dir (…/Skynet instead of …/Electron) in dev. The packaged build already
// gets "Skynet" from electron-builder's productName.
app.setName("Skynet");

// A fixed loopback port keeps the SPA's same-origin API/WS calls simple. If you
// run two copies at once the second will fail to bind — acceptable for a
// single-user desktop app.
const PORT = Number(process.env.SKYNET_DESKTOP_PORT) || 8099;
const HOST = "127.0.0.1";

// Common bin dirs a GUI-launched app's bare PATH omits (git, node, the runner
// CLIs). Prepend them so child spawns resolve; keep the inherited PATH last and
// drop dupes so nothing already present is shadowed. Windows installers put
// tools on the system PATH, so this is a no-op there.
function enrichPath(current) {
  const extra =
    process.platform === "win32"
      ? []
      : ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"];
  const sep = process.platform === "win32" ? ";" : ":";
  const seen = new Set();
  return [...extra, ...(current ? current.split(sep) : [])]
    .filter((d) => d && !seen.has(d) && seen.add(d))
    .join(sep);
}

// Dev (hot reload): the `desktop:dev` launcher runs the server (watch) + Vite
// (HMR) externally, so the window loads Vite and we don't spawn/serve anything.
const DEV = process.env.SKYNET_DEV === "1";
// Match Vite's default bind (localhost) so the window connects on macOS where
// `localhost` may resolve to IPv6.
const DEV_URL = process.env.SKYNET_DEV_URL || "http://localhost:5173";

let serverProc = null;
let win = null;

// ─── skynet:// deep links ───────────────────────────────────────────────────
// A Telegram/Steward reply that links into a specific run/project used to only
// land cleanly if the browser tab already happened to be signed in — click it
// fresh and you'd hit a login wall. On desktop there's no login wall to hit:
// the app is already running locally as the single operator, so an OS-level
// `skynet://` protocol handler can route the click straight in, no token
// needed at all (see ROADMAP.md's "Chat → canvas handoff, zero cold start").
// Translation is pure + shared (deep-link.cjs); this section is just the
// Electron event wiring for the two platform-specific delivery mechanisms:
//   • macOS: the OS delivers `open-url` directly to the (single) running
//     process — no second process, no argv involved.
//   • Windows/Linux: the OS launches the protocol handler as a fresh process
//     with the URL as a plain argv entry. If Skynet is already running, that
//     second process loses `requestSingleInstanceLock()` and Electron forwards
//     its argv to the first instance via `second-instance`; if Skynet isn't
//     running, THIS process's own `process.argv` carries the URL, captured
//     below before `app.whenReady()` so `createWindow()` can apply it once the
//     page loads (the win-not-ready case `routeToHash` also covers, since
//     open-url can fire on macOS before whenReady resolves too).
let pendingDeepLink = null; // hash (e.g. "#/agent/xyz") queued until a window exists to apply it to

/** Focus the window and navigate the ALREADY-LOADED page to `hash` via a plain
 *  same-document `location.hash` assignment (not a reload — reusing the app's
 *  own hashchange handling, exactly like any shared link) — or, if there's no
 *  window yet, queue it for `createWindow()` to bake into the initial load. */
function routeToHash(hash) {
  if (!hash) return;
  if (!win || win.isDestroyed()) {
    pendingDeepLink = hash;
    return;
  }
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
  win.webContents.executeJavaScript(`location.hash = ${JSON.stringify(hash)};`).catch(() => {});
}

// Register as the OS default handler for skynet:// links. Safe/idempotent to
// call on every launch (updates the OS registration if needed); on Windows
// this points the registration at process.execPath + the launch args Electron
// already uses to relaunch itself, so a click reopens (or focuses, via the
// single-instance lock below) this same app.
app.setAsDefaultProtocolClient("skynet");

// macOS: register as early as possible (module scope, before whenReady) — the
// OS can deliver `open-url` before the app finishes launching, and Electron
// only replays it if a listener is already attached.
app.on("open-url", (event, url) => {
  event.preventDefault();
  routeToHash(skynetUrlToHash(url));
});

// Windows/Linux cold launch: `open-url` doesn't exist on these platforms — a
// launch via the protocol handler passes the URL as a plain argv entry on
// THIS process instead. Capture it now (before whenReady) so it's ready for
// createWindow() to apply once the page loads.
if (process.platform !== "darwin") {
  const arg = findSkynetUrlArg(process.argv);
  if (arg) pendingDeepLink = skynetUrlToHash(arg);
}

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

// Sentinel exit code the server uses to request a relaunch (Advanced settings →
// "restart engine to apply"). Keep in sync with RESTART_EXIT_CODE in config.ts.
const RESTART_EXIT_CODE = 88;

function startServer() {
  const { serverEntry, webDist } = resolvePaths();
  const userEnv = loadUserEnv();
  const dbPath = path.join(app.getPath("userData"), "skynet-data.json");

  const env = {
    ...process.env,
    ...userEnv,
    // A Finder-launched GUI app inherits only a bare PATH (/usr/bin:/bin:…), so
    // Homebrew CLIs — git at /opt/homebrew/bin, the runner's `claude`/`cursor`,
    // etc. — are invisible and spawns die with `spawn <cmd> ENOENT`. Prepend the
    // common install dirs so every child process (server + runner subprocesses)
    // can find them. Deduped, existing PATH kept last so nothing is shadowed.
    PATH: enrichPath(process.env.PATH),
    ELECTRON_RUN_AS_NODE: "1", // run the Electron binary as plain Node
    // Mark this as the desktop-managed engine + point the server at the same
    // overrides file we read above, so the in-app Advanced settings panel can
    // stage env changes and ask us to relaunch with them applied.
    SKYNET_DESKTOP: "1",
    SKYNET_ENV_FILE: path.join(app.getPath("userData"), "skynet.env"),
    // The local app has no login UI, so run in dev-auth mode (open + dev tokens).
    // In production the server requires real sessions and rejects the dev token.
    NODE_ENV: "development",
    STORE: "file", // zero-dependency JSON persistence
    // Single-process desktop: explicit backends (the server requires these).
    BUS: userEnv.BUS || "memory",
    SESSIONS: userEnv.SESSIONS || "memory",
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
    if (app.isQuitting) return;
    // Requested relaunch (Advanced settings → apply): re-spawn with fresh env
    // (loadUserEnv re-reads skynet.env), don't treat it as a crash. The window
    // stays open and reconnects once the new server is up.
    if (code === RESTART_EXIT_CODE) {
      startServer();
      return;
    }
    // Exit code 42 is an INTENTIONAL remote shutdown (the Telegram /quit kill
    // switch calls process.exit(42) in the server). Treat it as a clean quit —
    // no scary "exited unexpectedly" dialog, which is only for genuine crashes.
    if (code === 42) {
      app.isQuitting = true;
      app.quit();
      return;
    }
    dialog.showErrorBox(
      "Skynet server stopped",
      `The local Skynet server exited unexpectedly (code ${code ?? signal}). The app will close.`,
    );
    app.quit();
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

  // A deep link captured before this window existed (macOS open-url that fired
  // pre-whenReady, or a Windows/Linux cold launch's own process.argv) rides
  // straight into the initial load — simplest + no flash-then-hashchange, and
  // the app's own initial-view logic (parseHash() || initialView()) already
  // handles a hash present in the URL bar on first paint.
  const base = DEV ? DEV_URL : `http://${HOST}:${PORT}/`;
  const hash = pendingDeepLink;
  pendingDeepLink = null;
  win.loadURL(hash ? `${base}${hash}` : base);
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
  app.on("second-instance", (_event, argv) => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
    // Windows/Linux warm launch: the OS-launched second process's argv (the one
    // that just lost the single-instance lock) carries the skynet:// URL, if
    // this launch came from the protocol handler rather than a plain re-open.
    const arg = findSkynetUrlArg(argv);
    if (arg) routeToHash(skynetUrlToHash(arg));
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
