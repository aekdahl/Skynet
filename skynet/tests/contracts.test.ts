// Contracts round-trip: the zod schemas in @skynet/shared are the wire spine
// (Architecture Brief §06). A value that serializes to JSON and parses back must
// be unchanged, every ServerEvent variant must validate, and malformed payloads
// must be rejected — that's the guarantee both apps lean on.
import { describe, it, expect } from "vitest";
import {
  Agent,
  HitlItem,
  Resolution,
  ServerEvent,
  Snapshot,
  WsMessage,
  DEFAULT_PROVIDERS,
  DEFAULT_WORKSPACE,
} from "@skynet/shared";

const agent: Agent = {
  id: "billing",
  workspaceId: DEFAULT_WORKSPACE,
  projectId: "payments",
  name: "Stripe webhook reconciliation",
  status: "waiting",
  runnerId: "runner-01",
  provider: "claude",
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
};

const wire = <T>(v: T): unknown => JSON.parse(JSON.stringify(v));

describe("contracts round-trip", () => {
  it("Agent survives JSON serialize → parse unchanged", () => {
    const parsed = Agent.parse(wire(agent));
    expect(parsed).toEqual(agent);
  });

  it("zod defaults fill optional fields on parse", () => {
    // The wire may omit defaulted fields; parse must reconstruct them.
    const minimal = {
      id: "x", workspaceId: "w", projectId: "p", name: "n", status: "running",
      runnerId: null, provider: "claude", model: "m", branch: "b", modules: [],
      progress: 0, plan: [], modifiedFiles: [], log: [], startedAt: 0, lastHeartbeatAt: 0,
    };
    const parsed = Agent.parse(minimal);
    expect(parsed.previewUrl).toBeNull();
    expect(parsed.dependsOn).toEqual([]);
    expect(parsed.visual).toBe(false);
    expect(parsed.parentId).toBeNull();
  });

  it("rejects an out-of-range progress", () => {
    expect(() => Agent.parse({ ...agent, progress: 1.5 })).toThrow();
  });

  it("rejects an unknown agent status", () => {
    expect(() => Agent.parse({ ...agent, status: "frozen" })).toThrow();
  });

  it("every ServerEvent variant round-trips through its discriminated union", () => {
    const resolution: Resolution = { action: "approve", optionIndex: null, guidance: null, by: "op-1", at: 5 };
    const hitl: HitlItem = {
      id: "q1", workspaceId: DEFAULT_WORKSPACE, agentId: "billing", kind: "approval",
      title: "t", why: "w", risk: "medium", raisedAt: 1, resolvedAt: null, resolution: null,
      command: "deploy", options: null, recommended: null, steps: null, diff: null,
    };
    const events: ServerEvent[] = [
      { type: "agent.started", agent },
      { type: "agent.log", agentId: "billing", at: 1, line: "hi" },
      { type: "agent.progress", agentId: "billing", progress: 0.5, plan: [{ text: "s", state: "now" }] },
      { type: "agent.heartbeat", agentId: "billing", at: 2 },
      { type: "agent.status", agentId: "billing", status: "review" },
      { type: "agent.completed", agentId: "billing", branch: "agent/billing-hooks" },
      { type: "hitl.raised", item: hitl },
      { type: "hitl.resolved", id: "q1", resolution },
      { type: "conflict.detected", moduleId: "shared/ui", agentIds: ["onboard", "tokens"] },
      { type: "project.deleted", id: "payments" },
      { type: "task.deleted", id: "t-1" },
      { type: "runner.deleted", id: "runner-09" },
    ];
    for (const e of events) {
      expect(ServerEvent.parse(wire(e))).toEqual(e);
    }
  });

  it("rejects an unknown ServerEvent type", () => {
    expect(() => ServerEvent.parse({ type: "agent.exploded", agentId: "x" })).toThrow();
  });

  it("Snapshot validates a full default-provider catalog and WsMessage wraps it", () => {
    const snapshot: Snapshot = {
      agents: [agent], queue: [], projects: [], tasks: [], fleet: [],
      modules: [], deps: [], providers: DEFAULT_PROVIDERS, serverTime: 42,
    };
    expect(Snapshot.parse(wire(snapshot))).toEqual(snapshot);
    expect(WsMessage.parse(wire({ type: "snapshot", state: snapshot }))).toBeTruthy();
  });
});
