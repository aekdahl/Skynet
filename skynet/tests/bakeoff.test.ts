// Cross-vendor consensus runs ("bake-offs"): startBakeoff fans a task out to
// N providers sharing one baseRef/bakeoffId (all-or-nothing on acquisition/
// startup failure), and approving one sibling's diff HITL (deliver's
// collapseBakeoff) retires every other sibling and repoints the task at the
// winner. Uses a real git repo (like diff-review-requires-human.test.ts) so
// each sibling produces a genuine, mergeable diff.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_WORKSPACE } from "@skynet/shared";
import type { ProviderId, Project, Agent, Task, HitlItem } from "@skynet/shared";
import type { RunnerEvents, RunnerHandle, RunnerProvider, StartSpec } from "@skynet/runner-sdk";
import type { Bus } from "../apps/server/src/bus.js";

class NullBus implements Bus {
  publish(): void {}
  subscribe(): () => void {
    return () => {};
  }
}

// Writes a file unique to this run (so every sibling produces its own real,
// distinct diff against the same base commit) then completes.
class ScriptedProvider implements RunnerProvider {
  readonly id: ProviderId = "claude";
  starts = 0;
  async start(spec: StartSpec, events: RunnerEvents): Promise<RunnerHandle> {
    this.starts++;
    writeFileSync(join(spec.cwd!, `${spec.runId}.txt`), `written by ${spec.runId}\n`);
    setTimeout(() => events.onCompleted(spec.runId, spec.branch), 0);
    return { runId: spec.runId, provider: this.id, async pause() {}, async resume() {}, async message() {}, async stop() {} };
  }
}

let Hub: typeof import("../apps/server/src/hub.js").Hub;
let Orchestrator: typeof import("../apps/server/src/orchestrator.js").Orchestrator;
let MemoryStore: typeof import("../apps/server/src/store/memory.js").MemoryStore;
let repo: string, worktreesDir: string;

const waitFor = async (pred: () => Promise<boolean>, ms = 5000): Promise<void> => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await pred()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("condition not met in time");
};

beforeAll(async () => {
  repo = mkdtempSync(join(tmpdir(), "skynet-bo-repo-"));
  worktreesDir = mkdtempSync(join(tmpdir(), "skynet-bo-wt-"));
  execFileSync("git", ["init", "-b", "main", repo]);
  execFileSync("git", ["-C", repo, "config", "user.email", "t@t.local"]);
  execFileSync("git", ["-C", repo, "config", "user.name", "T"]);
  writeFileSync(join(repo, "README.md"), "# base\n");
  execFileSync("git", ["-C", repo, "add", "-A"]);
  execFileSync("git", ["-C", repo, "commit", "-m", "base"]);
  process.env.STORE = "memory";
  process.env.BUS = "memory";
  process.env.SKYNET_INTEGRATION_REPO = repo;
  process.env.SKYNET_WORKTREES_DIR = worktreesDir;
  process.env.SKYNET_BASE_BRANCH = "main";
  delete process.env.RUNNER;
  ({ Hub } = await import("../apps/server/src/hub.js"));
  ({ Orchestrator } = await import("../apps/server/src/orchestrator.js"));
  ({ MemoryStore } = await import("../apps/server/src/store/memory.js"));
});
afterAll(() => {
  rmSync(repo, { recursive: true, force: true });
  rmSync(worktreesDir, { recursive: true, force: true });
});

// Two fleet agents on DIFFERENT declared providers — providerOverride
// resolves both to the same injected instance regardless of id (see
// Orchestrator's `getProvider`/`providerUsable` test-seam handling), which is
// enough to exercise the fan-out/collapse ORCHESTRATION; genuine cross-vendor
// fidelity is a manual/e2e concern, not this suite's (same scoping call the
// implementation plan made for this suite).
async function seed(store: InstanceType<typeof MemoryStore>) {
  await store.putProject({
    id: "p1", workspaceId: DEFAULT_WORKSPACE, name: "P", goal: "", runIds: [], status: "active",
    repoPath: null, gitBacked: false,
  } as Project);
  await store.putAgent({ id: "r1", workspaceId: DEFAULT_WORKSPACE, name: "r1", provider: "claude", model: "opus-4.8", status: "idle", idleSince: 0 } as Agent);
  await store.putAgent({ id: "r2", workspaceId: DEFAULT_WORKSPACE, name: "r2", provider: "codex", model: "gpt-5.2-codex", status: "idle", idleSince: 0 } as Agent);
  await store.putTask({ id: "t1", workspaceId: DEFAULT_WORKSPACE, projectId: "p1", text: "bake-off task", state: "backlog", runId: null, bakeoffId: null } as Task);
}

const openDiffs = async (store: InstanceType<typeof MemoryStore>): Promise<HitlItem[]> =>
  (await store.listQueue(DEFAULT_WORKSPACE)).filter((q) => q.kind === "diff" && q.resolvedAt == null);

describe("Orchestrator.startBakeoff", () => {
  it("fans a task out to N providers sharing one bakeoffId + baseRef, task points at the anchor", async () => {
    const store = new MemoryStore({ seed: false });
    const hub = new Hub(store, new NullBus());
    const orchestrator = new Orchestrator(store, hub, new ScriptedProvider());
    await seed(store);

    const runs = await orchestrator.startBakeoff("p1", "t1", ["claude", "codex"]);
    expect(runs).toHaveLength(2);
    expect(new Set(runs.map((r) => r.provider))).toEqual(new Set(["claude", "codex"]));
    const bakeoffId = runs[0]!.bakeoffId;
    expect(bakeoffId).toBeTruthy();
    expect(runs[1]!.bakeoffId).toBe(bakeoffId);
    expect(runs.every((r) => r.parentId === null)).toBe(true);

    const task = await store.getTask("t1");
    expect(task?.bakeoffId).toBe(bakeoffId);
    expect(task?.runId).toBe(runs[0]!.id);
    expect(task?.state).toBe("ongoing");

    // Exactly 2 runs exist — no third spawn, no leaked idle capacity beyond
    // the 2 fleet agents this task actually used (ScriptedProvider completes
    // near-instantly, so by the time startBakeoff resolves either sibling may
    // already be back in "review"/idle — busy-at-this-instant isn't asserted).
    expect((await store.listRuns(DEFAULT_WORKSPACE)).length).toBe(2);
  });

  it("refuses fewer than 2 DISTINCT providers (no runner acquired)", async () => {
    const store = new MemoryStore({ seed: false });
    const hub = new Hub(store, new NullBus());
    const orchestrator = new Orchestrator(store, hub, new ScriptedProvider());
    await seed(store);

    await expect(orchestrator.startBakeoff("p1", "t1", ["claude"])).rejects.toThrow(/at least 2/);
    await expect(orchestrator.startBakeoff("p1", "t1", ["claude", "claude"])).rejects.toThrow(/at least 2/);
    expect((await store.listRuns(DEFAULT_WORKSPACE)).length).toBe(0);
    expect((await store.listAgents(DEFAULT_WORKSPACE)).every((a) => a.status === "idle")).toBe(true);
  });

  it("is all-or-nothing: a provider with no configured fleet agent rolls back every runner already acquired", async () => {
    const store = new MemoryStore({ seed: false });
    const hub = new Hub(store, new NullBus());
    const orchestrator = new Orchestrator(store, hub, new ScriptedProvider());
    await seed(store);
    // "gemini" has no fleet agent configured — must fail AFTER claude's runner
    // is already acquired, and that acquisition must be rolled back.
    await expect(orchestrator.startBakeoff("p1", "t1", ["claude", "gemini"])).rejects.toThrow(/No agent configured/);

    expect((await store.listRuns(DEFAULT_WORKSPACE)).length).toBe(0);
    const r1 = await store.getAgent("r1");
    expect(r1?.status).toBe("idle"); // rolled back, not left busy
    const task = await store.getTask("t1");
    expect(task?.state).toBe("backlog"); // never touched
    expect(task?.bakeoffId).toBeNull();
  });

  it("collapseBakeoff: approving one sibling's diff retires the others and repoints the task at the winner", async () => {
    const store = new MemoryStore({ seed: false });
    const hub = new Hub(store, new NullBus());
    const orchestrator = new Orchestrator(store, hub, new ScriptedProvider());
    await seed(store);

    const runs = await orchestrator.startBakeoff("p1", "t1", ["claude", "codex"]);
    const bakeoffId = runs[0]!.bakeoffId!;
    await waitFor(async () => (await openDiffs(store)).length === 2);

    const diffs = await openDiffs(store);
    expect(diffs.every((d) => d.bakeoffId === bakeoffId)).toBe(true);
    const winnerRunId = runs[0]!.id;
    const loserRunId = runs[1]!.id;
    const winnerHitl = diffs.find((d) => d.runId === winnerRunId)!;

    await orchestrator.deliver(winnerHitl, {
      action: "approve", optionIndex: null, guidance: null, targetBranch: null,
      memoryNote: null, resetWork: false, by: "op-1", at: Date.now(),
    });

    // The loser is retired: terminal status, dismissed HITL, no longer holding
    // the bake-off's group id hostage — collapseBakeoff runs synchronously
    // inside deliver(), before integrateRun, so this is true immediately.
    const loser = await store.getRun(loserRunId);
    expect(loser?.status).toBe("done");
    const loserHitl = (await store.listQueue(DEFAULT_WORKSPACE)).find((q) => q.runId === loserRunId && q.kind === "diff");
    expect(loserHitl?.resolvedAt).not.toBeNull();
    expect(loserHitl?.resolution?.action).toBe("dismiss");

    const taskRightAfter = await store.getTask("t1");
    expect(taskRightAfter?.bakeoffId).toBeNull();
    expect(taskRightAfter?.runId).toBe(winnerRunId);

    // The winner's own diff actually goes on to merge through the ordinary
    // local merge queue — collapseBakeoff didn't just repoint bookkeeping,
    // the approval it preceded still took effect.
    await waitFor(async () => (await store.getRun(winnerRunId))?.mergedAt != null);
    const finalTask = await store.getTask("t1");
    expect(finalTask?.state).toBe("done");
  });
});
