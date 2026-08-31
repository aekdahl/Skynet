// ─── Starter rules (Momentum Rollout Phase 1b) ───────────────────────────────
// The acceptance demo's fixture: "seed 2-3 starter rules via a test/script".
// Not wired into production boot — a later phase's rule-authoring UI is the
// real way operators create rules; this is a reusable, realistic fixture for
// exercising the engine end to end in tests and demos.
import { now } from "../config.js";
import type { Rule } from "@skynet/shared";
import type { Store } from "../store/store.js";

export interface SeedRuleOverrides {
  /** Defaults to 10 — kept short so a demo/test doesn't have to wait long for
   *  the announce-before-acting window to elapse. */
  undoWindowMin?: number;
}

/** Seeds three starter rules for `projectId`, covering the v1 vocabulary's
 *  most representative cases: a reactive GitHub signal (pr_merged), a
 *  reactive signal combined with a state check (checks_green + state_equals),
 *  and a time-based condition (time_since_signal_gt) creating a proposal
 *  instead of moving anything. Returns the seeded rules. */
export async function seedStarterRules(
  store: Store,
  workspaceId: string,
  projectId: string,
  overrides: SeedRuleOverrides = {},
): Promise<Rule[]> {
  const undoWindowMin = overrides.undoWindowMin ?? 10;
  const at = now();
  const base = { workspaceId, projectId, stats: { moves: 0, undos: 0 }, state: "live", pausedReason: null, createdAt: at, archived: false } as const;
  const safety = { announceBeforeActing: true, undoWindowMin, pauseAfterUndos: 3, excludePriorities: [] };

  const rules: Rule[] = [
    {
      ...base,
      id: `rule-${projectId}-pr-merged`,
      name: "PR merged → move to review",
      when: "a linked PR merges",
      conditions: [{ field: "event", op: "pr_merged", value: null }],
      actions: [{ type: "move_task", params: { toState: "review" } }],
      safety,
    },
    {
      ...base,
      id: `rule-${projectId}-checks-green`,
      name: "Checks pass on a reviewed PR → move to done",
      when: "checks pass while the task is in review",
      conditions: [
        { field: "event", op: "checks_green", value: null },
        { field: "task.state", op: "state_equals", value: "review" },
      ],
      actions: [{ type: "move_task", params: { toState: "done" } }],
      safety,
    },
    {
      ...base,
      id: `rule-${projectId}-stall`,
      name: "No signal 48h → create stall proposal",
      when: "an ongoing/review task has had no signal in 48 hours",
      conditions: [{ field: "task", op: "time_since_signal_gt", value: 48 }],
      actions: [{ type: "create_proposal", params: { kind: "stall_nudge", payload: {} } }],
      safety,
    },
  ];
  for (const r of rules) await store.putRule(r);
  return rules;
}
