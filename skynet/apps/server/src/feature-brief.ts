// ─── Feature-level ready-to-merge brief (make the one human approval reviewable) ──
// A batched feature PR (feature-scoped branch batching) can bundle dozens of
// tasks behind one merge decision — approving it via the plain diff card is
// either rubber-stamping or drowning. This composes a per-feature brief once
// the batch's aggregate PR opens: per-task one-liners + spend + evidence are
// SYSTEM-composed from data already in hand (never asked of the model — same
// discipline as merge-brief.ts); the ONE genuinely new thing is a
// consult-drafted narrative of what the feature now does as a whole, grounded
// on the combined branch diff. An unreadable/missing reply just means no
// narrative — it never blocks the PR (see Orchestrator.draftFeatureBrief).

import type { FeatureBrief, FeatureBriefTask, Task, TaskRun, Usage } from "@skynet/shared";
import { extractJsonObject } from "./review-verdict.js";

/** A human reviewer deciding whether to merge a whole BATCHED feature — not one
 *  diff, several completed tasks already merged into one branch. Distinct
 *  framing from the per-run merge brief (which explains one change): here the
 *  model is asked what the COMBINED change delivers, not to restate the task
 *  list (the caller already knows that). */
export const FEATURE_BRIEF_SYSTEM =
  "You are an AI coding agent. A human reviewer is deciding whether to MERGE an entire FEATURE — a " +
  "batch of several already-completed tasks, merged into one branch. Describe, in plain English, what " +
  "this feature now DOES as a whole once merged — grounded ONLY in the diff below. Never describe " +
  "behavior that isn't actually visible in the diff, and don't just restate the list of tasks.";

export const FEATURE_BRIEF_INSTRUCTION =
  'Respond with ONLY a JSON object and nothing else: {"narrative":"<2-4 plain-English sentences on what ' +
  'this feature now does as a whole, written for a merge decision>"}.';

/**
 * Read the model's structured narrative. A missing/empty narrative means the
 * reply wasn't readable: returns null so the brief composes with no
 * narrative, same as an unreadable merge brief or walkthrough.
 */
export function parseFeatureNarrative(reply: string): string | null {
  const obj = extractJsonObject(reply);
  const narrative = obj && typeof obj.narrative === "string" ? obj.narrative.trim().slice(0, 1000) : "";
  return narrative || null;
}

/** Elementwise sum of every run's reported Usage. A vendor-omitted `costUsd`/
 *  `durationMs` (null) doesn't zero out the total — it's excluded from the sum,
 *  and the aggregate field itself stays null only if NO run in the batch ever
 *  reported it (an honest "unknown", not a misleading zero). Returns null for
 *  an empty list — no runs, nothing to report. */
function sumUsage(list: Usage[]): Usage | null {
  if (list.length === 0) return null;
  let inputTokens = 0, outputTokens = 0, turns = 0;
  let costUsd = 0, sawCost = false;
  let durationMs = 0, sawDuration = false;
  for (const u of list) {
    inputTokens += u.inputTokens;
    outputTokens += u.outputTokens;
    turns += u.turns;
    if (u.costUsd != null) { costUsd += u.costUsd; sawCost = true; }
    if (u.durationMs != null) { durationMs += u.durationMs; sawDuration = true; }
  }
  return { inputTokens, outputTokens, turns, costUsd: sawCost ? costUsd : null, durationMs: sawDuration ? durationMs : null };
}

/**
 * Compose the SYSTEM-known half of a feature brief from data already in
 * hand — the per-task review verdicts, the aggregate spend, and what verified
 * this batch — plus whatever narrative a consult managed to draft (null when
 * it failed, wasn't supported, or was never attempted). Pure and synchronous
 * so it's directly testable from fixtures, no provider/store access needed.
 *
 * `evidenceSummary` reflects only what's ACTUALLY recorded today (review
 * verdicts + whether a verifier gate runs after merge) — it never fabricates
 * a breaker/verifier line that didn't happen. Once real verifier/breaker runs
 * record their own evidence on a Task, composing it in here is the natural
 * extension point; nothing here needs to change shape to make room for it.
 */
export function composeFeatureBrief(
  siblings: Task[],
  runs: TaskRun[],
  narrative: string | null,
  checksConfigured: boolean,
): FeatureBrief {
  const tasks: FeatureBriefTask[] = siblings.map((t) => ({
    taskId: t.id,
    text: t.text,
    verdict: t.reviewVerdict?.decision ?? null,
    reviewedBy: t.reviewVerdict?.by ?? null,
  }));
  const spend = sumUsage(runs.map((r) => r.usage).filter((u): u is Usage => u != null));
  const reviewed = siblings.filter((t) => t.reviewVerdict != null);
  const flagged = reviewed.filter((t) => t.reviewVerdict?.decision === "flag");
  const evidenceSummary: string[] = [];
  if (reviewed.length > 0) {
    evidenceSummary.push(
      flagged.length > 0
        ? `${reviewed.length - flagged.length} of ${reviewed.length} reviewed task(s) approved by their reviewing agent; ${flagged.length} flagged.`
        : `All ${reviewed.length} reviewed task(s) approved by their reviewing agent.`,
    );
  }
  if (checksConfigured) evidenceSummary.push("Verifier gate runs the project's checks after merge and rolls back the merge on failure.");
  return { tasks, spend, evidenceSummary, narrative };
}
