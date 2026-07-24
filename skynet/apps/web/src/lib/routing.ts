// ─── Routing / deep links (W7) ────────────────────────────────────────────
// Maps the in-memory router state (view / lens / projectId / runId) to a URL
// hash so views, projects, and runs are shareable and back/forward works.
// Hash form: #/home/<lens> · #/queue · #/audit · #/projects · #/fleet ·
//            #/project/<id> · #/agent/<id>

import type { Lens, ViewName } from "../App";

export interface RoutePatch {
  view?: ViewName;
  lens?: Lens;
  projectId?: string | null;
  runId?: string | null;
}

const LENSES: Lens[] = ["subway", "timeline", "ledger", "roster"];

/** Parse the current hash into a partial router state, or null if empty/unknown. */
export function parseHash(): RoutePatch | null {
  const raw = location.hash.replace(/^#\/?/, "");
  if (!raw) return null;
  const [seg, arg = ""] = raw.split("/");
  switch (seg) {
    case "home":
      return { view: "home", lens: (LENSES as string[]).includes(arg) ? (arg as Lens) : "subway" };
    case "queue":
    case "audit":
    case "projects":
    case "fleet":
    case "integrations":
    case "settings":
    case "acceptance":
    case "simulation":
      return { view: seg };
    case "project":
      return arg ? { view: "project", projectId: arg } : { view: "projects" };
    case "task":
      return arg ? { view: "task", runId: arg } : { view: "home" };
    default:
      return null;
  }
}

/** Serialize router state to a hash. */
export function toHash(r: { view: ViewName; lens: Lens; projectId: string | null; runId: string | null }): string {
  switch (r.view) {
    case "home":
      return `#/home/${r.lens}`;
    case "project":
      return r.projectId ? `#/project/${r.projectId}` : "#/projects";
    case "task":
      return r.runId ? `#/agent/${r.runId}` : "#/home";
    default:
      return `#/${r.view}`;
  }
}
