import type { ViewName } from "../App";

// ─── Internal surfaces ──────────────────────────────────────────────────────
// Some pages exist for US, not for the people we ship to: QA & Testing
// (Acceptance, Simulation) and the Roadmap. They must be reachable wherever we
// operate Skynet — a `vite dev` server AND our own deployed instance, which is
// where the fleet actually runs and therefore the only place these surfaces are
// worth anything — but hidden from RELEASE builds we hand to someone else.
//
// The distinction that matters is "release", NOT "production". Those aren't the
// same thing, and conflating them was the original bug: this used to key off
// `import.meta.env.DEV`, which is false for ANY `vite build` — so our own
// deployment was treated exactly like a shipped app and lost these tools. (The
// Roadmap needed a hand-written exemption to work around precisely that.)
//
// So: internal surfaces are ON everywhere by default and turned OFF explicitly
// when building a release. Defaulting the other way is what created the
// problem — a build that forgets the flag then silently hides our own tooling,
// which is annoying, rather than silently shipping it, which is embarrassing.
// Both failure modes are cheap here; this one is cheaper to notice.

/**
 * True only in a build produced for distribution (the packaged desktop app).
 * Set by `VITE_SKYNET_RELEASE=1` at build time — see `apps/web` build:release
 * and the desktop `dist`/`publish` scripts.
 */
export function isReleaseBuild(): boolean {
  return (import.meta as unknown as { env?: { VITE_SKYNET_RELEASE?: string } }).env?.VITE_SKYNET_RELEASE === "1";
}

/**
 * Should internal surfaces be shown? Everywhere except a release build.
 * `localStorage.skynet.devtools = "1"` forces them on for debugging a release;
 * `= "0"` forces them off, which is how you preview what a release will look
 * like without producing one.
 */
export function devToolsEnabled(): boolean {
  const optIn =
    typeof localStorage !== "undefined" ? localStorage.getItem("skynet.devtools") : null;
  if (optIn === "1") return true;
  if (optIn === "0") return false;
  return !isReleaseBuild();
}

/** Views hidden from release builds (nav item AND reachable page). */
// Hiding the nav item alone isn't a gate: a deep link, a stale hash, or a
// PWA/notification nav would still render the page in a shipped build. These
// are listed here so gateView() coerces them to "home" as well.
export const DEV_ONLY_VIEWS: ReadonlySet<ViewName> = new Set<ViewName>([
  "acceptance",
  "simulation",
]);

/** Coerce a dev-only view to "home" when internal tooling is off — so a release
 *  build can't reach it via a deep link, a stale hash, or a PWA/notification nav. */
export function gateView(v: ViewName): ViewName {
  return DEV_ONLY_VIEWS.has(v) && !devToolsEnabled() ? "home" : v;
}
