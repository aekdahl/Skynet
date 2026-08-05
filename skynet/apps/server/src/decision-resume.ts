// ─── Recovering a parked decision onto a fresh runner ────────────────────────
//
// When an operator resolves a mid-run HITL gate (approval / question / plan) but
// the run has no live runner handle — the process exited, e.g. a crash or a
// server restart dropped the in-memory session — the decision can't be delivered
// to the parked session (it's gone). The orchestrator instead re-acquires compute
// and starts a FRESH turn in the run's worktree, the same way an escalation or a
// post-review revise resumes. This module builds that turn's prompt.
//
// The decision is already structured (action / optionIndex / guidance) — this is
// pure string assembly off those fields, NOT any parsing/classification of free
// text. The agent lost its in-turn context, so the prompt tells it to reorient
// from the worktree before acting on the decision.

import type { HitlItem, Resolution } from "@skynet/shared";

/** Shared tail: the fresh session lost the original turn's context, so point it at
 *  the worktree to reorient, and tell it how to finish or ask again. */
function reorient(branch: string): string {
  return (
    `Your work so far is already in the working directory (branch ${branch}). ` +
    `The runner handling this task exited before the operator's decision reached you, ` +
    `so you're picking it up on a fresh session — read the working directory to reorient, ` +
    `then act on the decision above and finish the task. Stop when done, or ask again ` +
    `(AskUserQuestion) if you need another decision.`
  );
}

/**
 * Build the prompt that delivers a resolved decision to a re-acquired runner.
 * Covers the mid-run gate kinds only (approval / question / plan); the caller
 * gates on kind before calling.
 */
export function decisionResumePrompt(item: HitlItem, resolution: Resolution, branch: string): string {
  const tail = reorient(branch);

  if (item.kind === "question") {
    // The answer is the chosen option, else free-form guidance, else "decide".
    const answer =
      resolution.optionIndex != null && item.options?.[resolution.optionIndex] != null
        ? item.options[resolution.optionIndex]!
        : resolution.guidance?.trim() || "(no preference given — use your best judgement)";
    return `You paused to ask: "${item.title}".\n\nThe operator answered: ${answer}\n\n${tail}`;
  }

  // approval (a tool/command gate) and plan share approve / reject / modify.
  const subject =
    item.kind === "plan"
      ? "the plan you proposed"
      : `the action you paused on${item.command ? ` — ${item.command}` : ""}`;

  if (resolution.action === "reject") {
    return `The operator rejected ${subject}. Do not proceed with it — revise your approach.\n\n${tail}`;
  }
  if (resolution.action === "modify") {
    const guidance = resolution.guidance?.trim() || "Adjust per operator guidance.";
    return `The operator responded to ${subject} with a directive: ${guidance}\n\n${tail}`;
  }
  // approve (or an option index on a non-question gate) → proceed. The gated
  // action never actually ran (it was awaiting approval), so proceeding now is
  // the intended effect — no double-execution.
  return `The operator approved ${subject}. Proceed with it now and complete the task.\n\n${tail}`;
}
