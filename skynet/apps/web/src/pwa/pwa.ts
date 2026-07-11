// ─── PWA runtime ────────────────────────────────────────────────────────────
// Registers the service worker (production only), drives an Inbox-first install
// prompt, bridges service-worker messages into the app, and exposes a push /
// notification entry-point that lands the operator in the Inbox.
//
// All UI here is vanilla DOM with self-injected styles so it stays out of the
// React component tree (and out of styles.css) — collision-free with other
// streams. main.tsx calls setupPwa() once on boot.

import { alertsOn, setAlerts } from "../lib/alerts";

const NAV_EVENT = "skynet:navigate";
const INSTALL_STATE_EVENT = "skynet:installstate";

let deferredPrompt: (Event & { prompt: () => void; userChoice: Promise<{ outcome: string }> }) | null =
  null;
let installed = false;

function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  return (
    window.matchMedia?.("(display-mode: standalone)").matches === true ||
    window.matchMedia?.("(display-mode: minimal-ui)").matches === true ||
    (window.navigator as unknown as { standalone?: boolean }).standalone === true
  );
}

function emitInstallState() {
  window.dispatchEvent(new CustomEvent(INSTALL_STATE_EVENT));
}

/** Current installability — drives the persistent Install button in Settings. */
export function installState(): { available: boolean; installed: boolean } {
  return { available: deferredPrompt != null, installed: installed || isStandalone() };
}

/** Trigger the native install prompt. 'unavailable' when the browser hasn't
 *  offered one (already installed, or e.g. iOS Safari — use Add to Home Screen). */
export async function promptInstall(): Promise<"accepted" | "dismissed" | "unavailable"> {
  if (!deferredPrompt) return "unavailable";
  deferredPrompt.prompt();
  const choice = await deferredPrompt.userChoice.catch(() => ({ outcome: "dismissed" as const }));
  deferredPrompt = null;
  emitInstallState();
  return choice.outcome === "accepted" ? "accepted" : "dismissed";
}

/** Subscribe to install-availability changes (React re-renders the button). */
export function onInstallStateChange(cb: () => void): () => void {
  window.addEventListener(INSTALL_STATE_EVENT, cb);
  return () => window.removeEventListener(INSTALL_STATE_EVENT, cb);
}

function dispatchNavigate(view: string, runId: string | null) {
  window.dispatchEvent(new CustomEvent(NAV_EVENT, { detail: { view, runId } }));
}

// ─── Service worker registration ────────────────────────────────────────────

async function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  try {
    await navigator.serviceWorker.register("/sw.js", { scope: "/" });
  } catch (err) {
    console.warn("[pwa] service worker registration failed", err);
    return;
  }
  // Relay SW → app navigation (push / notification click) as a window event.
  navigator.serviceWorker.addEventListener("message", (event) => {
    const data = event.data as { type?: string; view?: string; runId?: string | null };
    if (data?.type === NAV_EVENT && data.view) dispatchNavigate(data.view, data.runId ?? null);
  });
}

// ─── Inbox alerts (push entry-point) ────────────────────────────────────────

/** Request notification permission. Returns true once granted. */
export async function enableInboxAlerts(): Promise<boolean> {
  if (!("Notification" in window)) return false;
  let perm = Notification.permission;
  if (perm === "default") perm = await Notification.requestPermission();
  return perm === "granted";
}

/**
 * Surface an Inbox notification. Routed through the service worker so its
 * `notificationclick` handler deep-links back into the Inbox — the same path a
 * server-sent Web Push takes. Falls back to a plain Notification if no SW.
 */
export async function notifyInbox(
  title = "Skynet — needs you",
  body = "An agent is blocked and waiting on a decision.",
  runId: string | null = null,
): Promise<void> {
  // Respect the app-level switch first (the real mute), then the OS permission.
  // Never auto-prompt here — permission is requested only when alerts are turned on.
  if (!alertsOn()) return;
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  const payload = {
    body,
    icon: "/icon.svg",
    badge: "/icon.svg",
    tag: "skynet-inbox",
    data: { url: "/?view=queue&source=push", view: "queue", runId },
  };
  const reg = "serviceWorker" in navigator ? await navigator.serviceWorker.ready : null;
  if (reg) await reg.showNotification(title, payload);
  else new Notification(title, payload);
}

// ─── Install banner (Inbox-first) ───────────────────────────────────────────

const STYLE = `
.pwa-install {
  position: fixed; left: 50%; transform: translateX(-50%);
  bottom: calc(40px + env(safe-area-inset-bottom, 0px));
  z-index: 200; max-width: min(460px, calc(100vw - 24px));
  display: flex; gap: 12px; align-items: center;
  padding: 12px 14px; border-radius: 12px;
  background: #11141A; color: #E9ECF2;
  border: 1px solid #232936; box-shadow: 0 12px 40px rgba(0,0,0,0.5);
  font-family: 'Space Grotesk', system-ui, sans-serif; font-size: 13px;
  animation: pwa-rise 0.25s ease both;
}
@keyframes pwa-rise { from { opacity: 0; transform: translate(-50%, 8px); } to { opacity: 1; transform: translate(-50%, 0); } }
.pwa-install .pwa-glyph { width: 30px; height: 30px; flex: none; }
.pwa-install .pwa-copy { line-height: 1.3; min-width: 0; }
.pwa-install .pwa-copy b { display: block; font-weight: 600; }
.pwa-install .pwa-copy span { color: #8B93A5; font-size: 12px; }
.pwa-install .pwa-actions { margin-left: auto; display: flex; gap: 8px; align-items: center; flex: none; }
.pwa-install button { font-family: inherit; font-size: 12px; cursor: pointer; border-radius: 7px; padding: 7px 12px; border: 1px solid #232936; background: #171B23; color: #E9ECF2; white-space: nowrap; }
.pwa-install button.primary { background: #FFB224; color: #0B0D11; border-color: #FFB224; font-weight: 600; }
.pwa-install button.icon { padding: 6px 9px; color: #8B93A5; }
@media (max-width: 520px) { .pwa-install { flex-wrap: wrap; } .pwa-install .pwa-actions { width: 100%; } }
`;

function injectStyleOnce() {
  if (document.getElementById("pwa-install-style")) return;
  const el = document.createElement("style");
  el.id = "pwa-install-style";
  el.textContent = STYLE;
  document.head.appendChild(el);
}

const DISMISS_KEY = "skynet.pwa.install.dismissed";

function showInstallBanner() {
  if (localStorage.getItem(DISMISS_KEY) === "1") return;
  if (document.querySelector(".pwa-install")) return;
  injectStyleOnce();

  const banner = document.createElement("div");
  banner.className = "pwa-install";
  banner.setAttribute("role", "dialog");
  banner.setAttribute("aria-label", "Install Skynet");
  banner.innerHTML = `
    <img class="pwa-glyph" src="/icon.svg" alt="" />
    <div class="pwa-copy">
      <b>Install Skynet</b>
      <span>Triage your Inbox from the home screen — opens straight to what needs you.</span>
    </div>
    <div class="pwa-actions">
      <button class="pwa-alerts" type="button">Enable alerts</button>
      <button class="primary pwa-go" type="button">Install</button>
      <button class="icon pwa-x" type="button" aria-label="Dismiss">✕</button>
    </div>`;

  banner.querySelector(".pwa-go")?.addEventListener("click", async () => {
    if (!deferredPrompt) return;
    deferredPrompt.prompt();
    await deferredPrompt.userChoice.catch(() => undefined);
    deferredPrompt = null;
    banner.remove();
  });
  banner.querySelector(".pwa-alerts")?.addEventListener("click", async () => {
    const ok = await enableInboxAlerts();
    setAlerts(ok); // turning on the app-level switch is what actually enables alerts
    if (ok) await notifyInbox("Inbox alerts on", "We'll ping you here when an agent needs a decision.");
  });
  banner.querySelector(".pwa-x")?.addEventListener("click", () => {
    localStorage.setItem(DISMISS_KEY, "1");
    banner.remove();
  });

  document.body.appendChild(banner);
}

// ─── Entry point ────────────────────────────────────────────────────────────

export function setupPwa() {
  if (typeof window === "undefined") return;

  // Only intercept in production builds; the Vite dev server stays untouched.
  // (Narrow local typing for import.meta.env — Vite still inlines this at build.)
  const isProd = (import.meta as unknown as { env?: { PROD?: boolean } }).env?.PROD === true;
  if (isProd) void registerServiceWorker();

  // Capture the install opportunity and surface the Inbox-first banner.
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferredPrompt = e as typeof deferredPrompt;
    emitInstallState();
    showInstallBanner();
  });
  window.addEventListener("appinstalled", () => {
    installed = true;
    deferredPrompt = null;
    emitInstallState();
    document.querySelector(".pwa-install")?.remove();
  });

  // Expose the push entry-point for manual triggering / backend integration.
  (window as unknown as Record<string, unknown>).skynet = { notifyInbox, enableInboxAlerts };
}
