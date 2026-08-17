// Cost/usage roll-up (operator ergonomics P3) — sums TaskRun.usage per project
// and per agent. A pure function, covered deterministically here. `costUsd`/
// `durationMs` stay null when nothing in the group reported one, distinct from
// `uncostedRuns` (runs with no usage report at all) — a caller must be able to
// tell "genuinely $0" apart from "vendor doesn't report."
import { describe, it, expect } from "vitest";
import type { TaskRun, Usage } from "@skynet/shared";
import { computeUsageRollup } from "../apps/web/src/lib/derive.js";

const usage = (extra: Partial<Usage> = {}): Usage =>
  ({ inputTokens: 100, outputTokens: 50, costUsd: 1.5, turns: 1, durationMs: 1000, ...extra });

const run = (id: string, projectId: string, agentId: string | null, extra: Partial<TaskRun> = {}): TaskRun =>
  ({ id, projectId, agentId, archived: false, usage: usage(), ...extra }) as unknown as TaskRun;

describe("computeUsageRollup", () => {
  it("sums tokens/cost/duration per project and per agent", () => {
    const runs = [
      run("r1", "p1", "a1"),
      run("r2", "p1", "a1", { usage: usage({ inputTokens: 200, outputTokens: 100, costUsd: 2.5, durationMs: 2000 }) }),
      run("r3", "p2", "a2"),
    ];
    const { byProject, byAgent } = computeUsageRollup(runs);
    expect(byProject.p1).toEqual({ runCount: 2, tokensIn: 300, tokensOut: 150, costUsd: 4, durationMs: 3000, uncostedRuns: 0 });
    expect(byProject.p2).toEqual({ runCount: 1, tokensIn: 100, tokensOut: 50, costUsd: 1.5, durationMs: 1000, uncostedRuns: 0 });
    expect(byAgent.a1).toEqual({ runCount: 2, tokensIn: 300, tokensOut: 150, costUsd: 4, durationMs: 3000, uncostedRuns: 0 });
    expect(byAgent.a2).toEqual({ runCount: 1, tokensIn: 100, tokensOut: 50, costUsd: 1.5, durationMs: 1000, uncostedRuns: 0 });
  });

  it("keeps costUsd/durationMs null (not 0) when no run in the group reported one", () => {
    const runs = [run("r1", "p1", "a1", { usage: null }), run("r2", "p1", "a1", { usage: null })];
    const { byProject } = computeUsageRollup(runs);
    expect(byProject.p1).toEqual({ runCount: 2, tokensIn: 0, tokensOut: 0, costUsd: null, durationMs: null, uncostedRuns: 2 });
  });

  it("distinguishes a genuinely-zero cost from an unreported one within the same group", () => {
    const runs = [
      run("r1", "p1", "a1", { usage: usage({ costUsd: 0 }) }), // vendor reported exactly $0
      run("r2", "p1", "a1", { usage: null }), // vendor never reported
    ];
    const { byProject } = computeUsageRollup(runs);
    expect(byProject.p1.costUsd).toBe(0); // known total is $0, not "unknown"
    expect(byProject.p1.uncostedRuns).toBe(1); // but one run's cost is still unaccounted for
  });

  it("counts a run with usage but no costUsd as uncosted, while still summing its tokens", () => {
    const runs = [run("r1", "p1", "a1", { usage: usage({ costUsd: null, inputTokens: 40, outputTokens: 10 }) })];
    const { byProject } = computeUsageRollup(runs);
    expect(byProject.p1).toEqual({ runCount: 1, tokensIn: 40, tokensOut: 10, costUsd: null, durationMs: 1000, uncostedRuns: 1 });
  });

  it("excludes archived runs", () => {
    const runs = [run("r1", "p1", "a1"), run("r2", "p1", "a1", { archived: true })];
    const { byProject } = computeUsageRollup(runs);
    expect(byProject.p1.runCount).toBe(1);
  });

  it("omits a run with no agentId from byAgent but still counts it in byProject", () => {
    const runs = [run("r1", "p1", null)];
    const { byProject, byAgent } = computeUsageRollup(runs);
    expect(byProject.p1.runCount).toBe(1);
    expect(byAgent).toEqual({});
  });

  it("returns empty records for no runs", () => {
    expect(computeUsageRollup([])).toEqual({ byProject: {}, byAgent: {} });
  });
});
