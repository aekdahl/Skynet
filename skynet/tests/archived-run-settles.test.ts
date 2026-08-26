// Archiving a run must SETTLE it, not just hide it.
//
// Reported live: a run showing "REVIEW", offering Fork/Pause/Stop, still naming
// its agent — while being archived, with a 4-day-old heartbeat. Archiving was
// cosmetic: setRunArchived flipped a boolean and nothing else, so the run kept
// its non-terminal status and its runner forever. Worse, gcWorktrees' stuck-
// review sweep deliberately SKIPS archived runs, so nothing could ever finish
// one off — the live deployment had 14 such zombies.
//
// Archiving IS the operator saying "I'm done with this". It now stops the run,
// hands the runner back, dismisses any orphaned gate, marks the run terminal
// and releases the owning task — but deliberately KEEPS the worktree, because
// archive is documented as a reversible soft-hide that never deletes.
import { describe, it, expect } from "vitest";
import type { HitlItem, ProviderId, ServerEvent, Task } from "@skynet/shared";
import { DEFAULT_WORKSPACE } from "@skynet/shared";
import { Hub } from "../apps/server/src/hub.js";
import { Operations } from "../apps/server/src/operations.js";
import { Orchestrator } from "../apps/server/src/orchestrator.js";
import { MemoryStore } from "../apps/server/src/store/memory.js";
import type { Bus } from "../apps/server/src/bus.js";
import type { RunnerEvents, RunnerHandle, RunnerProvider, StartSpec } from "@skynet/runner-sdk";

class RecordingBus implements Bus {
  events: ServerEvent[] = [];
  publish(_ws: string, event: ServerEvent): void { this.events.push(event); }
  subscribe(): () => void { return () => {}; }
}
class NoopProvider implements RunnerProvider {
  readonly id: ProviderId = "claude";
  async start(spec: StartSpec, _e: RunnerEvents): Promise<RunnerHandle> {
    return { runId: spec.runId, provider: this.id, async pause() {}, async resume() {}, async message() {}, async stop() {} };
  }
}

const setup = () => {
  const store = new MemoryStore({ seed: false });
  const bus = new RecordingBus();
  const hub = new Hub(store, bus);
  const orchestrator = new Orchestrator(store, hub, new NoopProvider());
  const ops = new Operations({ store, hub, orchestrator });
  return { store, bus, hub, orchestrator, ops };
};

/** A run parked in `review` on a busy runner, with its task pointing at it. */
const parkedInReview = async (store: MemoryStore, over: { status?: string; archived?: boolean } = {}) => {
  await store.putAgent({
    id: "r1", workspaceId: DEFAULT_WORKSPACE, name: "r1", provider: "claude",
    model: "sonnet-5", status: "busy", idleSince: null,
  });
  await store.putRun({
    id: "run-1", workspaceId: DEFAULT_WORKSPACE, projectId: "p1", name: "t", status: (over.status ?? "review") as never,
    agentId: "r1", provider: "claude", credentialId: null, model: "sonnet-5", branch: "agent/run-1",
    modules: [], progress: 1, plan: [], usage: null, modifiedFiles: [], log: [], startedAt: 0,
    lastHeartbeatAt: 0, visual: false, previewUrl: null, dependsOn: [], parentId: null,
    branchFromStep: null, archived: over.archived ?? false, pr: null, mergedAt: null, flyDeployment: null,
  });
  await store.putTask({
    id: "task-1", workspaceId: DEFAULT_WORKSPACE, projectId: "p1", text: "do it", description: null,
    state: "review", runId: "run-1", autoPick: false, assessment: null, assessmentEffort: null,
    assessmentRisks: [], reviewVerdict: null, assignment: { mode: "any", agentIds: [] }, archived: false,
    estimatedDurationMs: null, plannedStartAt: null, featureId: null, milestoneId: null,
    source: null, lint: null, briefId: null, preferredProvider: null, preferredModel: null, order: 0,
  } as unknown as Task);
};

describe("archiving a mid-flight run settles it", () => {
  it("a run archived from `review` becomes terminal instead of staying in review forever", async () => {
    const { store, ops } = setup();
    await parkedInReview(store);
    await ops.archiveAgent(DEFAULT_WORKSPACE, "run-1", true);
    const run = (await store.getRun("run-1"))!;
    // The exact reported symptom: archived, yet still "REVIEW".
    expect(run.archived).toBe(true);
    expect(run.status).toBe("done");
  });

  it("hands the runner back — an archived run must not hold fleet capacity", async () => {
    const { store, ops } = setup();
    await parkedInReview(store);
    expect((await store.getAgent("r1"))!.status).toBe("busy");
    await ops.archiveAgent(DEFAULT_WORKSPACE, "run-1", true);
    expect((await store.getAgent("r1"))!.status).toBe("idle");
  });

  it("releases the owning task rather than stranding it on a hidden run", async () => {
    const { store, ops } = setup();
    await parkedInReview(store);
    await ops.archiveAgent(DEFAULT_WORKSPACE, "run-1", true);
    const task = (await store.getTask("task-1"))!;
    expect(task.state).toBe("todo");
    expect(task.runId).toBeNull();
  });

  it("dismisses a gate still pointing at the run — no orphan left in the Inbox", async () => {
    const { store, hub, ops } = setup();
    await parkedInReview(store);
    const gate: HitlItem = {
      id: "q-1", workspaceId: DEFAULT_WORKSPACE, runId: "run-1", kind: "diff", title: "review me",
      why: null, rationale: null, risk: "low", command: null, options: null, recommended: null,
      steps: null, diff: null, flags: [], raisedAt: 0, resolvedAt: null, resolution: null,
    } as unknown as HitlItem;
    await hub.raiseHitl(gate);
    await ops.archiveAgent(DEFAULT_WORKSPACE, "run-1", true);
    expect((await store.getHitl("q-1"))!.resolvedAt).not.toBeNull();
  });

  it("KEEPS the branch — archive is a reversible soft-hide, not a delete", async () => {
    const { store, ops } = setup();
    await parkedInReview(store);
    await ops.archiveAgent(DEFAULT_WORKSPACE, "run-1", true);
    // The run's own record still names its branch, so unarchiving still points
    // at real work. (settleArchivedRun deliberately skips the worktree retire
    // that haltAgent/stopAgent do.)
    expect((await store.getRun("run-1"))!.branch).toBe("agent/run-1");
  });

  it("UN-archiving is untouched — it never resurrects or re-settles anything", async () => {
    const { store, ops } = setup();
    await parkedInReview(store);
    await ops.archiveAgent(DEFAULT_WORKSPACE, "run-1", true);
    const restored = await ops.archiveAgent(DEFAULT_WORKSPACE, "run-1", false);
    expect(restored.archived).toBe(false);
    expect(restored.status).toBe("done"); // honest: it was settled, not un-settled
  });

  it("archiving an ALREADY-terminal run changes nothing but the flag", async () => {
    const { store, ops } = setup();
    await parkedInReview(store, { status: "done" });
    await ops.archiveAgent(DEFAULT_WORKSPACE, "run-1", true);
    const run = (await store.getRun("run-1"))!;
    expect(run.status).toBe("done");
    expect(run.archived).toBe(true);
  });
});

describe("settleArchivedRuns — self-heals zombies archived before the fix", () => {
  it("settles a run that is already archived but stuck non-terminal", async () => {
    const { store, orchestrator } = setup();
    // Exactly the live shape: archived AND still "review" (the old code path).
    await parkedInReview(store, { archived: true });
    const healed = await orchestrator.settleArchivedRuns();
    expect(healed).toBe(1);
    expect((await store.getRun("run-1"))!.status).toBe("done");
    expect((await store.getAgent("r1"))!.status).toBe("idle");
  });

  it("is a cheap no-op once nothing is stuck", async () => {
    const { store, orchestrator } = setup();
    await parkedInReview(store, { status: "done", archived: true });
    expect(await orchestrator.settleArchivedRuns()).toBe(0);
  });

  it("never touches a live (non-archived) run", async () => {
    const { store, orchestrator } = setup();
    await parkedInReview(store); // archived: false
    expect(await orchestrator.settleArchivedRuns()).toBe(0);
    expect((await store.getRun("run-1"))!.status).toBe("review");
  });
});
