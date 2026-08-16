// ─── Desktop bridge (renderer-exposed) ──────────────────────────────────────
// Two main-process-only capabilities the web app can't reach on its own: the
// dock/taskbar badge and restoring/focusing the window (e.g. after a clicked
// OS notification). contextIsolation is on, so this is the one sanctioned way
// in — a narrow, typed surface via contextBridge, not full Node/ipcRenderer
// access. See apps/web/src/lib/desktop.ts for the renderer-side consumer.

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("skynetDesktop", {
  setBadgeCount: (n) => ipcRenderer.send("skynet:badge", n),
  focusWindow: () => ipcRenderer.send("skynet:focus"),
});
