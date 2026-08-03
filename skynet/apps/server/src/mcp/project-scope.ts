// ─── MCP project scoping ──────────────────────────────────────────────────
// A service token can be confined to a subset of a workspace's projects
// (Principal.projectIds). This module enforces that confinement at the MCP tool
// boundary, in BOTH directions:
//
//  • Writes  — every mutation is gated. We resolve the project the call targets
//    from its arguments (projectId directly, or via the run / task / feature /
//    hitl id it names) and refuse it unless that project is in the allowlist.
//    A mutation we cannot attribute to an allowed project (create_project,
//    fleet-runner config) is refused outright — fail closed.
//
//  • Reads   — every workspace-wide listing is filtered down to the allowed
//    projects before it leaves the server, so a scoped token never even sees
//    another project's runs, tasks, roadmap, or HITL queue.
//
// An UNrestricted principal (projectIds undefined — humans, workspace-wide
// tokens) bypasses all of this: `restricted` is false and the tool layer skips
// every check, preserving today's behavior exactly.

import type { Snapshot } from "@skynet/shared";
import { allowsProject, type Principal } from "../auth.js";
import type { Operations } from "../operations.js";

/** Well-known id argument keys, in the priority we resolve a target project. */
const PROJECT_ID_KEYS = ["projectId", "runId", "taskId", "featureId", "hitlId"] as const;

export interface ProjectScope {
  /** True when this principal is confined to a project allowlist. */
  readonly restricted: boolean;
  /** Gate a mutation by its arguments. Resolves the target project and returns
   *  an error message if it's out of scope (or can't be attributed); null = ok. */
  gate(args: Record<string, unknown>): Promise<string | null>;
  /** Filter a full snapshot down to the allowed projects (in place is avoided —
   *  returns a new object). No-op when unrestricted. */
  filterSnapshot(snap: Snapshot): Promise<Snapshot>;
  /** Filter any list of project-bearing records (runs, tasks, features, …). */
  filterByProjectId<T extends { projectId: string }>(rows: T[]): T[];
  /** Filter a list of projects by their own id. */
  filterProjects<T extends { id: string }>(rows: T[]): T[];
  /** Filter runId-bearing records (HITL items, audit) via their owning run. */
  filterByRun<T extends { runId: string }>(rows: T[]): Promise<T[]>;
}

/** Build the project-scope enforcer for one principal + operations surface. */
export function projectScope(principal: Principal, operations: Operations, ws: string): ProjectScope {
  const restricted = principal.projectIds !== undefined;
  const allows = (projectId: string | undefined): boolean =>
    projectId !== undefined && allowsProject(principal, projectId);

  // Resolve runId → projectId, memoized per call-site burst via a lazy run map
  // (HITL/audit filtering touches many rows that share few runs).
  let runMap: Map<string, string> | undefined;
  const runsById = async (): Promise<Map<string, string>> => {
    if (!runMap) {
      const runs = await operations.listRuns(ws);
      runMap = new Map(runs.map((r) => [r.id, r.projectId]));
    }
    return runMap;
  };

  // Resolve the project a single well-known id belongs to. Everything is
  // workspace-scoped, so an id from another workspace resolves to undefined and
  // is therefore denied.
  const projectOf = async (key: (typeof PROJECT_ID_KEYS)[number], id: string): Promise<string | undefined> => {
    switch (key) {
      case "projectId":
        return id;
      case "runId":
        return (await runsById()).get(id);
      case "taskId":
        return (await operations.listTasks(ws)).find((t) => t.id === id)?.projectId;
      case "featureId":
        return (await operations.listFeatures(ws)).find((f) => f.id === id)?.projectId;
      case "hitlId": {
        const item = (await operations.listHitl(ws)).find((h) => h.id === id);
        return item ? (await runsById()).get(item.runId) : undefined;
      }
    }
  };

  return {
    restricted,

    async gate(args) {
      if (!restricted) return null;
      for (const key of PROJECT_ID_KEYS) {
        const raw = args[key];
        if (typeof raw !== "string") continue;
        const projectId = await projectOf(key, raw);
        if (projectId === undefined) {
          // The named record doesn't exist in this workspace — don't leak whether
          // it exists elsewhere; treat as out of scope.
          return `Forbidden: this token is scoped to specific projects and "${raw}" is not among them.`;
        }
        return allows(projectId)
          ? null
          : `Forbidden: this token is not scoped to project "${projectId}".`;
      }
      // No project-bearing argument at all → a workspace-level mutation
      // (create_project, runner config) a project-scoped token may not perform.
      return "Forbidden: this token is scoped to specific projects and cannot perform workspace-level actions.";
    },

    filterByProjectId(rows) {
      return restricted ? rows.filter((r) => allows(r.projectId)) : rows;
    },

    filterProjects(rows) {
      return restricted ? rows.filter((r) => allows(r.id)) : rows;
    },

    async filterByRun(rows) {
      if (!restricted) return rows;
      const map = await runsById();
      return rows.filter((r) => allows(map.get(r.runId)));
    },

    async filterSnapshot(snap) {
      if (!restricted) return snap;
      const map = await runsById();
      const runAllowed = (runId: string) => allows(map.get(runId));
      // Filter every project-attributable collection. Fleet runners, providers,
      // modules, and deps are workspace-level infrastructure (no project), so
      // they pass through — the per-project WORK (runs/tasks/roadmap/HITL) is
      // what gets confined.
      return {
        ...snap,
        projects: snap.projects.filter((p) => allows(p.id)),
        runs: snap.runs.filter((r) => allows(r.projectId)),
        tasks: snap.tasks.filter((t) => allows(t.projectId)),
        features: snap.features.filter((f) => allows(f.projectId)),
        milestones: snap.milestones.filter((m) => allows(m.projectId)),
        queue: snap.queue.filter((h) => runAllowed(h.runId)),
      };
    },
  };
}
