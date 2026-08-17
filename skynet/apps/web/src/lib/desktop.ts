// ─── Electron desktop bridge (renderer side) ────────────────────────────────
// The desktop shell (apps/desktop/main.cjs) exposes a couple of main-process-only
// capabilities — the dock badge and window focus/restore — via a preload script
// (apps/desktop/preload.cjs) that puts `window.skynetDesktop` on the page.
// Outside Electron (plain browser, PWA) that global is undefined, so every call
// here is a no-op — this module is safe to import unconditionally.

declare global {
  interface Window {
    skynetDesktop?: {
      setBadgeCount: (n: number) => void;
      focusWindow: () => void;
    };
  }
}

/** Set the dock/taskbar badge to the current pending-HITL count (0 clears it). */
export function setDesktopBadge(count: number): void {
  window.skynetDesktop?.setBadgeCount(Math.max(0, count));
}

/** Bring the app window to the front — called when a notification click lands. */
export function focusDesktopWindow(): void {
  window.skynetDesktop?.focusWindow();
}
