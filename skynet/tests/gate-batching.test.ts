// Governance-to-SOTA — policy-driven gate batching's pure grouping logic.
import { describe, it, expect } from "vitest";
import type { Decision } from "@skynet/shared";
import { groupBatchableDecisions } from "../apps/web/src/kanban/gate-batching.js";

const decision = (over: Partial<Decision> & Pick<Decision, "id">): Decision => ({
  workspaceId: "w", runId: `r-${over.id}`, bakeoffId: null, kind: "approval", title: "run tests",
  why: "", risk: "low", raisedAt: 1000, expiresAt: null, resolvedAt: null, resolution: null,
  rationale: null, command: "npm test", options: null, recommended: null, steps: null, diff: null,
  output: null, flags: [], sourceBranchOverride: null, projectId: "p1", roadmapProposalId: null,
  projectName: "Project One", taskTitle: "A task", costOfWaiting: 1,
  ...over,
});

describe("groupBatchableDecisions", () => {
  it("groups 2+ approval gates with an identical (normalized) command into one batch", () => {
    const decisions = [
      decision({ id: "a", command: "npm test" }),
      decision({ id: "b", command: "npm  test\n" }), // whitespace differs, same normalized command
      decision({ id: "c", command: "npm test" }),
    ];
    const { batches, singles } = groupBatchableDecisions(decisions);
    expect(singles).toHaveLength(0);
    expect(batches).toHaveLength(1);
    expect(batches[0]!.command).toBe("npm test");
    expect(batches[0]!.items.map((i) => i.id).sort()).toEqual(["a", "b", "c"]);
  });

  it("a lone matching gate (no other gate shares its command) stays a single, not a 1-item batch", () => {
    const decisions = [decision({ id: "a", command: "npm test" }), decision({ id: "b", command: "npm build" })];
    const { batches, singles } = groupBatchableDecisions(decisions);
    expect(batches).toHaveLength(0);
    expect(singles.map((d) => d.id).sort()).toEqual(["a", "b"]);
  });

  it("different commands never merge, even with 2+ each — one batch per distinct command", () => {
    const decisions = [
      decision({ id: "a", command: "npm test" }),
      decision({ id: "b", command: "npm test" }),
      decision({ id: "c", command: "npm build" }),
      decision({ id: "d", command: "npm build" }),
    ];
    const { batches, singles } = groupBatchableDecisions(decisions);
    expect(singles).toHaveLength(0);
    expect(batches).toHaveLength(2);
    expect(batches.map((b) => b.command).sort()).toEqual(["npm build", "npm test"]);
  });

  it("non-approval kinds never batch, regardless of command overlap or count", () => {
    const decisions = [
      decision({ id: "a", kind: "question", command: null }),
      decision({ id: "b", kind: "question", command: null }),
      decision({ id: "c", kind: "escalation", command: null }),
    ];
    const { batches, singles } = groupBatchableDecisions(decisions);
    expect(batches).toHaveLength(0);
    expect(singles).toHaveLength(3);
  });

  it("an approval gate with no command (a non-Claude runner's commandless approval) never batches", () => {
    const decisions = [
      decision({ id: "a", command: null }),
      decision({ id: "b", command: null }),
    ];
    const { batches, singles } = groupBatchableDecisions(decisions);
    expect(batches).toHaveLength(0);
    expect(singles).toHaveLength(2);
  });

  it("batches sort by their highest-cost-of-waiting member, most urgent first", () => {
    const decisions = [
      decision({ id: "a", command: "npm test", costOfWaiting: 5 }),
      decision({ id: "b", command: "npm test", costOfWaiting: 5 }),
      decision({ id: "c", command: "npm build", costOfWaiting: 50 }),
      decision({ id: "d", command: "npm build", costOfWaiting: 10 }),
    ];
    const { batches } = groupBatchableDecisions(decisions);
    expect(batches.map((b) => b.command)).toEqual(["npm build", "npm test"]);
  });

  it("cross-project gates on the same command still batch together", () => {
    const decisions = [
      decision({ id: "a", command: "npm test", projectId: "p1", projectName: "One" }),
      decision({ id: "b", command: "npm test", projectId: "p2", projectName: "Two" }),
    ];
    const { batches } = groupBatchableDecisions(decisions);
    expect(batches).toHaveLength(1);
    expect(batches[0]!.items.map((i) => i.projectName).sort()).toEqual(["One", "Two"]);
  });
});
