// The ready-to-merge flow: once a run's diff is approved and its PR is opened,
// the task completes and the PR is listed for a human's final call — merge,
// rework, or no-op. These drive the real Operations/Orchestrator path with a
// stubbed GitHub service (no network), asserting the list + each action.
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Agent, Project, Task, TaskRun, ServerEvent, PullRequest } from "@skynet/shared";
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
  briefing: { summary: "do X — 3+/1−", impact: "Touches api/x", risk: "low", recommendation: "merge", rationale: "a2: looks good", by: "a2" },
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
    expect(githubService.mergePr).toHaveBeenCalledWith(DEFAULT_WORKSPACE, "acme/app", 42, "squash");
    expect((await store.getRun("r1"))?.pr?.state).toBe("merged");
    expect((await store.getRun("r1"))?.status).toBe("done");
    expect((await store.getTask("t1"))?.state).toBe("done");
    expect(await orch.listReadyPrs(DEFAULT_WORKSPACE)).toEqual([]); // no longer open
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
});
