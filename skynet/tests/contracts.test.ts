// Contracts round-trip: the zod schemas in @skynet/shared are the wire spine
// (Architecture Brief §06). A value that serializes to JSON and parses back must
// be unchanged, every ServerEvent variant must validate, and malformed payloads
// must be rejected — that's the guarantee both apps lean on.
import { describe, it, expect } from "vitest";
import {
  Agent,
  Task,
  TaskRun,
  HitlItem,
  Resolution,
  ServerEvent,
  Snapshot,
  SolutionBrief,
  WsMessage,
  DEFAULT_PROVIDERS,
  DEFAULT_WORKSPACE,
  ProjectContextEntry,
  CreateProjectContextEntryRequest,
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
  endpoint: null,
  merge: null,
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
  flyDeployment: null,
};

// A fleet runner — distinct from `agent` (a TaskRun) above; `Agent` in
// contracts.ts is the fleet-runner slot (docs/agent-hierarchy.md's `role`
// field lives here, not on TaskRun).
const runner: Agent = {
  id: "runner-01",
  workspaceId: DEFAULT_WORKSPACE,
  name: "claude-ada",
  provider: "claude",
  credentialId: null,
  model: "opus-4.8",
  status: "idle",
  idleSince: 1_000,
  label: null,
  autoProvisioned: false,
  canReview: true,
  role: "worker",
};

const brief: SolutionBrief = {
  id: "brief-billing-1",
  workspaceId: DEFAULT_WORKSPACE,
  projectId: "payments",
  title: "Reconcile Stripe webhooks",
  problem: "Webhook retries can double-post a charge.",
  approach: "Idempotency key on the ledger insert.",
  optionsConsidered: [
    { name: "DB unique constraint", verdict: "chosen", why: "cheapest, no new infra" },
    { name: "Dedup queue", verdict: "rejected — too slow", why: "adds a network hop per event" },
  ],
  risks: ["migration must run before the flag flips"],
  acceptanceCriteria: ["a replayed webhook never double-posts"],
  openQuestions: ["do we backfill existing duplicates?"],
  status: "draft",
  featureId: null,
  createdAt: 1_000,
  updatedAt: 1_000,
  approvedAt: null,
  approvedBy: null,
  sourceConversation: null,
  exploration: null,
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

  it("Agent survives JSON serialize → parse unchanged", () => {
    const parsed = Agent.parse(wire(runner));
    expect(parsed).toEqual(runner);
  });

  it("Agent.role defaults to 'worker' on parse (docs/agent-hierarchy.md — additive, no behavior change)", () => {
    const minimal = {
      id: "x", workspaceId: "w", name: "n", provider: "claude", model: "m", status: "idle",
    };
    expect(Agent.parse(minimal).role).toBe("worker");
  });

  it("ProjectContextEntry survives JSON serialize → parse unchanged", () => {
    const entry: ProjectContextEntry = {
      id: "ctx-1",
      workspaceId: DEFAULT_WORKSPACE,
      projectId: "payments",
      source: "upload",
      label: "Kickoff notes.pdf",
      content: "the project is a billing dashboard for finance",
      filename: "Kickoff notes.pdf",
      mimeType: "application/pdf",
      createdAt: 1_000,
      createdBy: "op-1",
    };
    expect(ProjectContextEntry.parse(wire(entry))).toEqual(entry);
  });

  it("CreateProjectContextEntryRequest trims label/content and treats a blank label as absent", () => {
    const parsed = CreateProjectContextEntryRequest.parse({ label: "  Kickoff  ", content: "  notes  " });
    expect(parsed).toEqual({ label: "Kickoff", content: "notes" });
    expect(() => CreateProjectContextEntryRequest.parse({ content: "" })).toThrow(); // min(1) after trim
  });

  it("rejects an unknown Agent role", () => {
    expect(() => Agent.parse({ ...runner, role: "overlord" })).toThrow();
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

  it("SolutionBrief survives JSON serialize → parse unchanged", () => {
    expect(SolutionBrief.parse(wire(brief))).toEqual(brief);
  });

  it("SolutionBrief zod defaults fill array/status fields on parse", () => {
    const minimal = {
      id: "b1", workspaceId: "w", projectId: "p", title: "t",
      problem: "", approach: "", createdAt: 0, updatedAt: 0,
    };
    const parsed = SolutionBrief.parse(minimal);
    expect(parsed.status).toBe("draft");
    expect(parsed.optionsConsidered).toEqual([]);
    expect(parsed.risks).toEqual([]);
    expect(parsed.acceptanceCriteria).toEqual([]);
    expect(parsed.openQuestions).toEqual([]);
    expect(parsed.featureId).toBeNull();
    expect(parsed.approvedAt).toBeNull();
    expect(parsed.approvedBy).toBeNull();
    expect(parsed.sourceConversation).toBeNull();
  });

  it("rejects an unknown SolutionBrief status", () => {
    expect(() => SolutionBrief.parse({ ...brief, status: "shipped" })).toThrow();
  });

  it("Task.source round-trips the 'brief' provenance kind", () => {
    const withSource = { id: "t1", workspaceId: "w", projectId: "p", text: "x", state: "backlog", source: { kind: "brief", briefId: "brief-billing-1" } };
    expect(Task.parse(wire(withSource)).source).toEqual({ kind: "brief", briefId: "brief-billing-1" });
  });

  it("every ServerEvent variant round-trips through its discriminated union", () => {
    const resolution: Resolution = { action: "approve", optionIndex: null, guidance: null, targetBranch: null, memoryNote: null, resetWork: false, by: "op-1", at: 5 };
    const hitl: HitlItem = {
      id: "q1", workspaceId: DEFAULT_WORKSPACE, runId: "billing", kind: "approval",
      title: "t", why: "w", risk: "medium", raisedAt: 1, expiresAt: null, resolvedAt: null, resolution: null,
      command: "deploy", options: null, recommended: null, steps: null, diff: null, output: null, rationale: null, flags: [],
      sourceBranchOverride: null,
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
      { type: "solutionBrief.upserted", brief },
      { type: "solutionBrief.deleted", id: "brief-billing-1" },
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
      runs: [agent], queue: [], projects: [], tasks: [], features: [], milestones: [], solutionBriefs: [brief], fleet: [],
      modules: [], deps: [], providers: DEFAULT_PROVIDERS, serverTime: 42,
    };
    expect(Snapshot.parse(wire(snapshot))).toEqual(snapshot);
    expect(WsMessage.parse(wire({ type: "snapshot", state: snapshot }))).toBeTruthy();
  });
});
