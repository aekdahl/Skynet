// Contracts round-trip: the zod schemas in @skynet/shared are the wire spine
// (Architecture Brief §06). A value that serializes to JSON and parses back must
// be unchanged, every ServerEvent variant must validate, and malformed payloads
// must be rejected — that's the guarantee both apps lean on.
import { describe, it, expect } from "vitest";
import {
  Task,
  TaskRun,
  HitlItem,
  Resolution,
  ServerEvent,
  Snapshot,
  WsMessage,
  DEFAULT_PROVIDERS,
  DEFAULT_WORKSPACE,
} from "@skynet/shared";

const agent: TaskRun = {
  id: "billing",
  workspaceId: DEFAULT_WORKSPACE,
  projectId: "payments",
  name: "Stripe webhook reconciliation",
  status: "waiting",
  agentId: "runner-01",
  provider: "claude",
  credentialId: null,
  model: "opus-4.5",
  branch: "agent/billing-hooks",
  modules: ["api/billing", "db/migrations"],
  progress: 0.45,
  plan: [{ text: "Map events", state: "done" }],
  usage: null,
  modifiedFiles: ["api/billing/webhooks.ts"],
  log: [{ at: 1_000, line: "worker passes replay suite" }],
  startedAt: 10_000,
  lastHeartbeatAt: 20_000,
  visual: false,
  previewUrl: null,
  dependsOn: [],
  parentId: null,
  branchFromStep: null,
  archived: false,
  pr: null,
  mergedAt: null,
};

const wire = <T>(v: T): unknown => JSON.parse(JSON.stringify(v));

describe("contracts round-trip", () => {
  it("TaskRun survives JSON serialize → parse unchanged", () => {
    const parsed = TaskRun.parse(wire(agent));
    expect(parsed).toEqual(agent);
  });

  it("zod defaults fill optional fields on parse", () => {
    // The wire may omit defaulted fields; parse must reconstruct them.
    const minimal = {
      id: "x", workspaceId: "w", projectId: "p", name: "n", status: "running",
      agentId: null, provider: "claude", model: "m", branch: "b", modules: [],
      progress: 0, plan: [], modifiedFiles: [], log: [], startedAt: 0, lastHeartbeatAt: 0,
    };
    const parsed = TaskRun.parse(minimal);
    expect(parsed.previewUrl).toBeNull();
    expect(parsed.dependsOn).toEqual([]);
    expect(parsed.visual).toBe(false);
    expect(parsed.parentId).toBeNull();
  });

  it("Task.assignment defaults to unassigned and round-trips a pinned pool", () => {
    // A legacy task with no assignment parses to the `unassigned` default.
    const legacy = Task.parse({
      id: "t1", workspaceId: "w", projectId: "p", text: "x", state: "backlog",
    });
    expect(legacy.assignment).toEqual({ mode: "unassigned", agentIds: [] });
    // A pinned pool survives serialize → parse unchanged.
    const pinned = { ...legacy, assignment: { mode: "agents", agentIds: ["a1", "a2"] } };
    expect(Task.parse(wire(pinned)).assignment).toEqual({ mode: "agents", agentIds: ["a1", "a2"] });
  });

  it("rejects an `agents` assignment with an empty pool", () => {
    const bad = { id: "t1", workspaceId: "w", projectId: "p", text: "x", state: "backlog", assignment: { mode: "agents", agentIds: [] } };
    expect(() => Task.parse(bad)).toThrow();
  });

  it("rejects an out-of-range progress", () => {
    expect(() => TaskRun.parse({ ...agent, progress: 1.5 })).toThrow();
  });

  it("rejects an unknown agent status", () => {
    expect(() => TaskRun.parse({ ...agent, status: "frozen" })).toThrow();
  });

  it("every ServerEvent variant round-trips through its discriminated union", () => {
    const resolution: Resolution = { action: "approve", optionIndex: null, guidance: null, memoryNote: null, by: "op-1", at: 5 };
    const hitl: HitlItem = {
      id: "q1", workspaceId: DEFAULT_WORKSPACE, runId: "billing", kind: "approval",
      title: "t", why: "w", risk: "medium", raisedAt: 1, expiresAt: null, resolvedAt: null, resolution: null,
      command: "deploy", options: null, recommended: null, steps: null, diff: null, rationale: null, flags: [],
    };
    const events: ServerEvent[] = [
      { type: "run.started", run: agent },
      { type: "run.log", runId: "billing", at: 1, line: "hi" },
      { type: "run.progress", runId: "billing", progress: 0.5, plan: [{ text: "s", state: "now" }] },
      { type: "run.heartbeat", runId: "billing", at: 2 },
      { type: "run.status", runId: "billing", status: "review" },
      { type: "run.updated", run: agent },
      { type: "run.completed", runId: "billing", branch: "agent/billing-hooks" },
      { type: "hitl.raised", item: hitl },
      { type: "hitl.resolved", id: "q1", resolution },
      { type: "conflict.detected", moduleId: "shared/ui", runIds: ["onboard", "tokens"] },
      { type: "project.deleted", id: "payments" },
      { type: "task.deleted", id: "t-1" },
      { type: "agent.deleted", id: "runner-09" },
      { type: "audit.archived", hitlId: "q1", archived: true },
      { type: "audit.deleted", hitlId: "q1" },
      { type: "audit.archived-all" },
      { type: "audit.cleared" },
    ];
    for (const e of events) {
      expect(ServerEvent.parse(wire(e))).toEqual(e);
    }
  });

  it("rejects an unknown ServerEvent type", () => {
    expect(() => ServerEvent.parse({ type: "run.exploded", runId: "x" })).toThrow();
  });

  it("Snapshot validates a full default-provider catalog and WsMessage wraps it", () => {
    const snapshot: Snapshot = {
      runs: [agent], queue: [], projects: [], tasks: [], features: [], milestones: [], fleet: [],
      modules: [], deps: [], providers: DEFAULT_PROVIDERS, serverTime: 42,
    };
    expect(Snapshot.parse(wire(snapshot))).toEqual(snapshot);
    expect(WsMessage.parse(wire({ type: "snapshot", state: snapshot }))).toBeTruthy();
  });
});
