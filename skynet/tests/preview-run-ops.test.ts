// Per-run "Preview this change" (docs/live-preview.md) — the operator-facing
// gate for the run's own branch, pinned, pre-merge. The underlying mechanics
// (ProjectPreviewManager.startRun/restartRun/stop, the branch-exists guard,
// the sandboxed `/p/<token>/` proxy) are already exercised end to end against
// a real repo by deep-review.test.ts / breaker-review.test.ts. What's new
// here is the thin Operations wrapper (previewRunState/Start/Stop/Restart)
// that exposes that same manager to an operator via `/api/runs/:id/preview*`
// — so this pins its delegation (right key, right args) and its guards
// (workspace scoping, no-repo-to-preview) with the manager mocked out.
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Project, TaskRun, PreviewState } from "@skynet/shared";
import { DEFAULT_WORKSPACE } from "@skynet/shared";

const previewMock = vi.hoisted(() => ({
  state: vi.fn(),
  startRun: vi.fn(),
  restartRun: vi.fn(),
  stop: vi.fn(),
}));
vi.mock("../apps/server/src/preview/project-preview.js", () => ({
  projectPreview: previewMock,
}));

import { Hub } from "../apps/server/src/hub.js";
import { Operations } from "../apps/server/src/operations.js";
import { Orchestrator } from "../apps/server/src/orchestrator.js";
import { MemoryStore } from "../apps/server/src/store/memory.js";

const LIVE: PreviewState = {
  status: "live", url: "http://127.0.0.1:12345", port: 12345,
  recipe: { cmd: "npm run dev", source: "heuristic" }, error: null, logs: [],
  startedAt: 1, source: "merged", combined: null,
};

beforeEach(() => {
  vi.clearAllMocks();
});

function setup() {
  const store = new MemoryStore();
  const hub = new Hub(store, { publish: () => {}, subscribe: () => () => {} });
  const ops = new Operations({ store, hub, orchestrator: new Orchestrator(store, hub) });
  return { store, ops };
}

const mkProject = (over: Partial<Project> = {}): Project => ({
  id: "p1", workspaceId: DEFAULT_WORKSPACE, name: "P", goal: "", runIds: [],
  status: "active", autonomy: false, repoPath: "/repo/p1", gitBacked: true,
  ...over,
});
const mkRun = (over: Partial<TaskRun> = {}): TaskRun => ({
  id: "r1", workspaceId: DEFAULT_WORKSPACE, projectId: "p1", name: "do X", status: "review",
  agentId: "a1", provider: "claude", credentialId: null, model: "opus-4.8", branch: "agent/r1",
  modules: [], progress: 1, plan: [], usage: null, modifiedFiles: [], log: [], startedAt: 0,
  lastHeartbeatAt: 0, visual: false, previewUrl: null, dependsOn: [], parentId: null,
  branchFromStep: null, archived: false, pr: null, mergedAt: null,
  ...over,
});

describe("previewRunState", () => {
  it("reads the manager's state keyed run:<runId>", async () => {
    const { store, ops } = setup();
    await store.putProject(mkProject());
    await store.putRun(mkRun());
    previewMock.state.mockReturnValue(LIVE);

    const st = await ops.previewRunState(DEFAULT_WORKSPACE, "r1");

    expect(previewMock.state).toHaveBeenCalledWith("run:r1");
    expect(st).toBe(LIVE);
  });

  it("404s for a run outside the workspace", async () => {
    const { store, ops } = setup();
    await store.putProject(mkProject());
    await store.putRun(mkRun({ workspaceId: "other-ws" }));
    await expect(ops.previewRunState(DEFAULT_WORKSPACE, "r1")).rejects.toThrow();
  });
});

describe("previewRunStart / previewRunRestart", () => {
  it("starts the run's own branch against its project's repo", async () => {
    const { store, ops } = setup();
    await store.putProject(mkProject());
    await store.putRun(mkRun());
    previewMock.startRun.mockResolvedValue(LIVE);

    const st = await ops.previewRunStart(DEFAULT_WORKSPACE, "r1");

    expect(previewMock.startRun).toHaveBeenCalledWith("r1", {
      repoPath: "/repo/p1", projectId: "p1", branch: "agent/r1", workspaceId: DEFAULT_WORKSPACE,
    });
    expect(st).toBe(LIVE);
  });

  it("restarts with the same args as start", async () => {
    const { store, ops } = setup();
    await store.putProject(mkProject());
    await store.putRun(mkRun());
    previewMock.restartRun.mockResolvedValue(LIVE);

    await ops.previewRunRestart(DEFAULT_WORKSPACE, "r1");

    expect(previewMock.restartRun).toHaveBeenCalledWith("r1", {
      repoPath: "/repo/p1", projectId: "p1", branch: "agent/r1", workspaceId: DEFAULT_WORKSPACE,
    });
  });

  it("refuses to start when the project has no local folder to preview", async () => {
    const { store, ops } = setup();
    await store.putProject(mkProject({ repoPath: null }));
    await store.putRun(mkRun());

    await expect(ops.previewRunStart(DEFAULT_WORKSPACE, "r1")).rejects.toThrow(/no local folder/);
    expect(previewMock.startRun).not.toHaveBeenCalled();
  });

  it("404s for a run outside the workspace, never touching the manager", async () => {
    const { store, ops } = setup();
    await store.putProject(mkProject());
    await store.putRun(mkRun({ workspaceId: "other-ws" }));

    await expect(ops.previewRunStart(DEFAULT_WORKSPACE, "r1")).rejects.toThrow();
    expect(previewMock.startRun).not.toHaveBeenCalled();
  });
});

describe("previewRunStop", () => {
  it("stops the manager's run:<runId> entry", async () => {
    const { store, ops } = setup();
    await store.putProject(mkProject());
    await store.putRun(mkRun());
    previewMock.stop.mockResolvedValue({ ...LIVE, status: "stopped" });

    const st = await ops.previewRunStop(DEFAULT_WORKSPACE, "r1");

    expect(previewMock.stop).toHaveBeenCalledWith("run:r1");
    expect(st.status).toBe("stopped");
  });

  it("404s for a run outside the workspace", async () => {
    const { store, ops } = setup();
    await store.putProject(mkProject());
    await store.putRun(mkRun({ workspaceId: "other-ws" }));
    await expect(ops.previewRunStop(DEFAULT_WORKSPACE, "r1")).rejects.toThrow();
    expect(previewMock.stop).not.toHaveBeenCalled();
  });
});
