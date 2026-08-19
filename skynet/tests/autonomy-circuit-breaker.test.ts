// Session circuit-breaker: N consecutive BAD autonomy outcomes (a flagged
// auto-review verdict, or a failed run) for the same project, with no good
// outcome in between, pauses that project's `autonomy` toggle and raises ONE
// summary `escalation` HITL — a behavioral stop for a stuck autonomous sweep,
// distinct from the (separate, out-of-scope-here) spend budget.
import { describe, it, expect } from "vitest";
import type { Agent, HitlItem, Project, ProviderId, ServerEvent, Task, TaskRun } from "@skynet/shared";
import { DEFAULT_WORKSPACE } from "@skynet/shared";
import { Hub } from "../apps/server/src/hub.js";
import { Orchestrator } from "../apps/server/src/orchestrator.js";
import { MemoryStore } from "../apps/server/src/store/memory.js";
import type { Bus } from "../apps/server/src/bus.js";
import type { RunnerEvents, RunnerHandle, RunnerProvider, StartSpec } from "@skynet/runner-sdk";

class NullBus implements Bus {
  publish(_ws: string, _e: ServerEvent): void {}
  subscribe(): () => void { return () => {}; }
}

// A provider whose review-consult reply is mutable between ticks (the
// "interleaved success resets" test flips it flag → approve → flag), whose
// start() is a real live handle so manual assignment can be exercised, and
// with a one-shot `failNext`: when armed, the NEXT start() reports onFailed
// asynchronously instead of running cleanly (like a missing CLI binary or a
// crashed process — see tests/runner-failure.test.ts, same async-onFailed
// pattern). One provider class covers both shapes so a single test can drive
// a review-consult round AND a real assignTask()-spawned failure through the
// SAME orchestrator instance — the circuit-breaker's streak is in-memory
// per-orchestrator, so two separate provider/orchestrator pairs wouldn't
// share one streak.
class MixedProvider implements RunnerProvider {
  readonly id: ProviderId = "claude";
  reply = "ok";
  failNext = false;
  started = 0;
  async start(spec: StartSpec, events: RunnerEvents): Promise<RunnerHandle> {
    this.started++;
    if (this.failNext) {
      this.failNext = false;
      setTimeout(() => events.onFailed(spec.runId, "boom (simulated)"), 0);
    }
    return { runId: spec.runId, provider: this.id, async pause() {}, async resume() {}, async message() {}, async stop() {} };
  }
  async consult(): Promise<string> { return this.reply; }
}

const tick = () => new Promise((r) => setTimeout(r, 20));

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

const setup = async () => {
  const store = new MemoryStore();
  const hub = new Hub(store, new NullBus());
  const provider = new MixedProvider();
  const orch = new Orchestrator(store, hub, provider);
  await store.putProject(mkProject());
  await store.putAgent(mkAgent({ id: "a1" }));
  await store.putAgent(mkAgent({ id: "a2", canReview: true })); // reviews a1's runs
  return { store, orch, provider };
};

/** Push one review-state run + open diff HITL + task through a single
 *  tickAutonomy(), with the reviewer replying `reply`. Mirrors the exact setup
 *  autonomy.test.ts's own auto-review tests use, one round per call so the
 *  `mine.find(review-eligible)` picks exactly this round's task. */
async function reviewRound(
  store: MemoryStore,
  orch: Orchestrator,
  provider: MixedProvider,
  n: number,
  reply: string,
) {
  await store.putRun(mkRun({ id: `r${n}`, agentId: "a1" }));
  await store.putHitl(mkHitl({ id: `q${n}`, runId: `r${n}` }));
  await store.putTask(mkTask({ id: `t${n}`, runId: `r${n}`, state: "review" }));
  provider.reply = reply;
  await orch.tickAutonomy();
}

const FLAG = '{"verdict":"flag","reason":"missing tests"}';
const APPROVE = '{"verdict":"approve","reason":"looks good"}';

describe("session circuit-breaker — consecutive bad autonomy outcomes", () => {
  it("3 flags in a row pause the project and raise exactly ONE summary escalation (not three)", async () => {
    const { store, orch, provider } = await setup();
    await reviewRound(store, orch, provider, 1, FLAG);
    expect((await store.getProject("p1"))?.autonomy).toBe(true); // 1/3 — not yet
    await reviewRound(store, orch, provider, 2, FLAG);
    expect((await store.getProject("p1"))?.autonomy).toBe(true); // 2/3 — not yet
    await reviewRound(store, orch, provider, 3, FLAG);
    expect((await store.getProject("p1"))?.autonomy).toBe(false); // tripped

    const queue = await store.listQueue(DEFAULT_WORKSPACE);
    const escalations = queue.filter((q) => q.kind === "escalation" && q.flags?.includes("autonomy-paused"));
    expect(escalations).toHaveLength(1); // ONE summary, not three
    const [item] = escalations;
    expect(item!.why).toContain("3 bad outcomes");
    // Names which tasks + reasons, not just a bare count.
    expect(item!.why).toContain('"do X" flagged');
    expect(item!.why).toContain("missing tests");

    // All 3 review verdicts were still recorded on their own tasks — the
    // breaker composes the existing verdict/failure signals, it doesn't
    // suppress them.
    expect((await store.getTask("t1"))?.reviewVerdict?.decision).toBe("flag");
    expect((await store.getTask("t2"))?.reviewVerdict?.decision).toBe("flag");
    expect((await store.getTask("t3"))?.reviewVerdict?.decision).toBe("flag");
  });

  it("a 4th flag after tripping does NOT raise a second escalation", async () => {
    const { store, orch, provider } = await setup();
    for (const n of [1, 2, 3]) await reviewRound(store, orch, provider, n, FLAG);
    expect((await store.getProject("p1"))?.autonomy).toBe(false);

    // Re-enable a REVIEWER-eligible idle agent isn't the point here — autonomy
    // is off, so tickAutonomy's own auto-pick/review-approve steps stay
    // gated; but if some OTHER caller still fed a bad outcome in (e.g. a
    // manually-assigned run failing while paused), it must not pile on a
    // second escalation on an already-paused project.
    await store.putRun(mkRun({ id: "r4", agentId: "a1" }));
    await store.putHitl(mkHitl({ id: "q4", runId: "r4" }));
    await store.putTask(mkTask({ id: "t4", runId: "r4", state: "review" }));
    provider.reply = FLAG;
    await orch.tickAutonomy(); // review still runs "regardless of p.autonomy"

    const escalations = (await store.listQueue(DEFAULT_WORKSPACE)).filter(
      (q) => q.kind === "escalation" && q.flags?.includes("autonomy-paused"),
    );
    expect(escalations).toHaveLength(1); // still just the one
  });

  it("a good outcome (approve) resets the streak — 2 flags + approve + 2 flags does NOT trip", async () => {
    const { store, orch, provider } = await setup();
    await reviewRound(store, orch, provider, 1, FLAG);
    await reviewRound(store, orch, provider, 2, FLAG);
    // The approve needs a SECOND idle reviewer-eligible agent too, same as any
    // other round — canResolve stays true (autonomy is still on), so this one
    // also merges/completes for real.
    await reviewRound(store, orch, provider, 3, APPROVE);
    expect((await store.getTask("t3"))?.state).toBe("done");

    await reviewRound(store, orch, provider, 4, FLAG);
    await reviewRound(store, orch, provider, 5, FLAG);
    // Only 2 CONSECUTIVE bad outcomes since the reset — must not have tripped.
    expect((await store.getProject("p1"))?.autonomy).toBe(true);
    expect((await store.listQueue(DEFAULT_WORKSPACE)).some((q) => q.kind === "escalation")).toBe(false);

    // One more flag completes the streak of 3 (t4, t5, t6) and DOES trip.
    await reviewRound(store, orch, provider, 6, FLAG);
    expect((await store.getProject("p1"))?.autonomy).toBe(false);
  });

  it("a failed run counts as one bad outcome toward the same streak as flags", async () => {
    const { store, orch, provider } = await setup();

    // 2 flags via auto-review (a1's already-finished runs)...
    await reviewRound(store, orch, provider, 1, FLAG);
    await reviewRound(store, orch, provider, 2, FLAG);
    expect((await store.getProject("p1"))?.autonomy).toBe(true); // 2/3

    // ...then a THIRD, freshly-assigned run fails outright (never reaches
    // review at all) — still the 3rd consecutive bad outcome, same streak.
    // `autoPick: false` + created only now, so the tick steps above (while
    // autonomy was still on) can't have already auto-picked it themselves.
    await store.putTask(mkTask({ id: "t9", text: "the flaky one", state: "todo", autoPick: false }));
    provider.failNext = true;
    await orch.assignTask("p1", "t9");
    await tick(); // let the async onFailed propagate
    expect((await store.getProject("p1"))?.autonomy).toBe(false);
    const escalations = (await store.listQueue(DEFAULT_WORKSPACE)).filter(
      (q) => q.kind === "escalation" && q.flags?.includes("autonomy-paused"),
    );
    expect(escalations).toHaveLength(1);
    expect(escalations[0]!.why).toContain("the flaky one"); // t9's own text, from the failed run
  });

  it("manual assignment is still allowed on a paused project", async () => {
    const { store, orch, provider } = await setup();
    for (const n of [1, 2, 3]) await reviewRound(store, orch, provider, n, FLAG);
    expect((await store.getProject("p1"))?.autonomy).toBe(false);

    await store.putTask(mkTask({ id: "t9", state: "todo" }));
    const run = await orch.assignTask("p1", "t9"); // an operator's own "Start now"
    expect(run.status).toBe("running");
    expect(provider.started).toBeGreaterThan(0);
    expect((await store.getTask("t9"))?.state).toBe("ongoing");
  });

  it("pause is per-project, not per-workspace — a second project's autonomy is untouched", async () => {
    const { store, orch, provider } = await setup();
    await store.putProject(mkProject({ id: "p2", name: "P2" }));
    for (const n of [1, 2, 3]) await reviewRound(store, orch, provider, n, FLAG);
    expect((await store.getProject("p1"))?.autonomy).toBe(false);
    expect((await store.getProject("p2"))?.autonomy).toBe(true); // untouched
  });

  it("re-enabling the autonomy toggle resumes and resets the streak", async () => {
    const { store, orch, provider } = await setup();
    for (const n of [1, 2, 3]) await reviewRound(store, orch, provider, n, FLAG);
    expect((await store.getProject("p1"))?.autonomy).toBe(false);

    // The existing UI toggle → PATCH /api/projects/:id { autonomy: true } →
    // operations.ts#updateProject → orchestrator.resetAutonomyStreak. Exercise
    // the orchestrator's own reset call directly (operations.ts is a thin
    // pass-through covered by its own suite) alongside flipping the flag the
    // same way the operator's PATCH would.
    await store.putProject({ ...(await store.getProject("p1"))!, autonomy: true });
    orch.resetAutonomyStreak("p1");

    // A single flag right after re-enabling must NOT immediately re-trip —
    // proof the streak actually reset to 0, not just that autonomy flipped on.
    await reviewRound(store, orch, provider, 7, FLAG);
    expect((await store.getProject("p1"))?.autonomy).toBe(true);
  });

  it("resolving the summary escalation just dismisses it — no run-lifecycle side effect on the last run", async () => {
    const { store, orch, provider } = await setup();
    for (const n of [1, 2, 3]) await reviewRound(store, orch, provider, n, FLAG);
    const item = (await store.listQueue(DEFAULT_WORKSPACE)).find(
      (q) => q.kind === "escalation" && q.flags?.includes("autonomy-paused"),
    )!;
    const runBefore = await store.getRun(item.runId);
    // "Reject" on a REAL escalation would stop the run and mark it done — that
    // must NOT happen here; the item is informational only.
    await orch.deliver(item, { action: "reject", optionIndex: null, guidance: null, targetBranch: null, memoryNote: null, by: "jordan", at: 1 });
    const runAfter = await store.getRun(item.runId);
    expect(runAfter?.status).toBe(runBefore?.status); // untouched
  });
});
