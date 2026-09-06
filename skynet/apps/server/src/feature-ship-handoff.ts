// ─── Agent-to-agent handoff on feature completion (v2) ──────────────────────
// The join-point ROADMAP.md calls out as already existing: `feature.upserted`
// and `milestone.upserted` bus events already fire on every write, including
// the one that flips `status` to "shipped". This subscriber watches for that
// SPECIFIC transition (not just any upsert of an already-shipped item — a
// project's Overview re-rendering, an unrelated field edit, etc. must not
// re-fire the fan-out) and, for each role a project has configured
// (`Project.roleAgents`), asks the Orchestrator to draft that role's artifact.
//
// Mirrors task-sync.ts's own shape almost exactly: one bus subscription per
// workspace, a `Map<id, prevStatus>` to detect a real transition, and
// best-effort dispatch (a failure is logged, never blocks the write that
// triggered it — this runs well after the write already committed).

import { DEFAULT_WORKSPACE, type Feature, type FeatureStatus, type Milestone, type MilestoneStatus, type HandoffRole } from "@skynet/shared";
import type { Bus } from "./bus.js";
import type { Store } from "./store/store.js";
import type { Orchestrator } from "./orchestrator.js";

export interface FeatureShipHandoffDeps {
  store: Store;
  orchestrator: Orchestrator;
  log?: (msg: string) => void;
}

const ROLE_KEYS: { role: HandoffRole; agentKey: "changeManager" | "docsWriter" | "releaseComms" }[] = [
  { role: "change-manager", agentKey: "changeManager" },
  { role: "docs-writer", agentKey: "docsWriter" },
  { role: "release-comms", agentKey: "releaseComms" },
];

/** Subscribe to feature/milestone ship transitions and fan out configured
 *  role-agents. Returns an unsubscribe fn. Single-tenant: watches the default
 *  workspace's channel, same as startTaskSourceSync. */
export function startFeatureShipHandoff(bus: Bus, deps: FeatureShipHandoffDeps): () => void {
  const lastStatus = new Map<string, FeatureStatus | MilestoneStatus>();
  return bus.subscribe(DEFAULT_WORKSPACE, (ev) => {
    if (ev.type !== "feature.upserted" && ev.type !== "milestone.upserted") return;
    const sourceKind = ev.type === "feature.upserted" ? "feature" : "milestone";
    const source = ev.type === "feature.upserted" ? ev.feature : ev.milestone;
    const prev = lastStatus.get(source.id);
    lastStatus.set(source.id, source.status);
    // Only act on a real transition INTO shipped — first sighting just seeds
    // (so a server restart doesn't replay history as a wave of transitions),
    // and re-upserting an already-shipped item (e.g. an unrelated edit) is a
    // no-op here.
    if (prev === undefined || prev === source.status || source.status !== "shipped") return;
    void dispatchAll(sourceKind, source, deps).catch((e) =>
      deps.log?.(`[feature-ship-handoff] ${sourceKind} ${source.id} failed: ${(e as Error).message}`),
    );
  });
}

async function dispatchAll(sourceKind: "feature" | "milestone", source: Feature | Milestone, deps: FeatureShipHandoffDeps): Promise<void> {
  const project = await deps.store.getProject(source.projectId);
  if (!project || project.workspaceId !== source.workspaceId) return;
  for (const { role, agentKey } of ROLE_KEYS) {
    const agentId = project.roleAgents[agentKey];
    if (!agentId) continue; // role not configured for this project — opt-in, all off by default
    await deps.orchestrator
      .dispatchFeatureHandoff(source.workspaceId, project, sourceKind, source.id, source.name, source.description, role, agentId)
      .catch((e) => deps.log?.(`[feature-ship-handoff] ${sourceKind} ${source.id} role ${role} failed: ${(e as Error).message}`));
  }
}
