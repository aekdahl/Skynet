// Spend efficiency: how much of what the fleet costs actually ships. Added
// after reconciling a month of real spend showed only a fraction of it reached
// a merge — a number that mattered enormously and appeared nowhere in the UI.
// PURE derivation over runs already in the snapshot.
import { describe, it, expect } from "vitest";
import type { TaskRun } from "@skynet/shared";
import { DEFAULT_WORKSPACE } from "@skynet/shared";
import { spendEfficiency, spendOutcomeOf } from "../apps/web/src/lib/derive";

const run = (over: Partial<TaskRun> & { costUsd?: number | null } = {}): TaskRun => {
  const { costUsd, ...rest } = over;
  return {
    id: "r", workspaceId: DEFAULT_WORKSPACE, projectId: "p", name: "t", status: "done",
    agentId: null, provider: "claude", credentialId: null, model: "sonnet-5", branch: "b",
    modules: [], progress: 0, plan: [], modifiedFiles: [], log: [], startedAt: 0,
    lastHeartbeatAt: 0, visual: false, previewUrl: null, dependsOn: [], parentId: null,
    branchFromStep: null, archived: false, pr: null, mergedAt: null, flyDeployment: null,
    usage: costUsd === undefined ? null : { inputTokens: 0, outputTokens: 0, costUsd, turns: 0, durationMs: null },
    ...rest,
  } as TaskRun;
};

describe("spendOutcomeOf", () => {
  it("a merged run is the only thing that counts as delivered", () => {
    expect(spendOutcomeOf(run({ mergedAt: 1, status: "done" }))).toBe("delivered");
  });

  it("running / waiting / review are in-flight — not yet judged", () => {
    for (const status of ["running", "waiting", "review"] as const) {
      expect(spendOutcomeOf(run({ status }))).toBe("in-flight");
    }
  });

  it("done-without-a-merge is money spent that didn't land", () => {
    expect(spendOutcomeOf(run({ status: "done", mergedAt: null }))).toBe("abandoned");
  });

  it("an ARCHIVED run is never in-flight, whatever its status says", () => {
    // Reaped/stopped runs get archived while their status may still read
    // "waiting" — counting those as in-flight would hide real waste.
    expect(spendOutcomeOf(run({ status: "waiting", archived: true }))).toBe("abandoned");
  });

  it("a merged run stays delivered even once archived", () => {
    expect(spendOutcomeOf(run({ status: "done", mergedAt: 5, archived: true }))).toBe("delivered");
  });
});

describe("spendEfficiency", () => {
  it("splits spend by outcome and reports the delivered share", () => {
    const eff = spendEfficiency([
      run({ mergedAt: 1, costUsd: 20 }),
      run({ status: "done", costUsd: 60 }),
      run({ status: "running", costUsd: 20 }),
    ]);
    expect(eff.totalUsd).toBeCloseTo(100, 6);
    expect(eff.deliveredShare).toBeCloseTo(0.2, 6);
    const by = Object.fromEntries(eff.buckets.map((b) => [b.outcome, b]));
    expect(by.delivered!.costUsd).toBeCloseTo(20, 6);
    expect(by.abandoned!.costUsd).toBeCloseTo(60, 6);
    expect(by["in-flight"]!.costUsd).toBeCloseTo(20, 6);
    expect(by.abandoned!.share).toBeCloseTo(0.6, 6);
  });

  it("always returns all three buckets, even at zero, so the legend never jumps", () => {
    const eff = spendEfficiency([run({ mergedAt: 1, costUsd: 5 })]);
    expect(eff.buckets.map((b) => b.outcome)).toEqual(["delivered", "in-flight", "abandoned"]);
  });

  it("counts unpriced runs in `runs` but not in the money — and flags it via pricedShare", () => {
    // A run the provider never priced (or, before the accounting fix, never
    // reported at all) must not silently inflate the delivered share.
    const eff = spendEfficiency([
      run({ mergedAt: 1, costUsd: 10 }),
      run({ status: "done", costUsd: null }),
      run({ status: "done" }), // usage entirely absent
    ]);
    expect(eff.runs).toBe(3);
    expect(eff.totalUsd).toBeCloseTo(10, 6);
    expect(eff.pricedShare).toBeCloseTo(1 / 3, 6);
    // Two abandoned runs are counted, but contribute $0 — the caveat line in
    // the UI is what keeps this honest rather than confidently wrong.
    const abandoned = eff.buckets.find((b) => b.outcome === "abandoned")!;
    expect(abandoned.runs).toBe(2);
    expect(abandoned.costUsd).toBe(0);
  });

  it("no runs → zeroed, no division by zero, pricedShare 1", () => {
    const eff = spendEfficiency([]);
    expect(eff).toMatchObject({ totalUsd: 0, deliveredShare: 0, pricedShare: 1, runs: 0 });
    expect(eff.buckets.every((b) => b.share === 0)).toBe(true);
  });

  it("all-unpriced runs → no NaN shares", () => {
    const eff = spendEfficiency([run({ costUsd: null }), run({ costUsd: null })]);
    expect(eff.deliveredShare).toBe(0);
    expect(eff.buckets.every((b) => Number.isFinite(b.share))).toBe(true);
  });

  it("reproduces the real-deployment shape that prompted this (mostly not landing)", () => {
    // Modelled on the live reconciliation: a minority of spend merged, a large
    // share stalled/stopped. The card exists to make exactly this visible.
    const eff = spendEfficiency([
      ...Array.from({ length: 23 }, () => run({ mergedAt: 1, costUsd: 26.53 / 23 })),
      ...Array.from({ length: 40 }, () => run({ status: "done", archived: true, costUsd: 39.84 / 40 })),
      ...Array.from({ length: 76 }, () => run({ status: "done", costUsd: 70.8 / 76 })),
    ]);
    expect(eff.totalUsd).toBeCloseTo(137.17, 1);
    expect(eff.deliveredShare).toBeGreaterThan(0.18);
    expect(eff.deliveredShare).toBeLessThan(0.2);
  });
});
