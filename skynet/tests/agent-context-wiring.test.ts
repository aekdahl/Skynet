// S1: buildAgentContext's goal/feature threading, proven on the three
// call sites that need a REAL git worktree to reach (checkpoint restore,
// the modify-review revise loop, and an escalation resume) — the lighter
// assign/fork paths are already covered with an in-memory RecordingProvider
// in tests/project-instructions.test.ts. Each test here drives the actual
// orchestrator against a throwaway git repo (same harness as
// tests/review-modify-revise.test.ts / tests/escalation.test.ts) with a
// provider that RECORDS every StartSpec it's given, so we can assert the
// project's goal (and, where a task carries one, its Feature) actually
// reaches the runner's prompt at each of these later-lifecycle restarts —
// not just the initial assign.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_WORKSPACE } from "@skynet/shared";
import type { Agent, ProviderId, Resolution, ServerEvent, HitlItem } from "@skynet/shared";
import type { RunnerEvents, RunnerHandle, RunnerProvider, StartSpec } from "@skynet/runner-sdk";
import { Hub } from "../apps/server/src/hub.js";
import { Orchestrator } from "../apps/server/src/orchestrator.js";
import { Operations } from "../apps/server/src/operations.js";
import { MemoryStore } from "../apps/server/src/store/memory.js";
import type { Bus } from "../apps/server/src/bus.js";

class RecordingBus implements Bus {
  events: ServerEvent[] = [];
  publish(_ws: string, event: ServerEvent): void {
    this.events.push(event);
  }
  subscribe(): () => void {
    return () => {};
  }
  raised(): HitlItem[] {
    return this.events.filter((e) => e.type === "hitl.raised").map((e) => (e as { item: HitlItem }).item);
  }
}

class RecordingHandle implements RunnerHandle {
  readonly provider: ProviderId = "claude";
  resumeCalls: Array<Resolution | undefined> = [];
  stopCalls = 0;
  constructor(readonly runId: string) {}
  async pause(): Promise<void> {}
  async message(): Promise<void> {}
  async resume(decision?: Resolution): Promise<void> {
    this.resumeCalls.push(decision);
  }
  async stop(): Promise<void> {
    this.stopCalls++;
  }
}

/** Records every StartSpec it's handed, and never completes a run on its own —
 *  tests drive completion/failure explicitly via the captured RunnerEvents.
 *  Writes a small change into the worktree on every start() so `complete()`
 *  always finds something to commit (raising the diff review that the
 *  revise-loop test needs) instead of taking the "nothing to integrate" path. */
class RecordingProvider implements RunnerProvider {
  readonly id: ProviderId = "claude";
  specs: StartSpec[] = [];
  events = new Map<string, RunnerEvents>();
  handles = new Map<string, RecordingHandle>();
  async start(spec: StartSpec, events: RunnerEvents): Promise<RunnerHandle> {
    this.specs.push(spec);
    this.events.set(spec.runId, events);
    if (spec.cwd) writeFileSync(join(spec.cwd, "OUTPUT.md"), `run ${spec.runId} turn ${this.specs.length}\n`);
    const h = new RecordingHandle(spec.runId);
    this.handles.set(spec.runId, h);
    return h;
  }
}

const waitFor = async (pred: () => Promise<boolean> | boolean, ms = 3000): Promise<void> => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await pred()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("condition not met in time");
};

describe("buildAgentContext wiring — checkpoint restore / revise / escalation resume", () => {
  let repo: string;
  let store: MemoryStore;
  let bus: RecordingBus;
  let hub: Hub;
  let provider: RecordingProvider;
  let orchestrator: Orchestrator;
  let ops: Operations;

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "agent-context-wiring-repo-"));
    execFileSync("git", ["init", "-q", "-b", "main", repo]);
    execFileSync("git", ["-C", repo, "config", "user.email", "t@t"]);
    execFileSync("git", ["-C", repo, "config", "user.name", "t"]);
    writeFileSync(join(repo, "README.md"), "base\n");
    execFileSync("git", ["-C", repo, "add", "-A"]);
    execFileSync("git", ["-C", repo, "commit", "-q", "-m", "base"]);

    store = new MemoryStore({ seed: false });
    bus = new RecordingBus();
    hub = new Hub(store, bus);
    provider = new RecordingProvider();
    orchestrator = new Orchestrator(store, hub, provider);
    ops = new Operations({ store, hub, orchestrator });
  });

  afterEach(() => {
    rmSync(repo, { recursive: true, force: true });
  });

  const setUpProjectAndFeatureTask = async () => {
    await store.putAgent({ id: "r1", workspaceId: DEFAULT_WORKSPACE, name: "r1", provider: "claude", model: "opus-4.8", status: "idle", idleSince: 0 } as Agent);
    const project = await ops.createProject(DEFAULT_WORKSPACE, {
      name: "Acme",
      goal: "Ship the checkout redesign",
      repoPath: repo,
    });
    const feature = await ops.createFeature(DEFAULT_WORKSPACE, project.id, {
      name: "Checkout redesign",
      description: "A new one-page checkout flow.",
    });
    const task = await ops.createTask(DEFAULT_WORKSPACE, project.id, { text: "Add a health check endpoint" });
    await ops.updateTask(DEFAULT_WORKSPACE, task.id, { featureId: feature.id });
    const run = await ops.assignTask(DEFAULT_WORKSPACE, project.id, task.id);
    return { project, feature, task, run };
  };

  it("restoreCheckpoint: the relaunched prompt carries the project's goal and the task's feature", async () => {
    const { run } = await setUpProjectAndFeatureTask();
    const checkpoint = await orchestrator.checkpoint(run.id, "before the risky part");

    provider.specs.length = 0; // only care about the relaunch's own spec below
    await orchestrator.restoreCheckpoint(run.id, checkpoint.id);

    expect(provider.specs).toHaveLength(1);
    const { task } = provider.specs[0]!;
    expect(task).toContain("=== PROJECT ===");
    expect(task).toContain("Ship the checkout redesign");
    expect(task).toContain("=== FEATURE ===");
    expect(task).toContain("Checkout redesign");
    expect(task).toContain("A new one-page checkout flow.");
  });

  it("reviseAfterReview (modify on a finished diff review): the revise prompt carries the project's goal and the task's feature", async () => {
    const { run } = await setUpProjectAndFeatureTask();

    // Turn 1 finishes the run and its diff review is raised.
    const events = provider.events.get(run.id)!;
    events.onCompleted(run.id, run.branch);
    await waitFor(async () => bus.raised().some((i) => i.kind === "diff"));
    const diffItem = bus.raised().find((i) => i.kind === "diff")!;

    // Completion frees the runner/live handle — the modify below re-acquires
    // compute fresh (reviseAfterReview), which is the path under test.
    provider.specs.length = 0;
    const resolution: Resolution = { action: "modify", optionIndex: null, guidance: "Add error handling.", targetBranch: null, memoryNote: null, by: "test", at: Date.now() };
    await hub.resolveHitl(diffItem.id, resolution);
    await orchestrator.deliver(diffItem, resolution);

    await waitFor(async () => provider.specs.length > 0);
    const { task } = provider.specs[0]!;
    expect(task).toContain("=== PROJECT ===");
    expect(task).toContain("Ship the checkout redesign");
    expect(task).toContain("=== FEATURE ===");
    expect(task).toContain("Checkout redesign");
    expect(task).toContain("Add error handling.");
  });

  it("escalation resume (relaunchEscalated): the resumed prompt carries the project's goal and the task's feature", async () => {
    const { run } = await setUpProjectAndFeatureTask();

    // Simulate a server restart: the in-memory live handle is gone, the
    // heartbeat is stale — the reaper escalates it as "stalled" and resumable.
    const cur = (await store.getRun(run.id))!;
    await store.putRun({ ...cur, status: "running", lastHeartbeatAt: 0 });
    await orchestrator.reapStaleAgents();
    await waitFor(async () => bus.raised().some((i) => i.kind === "escalation"));
    const esc = bus.raised().find((i) => i.kind === "escalation")!;

    provider.specs.length = 0; // only care about the relaunch's own spec below
    await ops.resolveHitl(DEFAULT_WORKSPACE, esc.id, { action: "modify", guidance: "Try a different approach." }, "op-1");

    await waitFor(async () => provider.specs.length > 0);
    const { task } = provider.specs[0]!;
    expect(task).toContain("=== PROJECT ===");
    expect(task).toContain("Ship the checkout redesign");
    expect(task).toContain("=== FEATURE ===");
    expect(task).toContain("Checkout redesign");
    expect(task).toContain("Try a different approach.");
  });
});
