// Manual "Re-sync": pull new/drifted GitHub issues + repo-file checklist items,
// and push any Skynet-side task state that never made it back to the source —
// the gap neither the one-time import nor the event-driven write-back
// (task-sync.ts) covers on its own. Drives the real Operations/MemoryStore with
// a stubbed GitHub service (no network).
import { describe, it, expect, beforeEach, vi } from "vitest";
import { DEFAULT_WORKSPACE } from "@skynet/shared";
import type { Project, Task } from "@skynet/shared";

vi.mock("../apps/server/src/github/index.js", () => ({
  githubService: {
    listIssues: vi.fn(async () => []),
    getIssue: vi.fn(async () => ({ state: "open", labels: [] })),
    setIssueState: vi.fn(async () => {}),
    getIssueLabels: vi.fn(async () => []),
    setIssueLabels: vi.fn(async () => {}),
    getRepoFileWithSha: vi.fn(async () => null),
    commitRepoFile: vi.fn(async () => {}),
  },
}));
import { githubService } from "../apps/server/src/github/index.js";
import { Hub } from "../apps/server/src/hub.js";
import { Orchestrator } from "../apps/server/src/orchestrator.js";
import { Operations } from "../apps/server/src/operations.js";
import { MemoryStore } from "../apps/server/src/store/memory.js";
import type { Bus } from "../apps/server/src/bus.js";
import type { RunnerProvider } from "@skynet/runner-sdk";

class NullBus implements Bus {
  publish(): void {}
  subscribe(): () => void {
    return () => {};
  }
}
const provider = {} as RunnerProvider; // resync never starts a run

const mk = (over: Partial<Project> = {}): Project =>
  ({
    id: "p1", workspaceId: DEFAULT_WORKSPACE, name: "P", goal: "", runIds: [],
    status: "active", repoPath: null, gitBacked: false, repo: "acme/app", syncSourceStatus: false,
    ...over,
  }) as Project;

async function setup(projectOver: Partial<Project> = {}) {
  const store = new MemoryStore({ seed: false });
  const hub = new Hub(store, new NullBus());
  const orch = new Orchestrator(store, hub, provider);
  // Spy on the lint consult so tests can assert which paths kick a
  // background lint — resync's drift pass must NOT (2026-08-27 incident:
  // a big re-sync fanning out lint model calls OOM'd the host).
  const lintConsult = vi.fn(async () => []);
  const ops = new Operations({ store, hub, orchestrator: orch, lintConsult });
  await store.putProject(mk(projectOver));
  return { store, ops, lintConsult };
}

const fn = <T,>(m: T) => m as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  fn(githubService.listIssues).mockReset().mockResolvedValue([]);
  fn(githubService.getIssue).mockReset().mockResolvedValue({ state: "open", labels: [] });
  fn(githubService.setIssueState).mockReset().mockResolvedValue(undefined);
  fn(githubService.getIssueLabels).mockReset().mockResolvedValue([]);
  fn(githubService.setIssueLabels).mockReset().mockResolvedValue(undefined);
  fn(githubService.getRepoFileWithSha).mockReset().mockResolvedValue(null);
  fn(githubService.commitRepoFile).mockReset().mockResolvedValue(undefined);
});

describe("resyncProjectSource", () => {
  it("throws when the project isn't GitHub-bound — nothing to re-sync", async () => {
    const { ops } = await setup({ repo: undefined });
    await expect(ops.resyncProjectSource(DEFAULT_WORKSPACE, "p1")).rejects.toThrow(/isn't bound to a GitHub repo/i);
  });

  it("pulls a new issue as a task", async () => {
    const { store, ops } = await setup();
    fn(githubService.listIssues).mockResolvedValue([{ number: 7, title: "Fix login redirect", body: "It loops.", url: "https://x/7", state: "open" }]);

    const res = await ops.resyncProjectSource(DEFAULT_WORKSPACE, "p1");
    expect(res).toMatchObject({ imported: 1, updated: 0, pushed: 0 });
    const tasks = await store.listTasks(DEFAULT_WORKSPACE);
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ text: "Fix login redirect", description: "It loops.", source: { kind: "github_issue", repo: "acme/app", number: 7 } });
  });

  it("does not duplicate an already-imported issue, but updates it when the title/body drifted on GitHub", async () => {
    const { store, ops } = await setup();
    await ops.createTask(DEFAULT_WORKSPACE, "p1", { text: "Old title", description: "old body", source: { kind: "github_issue", repo: "acme/app", number: 7, url: "https://x/7" } });
    fn(githubService.listIssues).mockResolvedValue([{ number: 7, title: "New title", body: "new body", url: "https://x/7", state: "open" }]);

    const res = await ops.resyncProjectSource(DEFAULT_WORKSPACE, "p1");
    expect(res).toMatchObject({ imported: 0, updated: 1, pushed: 0 });
    const tasks = await store.listTasks(DEFAULT_WORKSPACE);
    expect(tasks).toHaveLength(1); // no duplicate
    expect(tasks[0]).toMatchObject({ text: "New title", description: "new body" });
  });

  it("a drift update clears any stale lint but does NOT kick a re-lint (bulk path), while a manual edit still does", async () => {
    const { store, ops, lintConsult } = await setup();
    const task = await ops.createTask(DEFAULT_WORKSPACE, "p1", { text: "Old title", description: "old body", source: { kind: "github_issue", repo: "acme/app", number: 7, url: "https://x/7" } });
    // Imported tasks skip the create-time lint too — precondition, not the
    // thing under test here.
    expect(lintConsult).not.toHaveBeenCalled();
    // Give it a stale lint result to prove the drift update clears it.
    const fresh = await store.getTask(task.id);
    await store.putTask({ ...fresh!, lint: { concerns: [{ kind: "vague", note: "stale" }], at: new Date().toISOString(), dismissed: false } });
    fn(githubService.listIssues).mockResolvedValue([{ number: 7, title: "New title", body: "new body", url: "https://x/7", state: "open" }]);

    await ops.resyncProjectSource(DEFAULT_WORKSPACE, "p1");
    await new Promise((r) => setTimeout(r, 0)); // fire-and-forget lint would land here
    expect(lintConsult).not.toHaveBeenCalled(); // GitHub's text, bulk path — no lint fan-out
    expect((await store.getTask(task.id))?.lint).toBeNull(); // stale verdict cleared, not left against new text

    // A human editing the same imported task afterwards still gets the linter.
    await ops.updateTask(DEFAULT_WORKSPACE, task.id, { text: "Human-tuned title" });
    await new Promise((r) => setTimeout(r, 0));
    expect(lintConsult).toHaveBeenCalledTimes(1);
  });

  it("leaves an already-imported issue alone when nothing changed", async () => {
    const { ops } = await setup();
    await ops.createTask(DEFAULT_WORKSPACE, "p1", { text: "Same", description: "same", source: { kind: "github_issue", repo: "acme/app", number: 7, url: "https://x/7" } });
    fn(githubService.listIssues).mockResolvedValue([{ number: 7, title: "Same", body: "same", url: "https://x/7", state: "open" }]);

    const res = await ops.resyncProjectSource(DEFAULT_WORKSPACE, "p1");
    expect(res).toMatchObject({ imported: 0, updated: 0, pushed: 0 });
  });

  it("pulls new checklist items from a repo file already linked by an existing task", async () => {
    const { store, ops } = await setup();
    await ops.createTask(DEFAULT_WORKSPACE, "p1", { text: "Existing item", source: { kind: "repo_file", path: "TODO.md", anchor: "Existing item" } });
    fn(githubService.getRepoFileWithSha).mockResolvedValue({ content: "- [ ] Existing item\n- [ ] New item\n", sha: "abc" });

    const res = await ops.resyncProjectSource(DEFAULT_WORKSPACE, "p1");
    expect(res.imported).toBe(1); // only the new item
    const tasks = await store.listTasks(DEFAULT_WORKSPACE);
    expect(tasks.map((t) => t.text).sort()).toEqual(["Existing item", "New item"]);
  });

  it("does NOT push write-back drift when syncSourceStatus is off", async () => {
    const { store, ops } = await setup({ syncSourceStatus: false });
    const task = await ops.createTask(DEFAULT_WORKSPACE, "p1", { text: "Done work", source: { kind: "github_issue", repo: "acme/app", number: 7, url: "https://x/7" } });
    const fresh = await store.getTask(task.id);
    await store.putTask({ ...fresh!, state: "done" }); // drifted — issue is still open (default mock)

    const res = await ops.resyncProjectSource(DEFAULT_WORKSPACE, "p1");
    expect(res.pushed).toBe(0);
    expect(githubService.setIssueState).not.toHaveBeenCalled();
    expect(githubService.getIssue).not.toHaveBeenCalled(); // never even checked — respects the project's own opt-out
  });

  it("pushes drift for a done task whose issue is still open, when syncSourceStatus is on", async () => {
    const { store, ops } = await setup({ syncSourceStatus: true });
    const task = await ops.createTask(DEFAULT_WORKSPACE, "p1", { text: "Done work", source: { kind: "github_issue", repo: "acme/app", number: 7, url: "https://x/7" } });
    // Force the task straight to "done" without going through a real run/HITL —
    // reconcile only cares about the CURRENT state, not how it got there.
    const fresh = await store.getTask(task.id);
    await store.putTask({ ...fresh!, state: "done" });
    fn(githubService.getIssue).mockResolvedValue({ state: "open", labels: [] }); // GitHub never heard about it

    const res = await ops.resyncProjectSource(DEFAULT_WORKSPACE, "p1");
    expect(res.pushed).toBe(1);
    expect(githubService.setIssueState).toHaveBeenCalledWith(DEFAULT_WORKSPACE, "acme/app", 7, "closed", undefined);
    expect(githubService.setIssueLabels).toHaveBeenCalledWith(DEFAULT_WORKSPACE, "acme/app", 7, ["skynet:done"], undefined);
    // Reconcile never narrates a comment — that's writeBack's job, not a
    // repeatable idempotent state fix.
    expect(githubService.getIssue).toHaveBeenCalled();
  });

  it("does not push when the issue already reflects the task's current state", async () => {
    const { store, ops } = await setup({ syncSourceStatus: true });
    const task = await ops.createTask(DEFAULT_WORKSPACE, "p1", { text: "Done work", source: { kind: "github_issue", repo: "acme/app", number: 7, url: "https://x/7" } });
    const fresh = await store.getTask(task.id);
    await store.putTask({ ...fresh!, state: "done" });
    fn(githubService.getIssue).mockResolvedValue({ state: "closed", labels: ["skynet:done"] }); // already in sync

    const res = await ops.resyncProjectSource(DEFAULT_WORKSPACE, "p1");
    expect(res.pushed).toBe(0);
    expect(githubService.setIssueState).not.toHaveBeenCalled();
    expect(githubService.setIssueLabels).not.toHaveBeenCalled();
  });
});
