// buildSiblingDigest (S3) — the pure derivation every run-start call site now
// feeds into buildAgentContext's `siblings` field (see agent-context.ts) so an
// agent starting fresh work sees what else is happening on the SAME project
// right now, and stops duplicating/colliding with it. No LLM involved — this
// is a pure composition over data already in the store.
import { describe, it, expect } from "vitest";
import type { Feature, Task, TaskRun } from "@skynet/shared";
import { buildSiblingDigest } from "../apps/server/src/sibling-digest.js";

const project = { id: "p1" };

const mkTask = (over: Partial<Task>): Task =>
  ({
    id: "t-x", workspaceId: "ws", projectId: "p1", text: "do something", state: "todo",
    runId: null, archived: false, assignment: { mode: "unassigned", agentIds: [] },
    ...over,
  }) as Task;

const mkRun = (over: Partial<TaskRun>): TaskRun =>
  ({
    id: "r-x", workspaceId: "ws", projectId: "p1", name: "do something", status: "done",
    provider: "claude", model: "opus-4.8", branch: "agent/r-x", mergedAt: null,
    ...over,
  }) as TaskRun;

const mkFeature = (over: Partial<Feature>): Feature =>
  ({
    id: "f-x", workspaceId: "ws", projectId: "p1", name: "Some Feature", description: null,
    status: "active", milestoneId: null, archived: false, createdAt: 0, pr: null, sizeWarning: null,
    ...over,
  }) as Feature;

describe("buildSiblingDigest — empty / no-op cases", () => {
  it("returns an empty string when the project has no siblings at all", () => {
    expect(buildSiblingDigest(project, [], [], "t1")).toBe("");
  });

  it("returns an empty string when the only tasks are the excluded one, done, backlog, or archived (nothing sibling-worthy)", () => {
    const tasks: Task[] = [
      mkTask({ id: "t1", state: "ongoing" }), // the excluded task itself
      mkTask({ id: "t2", state: "done" }),
      mkTask({ id: "t3", state: "backlog" }),
      mkTask({ id: "t4", state: "ongoing", archived: true }),
    ];
    expect(buildSiblingDigest(project, tasks, [], "t1")).toBe("");
  });

  it("ignores tasks/runs from a DIFFERENT project", () => {
    const tasks: Task[] = [mkTask({ id: "t2", projectId: "other-project", state: "ongoing" })];
    const runs: TaskRun[] = [mkRun({ id: "r2", projectId: "other-project", mergedAt: 100 })];
    expect(buildSiblingDigest(project, tasks, runs, "t1")).toBe("");
  });
});

describe("buildSiblingDigest — excludes the caller's own task", () => {
  it("never lists excludeTaskId as one of its own siblings", () => {
    const tasks: Task[] = [
      mkTask({ id: "t1", text: "the task starting now", state: "ongoing" }),
      mkTask({ id: "t2", text: "a real sibling", state: "ongoing" }),
    ];
    const out = buildSiblingDigest(project, tasks, [], "t1");
    expect(out).not.toContain("the task starting now");
    expect(out).toContain("a real sibling");
  });
});

describe("buildSiblingDigest — content + formatting", () => {
  it("lists ongoing/review siblings with a short text snippet, state, and feature name", () => {
    const tasks: Task[] = [
      mkTask({ id: "t2", text: "Add rate limiting to the API", state: "ongoing", featureId: "f-x" }),
      mkTask({ id: "t3", text: "Fix the login redirect loop", state: "review" }),
    ];
    const out = buildSiblingDigest(project, tasks, [], "t1", [mkFeature({ id: "f-x", name: "API hardening" })]);
    expect(out).toContain('"Add rate limiting to the API" (ongoing, Feature: API hardening)');
    expect(out).toContain('"Fix the login redirect loop" (review)');
    // The steering instruction always rides along with real content.
    expect(out).toContain("prefer building on it over duplicating it");
  });

  it("truncates task text to ~80 chars with an ellipsis", () => {
    const longText = "x".repeat(150);
    const tasks: Task[] = [mkTask({ id: "t2", text: longText, state: "ongoing" })];
    const out = buildSiblingDigest(project, tasks, [], "t1");
    expect(out).toContain(`"${"x".repeat(80)}…"`);
    expect(out).not.toContain("x".repeat(81));
  });

  it("caps recently-merged runs to the 5 most recent by mergedAt, most recent first", () => {
    const runs: TaskRun[] = Array.from({ length: 8 }, (_, i) =>
      mkRun({ id: `r${i}`, name: `merged run ${i}`, mergedAt: i * 1000 }),
    );
    const out = buildSiblingDigest(project, [], runs, "t1");
    const order = [7, 6, 5, 4, 3].map((i) => `merged run ${i}`);
    let cursor = 0;
    for (const name of order) {
      const idx = out.indexOf(name);
      expect(idx).toBeGreaterThanOrEqual(cursor);
      cursor = idx;
    }
    // The two oldest merges were dropped by the top-5 cap.
    expect(out).not.toContain("merged run 0");
    expect(out).not.toContain("merged run 1");
  });

  it("ignores unmerged runs (mergedAt: null)", () => {
    const runs: TaskRun[] = [mkRun({ id: "r2", name: "still running", mergedAt: null })];
    expect(buildSiblingDigest(project, [], runs, "t1")).toBe("");
  });

  it("caps queued-up-next todo tasks to the top 3 by `order`, ascending", () => {
    const tasks: Task[] = [
      mkTask({ id: "t2", text: "queued D", state: "todo", order: 4 }),
      mkTask({ id: "t3", text: "queued A", state: "todo", order: 1 }),
      mkTask({ id: "t4", text: "queued C", state: "todo", order: 3 }),
      mkTask({ id: "t5", text: "queued B", state: "todo", order: 2 }),
    ];
    const out = buildSiblingDigest(project, tasks, [], "t1");
    expect(out).toContain("queued A");
    expect(out).toContain("queued B");
    expect(out).toContain("queued C");
    expect(out).not.toContain("queued D"); // 4th by order — dropped by the top-3 cap
    expect(out.indexOf("queued A")).toBeLessThan(out.indexOf("queued B"));
    expect(out.indexOf("queued B")).toBeLessThan(out.indexOf("queued C"));
  });
});

describe("buildSiblingDigest — the ~1.2k hard cap", () => {
  it("never exceeds the cap, and the steering instruction always survives", () => {
    // 30 ongoing siblings, each near the 80-char snippet cap — comfortably
    // enough on its own to blow well past 1.2k chars if nothing were dropped.
    const tasks: Task[] = Array.from({ length: 30 }, (_, i) =>
      mkTask({ id: `t${i + 2}`, text: `ongoing sibling number ${i} touching the shared module `.repeat(2), state: "ongoing" }),
    );
    const out = buildSiblingDigest(project, tasks, [], "t1");
    expect(out.length).toBeLessThanOrEqual(1_200);
    expect(out).toContain("prefer building on it over duplicating it");
  });

  it("drops queued-up-next and recently-merged before touching ongoing/review siblings", () => {
    const tasks: Task[] = [
      ...Array.from({ length: 20 }, (_, i) =>
        mkTask({ id: `t${i + 2}`, text: `busy sibling ${i} doing real overlapping work here `.repeat(2), state: "ongoing" }),
      ),
      mkTask({ id: "tq1", text: "a queued task", state: "todo", order: 1 }),
    ];
    const runs: TaskRun[] = [mkRun({ id: "rm1", name: "a merged run", mergedAt: 100 })];
    const out = buildSiblingDigest(project, tasks, runs, "t1");
    expect(out.length).toBeLessThanOrEqual(1_200);
    // Lower-priority sections were dropped to stay under budget...
    expect(out).not.toContain("a queued task");
    expect(out).not.toContain("a merged run");
    // ...while at least some ongoing/review content (the highest-priority,
    // most collision-relevant section) survived.
    expect(out).toContain("busy sibling 0");
  });
});
