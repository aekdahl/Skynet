// TASK 19 — the autonomy dial (composite notch over autonomy+approvalLevel)
// and the now-PERSISTED session circuit-breaker + its manual override. The
// breaker's core trip/reset LOGIC is exercised by tests/autonomy-circuit-
// breaker.test.ts; this file covers what's new here: the dial's read/write
// endpoints, durability across a "restart" (a fresh Orchestrator instance
// over the same store), the trip/lift audit trail, and override expiry.
import { describe, it, expect, vi, afterEach } from "vitest";
import type { Agent, HitlItem, Project, ProviderId, ServerEvent, Task, TaskRun } from "@skynet/shared";
import { DEFAULT_WORKSPACE } from "@skynet/shared";
import { Hub } from "../apps/server/src/hub.js";
import { Orchestrator } from "../apps/server/src/orchestrator.js";
import { Operations } from "../apps/server/src/operations.js";
import { MemoryStore } from "../apps/server/src/store/memory.js";
import { config } from "../apps/server/src/config.js";
import type { Bus } from "../apps/server/src/bus.js";
import type { RunnerEvents, RunnerHandle, RunnerProvider, StartSpec } from "@skynet/runner-sdk";

class NullBus implements Bus {
  publish(_ws: string, _e: ServerEvent): void {}
  subscribe(): () => void { return () => {}; }
}

class ReviewProvider implements RunnerProvider {
  readonly id: ProviderId = "claude";
  reply = "ok";
  async start(spec: StartSpec, _events: RunnerEvents): Promise<RunnerHandle> {
    return { runId: spec.runId, provider: this.id, async pause() {}, async resume() {}, async message() {}, async stop() {} };
  }
  async consult(): Promise<string> { return this.reply; }
}

const mkProject = (over: Partial<Project> = {}): Project => ({
  id: "p1", workspaceId: DEFAULT_WORKSPACE, name: "P", goal: "", runIds: [],
  status: "active", autonomy: true, repoPath: null, gitBacked: false, ...over,
});
const mkAgent = (over: Partial<Agent>): Agent => ({
  id: "a1", workspaceId: DEFAULT_WORKSPACE, name: "a1", provider: "claude",
  model: "opus-4.8", status: "idle", idleSince: 0, ...over,
});
const mkTask = (over: Partial<Task>): Task => ({
  id: "t1", workspaceId: DEFAULT_WORKSPACE, projectId: "p1", text: "do X", state: "backlog",
  runId: null, autoPick: false, assessment: null, reviewVerdict: null, lint: null,
  assignment: { mode: "any", agentIds: [] }, ...over,
});
const mkRun = (over: Partial<TaskRun>): TaskRun => ({
  id: "r1", workspaceId: DEFAULT_WORKSPACE, projectId: "p1", name: "do X", status: "review",
  agentId: "a1", provider: "claude", model: "opus-4.8", branch: "agent/r1", modules: [], progress: 1,
  plan: [], modifiedFiles: [], log: [], startedAt: 0, lastHeartbeatAt: 0, visual: false,
  previewUrl: null, dependsOn: [], parentId: null, branchFromStep: null, archived: false, ...over,
});
const mkHitl = (over: Partial<HitlItem>): HitlItem => ({
  id: "q1", workspaceId: DEFAULT_WORKSPACE, runId: "r1", kind: "diff", title: "Review",
  why: "", risk: "medium", raisedAt: 0, expiresAt: null, resolvedAt: null, resolution: null,
  command: null, options: null, recommended: null, steps: null, diff: null, ...over,
});

const FLAG = '{"verdict":"flag","reason":"missing tests"}';

/** One review-state run + open diff HITL + task through a single tickAutonomy —
 *  same shape as tests/autonomy-circuit-breaker.test.ts's own helper. */
async function reviewRound(store: MemoryStore, orch: Orchestrator, provider: ReviewProvider, n: number, reply: string) {
  await store.putRun(mkRun({ id: `r${n}`, agentId: "a1" }));
  await store.putHitl(mkHitl({ id: `q${n}`, runId: `r${n}` }));
  await store.putTask(mkTask({ id: `t${n}`, runId: `r${n}`, state: "review" }));
  provider.reply = reply;
  await orch.tickAutonomy();
}

const setup = async () => {
  const store = new MemoryStore();
  const hub = new Hub(store, new NullBus());
  const provider = new ReviewProvider();
  const orch = new Orchestrator(store, hub, provider);
  const ops = new Operations({ store, hub, orchestrator: orch });
  await store.putProject(mkProject());
  await store.putAgent(mkAgent({ id: "a1" }));
  await store.putAgent(mkAgent({ id: "a2", canReview: true }));
  return { store, hub, orch, ops, provider };
};

describe("autonomy dial — setAutonomyDetent writes the correct underlying pair", () => {
  it("shadow → autonomy off (approvalLevel untouched)", async () => {
    const { ops } = await setup();
    const p = await ops.setAutonomyDetent(DEFAULT_WORKSPACE, "p1", "shadow", "op");
    expect(p.autonomy).toBe(false);
  });
  it("assisted → autonomy on, approvalLevel assisted", async () => {
    const { ops } = await setup();
    const p = await ops.setAutonomyDetent(DEFAULT_WORKSPACE, "p1", "assisted", "op");
    expect(p.autonomy).toBe(true);
    expect(p.approvalLevel).toBe("assisted");
  });
  it("earned → autonomy on, approvalLevel trusted", async () => {
    const { ops } = await setup();
    const p = await ops.setAutonomyDetent(DEFAULT_WORKSPACE, "p1", "earned", "op");
    expect(p.autonomy).toBe(true);
    expect(p.approvalLevel).toBe("trusted");
  });
  it("unattended → autonomy on, approvalLevel full", async () => {
    const { ops } = await setup();
    const p = await ops.setAutonomyDetent(DEFAULT_WORKSPACE, "p1", "unattended", "op");
    expect(p.autonomy).toBe(true);
    expect(p.approvalLevel).toBe("full");
  });
  it("getAutonomyDetent reads back the composed notch", async () => {
    const { ops } = await setup();
    await ops.setAutonomyDetent(DEFAULT_WORKSPACE, "p1", "earned", "op");
    const state = await ops.getAutonomyDetent(DEFAULT_WORKSPACE, "p1");
    expect(state.detent).toBe("earned");
    expect(state.autonomy).toBe(true);
    expect(state.approvalLevel).toBe("trusted");
  });
});

describe("autonomy breaker — persisted across a restart", () => {
  it("a restart mid-streak (fresh Orchestrator over the same store) does not reset the count", async () => {
    const { store, hub, orch, provider } = await setup();
    await reviewRound(store, orch, provider, 1, FLAG);
    await reviewRound(store, orch, provider, 2, FLAG);
    expect((await store.getProject("p1"))?.autonomy).toBe(true); // 2/3 — not yet tripped
    const breaker = await store.getAutonomyBreaker("p1");
    expect(breaker?.count).toBe(2);

    // "Restart": a brand-new Orchestrator instance (no in-memory state carried
    // over) driving the SAME store — the old in-memory autonomyStreaks Map
    // would have forgotten the streak here; the persisted one must not.
    const restarted = new Orchestrator(store, hub, provider);
    await reviewRound(store, restarted, provider, 3, FLAG);
    expect((await store.getProject("p1"))?.autonomy).toBe(false); // 3rd bad outcome trips it
  });

  it("a trip and a later lift both appear as audit rows", async () => {
    const { store, orch, provider } = await setup();
    for (const n of [1, 2, 3]) await reviewRound(store, orch, provider, n, FLAG);
    expect((await store.getProject("p1"))?.autonomy).toBe(false);

    const afterTrip = await store.listAudit(DEFAULT_WORKSPACE);
    const tripRow = afterTrip.find((a) => a.action === "autonomy-breaker-tripped");
    expect(tripRow).toBeTruthy();
    expect((tripRow!.payload as { count: number }).count).toBe(3);

    const project = { ...(await store.getProject("p1"))!, autonomy: true };
    await store.putProject(project);
    await orch.resetAutonomyStreak(project, "jordan");

    const afterLift = await store.listAudit(DEFAULT_WORKSPACE);
    const liftRow = afterLift.find((a) => a.action === "autonomy-breaker-lifted");
    expect(liftRow).toBeTruthy();
    expect(liftRow!.operatorId).toBe("jordan");

    // The persisted breaker record itself is gone — a fresh streak starts at 0.
    expect(await store.getAutonomyBreaker("p1")).toBeUndefined();
  });

  it("clearing a streak that never actually tripped is not audit-worthy", async () => {
    const { store, orch, provider } = await setup();
    await reviewRound(store, orch, provider, 1, FLAG); // 1/3 — never trips
    const project = (await store.getProject("p1"))!;
    await orch.resetAutonomyStreak(project, "jordan");
    const audit = await store.listAudit(DEFAULT_WORKSPACE);
    expect(audit.some((a) => a.action === "autonomy-breaker-lifted")).toBe(false);
  });
});

describe("autonomy override — reverts automatically at expiry", () => {
  afterEach(() => vi.useRealTimers());

  it("bypasses a tripped breaker immediately, then reverts once it expires (breaker still tripped)", async () => {
    const { store, hub, orch, ops, provider } = await setup();
    for (const n of [1, 2, 3]) await reviewRound(store, orch, provider, n, FLAG);
    expect((await store.getProject("p1"))?.autonomy).toBe(false);

    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 1, 0, 0));
    await ops.createAutonomyOverride(DEFAULT_WORKSPACE, "p1", "jordan");
    expect((await store.getProject("p1"))?.autonomy).toBe(true); // resumed immediately
    const override = await store.getAutonomyOverride("p1");
    expect(override?.overriddenBy).toBe("jordan");
    expect(override?.expiresAt).toBe(Date.now() + config.autonomyOverrideDurationMs);

    // Advance past expiry and run the same sweep tickAutonomy calls each tick.
    vi.setSystemTime(new Date(Date.now() + config.autonomyOverrideDurationMs + 1000));
    const project = (await store.getProject("p1"))!;
    await (orch as unknown as { sweepAutonomyOverrides: (ws: string, projects: Project[]) => Promise<void> })
      .sweepAutonomyOverrides(DEFAULT_WORKSPACE, [project]);

    expect((await store.getProject("p1"))?.autonomy).toBe(false); // reverted — breaker is still tripped
    expect(await store.getAutonomyOverride("p1")).toBeUndefined(); // the override record itself is gone
    void hub;
  });

  it("does nothing if the breaker was genuinely lifted before the override expired", async () => {
    const { store, orch, ops, provider } = await setup();
    for (const n of [1, 2, 3]) await reviewRound(store, orch, provider, n, FLAG);

    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 1, 0, 0));
    await ops.createAutonomyOverride(DEFAULT_WORKSPACE, "p1", "jordan");

    // A real lift happens while the override is still active (e.g. the
    // operator explicitly re-enables autonomy for good).
    const project = { ...(await store.getProject("p1"))!, autonomy: true };
    await store.putProject(project);
    await orch.resetAutonomyStreak(project, "jordan");

    vi.setSystemTime(new Date(Date.now() + config.autonomyOverrideDurationMs + 1000));
    await (orch as unknown as { sweepAutonomyOverrides: (ws: string, projects: Project[]) => Promise<void> })
      .sweepAutonomyOverrides(DEFAULT_WORKSPACE, [{ ...(await store.getProject("p1"))! }]);

    expect((await store.getProject("p1"))?.autonomy).toBe(true); // untouched — no trip to revert to
  });
});
