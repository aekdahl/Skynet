// Repo-optional / chat-only mode (ROADMAP.md "Easier to use than anyone else").
// A project with no bound repo (repoPath: null, repo: undefined) already runs
// through the pre-existing "Phase 0" path in orchestrator.ts: gitContextFor()
// resolves to `undefined`, so assignTask/fork never touch WorktreeProvisioner,
// and complete() skips the commit→diff-review→merge branch entirely, going
// straight to "Phase 0 / no-diff completion" — no worktree, no diff HITL, no
// merge. What THIS test actually guards is the hardening on top of that
// mechanism: a chat-only run must get an isolated per-run scratch cwd (never
// `undefined`, which every runner-sdk provider falls back to `process.cwd()`
// for — i.e. the SERVER's own directory), and that scratch dir must be
// cleaned up once the run ends.
import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import type { Agent, Project, Task, ServerEvent } from "@skynet/shared";
import { DEFAULT_WORKSPACE } from "@skynet/shared";
import { Hub } from "../apps/server/src/hub.js";
import { Orchestrator } from "../apps/server/src/orchestrator.js";
import { MemoryStore } from "../apps/server/src/store/memory.js";
import type { Bus } from "../apps/server/src/bus.js";
import type { RunnerEvents, RunnerHandle, RunnerProvider, StartSpec } from "@skynet/runner-sdk";

class NullBus implements Bus {
  publish(_ws: string, _e: ServerEvent): void {}
  subscribe(): () => void {
    return () => {};
  }
}

// Captures the cwd each run actually started with, and completes it
// immediately (no diff) — the same "finished with nothing to integrate" shape
// a real runner reports when it made no changes.
class RecordingProvider implements RunnerProvider {
  readonly id = "claude" as const;
  cwds: (string | undefined)[] = [];
  async start(spec: StartSpec, e: RunnerEvents): Promise<RunnerHandle> {
    this.cwds.push(spec.cwd);
    // A macrotask, not a microtask: a real runner reports completion only
    // after start() has already returned and the caller's `await` has resumed
    // (recording the live-run entry) — queueMicrotask here would race ahead of
    // that continuation and fire before assignTask finishes bookkeeping.
    setTimeout(() => e.onCompleted(spec.runId, spec.branch), 0);
    return { runId: spec.runId, provider: this.id, async pause() {}, async resume() {}, async message() {}, async stop() {} };
  }
  async consult(): Promise<string> {
    return "ok";
  }
}

// No repoPath, no repo — gitContextFor(project) resolves to undefined (see
// orchestrator.ts's own doc comment on that method).
const chatOnlyProject: Project = {
  id: "p1", workspaceId: DEFAULT_WORKSPACE, name: "P", goal: "", runIds: [],
  status: "active", autonomy: true, repoPath: null, gitBacked: false,
};
const idleAgent: Agent = {
  id: "a1", workspaceId: DEFAULT_WORKSPACE, name: "a1", provider: "claude",
  model: "opus-4.8", status: "idle", idleSince: 0,
};
const task: Task = {
  id: "t1", workspaceId: DEFAULT_WORKSPACE, projectId: "p1", text: "say hi", state: "backlog",
  runId: null, autoPick: false, assessment: null, reviewVerdict: null, lint: null,
  assignment: { mode: "any", agentIds: [] },
};

const setup = async () => {
  const store = new MemoryStore();
  const hub = new Hub(store, new NullBus());
  const provider = new RecordingProvider();
  const orch = new Orchestrator(store, hub, provider);
  await store.putProject(chatOnlyProject);
  await store.putAgent(idleAgent);
  await store.putTask(task);
  return { store, orch, provider };
};

// complete() is fired-and-forgotten from RunnerEvents.onCompleted (`void
// this.complete(...)`), so nothing in this test's own call stack can be
// awaited to know when it's done. Poll instead of guessing a fixed number of
// event-loop ticks — robust regardless of how many internal awaits complete()
// takes (freeRunner → getTask → upsertTask → runStatus → runCompleted).
async function waitUntil(check: () => Promise<boolean>, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!(await check())) {
    if (Date.now() - start > timeoutMs) throw new Error("waitUntil: condition never became true");
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("chat-only run (no bound repo)", () => {
  it("never provisions a worktree and gets a real, isolated scratch cwd", async () => {
    const { orch, provider } = await setup();
    await orch.assignTask("p1", "t1");

    expect(provider.cwds).toHaveLength(1);
    const cwd = provider.cwds[0];
    // A real path was minted — never left undefined for the runner-sdk's own
    // process.cwd() fallback to kick in.
    expect(cwd).toBeTruthy();
    expect(cwd).not.toBe(process.cwd());
    expect(existsSync(cwd!)).toBe(true);
  });

  it("completes via Phase-0 (no diff HITL, no merge) and cleans up its scratch dir", async () => {
    const { store, orch, provider } = await setup();
    await orch.assignTask("p1", "t1");
    const cwd = provider.cwds[0]!;
    expect(existsSync(cwd)).toBe(true);

    // Let the queued onCompleted() (fired from RecordingProvider.start) drive
    // orchestrator.complete() through to its terminal state.
    await waitUntil(async () => {
      const run = (await store.listRuns(DEFAULT_WORKSPACE)).find((r) => r.projectId === "p1");
      return run?.status === "done";
    });

    const updatedTask = await store.getTask("t1");
    expect(updatedTask?.state).toBe("done");
    // The scratch dir is gone — never leaked past run completion.
    expect(existsSync(cwd)).toBe(false);
  });

  it("two runs each get their own distinct scratch dir", async () => {
    const { store, orch, provider } = await setup();
    await store.putTask({ ...task, id: "t2", text: "say bye" });
    await store.putAgent({ ...idleAgent, id: "a2" });

    await orch.assignTask("p1", "t1");
    const firstCwd = provider.cwds[0]!;
    // The first run's own onCompleted may already be racing to clean up its
    // scratch dir on a real timer — capture its path before asserting
    // anything else about it, and assert distinctness (the real invariant:
    // isolation), not simultaneous existence.
    await orch.assignTask("p1", "t2");
    const secondCwd = provider.cwds[1]!;

    expect(provider.cwds).toHaveLength(2);
    expect(firstCwd).not.toBe(secondCwd);
    // The second run's dir is fresh — nothing has had a chance to complete it yet.
    expect(existsSync(secondCwd)).toBe(true);
  });
});
