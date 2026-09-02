// ─── Routing / deep links (W7) ────────────────────────────────────────────
// Maps the in-memory router state (view / projectId / runId) to a URL hash so
// views, projects, and runs are shareable and back/forward works.
// Hash form: #/home · #/queue · #/audit · #/projects · #/fleet ·
//            #/fleet/<agentId> · #/project/<id> · #/agent/<runId>

import type { ViewName } from "../App";

export interface RoutePatch {
  view?: ViewName;
  projectId?: string | null;
  runId?: string | null;
  agentId?: string | null;
  // TASK 21 — set only by a `#/project/<id>/autonomy` deep link (a breaker-
  // event source chip): the project view reads this once on mount to
  // pre-open TASK 19's autonomy dial modal, then it's consumed (not part of
  // toHash's own round trip — the dial's own open/close state takes over
  // from there, same as any other in-page modal).
  autonomyOpen?: boolean;
}

/** Parse the current hash into a partial router state, or null if empty/unknown.
 *  A `#/home/<anything>` deep link from before Home was a single view still
 *  resolves to plain Home rather than 404ing. */
export function parseHash(): RoutePatch | null {
  const raw = location.hash.replace(/^#\/?/, "");
  if (!raw) return null;
  const [seg, arg = "", sub = ""] = raw.split("/");
  switch (seg) {
    case "home":
      return { view: "home" };
    case "queue":
    case "audit":
    case "projects":
    case "integrations":
    case "roadmap":
    case "settings":
    case "acceptance":
    case "simulation":
      return { view: seg };
    case "design-tokens":
      return { view: "designTokens" };
    case "roadmap-rollup":
      return { view: "workspaceRoadmap" };
    case "fleet":
      return arg ? { view: "agentDetail", agentId: arg } : { view: "fleet" };
    case "project":
      // `/autonomy` — a breaker-event source chip (TASK 19's dial has no
      // route of its own since it's a modal, not a page); see breakerPanelHref.
      return arg
        ? { view: "project", projectId: arg, ...(sub === "autonomy" ? { autonomyOpen: true } : {}) }
        : { view: "projects" };
    // `agent` is the canonical run route (matches toHash + this file's header
    // doc); `task` stays an accepted alias so any older links still resolve.
    case "agent":
    case "task":
      return arg ? { view: "task", runId: arg } : { view: "home" };
    default:
      return null;
  }
}

// TASK 21 — one-off hash builders for a specific entity, reused by Steward's
// source-chip resolver (source-chips.ts) so a chip's href is built through
// the SAME route strings as the real router, never a hand-rolled duplicate.
export const runHref = (runId: string): string => `#/agent/${runId}`;
export const projectHref = (projectId: string): string => `#/project/${projectId}`;
/** The project view with its Governance menu's autonomy dial pre-opened —
 *  the breaker-event source chip's target (TASK 19's dial has no route of
 *  its own since it's a modal, not a page; parseHash below recognizes the
 *  trailing `/autonomy` segment and flags it via RoutePatch.autonomyOpen). */
export const breakerPanelHref = (projectId: string): string => `#/project/${projectId}/autonomy`;

/** Serialize router state to a hash. */
export function toHash(r: {
  view: ViewName;
  projectId: string | null;
  runId: string | null;
  agentId: string | null;
}): string {
  switch (r.view) {
    case "agentDetail":
      return r.agentId ? `#/fleet/${r.agentId}` : "#/fleet";
    case "project":
      return r.projectId ? `#/project/${r.projectId}` : "#/projects";
    case "task":
      return r.runId ? `#/agent/${r.runId}` : "#/home";
    case "designTokens":
      return "#/design-tokens";
    case "workspaceRoadmap":
      return "#/roadmap-rollup";
    default:
      return `#/${r.view}`;
  }
}
