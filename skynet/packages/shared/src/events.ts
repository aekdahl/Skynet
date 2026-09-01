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
  GithubSignalKind,
  GithubSignalPayload,
  HitlItem,
  Milestone,
  Module,
  PlanStep,
  Project,
  ProjectContextEntry,
  ProviderInfo,
  Resolution,
  Agent,
  SolutionBrief,
  Task,
  Timestamp,
  Usage,
  WorkspaceSettings,
} from "./contracts.js";
import { Proposal, Rule, Transition } from "./kanban.js";

// ─── Connect-time snapshot ────────────────────────────────────────────────

// "idle runners + deep backlog → spin up more?" (roadmap v1.5) — a light,
// non-naggy hint derived server-side (see apps/server/src/derive/parallelism.ts)
// from the fleet's own idle count vs. eligible backlog+todo depth.
export const ParallelismNudge = z.object({
  idleRunners: z.number().int().nonnegative(),
  eligibleBacklog: z.number().int().nonnegative(),
  shouldNudge: z.boolean(),
});
export type ParallelismNudge = z.infer<typeof ParallelismNudge>;

export const Snapshot = z.object({
  runs: z.array(TaskRun),
  queue: z.array(HitlItem), // open + recently-resolved HITL items
  projects: z.array(Project),
  tasks: z.array(Task),
  features: z.array(Feature).default([]),
  milestones: z.array(Milestone).default([]),
  solutionBriefs: z.array(SolutionBrief).default([]),
  fleet: z.array(Agent),
  modules: z.array(Module),
  deps: z.array(Dependency),
  providers: z.array(ProviderInfo),
  // Momentum Rollout kanban rebuild — project-scoped in the store (Rule/
  // Proposal have no natural workspace-wide list of their own), fanned out to
  // the whole workspace here same as every other snapshot collection.
  rules: z.array(Rule).default([]),
  proposals: z.array(Proposal).default([]),
  serverTime: Timestamp, // lets clients correct for clock skew when ticking
  // The server's default approval level (SKYNET_APPROVAL_LEVEL), so the
  // create-project form can pre-select what a new project would otherwise get.
  // Optional for forward-compat with older servers that don't send it.
  defaultApprovalLevel: ApprovalLevel.optional(),
  // The live workspace fleet policy (auto-scale + cap). Optional for forward-compat.
  workspaceSettings: WorkspaceSettings.optional(),
  // Derived read, not a persisted record (see ParallelismNudge above). Optional
  // for forward-compat with older servers that don't send it.
  parallelismNudge: ParallelismNudge.optional(),
});
export type Snapshot = z.infer<typeof Snapshot>;

// ─── Server → client deltas ───────────────────────────────────────────────

export const ServerEvent = z.discriminatedUnion("type", [
  // task-run lifecycle
  z.object({ type: z.literal("run.started"), run: TaskRun }),
  z.object({ type: z.literal("run.log"), runId: z.string(), at: Timestamp, line: z.string(), detail: z.string().optional() }),
  // Token-level "typing" preview of the line currently being generated — NOT
  // persisted (no store write, see Hub.runLogDelta): a real `run.log` still
  // lands once the message is complete. Clients hold this in a transient
  // per-run buffer and drop it once the matching `run.log` arrives.
  z.object({ type: z.literal("run.log.delta"), runId: z.string(), delta: z.string() }),
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
  // A whole-run replace — used when a field with no dedicated event changes (e.g.
  // `pr`, the ready-to-merge record). The client upserts the full run.
  z.object({ type: z.literal("run.updated"), run: TaskRun }),

  // HITL round-trip
  z.object({ type: z.literal("hitl.raised"), item: HitlItem }),
  z.object({ type: z.literal("hitl.resolved"), id: z.string(), resolution: Resolution }),

  // Momentum Rollout, phase 1a — a GitHub PR/review/check/deploy webhook
  // resolved to one of our own tasks. Bus-only (see Hub.publishGithubSignal):
  // this phase only verifies, parses, resolves, and publishes — the later
  // rule-engine phase is what turns a signal into a persisted Transition.
  z.object({ type: z.literal("github.signal"), taskId: z.string(), kind: GithubSignalKind, payload: GithubSignalPayload }),

  // derived intelligence
  z.object({ type: z.literal("conflict.detected"), moduleId: z.string(), runIds: z.array(z.string()) }),

  // Momentum Rollout kanban rebuild, Phase 1c — rule engine + API-surface
  // mutations. Rule/Proposal follow the same upsert-only shape as every other
  // collection delta below; a Transition is append-only (never updated), so
  // it only ever gets a "created" event, never "upserted"/"deleted".
  z.object({ type: z.literal("transition.created"), transition: Transition }),
  z.object({ type: z.literal("rule.upserted"), rule: Rule }),
  z.object({ type: z.literal("rule.deleted"), id: z.string() }),
  z.object({ type: z.literal("proposal.upserted"), proposal: Proposal }),

  // collection CRUD deltas — keep every operator's view consistent
  z.object({ type: z.literal("project.upserted"), project: Project }),
  z.object({ type: z.literal("project.deleted"), id: z.string() }),
  z.object({ type: z.literal("task.upserted"), task: Task }),
  z.object({ type: z.literal("task.deleted"), id: z.string() }),
  z.object({ type: z.literal("feature.upserted"), feature: Feature }),
  z.object({ type: z.literal("feature.deleted"), id: z.string() }),
  z.object({ type: z.literal("milestone.upserted"), milestone: Milestone }),
  z.object({ type: z.literal("milestone.deleted"), id: z.string() }),
  z.object({ type: z.literal("solutionBrief.upserted"), brief: SolutionBrief }),
  z.object({ type: z.literal("solutionBrief.deleted"), id: z.string() }),
  z.object({ type: z.literal("contextEntry.upserted"), entry: ProjectContextEntry }),
  z.object({ type: z.literal("contextEntry.deleted"), id: z.string() }),
  z.object({ type: z.literal("agent.upserted"), agent: Agent }),
  z.object({ type: z.literal("agent.deleted"), id: z.string() }),

  // audit trail mutations — the decision audit isn't part of the snapshot, so
  // these carry no payload beyond identity; clients re-fetch /api/audit on them.
  z.object({ type: z.literal("audit.archived"), hitlId: z.string(), archived: z.boolean() }),
  z.object({ type: z.literal("audit.deleted"), hitlId: z.string() }),
  z.object({ type: z.literal("audit.archived-all") }),
  z.object({ type: z.literal("audit.cleared") }),

  // Autonomy breaker/override (TASK 19) — like the audit deltas above, neither
  // is part of the snapshot; carries only identity, clients re-fetch
  // GET /api/projects/:id/autonomy-detent on it.
  z.object({ type: z.literal("autonomyBreaker.updated"), projectId: z.string() }),
]);
export type ServerEvent = z.infer<typeof ServerEvent>;

export type ServerEventType = ServerEvent["type"];

/** Everything the server can push down a socket. */
export const WsMessage = z.union([
  z.object({ type: z.literal("snapshot"), state: Snapshot }),
  ServerEvent,
]);
export type WsMessage = z.infer<typeof WsMessage>;
