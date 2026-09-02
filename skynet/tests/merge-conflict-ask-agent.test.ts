// Merge conflicts used to discard everything but a file list — MergeEngine ran
// `merge --abort` before the conflict markers were ever captured, so an
// operator's only options were to reconcile it themselves or type out
// instructions blind. Now the actual conflict (git diff, including the
// <<<<<<</=======/>>>>>>> markers) is captured before the abort and rides the
// merge HITL's `output`; clicking Modify with NO typed guidance is enough to
// resume the agent with that real conflict as its task. Drives the real
// Orchestrator + MergeEngine against real git repos end to end (diff-approve →
// merge conflict → Modify → the resumed agent's actual prompt), not a mock.
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

// Writes different content to the same file on each successive start() call —
// the first two calls (one per run) create the conflicting commits; a third
// call (the resumed "fix it" turn) just records its prompt without editing
// anything further, so the test can inspect exactly what the agent was told.
class ConflictingProvider implements RunnerProvider {
  readonly id: ProviderId = "claude";
  starts: StartSpec[] = [];
  async start(spec: StartSpec, events: RunnerEvents): Promise<RunnerHandle> {
    this.starts.push(spec);
    if (this.starts.length <= 2) {
      writeFileSync(join(spec.cwd!, "shared.txt"), this.starts.length === 1 ? "version A\n" : "version B\n");
    }
    setTimeout(() => events.onCompleted(spec.runId, spec.branch), 0);
    return { runId: spec.runId, provider: this.id, async pause() {}, async resume() {}, async message() {}, async stop() {} };
  }
}

let Hub: typeof import("../apps/server/src/hub.js").Hub;
let Orchestrator: typeof import("../apps/server/src/orchestrator.js").Orchestrator;
let Operations: typeof import("../apps/server/src/operations.js").Operations;
let MemoryStore: typeof import("../apps/server/src/store/memory.js").MemoryStore;
let repo: string, worktreesDir: string;

const waitFor = async (pred: () => Promise<boolean>, ms = 8000) => {
  const dl = Date.now() + ms;
  while (Date.now() < dl) {
    if (await pred()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("timeout");
};

beforeAll(async () => {
  repo = mkdtempSync(join(tmpdir(), "skynet-conflict-fix-repo-"));
  worktreesDir = mkdtempSync(join(tmpdir(), "skynet-conflict-fix-wt-"));
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
  ({ Operations } = await import("../apps/server/src/operations.js"));
  ({ MemoryStore } = await import("../apps/server/src/store/memory.js"));
});
afterAll(() => {
  rmSync(repo, { recursive: true, force: true });
  rmSync(worktreesDir, { recursive: true, force: true });
});

describe("a merge conflict's captured diff can resume the agent with zero typing", () => {
  it("Modify with blank guidance resumes the SECOND run with the actual conflict markers as its task", async () => {
    const store = new MemoryStore({ seed: false });
    const hub = new Hub(store, new NullBus());
    const provider = new ConflictingProvider();
    const orchestrator = new Orchestrator(store, hub, provider);
    const ops = new Operations({ store, hub, orchestrator });
    await store.putProject({ id: "p1", workspaceId: DEFAULT_WORKSPACE, name: "P", goal: "", runIds: [], status: "active", repoPath: null, gitBacked: false } as Project);
    await store.putAgent({ id: "r1", workspaceId: DEFAULT_WORKSPACE, name: "r1", provider: "claude", model: "opus-4.8", status: "idle", idleSince: 0 } as Agent);
    await store.putTask({ id: "ta", workspaceId: DEFAULT_WORKSPACE, projectId: "p1", text: "edit shared A", state: "backlog", runId: null } as Task);
    await store.putTask({ id: "tb", workspaceId: DEFAULT_WORKSPACE, projectId: "p1", text: "edit shared B", state: "backlog", runId: null } as Task);

    const openOf = async (kind: HitlItem["kind"]) =>
      (await store.listQueue(DEFAULT_WORKSPACE)).find((q) => q.kind === kind && q.resolvedAt == null);

    // Run A: completes, its diff auto-raises, approve it → clean merge (first
    // to land, nothing to conflict with yet).
    const runA = await orchestrator.assignTask("p1", "ta");
    await waitFor(async () => !!(await openOf("diff")));
    const diffA = (await openOf("diff"))!;
    expect(diffA.runId).toBe(runA.id);
    await ops.resolveHitl(DEFAULT_WORKSPACE, diffA.id, { action: "approve" }, "op-1");
    await waitFor(async () => (await store.getRun(runA.id))?.status === "done");

    // A different runner slot for run B (A's is now idle again, but a run
    // needs an available runner — reuse r1, it's free again).
    const runB = await orchestrator.assignTask("p1", "tb");
    await waitFor(async () => !!(await openOf("diff")));
    const diffB = (await openOf("diff"))!;
    expect(diffB.runId).toBe(runB.id);
    await ops.resolveHitl(DEFAULT_WORKSPACE, diffB.id, { action: "approve" }, "op-1");

    // B's merge conflicts with A's already-landed change.
    await waitFor(async () => !!(await openOf("merge")));
    const mergeItem = (await openOf("merge"))!;
    expect(mergeItem.runId).toBe(runB.id);
    expect(mergeItem.output).toBeTruthy();
    // The RESOLVED target branch (no featureId, no operator override here —
    // the project's own default integration branch) is named up front, not
    // left for the agent to guess from "the target branch" alone.
    expect(mergeItem.output).toContain("Target branch: skynet/integration/p1");
    expect(mergeItem.output).toContain("<<<<<<<");
    expect(mergeItem.output).toContain("version A");
    expect(mergeItem.output).toContain("version B");
    // TASK 15 — a REAL same-file collision carries the "file_collision" tag
    // (alongside the conflicting file itself) so a cross-project consumer can
    // tell it apart from an ordinary `kind:"merge"` item that isn't one.
    expect(mergeItem.flags).toContain("file_collision");
    expect(mergeItem.flags).toContain("shared.txt");

    // Modify with NO typed guidance — the button the operator clicks with
    // zero typing ("Ask agent to fix" in the UI).
    expect(provider.starts).toHaveLength(2); // one per run so far
    await ops.resolveHitl(DEFAULT_WORKSPACE, mergeItem.id, { action: "modify" }, "op-1");
    await waitFor(async () => provider.starts.length >= 3);

    const resumedPrompt = provider.starts[2]!.task;
    expect(provider.starts[2]!.runId).toBe(runB.id);
    // The agent's task genuinely contains the real conflict, not a vague
    // "make changes" instruction with nothing to act on.
    expect(resumedPrompt).toContain("<<<<<<<");
    expect(resumedPrompt).toContain("version A");
    expect(resumedPrompt).toContain("version B");
    expect(resumedPrompt).toMatch(/merge conflict/i);
    // The real target ref rides the prompt, and the agent is told it can go
    // look at that branch's actual current content directly rather than
    // reconstructing the merge blind from the diff snippet alone.
    expect(resumedPrompt).toContain("Target branch: skynet/integration/p1");
    expect(resumedPrompt).toMatch(/git show|git diff/);
  });
});
