// Merge-conflict escape hatch: "push" lets an operator push the run's own
// branch and open a GitHub PR against the project's base branch EVEN THOUGH
// the local merge queue couldn't auto-merge it — so a human can reconcile on
// GitHub (which has real conflict-resolution tooling) instead of being
// blocked on an automated clean merge. Reuses the same push+PR path a normal
// diff approval takes when GitHub is connected (openPrForRun/pushToGithub);
// this only proves the merge CONFLICT no longer blocks reaching it.
//
// Real git for the conflict (same two-run harness as
// merge-conflict-ask-agent.test.ts); githubService stubbed for the push+PR
// call (no network), same pattern as feature-brief-orchestrator.test.ts.
//
// The two conflicting tasks are under a Feature: feature-scoped branch
// batching routes a task's diff-approval through the LOCAL merge queue even
// on a GitHub-connected project (see orchestrator.ts's deliver()), which is
// exactly how a real merge conflict happens on a connected project — same
// shape as the screenshot that prompted this feature.
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_WORKSPACE } from "@skynet/shared";
import type { ProviderId, Project, Agent, Task, Feature, HitlItem } from "@skynet/shared";
import type { RunnerEvents, RunnerHandle, RunnerProvider, StartSpec } from "@skynet/runner-sdk";
import type { Bus } from "../apps/server/src/bus.js";

vi.mock("../apps/server/src/github/index.js", () => ({
  githubService: {
    get: vi.fn(async () => ({ workspaceId: DEFAULT_WORKSPACE, connected: true, auth: "pat", installation: null, tokenLast4: "abcd", repos: [], safety: {} })),
    pushAndOpenPr: vi.fn(async () => ({ ok: true, pushed: true, pr: { number: 9, url: "https://github.com/acme/app/pull/9" } })),
  },
}));
import { githubService } from "../apps/server/src/github/index.js";

class NullBus implements Bus {
  publish(): void {}
  subscribe(): () => void {
    return () => {};
  }
}

// Same shape as merge-conflict-ask-agent.test.ts's ConflictingProvider: writes
// different content to the same file on each of the first two start() calls,
// forcing a genuine textual conflict between run A and run B.
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
  repo = mkdtempSync(join(tmpdir(), "skynet-conflict-push-repo-"));
  worktreesDir = mkdtempSync(join(tmpdir(), "skynet-conflict-push-wt-"));
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

/** Drives run A to a clean merge, then run B into a conflict with it — same
 *  two-task setup as merge-conflict-ask-agent.test.ts. Returns the open
 *  `merge` HITL for run B plus its branch name. */
async function driveToConflict(
  store: InstanceType<typeof MemoryStore>,
  orch: InstanceType<typeof Orchestrator>,
  ops: InstanceType<typeof Operations>,
): Promise<{ item: HitlItem; branchB: string }> {
  const openOf = async (kind: HitlItem["kind"]) =>
    (await store.listQueue(DEFAULT_WORKSPACE)).find((q) => q.kind === kind && q.resolvedAt == null);

  const runA = await orch.assignTask("p1", "ta");
  await waitFor(async () => !!(await openOf("diff")));
  await ops.resolveHitl(DEFAULT_WORKSPACE, (await openOf("diff"))!.id, { action: "approve" }, "op-1");
  await waitFor(async () => (await store.getRun(runA.id))?.status === "done");

  const runB = await orch.assignTask("p1", "tb");
  await waitFor(async () => !!(await openOf("diff")));
  await ops.resolveHitl(DEFAULT_WORKSPACE, (await openOf("diff"))!.id, { action: "approve" }, "op-1");

  await waitFor(async () => !!(await openOf("merge")));
  const item = (await openOf("merge"))!;
  return { item, branchB: (await store.getRun(runB.id))!.branch };
}

describe("merge-conflict escape hatch: push the branch and open a PR anyway", () => {
  it("'push' bypasses the local conflict — pushes the conflicting run's own branch and opens a PR", async () => {
    (githubService.get as ReturnType<typeof vi.fn>).mockClear().mockResolvedValue({
      workspaceId: DEFAULT_WORKSPACE, connected: true, auth: "pat", installation: null, tokenLast4: "abcd", repos: [], safety: {},
    });
    (githubService.pushAndOpenPr as ReturnType<typeof vi.fn>).mockClear();

    const store = new MemoryStore({ seed: false });
    const hub = new Hub(store, new NullBus());
    const provider = new ConflictingProvider();
    const orchestrator = new Orchestrator(store, hub, provider);
    const ops = new Operations({ store, hub, orchestrator });
    await store.putProject({
      id: "p1", workspaceId: DEFAULT_WORKSPACE, name: "P", goal: "", runIds: [],
      status: "active", repoPath: null, gitBacked: false, repo: "acme/app",
    } as Project);
    await store.putAgent({ id: "r1", workspaceId: DEFAULT_WORKSPACE, name: "r1", provider: "claude", model: "opus-4.8", status: "idle", idleSince: 0 } as Agent);
    const feature: Feature = {
      id: "f1", workspaceId: DEFAULT_WORKSPACE, projectId: "p1", name: "Shared surface",
      description: null, status: "active", milestoneId: null, archived: false, createdAt: Date.now(), pr: null,
    };
    await store.putFeature(feature);
    await store.putTask({ id: "ta", workspaceId: DEFAULT_WORKSPACE, projectId: "p1", text: "edit shared A", state: "backlog", runId: null, featureId: "f1" } as Task);
    await store.putTask({ id: "tb", workspaceId: DEFAULT_WORKSPACE, projectId: "p1", text: "edit shared B", state: "backlog", runId: null, featureId: "f1" } as Task);

    const { item, branchB } = await driveToConflict(store, orchestrator, ops);
    expect(item.output).toContain("<<<<<<<"); // genuinely conflicted, not a trivial case

    await ops.resolveHitl(DEFAULT_WORKSPACE, item.id, { action: "push" }, "op-1");
    await waitFor(async () => (githubService.pushAndOpenPr as ReturnType<typeof vi.fn>).mock.calls.length > 0);

    // Pushed the CONFLICTING run's own branch (not the shared integration
    // branch it failed to merge into) — the whole point is bypassing that.
    const call = (githubService.pushAndOpenPr as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(call.branch).toBe(branchB);
    expect(call.repo).toBe("acme/app");
  });

  it("no-ops with a clear log line when the project has no connected GitHub repo — never silently drops the request", async () => {
    (githubService.get as ReturnType<typeof vi.fn>).mockClear().mockResolvedValue(undefined);
    (githubService.pushAndOpenPr as ReturnType<typeof vi.fn>).mockClear();

    const store = new MemoryStore({ seed: false });
    const hub = new Hub(store, new NullBus());
    const provider = new ConflictingProvider();
    const orchestrator = new Orchestrator(store, hub, provider);
    const ops = new Operations({ store, hub, orchestrator });
    // No `repo` on the project — mirrors "GitHub not bound", the other
    // no-op trigger alongside a disconnected workspace.
    await store.putProject({
      id: "p1", workspaceId: DEFAULT_WORKSPACE, name: "P", goal: "", runIds: [],
      status: "active", repoPath: null, gitBacked: false,
    } as Project);
    await store.putAgent({ id: "r1", workspaceId: DEFAULT_WORKSPACE, name: "r1", provider: "claude", model: "opus-4.8", status: "idle", idleSince: 0 } as Agent);
    await store.putTask({ id: "ta", workspaceId: DEFAULT_WORKSPACE, projectId: "p1", text: "edit shared A", state: "backlog", runId: null } as Task);
    await store.putTask({ id: "tb", workspaceId: DEFAULT_WORKSPACE, projectId: "p1", text: "edit shared B", state: "backlog", runId: null } as Task);

    const { item } = await driveToConflict(store, orchestrator, ops);
    await ops.resolveHitl(DEFAULT_WORKSPACE, item.id, { action: "push" }, "op-1");

    // Give deliver() a beat, then assert the honest no-op: nothing pushed...
    await new Promise((r) => setTimeout(r, 100));
    expect(githubService.pushAndOpenPr).not.toHaveBeenCalled();
    // ...and the reason is on the run's own log, not silently swallowed.
    const run = (await store.listRuns(DEFAULT_WORKSPACE)).find((r) => r.id === item.runId)!;
    expect(run.log.some((l) => l.line.includes("no GitHub repo is connected"))).toBe(true);
  });
});
