import type { ViewName } from "../App";

// ─── Dev-only surfaces ──────────────────────────────────────────────────────
// Some pages exist for us, not operators (the Roadmap, and future internal
// tools). They show under a `vite dev` server but are hidden from RELEASE builds
// — the packaged desktop app serves the production SPA (`import.meta.env.DEV`
// false). An escape hatch (`localStorage.skynet.devtools = "1"`) re-enables them
// on any build for debugging.
//
// To make a new page dev-only: add its ViewName to DEV_ONLY_VIEWS and guard its
// nav item with `devToolsEnabled()`. The router (App.gateView) then hides the
// page in releases even via a deep link, and the nav item disappears.

export function devToolsEnabled(): boolean {
  const dev = (import.meta as unknown as { env?: { DEV?: boolean } }).env?.DEV === true;
  const optIn =
    typeof localStorage !== "undefined" && localStorage.getItem("skynet.devtools") === "1";
  return dev || optIn;
}

/** Views hidden from release builds (nav item + reachable page). */
export const DEV_ONLY_VIEWS: ReadonlySet<ViewName> = new Set<ViewName>(["roadmap"]);

/** Coerce a dev-only view to "home" when dev tooling is off — so a release build
 *  can't reach it via a deep link, a stale hash, or a PWA/notification nav. */
export function gateView(v: ViewName): ViewName {
  return DEV_ONLY_VIEWS.has(v) && !devToolsEnabled() ? "home" : v;
}
