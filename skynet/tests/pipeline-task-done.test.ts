import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_WORKSPACE } from "@skynet/shared";
import type { ProviderId, Project, Agent, Task, Resolution, HitlItem } from "@skynet/shared";
import type { RunnerEvents, RunnerHandle, RunnerProvider, StartSpec } from "@skynet/runner-sdk";
import type { Bus } from "../apps/server/src/bus.js";

class NullBus implements Bus { publish(): void {} subscribe(): () => void { return () => {}; } }

class EditOnceProvider implements RunnerProvider {
  readonly id: ProviderId = "claude";
  async start(spec: StartSpec, events: RunnerEvents): Promise<RunnerHandle> {
    writeFileSync(join(spec.cwd!, "skynet-sim.txt"), "pipeline\n");
    setTimeout(() => events.onCompleted(spec.runId, spec.branch), 0);
    return { runId: spec.runId, provider: this.id, async pause() {}, async resume() {}, async message() {}, async stop() {} };
  }
}

let Hub: typeof import("../apps/server/src/hub.js").Hub;
let Orchestrator: typeof import("../apps/server/src/orchestrator.js").Orchestrator;
let MemoryStore: typeof import("../apps/server/src/store/memory.js").MemoryStore;
let repo: string, worktreesDir: string;
const git = (...a: string[]) => execFileSync("git", ["-C", repo, ...a], { stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
const waitFor = async (pred: () => Promise<boolean>, ms = 5000) => {
  const dl = Date.now() + ms;
  while (Date.now() < dl) { if (await pred()) return; await new Promise((r) => setTimeout(r, 10)); }
  throw new Error("timeout");
};

beforeAll(async () => {
  repo = mkdtempSync(join(tmpdir(), "skynet-pipe-repo-"));
  worktreesDir = mkdtempSync(join(tmpdir(), "skynet-pipe-wt-"));
  execFileSync("git", ["init", "-b", "main", repo]);
  git("config", "user.email", "t@t.local"); git("config", "user.name", "T");
  writeFileSync(join(repo, "README.md"), "# base\n"); git("add", "-A"); git("commit", "-m", "base");
  process.env.STORE = "memory"; process.env.BUS = "memory";
  process.env.SKYNET_INTEGRATION_REPO = repo; process.env.SKYNET_WORKTREES_DIR = worktreesDir;
  process.env.SKYNET_BASE_BRANCH = "main"; delete process.env.RUNNER;
  ({ Hub } = await import("../apps/server/src/hub.js"));
  ({ Orchestrator } = await import("../apps/server/src/orchestrator.js"));
  ({ MemoryStore } = await import("../apps/server/src/store/memory.js"));
});
afterAll(() => { rmSync(repo, { recursive: true, force: true }); rmSync(worktreesDir, { recursive: true, force: true }); });

describe("full run pipeline: owning task reaches done on merge", () => {
  it("edit → diff review → approve → merge: run AND task both end done", async () => {
    const store = new MemoryStore({ seed: false });
    const hub = new Hub(store, new NullBus());
    const orchestrator = new Orchestrator(store, hub, new EditOnceProvider());
    await store.putProject({ id: "p1", workspaceId: DEFAULT_WORKSPACE, name: "P", goal: "", runIds: [], status: "active", repoPath: null, gitBacked: false } as Project);
    await store.putAgent({ id: "r1", workspaceId: DEFAULT_WORKSPACE, name: "r1", provider: "claude", model: "opus-4.8", status: "idle", idleSince: 0 } as Agent);
    await store.putTask({ id: "t1", workspaceId: DEFAULT_WORKSPACE, projectId: "p1", text: "create a file", state: "backlog", runId: null } as Task);

    const openDiff = async (): Promise<HitlItem | undefined> =>
      (await store.listQueue(DEFAULT_WORKSPACE)).find((q) => q.kind === "diff" && q.resolvedAt == null);

    const run = await orchestrator.assignTask("p1", "t1");
    await waitFor(openDiff);
    // Sanity: task points at the run, and is in review.
    const t = await store.getTask("t1");
    expect(t?.runId).toBe(run.id);
    expect(t?.state).toBe("review");

    const item = (await openDiff())!;
    const resolution: Resolution = { action: "approve", optionIndex: null, guidance: null, targetBranch: null, memoryNote: null, by: "jordan", at: Date.now() };
    const r = await hub.resolveHitl(item.id, resolution);
    if (r?.resolution?.at === resolution.at) await orchestrator.deliver(item, resolution);

    // Assert off the SNAPSHOT (as the sim journey does via fetchSnapshot), not the
    // store directly — the journey settles on run=done then reads the task from
    // that SAME snapshot. If snapshot() reads runs and tasks non-atomically, a
    // concurrent merge write can yield run=done + task=review.
    let snap = await store.snapshot(DEFAULT_WORKSPACE);
    await waitFor(async () => {
      snap = await store.snapshot(DEFAULT_WORKSPACE);
      return snap.runs.find((a) => a.id === run.id)?.status === "done";
    });
    const snapRun = snap.runs.find((a) => a.id === run.id);
    const snapTask = snap.tasks.find((t) => t.id === "t1");
    expect(snapRun?.status).toBe("done");
    expect(snapTask?.state).toBe("done"); // <-- the invariant the sim journey checks
  });

  // Regression guard: completeMerged must advance the task to done even when the
  // runId→task match can't be made (the failure seen on the shared board). It now
  // resolves via the exact taskId stashed at review, so a stale/missing task.runId
  // no longer strands the task in `review` after its run reaches `done`.
  it("task still reaches done when the runId→task match fails (resolved via taskId)", async () => {
    const store = new MemoryStore({ seed: false });
    const hub = new Hub(store, new NullBus());
    const orchestrator = new Orchestrator(store, hub, new EditOnceProvider());
    await store.putProject({ id: "p2", workspaceId: DEFAULT_WORKSPACE, name: "P2", goal: "", runIds: [], status: "active", repoPath: null, gitBacked: false } as Project);
    await store.putAgent({ id: "r2", workspaceId: DEFAULT_WORKSPACE, name: "r1", provider: "claude", model: "opus-4.8", status: "idle", idleSince: 0 } as Agent);
    await store.putTask({ id: "t2", workspaceId: DEFAULT_WORKSPACE, projectId: "p2", text: "create a file", state: "backlog", runId: null } as Task);

    const openDiff = async () => (await store.listQueue(DEFAULT_WORKSPACE)).find((q) => q.kind === "diff" && q.resolvedAt == null);
    const run = await orchestrator.assignTask("p2","t2");
    await waitFor(openDiff);

    // Simulate the lookup failure: break the task's runId so find(t.runId===runId)
    // can no longer match it. The exact-taskId path must still carry it to done.
    const t = (await store.getTask("t2"))!;
    await store.putTask({ ...t, runId: "MISMATCH" });

    const item = (await openDiff())!;
    const resolution: Resolution = { action: "approve", optionIndex: null, guidance: null, targetBranch: null, memoryNote: null, by: "jordan", at: Date.now() };
    const r = await hub.resolveHitl(item.id, resolution);
    if (r?.resolution?.at === resolution.at) await orchestrator.deliver(item, resolution);

    await waitFor(async () => (await store.getRun(run.id))?.status === "done");
    expect((await store.getTask("t2"))?.state).toBe("done"); // not stranded in review
  });
});
