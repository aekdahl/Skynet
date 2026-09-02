// The ready-to-merge flow: once a run's diff is approved and its PR is opened,
// the task completes and the PR is listed for a human's final call — merge,
// rework, or no-op. These drive the real Operations/Orchestrator path with a
// stubbed GitHub service (no network), asserting the list + each action.
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Agent, Feature, Project, Task, TaskRun, ServerEvent, PullRequest } from "@skynet/shared";
import { DEFAULT_WORKSPACE } from "@skynet/shared";

// Stub the GitHub barrel: the orchestrator only uses `githubService` from it.
vi.mock("../apps/server/src/github/index.js", () => ({
  githubService: {
    mergePr: vi.fn(async () => ({ merged: true })),
    commentIssue: vi.fn(async () => {}),
    prStatus: vi.fn(async () => ({ state: "open", checks: "none", mergeable: true })),
  },
}));
import { githubService } from "../apps/server/src/github/index.js";
import { Hub } from "../apps/server/src/hub.js";
import { Orchestrator } from "../apps/server/src/orchestrator.js";
import { MemoryStore } from "../apps/server/src/store/memory.js";
import type { Bus } from "../apps/server/src/bus.js";
import type { RunnerEvents, RunnerHandle, RunnerProvider, StartSpec } from "@skynet/runner-sdk";

class NullBus implements Bus {
  publish(_ws: string, _e: ServerEvent): void {}
  subscribe(): () => void { return () => {}; }
}
const provider: RunnerProvider = {
  id: "claude",
  async start(spec: StartSpec, _e: RunnerEvents): Promise<RunnerHandle> {
    return { runId: spec.runId, provider: "claude", async pause() {}, async resume() {}, async message() {}, async stop() {} };
  },
};

const project: Project = {
  id: "p1", workspaceId: DEFAULT_WORKSPACE, name: "P", goal: "", runIds: [],
  status: "active", repoPath: null, gitBacked: false, repo: "acme/app",
};
const openPr: PullRequest = {
  number: 42, url: "https://github.com/acme/app/pull/42", repo: "acme/app",
  branch: "agent/r1", base: "main", state: "open", openedAt: 1000,
  briefing: {
    summary: "do X — 3+/1−", impact: "Touches api/x", risk: "low", recommendation: "merge", rationale: "a2: looks good", by: "a2",
    add: 3, del: 1, filesChanged: 1, modules: ["api/x"], sensitiveFiles: [], testsChanged: false,
    authoredBy: "a1", reviewedBy: "a2", reviewDecision: "approve",
  },
  dismissed: false,
};
const mkRun = (over: Partial<TaskRun> = {}): TaskRun => ({
  id: "r1", workspaceId: DEFAULT_WORKSPACE, projectId: "p1", name: "do X", status: "done",
  agentId: "a1", provider: "claude", credentialId: null, model: "opus-4.8", branch: "agent/r1",
  modules: [], progress: 1, plan: [], usage: null, modifiedFiles: [], log: [], startedAt: 0,
  lastHeartbeatAt: 0, visual: false, previewUrl: null, dependsOn: [], parentId: null,
  branchFromStep: null, archived: false, pr: openPr, ...over,
});
const agent: Agent = {
  id: "a1", workspaceId: DEFAULT_WORKSPACE, name: "a1", provider: "claude",
  model: "opus-4.8", status: "idle", idleSince: 0, autoProvisioned: false, canReview: true,
};

const setup = async () => {
  const store = new MemoryStore();
  const hub = new Hub(store, new NullBus());
  const orch = new Orchestrator(store, hub, provider);
  await store.putProject(project);
  await store.putAgent(agent);
  return { store, orch };
};

describe("ready-to-merge", () => {
  beforeEach(() => {
    (githubService.mergePr as ReturnType<typeof vi.fn>).mockClear().mockResolvedValue({ merged: true });
    (githubService.commentIssue as ReturnType<typeof vi.fn>).mockClear();
    (githubService.prStatus as ReturnType<typeof vi.fn>).mockClear().mockResolvedValue({ state: "open", checks: "none", mergeable: true });
  });

  it("lists a run whose PR is open, and hides it once set aside (no-op)", async () => {
    const { store, orch } = await setup();
    await store.putRun(mkRun());
    await store.putTask({ id: "t1", workspaceId: DEFAULT_WORKSPACE, projectId: "p1", text: "do X", state: "done", runId: "r1" } as Task);

    expect((await orch.listReadyPrs(DEFAULT_WORKSPACE)).map((r) => r.id)).toEqual(["r1"]);

    await orch.dismissReadyPr(DEFAULT_WORKSPACE, "r1");
    expect(await orch.listReadyPrs(DEFAULT_WORKSPACE)).toEqual([]); // set aside — gone from the list
    expect((await store.getRun("r1"))?.pr?.dismissed).toBe(true); // PR untouched on GitHub, just hidden
  });

  it("merge → integrates and settles run + task to done, PR marked merged", async () => {
    const { store, orch } = await setup();
    await store.putRun(mkRun());
    await store.putTask({ id: "t1", workspaceId: DEFAULT_WORKSPACE, projectId: "p1", text: "do X", state: "review", runId: "r1" } as Task);

    const res = await orch.mergeReadyPr(DEFAULT_WORKSPACE, "r1", "squash");
    expect(res.merged).toBe(true);
    // No pinned account on this project → the 5th arg (githubCredentialId) is null,
    // same as every other GitHub call (prStatus, pushAndOpenPr) already threads.
    expect(githubService.mergePr).toHaveBeenCalledWith(DEFAULT_WORKSPACE, "acme/app", 42, "squash", null);
    expect((await store.getRun("r1"))?.pr?.state).toBe("merged");
    expect((await store.getRun("r1"))?.status).toBe("done");
    expect((await store.getTask("t1"))?.state).toBe("done");
    expect(await orch.listReadyPrs(DEFAULT_WORKSPACE)).toEqual([]); // no longer open
  });

  it("merge → uses the PROJECT's pinned GitHub account, not the workspace default", async () => {
    // Regression: mergePr used to be the one GitHub call site that DIDN'T
    // thread Project.githubCredentialId (push/PR/prStatus/clone always did),
    // so a project pinned to its own PAT still merged under the workspace's
    // default GitHub connection instead.
    const { store, orch } = await setup();
    await store.putProject({ ...project, githubCredentialId: "gh-cyberdyne-pat" });
    await store.putRun(mkRun());
    await store.putTask({ id: "t1", workspaceId: DEFAULT_WORKSPACE, projectId: "p1", text: "do X", state: "review", runId: "r1" } as Task);

    const res = await orch.mergeReadyPr(DEFAULT_WORKSPACE, "r1", "squash");
    expect(res.merged).toBe(true);
    expect(githubService.mergePr).toHaveBeenCalledWith(DEFAULT_WORKSPACE, "acme/app", 42, "squash", "gh-cyberdyne-pat");
  });

  it("merge blocked → classifies a CONFLICT (base moved) and keeps the PR ready", async () => {
    (githubService.mergePr as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ merged: false, reason: "not mergeable" });
    (githubService.prStatus as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ state: "open", checks: "passing", mergeable: false });
    const { store, orch } = await setup();
    await store.putRun(mkRun());

    const res = await orch.mergeReadyPr(DEFAULT_WORKSPACE, "r1", "squash");
    expect(res.merged).toBe(false);
    expect(res.blocked).toBe("conflict");
    expect(res.reason).toMatch(/conflicts with main/i);
    expect((await store.getRun("r1"))?.pr?.state).toBe("open"); // unchanged — still fixable
    expect((await orch.listReadyPrs(DEFAULT_WORKSPACE)).map((r) => r.id)).toEqual(["r1"]);
  });

  it("merge blocked → classifies failing CHECKS vs a PROTECTION block", async () => {
    const { store, orch } = await setup();
    await store.putRun(mkRun());

    (githubService.mergePr as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ merged: false, reason: "not mergeable" });
    (githubService.prStatus as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ state: "open", checks: "failing", mergeable: true });
    expect((await orch.mergeReadyPr(DEFAULT_WORKSPACE, "r1", "squash")).blocked).toBe("checks");

    (githubService.mergePr as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ merged: false, reason: "At least 1 approving review is required" });
    (githubService.prStatus as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ state: "open", checks: "passing", mergeable: true });
    const prot = await orch.mergeReadyPr(DEFAULT_WORKSPACE, "r1", "squash");
    expect(prot.blocked).toBe("protection");
    expect(prot.reason).toMatch(/approving review/i);
  });

  it("update-branch rejects a run with no open PR", async () => {
    const { store, orch } = await setup();
    await store.putRun(mkRun({ pr: null }));
    await expect(orch.updateReadyPrBranch(DEFAULT_WORKSPACE, "r1")).rejects.toThrow(/no open pr/i);
  });

  it("rework → comments on the PR and clears the ready record while revising", async () => {
    const { store, orch } = await setup();
    await store.putRun(mkRun());
    await store.putTask({ id: "t1", workspaceId: DEFAULT_WORKSPACE, projectId: "p1", text: "do X", state: "done", runId: "r1" } as Task);

    // No live runner + no review handle → revise can't resume, but the PR-comment
    // and ready-list-clear happen first and are what we assert here.
    await orch.reworkReadyPr(DEFAULT_WORKSPACE, "r1", "add tests", "please add coverage");
    expect(githubService.commentIssue).toHaveBeenCalledWith(DEFAULT_WORKSPACE, "acme/app", 42, "please add coverage", null);
    expect((await store.getRun("r1"))?.pr).toBeNull(); // left the ready list while reworking
    expect(await orch.listReadyPrs(DEFAULT_WORKSPACE)).toEqual([]);
  });

  it("rejects an action on a run with no open PR", async () => {
    const { store, orch } = await setup();
    await store.putRun(mkRun({ pr: null }));
    await expect(orch.mergeReadyPr(DEFAULT_WORKSPACE, "r1", "squash")).rejects.toThrow(/no open pr/i);
  });

  // Live GitHub check-run status — fetched by the card BEFORE a merge decision
  // (not just learned reactively once GitHub blocks an attempt), so an
  // operator can see whether CI actually ran and passed before trusting a
  // "RECOMMEND MERGE" verdict.
  it("prChecksForRun surfaces the real check-run status for the open PR", async () => {
    (githubService.prStatus as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ state: "open", checks: "passing", mergeable: true, runs: [] });
    const { store, orch } = await setup();
    await store.putRun(mkRun());
    expect(await orch.prChecksForRun(DEFAULT_WORKSPACE, "r1")).toEqual({ checks: "passing", mergeable: true, runs: [], state: "open" });
    expect(githubService.prStatus).toHaveBeenCalledWith(DEFAULT_WORKSPACE, "acme/app", 42, null);
  });

  // (c): the aggregate "checks: failing" verdict alone doesn't say WHICH gate
  // failed — the per-check-run breakdown (named lint/typecheck/test jobs) must
  // pass through untouched so the ready-to-merge card can show it inline.
  it("prChecksForRun forwards the per-check-run breakdown, not just the aggregate verdict", async () => {
    (githubService.prStatus as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      state: "open",
      checks: "failing",
      mergeable: true,
      runs: [{ name: "lint", state: "pass" }, { name: "typecheck", state: "fail" }, { name: "test", state: "pending" }],
    });
    const { store, orch } = await setup();
    await store.putRun(mkRun());
    expect(await orch.prChecksForRun(DEFAULT_WORKSPACE, "r1")).toEqual({
      checks: "failing",
      mergeable: true,
      runs: [{ name: "lint", state: "pass" }, { name: "typecheck", state: "fail" }, { name: "test", state: "pending" }],
      state: "open",
    });
  });

  it("prChecksForRun returns null (never throws) when there's no open PR or the workspace doesn't match", async () => {
    const { store, orch } = await setup();
    await store.putRun(mkRun({ pr: null }));
    expect(await orch.prChecksForRun(DEFAULT_WORKSPACE, "r1")).toBeNull();
    expect(await orch.prChecksForRun(DEFAULT_WORKSPACE, "no-such-run")).toBeNull();
  });

  it("prChecksForRun is best-effort — a GitHub failure resolves null, doesn't throw", async () => {
    (githubService.prStatus as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("rate limited"));
    const { store, orch } = await setup();
    await store.putRun(mkRun());
    expect(await orch.prChecksForRun(DEFAULT_WORKSPACE, "r1")).toBeNull();
  });

  // The whole point: a human can merge (or close) a ready PR directly on
  // GitHub, bypassing Skynet entirely — the stored `pr.state:"open"` would
  // otherwise never learn that happened, and the card would sit "ready to
  // merge" forever. The card's own on-mount status check (this same call) IS
  // the reconciliation point — no separate poller/webhook needed.
  it("prChecksForRun self-heals a PR merged OUTSIDE Skynet — same local completion as clicking Merge here would", async () => {
    (githubService.prStatus as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ state: "merged", checks: "passing", mergeable: true, runs: [] });
    const { store, orch } = await setup();
    await store.putRun(mkRun());
    await store.putTask({ id: "t1", workspaceId: DEFAULT_WORKSPACE, projectId: "p1", text: "do X", state: "review", runId: "r1" } as Task);

    const result = await orch.prChecksForRun(DEFAULT_WORKSPACE, "r1");
    expect(result?.state).toBe("merged");
    expect((await store.getRun("r1"))?.pr?.state).toBe("merged");
    expect((await store.getRun("r1"))?.status).toBe("done");
    expect((await store.getRun("r1"))?.mergedAt).not.toBeNull();
    expect((await store.getTask("t1"))?.state).toBe("done");
    expect(await orch.listReadyPrs(DEFAULT_WORKSPACE)).toEqual([]); // no longer open — self-cleared
  });

  it("prChecksForRun self-heals a PR closed OUTSIDE Skynet without merging — drops it from the ready list, but never invents a 'done'", async () => {
    (githubService.prStatus as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ state: "closed", checks: "none", mergeable: null, runs: [] });
    const { store, orch } = await setup();
    await store.putRun(mkRun());
    await store.putTask({ id: "t1", workspaceId: DEFAULT_WORKSPACE, projectId: "p1", text: "do X", state: "review", runId: "r1" } as Task);

    const result = await orch.prChecksForRun(DEFAULT_WORKSPACE, "r1");
    expect(result?.state).toBe("closed");
    expect((await store.getRun("r1"))?.pr?.state).toBe("closed");
    expect((await store.getRun("r1"))?.mergedAt).toBeFalsy(); // never stamped — rejected work never earns a silent "done"
    expect((await store.getTask("t1"))?.state).toBe("review"); // untouched
    expect(await orch.listReadyPrs(DEFAULT_WORKSPACE)).toEqual([]); // still drops off the ready list
  });

  it("prChecksForRun is a no-op reconciliation-wise once already reconciled — a second read doesn't re-run completion", async () => {
    (githubService.prStatus as ReturnType<typeof vi.fn>).mockResolvedValue({ state: "merged", checks: "passing", mergeable: true, runs: [] });
    const { store, orch } = await setup();
    await store.putRun(mkRun());
    await store.putTask({ id: "t1", workspaceId: DEFAULT_WORKSPACE, projectId: "p1", text: "do X", state: "review", runId: "r1" } as Task);

    await orch.prChecksForRun(DEFAULT_WORKSPACE, "r1");
    const afterFirst = await store.getRun("r1");
    await orch.prChecksForRun(DEFAULT_WORKSPACE, "r1"); // a second card mount, e.g. another reload
    const afterSecond = await store.getRun("r1");
    expect(afterSecond?.mergedAt).toBe(afterFirst?.mergedAt); // not re-stamped
  });
});

// Feature-scoped branch batching's aggregate PR (one per completed Feature,
// not per task — see orchestrator.ts's checkFeatureCompletion). Same
// stubbed-GitHub Operations/Orchestrator harness as the per-run tests above;
// the underlying git-merge tiers themselves are covered end to end with real
// repos in merge.test.ts.
describe("ready-to-merge — feature-scoped batches", () => {
  const featurePr: PullRequest = {
    number: 43, url: "https://github.com/acme/app/pull/43", repo: "acme/app",
    branch: "skynet/feature/f1", base: "main", state: "open", openedAt: 1000,
    briefing: {
      summary: "Checkout — 5+/1− across 2 file(s), 2 task(s): do X, do Y", impact: "Touches api/x", risk: "low", recommendation: "merge", rationale: "No flagged tasks in this batch.", by: "heuristic",
      add: 5, del: 1, filesChanged: 2, modules: ["api/x"], sensitiveFiles: [], testsChanged: false,
      authoredBy: null, reviewedBy: null, reviewDecision: "approve",
    },
    dismissed: false,
  };
  const mkFeature = (over: Partial<Feature> = {}): Feature => ({
    id: "f1", workspaceId: DEFAULT_WORKSPACE, projectId: "p1", name: "Checkout",
    description: null, status: "active", milestoneId: null, archived: false, createdAt: 0,
    pr: featurePr, ...over,
  });

  beforeEach(() => {
    (githubService.mergePr as ReturnType<typeof vi.fn>).mockClear().mockResolvedValue({ merged: true });
    (githubService.prStatus as ReturnType<typeof vi.fn>).mockClear().mockResolvedValue({ state: "open", checks: "none", mergeable: true });
  });

  it("lists a feature whose aggregate PR is open, and hides it once set aside (no-op)", async () => {
    const { store, orch } = await setup();
    await store.putFeature(mkFeature());

    expect((await orch.listReadyFeaturePrs(DEFAULT_WORKSPACE)).map((f) => f.id)).toEqual(["f1"]);

    await orch.dismissReadyFeaturePr(DEFAULT_WORKSPACE, "f1");
    expect(await orch.listReadyFeaturePrs(DEFAULT_WORKSPACE)).toEqual([]); // set aside — gone from the list
    expect((await store.getFeature("f1"))?.pr?.dismissed).toBe(true); // PR untouched on GitHub, just hidden
  });

  it("merge → marks the feature shipped, PR marked merged — no per-run worktree/review reconciliation needed (already happened in step 1)", async () => {
    const { store, orch } = await setup();
    await store.putFeature(mkFeature());

    const res = await orch.mergeReadyFeaturePr(DEFAULT_WORKSPACE, "f1", "squash");
    expect(res.merged).toBe(true);
    expect(githubService.mergePr).toHaveBeenCalledWith(DEFAULT_WORKSPACE, "acme/app", 43, "squash", null);
    const fresh = await store.getFeature("f1");
    expect(fresh?.status).toBe("shipped");
    expect(fresh?.pr?.state).toBe("merged");
    expect(await orch.listReadyFeaturePrs(DEFAULT_WORKSPACE)).toEqual([]); // no longer open
  });

  it("merge → uses the PROJECT's pinned GitHub account, not the workspace default", async () => {
    const { store, orch } = await setup();
    await store.putProject({ ...project, githubCredentialId: "gh-cyberdyne-pat" });
    await store.putFeature(mkFeature());

    const res = await orch.mergeReadyFeaturePr(DEFAULT_WORKSPACE, "f1", "squash");
    expect(res.merged).toBe(true);
    expect(githubService.mergePr).toHaveBeenCalledWith(DEFAULT_WORKSPACE, "acme/app", 43, "squash", "gh-cyberdyne-pat");
  });

  it("merge blocked → classifies a CONFLICT (base moved) and keeps the feature PR ready, status untouched", async () => {
    (githubService.mergePr as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ merged: false, reason: "not mergeable" });
    (githubService.prStatus as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ state: "open", checks: "passing", mergeable: false });
    const { store, orch } = await setup();
    await store.putFeature(mkFeature());

    const res = await orch.mergeReadyFeaturePr(DEFAULT_WORKSPACE, "f1", "squash");
    expect(res.merged).toBe(false);
    expect(res.blocked).toBe("conflict");
    expect(res.reason).toMatch(/conflicts with main/i);
    const fresh = await store.getFeature("f1");
    expect(fresh?.pr?.state).toBe("open"); // unchanged — still fixable
    expect(fresh?.status).toBe("active"); // not shipped — merge didn't happen
    expect((await orch.listReadyFeaturePrs(DEFAULT_WORKSPACE)).map((f) => f.id)).toEqual(["f1"]);
  });

  it("rejects an action on a feature with no open PR", async () => {
    const { store, orch } = await setup();
    await store.putFeature(mkFeature({ pr: null }));
    await expect(orch.mergeReadyFeaturePr(DEFAULT_WORKSPACE, "f1", "squash")).rejects.toThrow(/no open pr/i);
    await expect(orch.dismissReadyFeaturePr(DEFAULT_WORKSPACE, "f1")).rejects.toThrow(/no pr/i);
  });

  it("prChecksForFeature surfaces the real check-run status for the aggregate PR", async () => {
    (githubService.prStatus as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ state: "open", checks: "failing", mergeable: true });
    const { store, orch } = await setup();
    await store.putFeature(mkFeature());
    expect(await orch.prChecksForFeature(DEFAULT_WORKSPACE, "f1")).toEqual({ checks: "failing", mergeable: true, state: "open" });
    expect(githubService.prStatus).toHaveBeenCalledWith(DEFAULT_WORKSPACE, "acme/app", 43, null);
  });

  it("prChecksForFeature returns null when there's no open PR", async () => {
    const { store, orch } = await setup();
    await store.putFeature(mkFeature({ pr: null }));
    expect(await orch.prChecksForFeature(DEFAULT_WORKSPACE, "f1")).toBeNull();
  });

  // Same self-heal as the per-run case, simpler here: every task in the batch
  // already finished its own lifecycle merging into the feature branch, so
  // there's no local worktree/task reconciliation left to do — just the same
  // shipped+merged flip mergeReadyFeaturePr's own success path makes.
  it("prChecksForFeature self-heals an aggregate PR merged OUTSIDE Skynet", async () => {
    (githubService.prStatus as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ state: "merged", checks: "passing", mergeable: true, runs: [] });
    const { store, orch } = await setup();
    await store.putFeature(mkFeature());

    const result = await orch.prChecksForFeature(DEFAULT_WORKSPACE, "f1");
    expect(result?.state).toBe("merged");
    const fresh = await store.getFeature("f1");
    expect(fresh?.pr?.state).toBe("merged");
    expect(fresh?.status).toBe("shipped");
    expect(await orch.listReadyFeaturePrs(DEFAULT_WORKSPACE)).toEqual([]); // no longer open
  });

  it("prChecksForFeature self-heals an aggregate PR closed OUTSIDE Skynet without merging", async () => {
    (githubService.prStatus as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ state: "closed", checks: "none", mergeable: null, runs: [] });
    const { store, orch } = await setup();
    await store.putFeature(mkFeature());

    const result = await orch.prChecksForFeature(DEFAULT_WORKSPACE, "f1");
    expect(result?.state).toBe("closed");
    const fresh = await store.getFeature("f1");
    expect(fresh?.pr?.state).toBe("closed");
    expect(fresh?.status).toBe("active"); // never silently "shipped" — it wasn't
    expect(await orch.listReadyFeaturePrs(DEFAULT_WORKSPACE)).toEqual([]);
  });
});
