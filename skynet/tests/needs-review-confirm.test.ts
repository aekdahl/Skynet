// Approving a diff/merge gate merges the run's work — needsReviewConfirm
// flags when that's about to happen with NO other agent having looked at it,
// so the UI can show "merge without a review?" friction instead of a silent
// one-click merge of completely unreviewed work.
import { describe, it, expect } from "vitest";
import type { HitlItem, Task } from "@skynet/shared";
import { needsReviewConfirm } from "../apps/web/src/lib/derive.js";

const item = (kind: HitlItem["kind"], runId = "r1"): HitlItem =>
  ({
    id: "q1", workspaceId: "ws", runId, kind, title: "x", why: "",
    risk: "medium", raisedAt: 0, expiresAt: null, resolvedAt: null, resolution: null,
    rationale: null, command: null, options: null, recommended: null, steps: null, diff: null,
  }) as HitlItem;

const task = (over: Partial<Task> = {}): Task =>
  ({
    id: "t1", workspaceId: "ws", projectId: "p1", text: "do it", state: "review",
    runId: "r1", reviewVerdict: null, ...over,
  }) as Task;

describe("needsReviewConfirm", () => {
  it("flags a diff gate whose task has no reviewVerdict", () => {
    expect(needsReviewConfirm(item("diff"), [task()])).toBe(true);
  });

  it("flags a merge gate whose task has no reviewVerdict", () => {
    expect(needsReviewConfirm(item("merge"), [task()])).toBe(true);
  });

  it("does not flag once a reviewVerdict is recorded", () => {
    const reviewed = task({ reviewVerdict: { decision: "approve", reason: "fine", by: "agent-2", at: 0, evidence: null, breaker: null } });
    expect(needsReviewConfirm(item("diff"), [reviewed])).toBe(false);
  });

  it("never flags approval/question/plan/verifier gates — they aren't a merge decision", () => {
    for (const kind of ["approval", "question", "plan", "verifier"] as const) {
      expect(needsReviewConfirm(item(kind), [task()])).toBe(false);
    }
  });

  it("flags (the safe default) when no task is linked to the run at all — never silently skip on ambiguity", () => {
    expect(needsReviewConfirm(item("diff", "r-unlinked"), [task()])).toBe(true);
  });
});
