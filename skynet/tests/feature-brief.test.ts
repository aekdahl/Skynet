import { describe, it, expect } from "vitest";
import type { Task, TaskRun } from "@skynet/shared";
import { composeFeatureBrief, parseFeatureNarrative } from "../apps/server/src/feature-brief.js";

const mkTask = (over: Partial<Task> = {}): Task => ({
  id: "t1", workspaceId: "w", projectId: "p1", text: "do X", description: null,
  state: "done", runId: "r1", autoPick: false, assessment: null, assessmentEffort: null,
  assessmentRisks: [], lint: null, reviewVerdict: null,
  assignment: { mode: "any", agentIds: [] }, archived: false, estimatedDurationMs: null,
  plannedStartAt: null, featureId: "f1", milestoneId: null, source: null,
  preferredProvider: null, preferredModel: null, ...over,
});

const mkRun = (over: Partial<TaskRun> = {}): TaskRun => ({
  id: "r1", workspaceId: "w", projectId: "p1", name: "do X", status: "done",
  agentId: "a1", provider: "claude", credentialId: null, model: "opus-4.8", branch: "agent/r1",
  modules: [], progress: 1, plan: [], usage: null, modifiedFiles: [], log: [], startedAt: 0,
  lastHeartbeatAt: 0, visual: false, previewUrl: null, dependsOn: [], parentId: null,
  branchFromStep: null, archived: false, pr: null, mergedAt: null, flyDeployment: null, ...over,
});

describe("parseFeatureNarrative — structured", () => {
  it("reads the narrative field", () => {
    expect(parseFeatureNarrative('{"narrative":"Adds a rate limiter to the public API."}')).toBe(
      "Adds a rate limiter to the public API.",
    );
  });
  it("tolerates a ```json fence and surrounding prose", () => {
    expect(parseFeatureNarrative('Here:\n```json\n{"narrative":"Ships dark mode."}\n```')).toBe("Ships dark mode.");
  });
  it("returns null when the reply isn't readable — never blocks the PR", () => {
    for (const bad of ["", "   ", "looks good", "{not json", '{"summary":"x"}', '{"narrative":""}']) {
      expect(parseFeatureNarrative(bad)).toBeNull();
    }
  });
});

describe("composeFeatureBrief — system-composed facts, from fixtures", () => {
  it("carries a one-liner + verdict per task", () => {
    const tasks = [
      mkTask({ id: "t1", text: "add rate limiter", reviewVerdict: { decision: "approve", reason: "looks good", by: "a2", at: 1 } }),
      mkTask({ id: "t2", text: "add tests", reviewVerdict: { decision: "flag", reason: "missing edge case", by: "a3", at: 2 } }),
      mkTask({ id: "t3", text: "update docs", reviewVerdict: null }),
    ];
    const brief = composeFeatureBrief(tasks, [], null, false);
    expect(brief.tasks).toEqual([
      { taskId: "t1", text: "add rate limiter", verdict: "approve", reviewedBy: "a2" },
      { taskId: "t2", text: "add tests", verdict: "flag", reviewedBy: "a3" },
      { taskId: "t3", text: "update docs", verdict: null, reviewedBy: null },
    ]);
  });

  it("sums every sibling run's usage, treating a vendor-omitted field as unknown, not zero", () => {
    const runs = [
      mkRun({ id: "r1", usage: { inputTokens: 1000, outputTokens: 200, costUsd: 0.05, turns: 3, durationMs: 4000 } }),
      mkRun({ id: "r2", usage: { inputTokens: 2000, outputTokens: 300, costUsd: 0.08, turns: 5, durationMs: 6000 } }),
      mkRun({ id: "r3", usage: null }), // never reported — excluded, not treated as zero spend
    ];
    const brief = composeFeatureBrief([], runs, null, false);
    expect(brief.spend).toEqual({ inputTokens: 3000, outputTokens: 500, costUsd: 0.13, turns: 8, durationMs: 10000 });
  });

  it("costUsd/durationMs stay null in the aggregate when NO run in the batch ever reported them", () => {
    const runs = [
      mkRun({ id: "r1", usage: { inputTokens: 100, outputTokens: 20, costUsd: null, turns: 1, durationMs: null } }),
      mkRun({ id: "r2", usage: { inputTokens: 200, outputTokens: 40, costUsd: null, turns: 2, durationMs: null } }),
    ];
    const brief = composeFeatureBrief([], runs, null, false);
    expect(brief.spend).toEqual({ inputTokens: 300, outputTokens: 60, costUsd: null, turns: 3, durationMs: null });
  });

  it("spend is null when no sibling run reported usage at all", () => {
    const brief = composeFeatureBrief([], [mkRun({ usage: null })], null, false);
    expect(brief.spend).toBeNull();
  });

  it("evidence summary reports approved/flagged counts from recorded verdicts only", () => {
    const tasks = [
      mkTask({ id: "t1", reviewVerdict: { decision: "approve", reason: "ok", by: "a2", at: 1 } }),
      mkTask({ id: "t2", reviewVerdict: { decision: "approve", reason: "ok", by: "a2", at: 1 } }),
      mkTask({ id: "t3", reviewVerdict: { decision: "flag", reason: "risky", by: "a3", at: 2 } }),
      mkTask({ id: "t4", reviewVerdict: null }), // not yet reviewed — excluded from the count
    ];
    const brief = composeFeatureBrief(tasks, [], null, false);
    expect(brief.evidenceSummary).toEqual(["2 of 3 reviewed task(s) approved by their reviewing agent; 1 flagged."]);
  });

  it("evidence summary says everything approved when nothing was flagged", () => {
    const tasks = [mkTask({ id: "t1", reviewVerdict: { decision: "approve", reason: "ok", by: "a2", at: 1 } })];
    const brief = composeFeatureBrief(tasks, [], null, false);
    expect(brief.evidenceSummary).toEqual(["All 1 reviewed task(s) approved by their reviewing agent."]);
  });

  it("adds a verifier-gate line only when checks are actually configured, never fabricated", () => {
    expect(composeFeatureBrief([], [], null, false).evidenceSummary).toEqual([]);
    expect(composeFeatureBrief([], [], null, true).evidenceSummary).toEqual([
      "Verifier gate runs the project's checks after merge and rolls back the merge on failure.",
    ]);
  });

  it("carries the narrative through unchanged, and null when none was drafted", () => {
    expect(composeFeatureBrief([], [], "What this feature does.", false).narrative).toBe("What this feature does.");
    expect(composeFeatureBrief([], [], null, false).narrative).toBeNull();
  });
});
