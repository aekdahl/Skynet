// TASK 24 — the sidebar's OPEN NOW row label: WHY a project is interesting
// right now (gates > stuck > runs > idle), most urgent first. Pure, so
// unit-tested directly rather than only exercised through the component.
import { describe, it, expect } from "vitest";
import type { HitlItem, Project, TaskRun } from "@skynet/shared";
import { openNowStatus } from "../apps/web/src/lib/derive.js";

const NOW = 1_000_000;

const project = (id: string): Project =>
  ({ id, name: id, status: "active" }) as Project;

const run = (id: string, projectId: string, over: Partial<TaskRun> = {}): TaskRun =>
  ({
    id, workspaceId: "w", projectId, name: id, status: "running", agentId: "a1",
    provider: "claude", credentialId: null, model: "sonnet-5", branch: "b",
    modules: [], progress: 0, plan: [], usage: null, modifiedFiles: [], log: [],
    startedAt: NOW, lastHeartbeatAt: NOW, visual: false, previewUrl: null, dependsOn: [],
    parentId: null, branchFromStep: null, archived: false, pr: null, mergedAt: null, flyDeployment: null,
    ...over,
  }) as TaskRun;

const gate = (runId: string): HitlItem =>
  ({
    id: `q-${runId}`, workspaceId: "w", runId, kind: "approval", title: "x", why: "",
    risk: "medium", raisedAt: NOW, expiresAt: null, resolvedAt: null, resolution: null,
    rationale: null, command: null, options: null, recommended: null, steps: null, diff: null,
    output: null, flags: [],
  }) as HitlItem;

describe("openNowStatus", () => {
  it("idle — no non-done runs at all", () => {
    const p = project("p1");
    expect(openNowStatus(p, [], [], NOW)).toEqual({ text: "idle", dot: "track" });
  });

  it("a project with only done runs is idle, not counted as a run", () => {
    const p = project("p1");
    const runs = [run("r1", "p1", { status: "done" })];
    expect(openNowStatus(p, runs, [], NOW)).toEqual({ text: "idle", dot: "track" });
  });

  it("N runs — ordinary running work, ambient (track), not a decision", () => {
    const p = project("p1");
    const runs = [run("r1", "p1"), run("r2", "p1")];
    expect(openNowStatus(p, runs, [], NOW)).toEqual({ text: "2 runs", dot: "track" });
  });

  it("stuck — a run with a stale heartbeat and NO open gate", () => {
    const p = project("p1");
    const runs = [run("r1", "p1", { status: "review", lastHeartbeatAt: NOW - 5 * 60_000 })];
    expect(openNowStatus(p, runs, [], NOW)).toEqual({ text: "stuck", dot: "warn" });
  });

  it("N gates — takes priority over stuck/running runs in the same project", () => {
    const p = project("p1");
    const runs = [run("r1", "p1"), run("r2", "p1", { status: "review", lastHeartbeatAt: NOW - 5 * 60_000 })];
    const queue = [gate("r1")];
    expect(openNowStatus(p, runs, queue, NOW)).toEqual({ text: "1 gate", dot: "human" });
  });

  it("a resolved gate doesn't count — hitlFor only matches an OPEN one", () => {
    const p = project("p1");
    const runs = [run("r1", "p1")];
    const queue = [{ ...gate("r1"), resolvedAt: NOW, resolution: { action: "approve", by: "x", at: NOW, optionIndex: null, guidance: null, targetBranch: null, memoryNote: null, resetWork: false } } as HitlItem];
    expect(openNowStatus(p, runs, queue, NOW)).toEqual({ text: "1 run", dot: "track" });
  });

  it("only counts runs/gates belonging to THIS project", () => {
    const p = project("p1");
    const runs = [run("r1", "p1"), run("r2", "p2")];
    const queue = [gate("r2")]; // gate on the OTHER project's run
    expect(openNowStatus(p, runs, queue, NOW)).toEqual({ text: "1 run", dot: "track" });
  });
});
