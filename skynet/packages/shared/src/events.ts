// ─── Real-time event stream ───────────────────────────────────────────────
// The server pushes a Snapshot on connect, then ServerEvent deltas. The UI's
// collections are designed to be replaced wholesale on connect and patched
// per-event after. (Backend Brief §07, Architecture Brief §06.)

import { z } from "zod";
import {
  TaskRun,
  TaskRunStatus,
  ApprovalLevel,
  Dependency,
  Feature,
  HitlItem,
  Milestone,
  Module,
  PlanStep,
  Project,
  ProviderInfo,
  Resolution,
  Agent,
  Task,
  Timestamp,
  Usage,
} from "./contracts.js";

// ─── Connect-time snapshot ────────────────────────────────────────────────

export const Snapshot = z.object({
  runs: z.array(TaskRun),
  queue: z.array(HitlItem), // open + recently-resolved HITL items
  projects: z.array(Project),
  tasks: z.array(Task),
  features: z.array(Feature).default([]),
  milestones: z.array(Milestone).default([]),
  fleet: z.array(Agent),
  modules: z.array(Module),
  deps: z.array(Dependency),
  providers: z.array(ProviderInfo),
  serverTime: Timestamp, // lets clients correct for clock skew when ticking
  // The server's default approval level (SKYNET_APPROVAL_LEVEL), so the
  // create-project form can pre-select what a new project would otherwise get.
  // Optional for forward-compat with older servers that don't send it.
  defaultApprovalLevel: ApprovalLevel.optional(),
});
export type Snapshot = z.infer<typeof Snapshot>;

// ─── Server → client deltas ───────────────────────────────────────────────

export const ServerEvent = z.discriminatedUnion("type", [
  // task-run lifecycle
  z.object({ type: z.literal("run.started"), run: TaskRun }),
  z.object({ type: z.literal("run.log"), runId: z.string(), at: Timestamp, line: z.string(), detail: z.string().optional() }),
  z.object({
    type: z.literal("run.progress"),
    runId: z.string(),
    progress: z.number().min(0).max(1),
    plan: z.array(PlanStep),
  }),
  z.object({ type: z.literal("run.heartbeat"), runId: z.string(), at: Timestamp }),
  z.object({ type: z.literal("run.usage"), runId: z.string(), usage: Usage }),
  z.object({ type: z.literal("run.status"), runId: z.string(), status: TaskRunStatus }),
  z.object({ type: z.literal("run.completed"), runId: z.string(), branch: z.string() }),
  z.object({ type: z.literal("run.archived"), runId: z.string(), archived: z.boolean() }),

  // HITL round-trip
  z.object({ type: z.literal("hitl.raised"), item: HitlItem }),
  z.object({ type: z.literal("hitl.resolved"), id: z.string(), resolution: Resolution }),

  // derived intelligence
  z.object({ type: z.literal("conflict.detected"), moduleId: z.string(), runIds: z.array(z.string()) }),

  // collection CRUD deltas — keep every operator's view consistent
  z.object({ type: z.literal("project.upserted"), project: Project }),
  z.object({ type: z.literal("project.deleted"), id: z.string() }),
  z.object({ type: z.literal("task.upserted"), task: Task }),
  z.object({ type: z.literal("task.deleted"), id: z.string() }),
  z.object({ type: z.literal("feature.upserted"), feature: Feature }),
  z.object({ type: z.literal("feature.deleted"), id: z.string() }),
  z.object({ type: z.literal("milestone.upserted"), milestone: Milestone }),
  z.object({ type: z.literal("milestone.deleted"), id: z.string() }),
  z.object({ type: z.literal("agent.upserted"), agent: Agent }),
  z.object({ type: z.literal("agent.deleted"), id: z.string() }),

  // audit trail mutations — the decision audit isn't part of the snapshot, so
  // these carry no payload beyond identity; clients re-fetch /api/audit on them.
  z.object({ type: z.literal("audit.archived"), hitlId: z.string(), archived: z.boolean() }),
  z.object({ type: z.literal("audit.deleted"), hitlId: z.string() }),
  z.object({ type: z.literal("audit.archived-all") }),
  z.object({ type: z.literal("audit.cleared") }),
]);
export type ServerEvent = z.infer<typeof ServerEvent>;

export type ServerEventType = ServerEvent["type"];

/** Everything the server can push down a socket. */
export const WsMessage = z.union([
  z.object({ type: z.literal("snapshot"), state: Snapshot }),
  ServerEvent,
]);
export type WsMessage = z.infer<typeof WsMessage>;
