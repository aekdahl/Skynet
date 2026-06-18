// ─── PWA launch routing ─────────────────────────────────────────────────────
// Decides which view the app opens on, and lets the app subscribe to "navigate"
// requests that arrive from outside React — a push/notification click (relayed
// by the service worker via postMessage) or a manifest shortcut / deep link.
//
// Dependency-free on purpose so App.tsx can import it without pulling in the
// service-worker runtime (src/pwa/pwa.ts). The type is mirrored, not imported,
// to avoid a cycle with App.tsx.

export type PwaView = "home" | "queue" | "projects" | "fleet";

const KNOWN: PwaView[] = ["home", "queue", "projects", "fleet"];

function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  return (
    window.matchMedia?.("(display-mode: standalone)").matches === true ||
    window.matchMedia?.("(display-mode: minimal-ui)").matches === true ||
    // iOS Safari (non-standard).
    (window.navigator as unknown as { standalone?: boolean }).standalone === true
  );
}

/**
 * The view to open on load.
 * - An explicit `?view=` (manifest shortcut, notification deep-link) always wins.
 * - Installed/standalone launches are Inbox-first: the operator opens straight
 *   into what needs them.
 * - A normal browser tab keeps the default Home.
 */
export function initialView(): PwaView | null {
  if (typeof window === "undefined") return null;
  const requested = new URLSearchParams(window.location.search).get("view");
  if (requested && (KNOWN as string[]).includes(requested)) return requested as PwaView;
  if (isStandalone()) return "queue";
  return null;
}

/**
 * Subscribe to navigation requests relayed from the service worker (push /
 * notification click). Returns an unsubscribe function. The `pwa.ts` runtime
 * re-dispatches SW `postMessage`s as a `skynet:navigate` CustomEvent so the
 * subscription has no direct service-worker dependency.
 */
export function onNavigate(cb: (view: PwaView, agentId: string | null) => void): () => void {
  if (typeof window === "undefined") return () => {};
  const handler = (e: Event) => {
    const detail = (e as CustomEvent).detail as { view?: string; agentId?: string | null };
    const view = detail?.view;
    if (view && (KNOWN as string[]).includes(view)) cb(view as PwaView, detail.agentId ?? null);
  };
  window.addEventListener("skynet:navigate", handler);
  return () => window.removeEventListener("skynet:navigate", handler);
}
