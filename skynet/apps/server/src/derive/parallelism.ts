// ─── Derived intelligence: parallelism nudge ─────────────────────────────────
// "idle runners + deep backlog → spin up more?" (roadmap v1.5) — turns the
// fleet's own idle state into a light, non-naggy hint. Computed server-side so
// it's authoritative (same reasoning as derive/conflicts.ts), not a second
// definition duplicated in the client. Eligibility mirrors the autonomy loop's
// own check (orchestrator.ts tickAutonomy, step 2 — auto-pick): a task with no
// assignment set isn't workable by anyone yet, human or auto, so it shouldn't
// count toward "there's real backlog waiting." Broader than auto-pick's own
// `autoPick` flag, though — this is total addressable backlog (backlog + todo),
// not just what the autonomy loop would grab next.

import type { Agent, Task } from "@skynet/shared";

// Two idle runners, not one — a single agent between runs is normal churn, not
// spare capacity. Three-plus eligible tasks is a real queue, not the last couple
// of items about to be picked up anyway. Deliberately simple; tune later.
const MIN_IDLE_RUNNERS = 2;
const MIN_ELIGIBLE_BACKLOG = 3;

export interface ParallelismNudge {
  idleRunners: number;
  eligibleBacklog: number;
  shouldNudge: boolean;
}

function isEligible(t: Task): boolean {
  return (
    !t.archived &&
    (t.state === "backlog" || t.state === "todo") &&
    (t.assignment?.mode ?? "unassigned") !== "unassigned"
  );
}

export function computeParallelismNudge(fleet: Agent[], tasks: Task[]): ParallelismNudge {
  const idleRunners = fleet.filter((a) => a.status === "idle").length;
  const eligibleBacklog = tasks.filter(isEligible).length;
  return {
    idleRunners,
    eligibleBacklog,
    shouldNudge: idleRunners >= MIN_IDLE_RUNNERS && eligibleBacklog >= MIN_ELIGIBLE_BACKLOG,
  };
}
