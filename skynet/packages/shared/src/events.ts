// ─── Real-time event stream ───────────────────────────────────────────────
// The server pushes a Snapshot on connect, then ServerEvent deltas. The UI's
// collections are designed to be replaced wholesale on connect and patched
// per-event after. (Backend Brief §07, Architecture Brief §06.)

import { z } from "zod";
import {
  Agent,
  AgentStatus,
  Dependency,
  HitlItem,
  Module,
  PlanStep,
  Project,
  ProviderInfo,
  Resolution,
  Runner,
  Task,
  Timestamp,
} from "./contracts.js";

// ─── Connect-time snapshot ────────────────────────────────────────────────

export const Snapshot = z.object({
  agents: z.array(Agent),
  queue: z.array(HitlItem), // open + recently-resolved HITL items
  projects: z.array(Project),
  tasks: z.array(Task),
  fleet: z.array(Runner),
  modules: z.array(Module),
  deps: z.array(Dependency),
  providers: z.array(ProviderInfo),
  serverTime: Timestamp, // lets clients correct for clock skew when ticking
});
export type Snapshot = z.infer<typeof Snapshot>;

// ─── Server → client deltas ───────────────────────────────────────────────

export const ServerEvent = z.discriminatedUnion("type", [
  // agent lifecycle
  z.object({ type: z.literal("agent.started"), agent: Agent }),
  z.object({ type: z.literal("agent.log"), agentId: z.string(), at: Timestamp, line: z.string(), detail: z.string().optional() }),
  z.object({
    type: z.literal("agent.progress"),
    agentId: z.string(),
    progress: z.number().min(0).max(1),
    plan: z.array(PlanStep),
  }),
  z.object({ type: z.literal("agent.heartbeat"), agentId: z.string(), at: Timestamp }),
  z.object({ type: z.literal("agent.status"), agentId: z.string(), status: AgentStatus }),
  z.object({ type: z.literal("agent.completed"), agentId: z.string(), branch: z.string() }),

  // HITL round-trip
  z.object({ type: z.literal("hitl.raised"), item: HitlItem }),
  z.object({ type: z.literal("hitl.resolved"), id: z.string(), resolution: Resolution }),

  // derived intelligence
  z.object({ type: z.literal("conflict.detected"), moduleId: z.string(), agentIds: z.array(z.string()) }),

  // collection CRUD deltas — keep every operator's view consistent
  z.object({ type: z.literal("project.upserted"), project: Project }),
  z.object({ type: z.literal("project.deleted"), id: z.string() }),
  z.object({ type: z.literal("task.upserted"), task: Task }),
  z.object({ type: z.literal("task.deleted"), id: z.string() }),
  z.object({ type: z.literal("runner.upserted"), runner: Runner }),
  z.object({ type: z.literal("runner.deleted"), id: z.string() }),
]);
export type ServerEvent = z.infer<typeof ServerEvent>;

export type ServerEventType = ServerEvent["type"];

/** Everything the server can push down a socket. */
export const WsMessage = z.union([
  z.object({ type: z.literal("snapshot"), state: Snapshot }),
  ServerEvent,
]);
export type WsMessage = z.infer<typeof WsMessage>;
