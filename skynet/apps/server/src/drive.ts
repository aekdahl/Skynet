// ─── Project driver: "what stands between this project and done?" ───────────
// The autonomy tick is TASK-scoped: it triages one item, auto-picks one, and
// auto-reviews one. That keeps individual tasks moving but never asks the
// project-level question — so a project with an empty backlog, two items stuck
// in triage and nothing merged for days looks EXACTLY like a healthy idle one.
// The loop stays busy; it doesn't drive.
//
// This is that missing question, as ONE pure function. Pure so the same
// judgement can be shown in the UI, asserted in tests, and acted on by the tick
// without any of them drifting — and so "why is this project not moving?" has a
// single answer rather than three approximations.
//
// It DIAGNOSES. It deliberately doesn't decide to spend money: the one
// automatic remedy the tick draws from it (re-pull a bound source when the
// backlog runs dry) is a read, not a run. Everything else is surfaced for a
// human, because a project that has genuinely run out of clear work is a
// decision point, not a scheduling problem.

import type { Agent, Project, Task, TaskRun } from "@skynet/shared";

/**
 * Why a project isn't progressing — ordered by what an operator should look at
 * first. `working` and `done` are the healthy states; everything else names a
 * specific thing standing in the way.
 */
export type DriveState =
  | "working" // runs in flight — nothing to say
  | "done" // every task finished
  | "needs_triage" // tasks exist but none came out of triage clear
  | "needs_review" // work finished and is waiting on a human verdict
  | "no_capacity" // ready work, but every runner is busy or benched
  | "no_runners" // ready work, and no usable runner is configured at all
  | "autonomy_off" // ready work, capacity free, but the project won't self-start
  | "empty"; // nothing on the board at all

export interface DriveAssessment {
  state: DriveState;
  /** One line an operator can act on. Never a bare state name. */
  detail: string;
  /** True when re-pulling a bound source (issues, roadmap doc) might help —
   *  the only remedy the tick applies on its own, because it's a read. */
  refillFromSource: boolean;
}

export interface DriveInput {
  project: Pick<Project, "id" | "name" | "status" | "autonomy"> & { repo?: string | null; syncSourceStatus?: boolean };
  /** This project's non-archived tasks. */
  tasks: Task[];
  /** This project's live (non-archived, non-done) runs. */
  liveRuns: TaskRun[];
  /** The workspace fleet, with `usable` resolved by the caller — a runner on a
   *  benched key is configured but cannot work, and conflating the two would
   *  tell an operator to free capacity that was never the problem. */
  runners: { agent: Agent; usable: boolean }[];
}

/**
 * PURE. Diagnose one project.
 *
 * Order matters and encodes priority: work in flight beats every other
 * observation (the project IS progressing), and a review waiting on a human
 * outranks a capacity complaint (the human is the bottleneck, not the fleet).
 */
export function assessProjectDrive(input: DriveInput): DriveAssessment {
  const { project, tasks, liveRuns, runners } = input;
  const none = (s: DriveState, detail: string): DriveAssessment => ({ state: s, detail, refillFromSource: false });

  if (liveRuns.length > 0) {
    return none("working", `${liveRuns.length} run${liveRuns.length === 1 ? "" : "s"} in flight.`);
  }

  const open = tasks.filter((t) => t.state !== "done");
  if (tasks.length === 0) {
    return {
      state: "empty",
      detail: hasSource(project)
        ? "No tasks yet — pulling from the connected source."
        : "No tasks yet. Add some, or connect a source (GitHub issues, a roadmap doc) to fill the board.",
      refillFromSource: hasSource(project),
    };
  }
  if (open.length === 0) {
    return none("done", "Every task is done — nothing left on the board.");
  }

  // A finished run waiting on a verdict is a HUMAN bottleneck. Saying "no
  // capacity" here would send someone to add runners that wouldn't help.
  const review = open.filter((t) => t.state === "review");
  if (review.length > 0 && review.length === open.length) {
    return none("needs_review", `${review.length} task${review.length === 1 ? " is" : "s are"} waiting on a review verdict.`);
  }

  const ready = open.filter((t) => t.state === "todo");
  const triage = open.filter((t) => t.state === "triage");
  if (ready.length === 0) {
    if (triage.length > 0) {
      return none(
        "needs_triage",
        `${triage.length} task${triage.length === 1 ? "" : "s"} parked in triage — none came out clear, so nothing is startable.`,
      );
    }
    if (review.length > 0) {
      return none("needs_review", `${review.length} task${review.length === 1 ? " is" : "s are"} waiting on a review verdict.`);
    }
    // Backlog only: real work exists but nothing has been promoted to ready.
    return {
      state: "empty",
      detail: hasSource(project)
        ? "Nothing is ready to start — the backlog hasn't been triaged, and I'm re-checking the connected source."
        : "Nothing is ready to start — everything is still sitting in the backlog.",
      refillFromSource: hasSource(project),
    };
  }

  // There IS ready work. Say precisely what's stopping it.
  const usable = runners.filter((r) => r.usable);
  if (usable.length === 0) {
    return none(
      "no_runners",
      runners.length === 0
        ? "Work is ready, but no runners are configured."
        : `Work is ready, but none of the ${runners.length} configured runner${runners.length === 1 ? "" : "s"} can run — their keys are paused or missing.`,
    );
  }
  if (!usable.some((r) => r.agent.status === "idle")) {
    return none("no_capacity", `${ready.length} task${ready.length === 1 ? "" : "s"} ready, but every usable runner is busy.`);
  }
  if (!project.autonomy) {
    return none(
      "autonomy_off",
      `${ready.length} task${ready.length === 1 ? " is" : "s are"} ready and a runner is free, but autonomy is off — nothing will start on its own.`,
    );
  }
  return none("working", `${ready.length} ready — the next tick will start ${ready.length === 1 ? "it" : "them"}.`);
}

/** A project whose board can be refilled from something other than a human. */
function hasSource(p: DriveInput["project"]): boolean {
  return !!p.repo && p.syncSourceStatus === true;
}

/** Would a human want to be told? `working`/`done` are the quiet states — a
 *  driver that announces healthy projects is noise, and noise gets muted. */
export function driveNeedsAttention(a: DriveAssessment): boolean {
  return a.state !== "working" && a.state !== "done";
}
