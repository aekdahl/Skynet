// Feature-batch size guardrail (ROADMAP: feature-scoped branch batching lets
// one human approval cover every task under a Feature — with no cap on how
// big that batch gets). `checkFeatureBatchSize` is the pure discriminator;
// `buildFeatureMergeBriefing` (private — reached the same way the existing
// preview tests poke private manager state, see preview-refresh-deps.test.ts)
// is where it's actually wired into the PR's briefing: past any threshold the
// PR still opens, but risk floors at "high" and the rationale names which
// threshold(s) tripped and by how much.
import { describe, it, expect } from "vitest";
import type { Feature, Task } from "@skynet/shared";
import { DEFAULT_WORKSPACE } from "@skynet/shared";
import { checkFeatureBatchSize, Orchestrator } from "../apps/server/src/orchestrator.js";
import { Hub } from "../apps/server/src/hub.js";
import { MemoryStore } from "../apps/server/src/store/memory.js";
import type { Bus } from "../apps/server/src/bus.js";

class NullBus implements Bus {
  publish(): void {}
  subscribe(): () => void {
    return () => {};
  }
}

const THRESHOLDS = { maxTasks: 12, maxChangedLines: 5000, maxFiles: 60 };

describe("checkFeatureBatchSize (pure)", () => {
  it("does not trip when every dimension is under threshold", () => {
    const result = checkFeatureBatchSize({ taskCount: 5, changedLines: 200, filesChanged: 10 }, THRESHOLDS);
    expect(result).toEqual({ tripped: false, reason: null });
  });

  it("does not trip exactly AT a threshold (over, not at-or-over)", () => {
    const result = checkFeatureBatchSize({ taskCount: 12, changedLines: 5000, filesChanged: 60 }, THRESHOLDS);
    expect(result.tripped).toBe(false);
  });

  it("trips on task count alone, naming the exact overage", () => {
    const result = checkFeatureBatchSize({ taskCount: 15, changedLines: 100, filesChanged: 5 }, THRESHOLDS);
    expect(result.tripped).toBe(true);
    expect(result.reason).toBe("15 tasks (3 over the 12-task limit)");
  });

  it("trips on changed-line count alone, naming the exact overage", () => {
    const result = checkFeatureBatchSize({ taskCount: 3, changedLines: 5200, filesChanged: 5 }, THRESHOLDS);
    expect(result.tripped).toBe(true);
    expect(result.reason).toBe("5200 changed lines (200 over the 5000-line limit)");
  });

  it("trips on files-changed count alone, naming the exact overage", () => {
    const result = checkFeatureBatchSize({ taskCount: 3, changedLines: 100, filesChanged: 75 }, THRESHOLDS);
    expect(result.tripped).toBe(true);
    expect(result.reason).toBe("75 files changed (15 over the 60-file limit)");
  });

  it("names EVERY threshold that trips, not just the first", () => {
    const result = checkFeatureBatchSize({ taskCount: 20, changedLines: 6000, filesChanged: 100 }, THRESHOLDS);
    expect(result.tripped).toBe(true);
    expect(result.reason).toBe(
      "20 tasks (8 over the 12-task limit); 6000 changed lines (1000 over the 5000-line limit); 100 files changed (40 over the 60-file limit)",
    );
  });
});

// ─── buildFeatureMergeBriefing wiring (private method — reached via a typed
// cast, the same style preview-refresh-deps.test.ts uses to poke a manager's
// private state directly) ────────────────────────────────────────────────
type BriefingFn = (
  feature: Feature,
  taskNames: string[],
  stat: { add: number; del: number; files: string[] },
  modules: string[],
  siblings: Task[],
) => { risk: string; rationale: string; recommendation: string };

function briefingFnOf(o: Orchestrator): BriefingFn {
  return (o as unknown as { buildFeatureMergeBriefing: BriefingFn }).buildFeatureMergeBriefing.bind(o);
}

const feature: Feature = {
  id: "f-1",
  workspaceId: DEFAULT_WORKSPACE,
  projectId: "p-1",
  name: "Checkout revamp",
  description: null,
  status: "active",
  milestoneId: null,
  order: 0,
  archived: false,
  createdAt: 0,
  pr: null,
  sizeWarning: null,
};

function siblingTasks(n: number): Task[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `t-${i}`,
    workspaceId: DEFAULT_WORKSPACE,
    projectId: "p-1",
    text: `task ${i}`,
    description: null,
    state: "done" as const,
    runId: null,
    autoPick: false,
    assessment: null,
    assessmentEffort: null,
    assessmentRisks: [],
    reviewVerdict: null,
    assignment: { mode: "unassigned" as const, agentIds: [] },
    order: i,
    archived: false,
    estimatedDurationMs: null,
    plannedStartAt: null,
    featureId: "f-1",
    milestoneId: null,
    source: null,
    lint: null,
    preferredProvider: null,
    preferredModel: null,
  }));
}

function newOrchestrator(): Orchestrator {
  const store = new MemoryStore({ seed: false });
  const hub = new Hub(store, new NullBus());
  return new Orchestrator(store, hub);
}

describe("buildFeatureMergeBriefing — size guardrail wiring", () => {
  it("under every threshold: risk/rationale UNCHANGED from today's plain heuristic", () => {
    const briefing = briefingFnOf(newOrchestrator())(
      feature,
      ["a", "b", "c"],
      { add: 100, del: 50, files: ["src/a.ts", "src/b.ts"] },
      ["src"],
      siblingTasks(3),
    );
    expect(briefing.risk).toBe("low"); // small, non-sensitive diff — unaffected by the guardrail
    expect(briefing.rationale).toBe("No flagged tasks in this batch.");
    expect(briefing.rationale).not.toMatch(/guardrail/i);
  });

  it("over the task-count threshold: risk floors at high, rationale names the guardrail + overage", () => {
    const taskNames = Array.from({ length: 14 }, (_, i) => `task ${i}`);
    const briefing = briefingFnOf(newOrchestrator())(
      feature,
      taskNames,
      { add: 100, del: 50, files: ["src/a.ts"] }, // small diff — would be "low" on its own
      ["src"],
      siblingTasks(14),
    );
    expect(briefing.risk).toBe("high");
    expect(briefing.rationale).toMatch(/exceeds the size guardrail/i);
    expect(briefing.rationale).toMatch(/14 tasks \(2 over the 12-task limit\)/);
  });

  it("over the changed-lines threshold: risk floors at high even with few files/tasks", () => {
    const briefing = briefingFnOf(newOrchestrator())(
      feature,
      ["a"],
      { add: 4000, del: 2000, files: ["src/a.ts"] }, // 6000 changed lines, 1 file
      ["src"],
      siblingTasks(1),
    );
    expect(briefing.risk).toBe("high");
    expect(briefing.rationale).toMatch(/6000 changed lines \(1000 over the 5000-line limit\)/);
  });

  it("a flagged sibling AND a size breach both surface — rework recommendation, guardrail rationale appended", () => {
    const siblings = siblingTasks(14);
    siblings[0]!.reviewVerdict = { by: "reviewer", decision: "flag", reason: "needs a second look" };
    const taskNames = siblings.map((t) => t.text);
    const briefing = briefingFnOf(newOrchestrator())(feature, taskNames, { add: 50, del: 20, files: ["a.ts"] }, [], siblings);
    expect(briefing.recommendation).toBe("rework");
    expect(briefing.risk).toBe("high");
    expect(briefing.rationale).toMatch(/1 of 14 task\(s\) were flagged/);
    expect(briefing.rationale).toMatch(/exceeds the size guardrail/i);
  });
});
