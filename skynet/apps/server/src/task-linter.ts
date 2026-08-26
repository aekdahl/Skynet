// ─── Task linter (v1.5 assistive v0 + v5 LLM coach) ─────────────────────────
// A cheap one-shot consult run in the BACKGROUND right after a task is created
// or its text/description is edited (see operations.ts `maybeLintTask`): does
// this task read as vague, does it look like it spans several modules and
// would go faster split, is there no way to tell when it's done? This is
// advisory ONLY — it never blocks creation/edits and never auto-splits a task.
// It just leaves a dismissible hint (Task.lint) the operator can act on or
// ignore.
//
// v5 layers two more concerns on the same call rather than a second one: an
// implied dependency the task text never actually records, and a sibling task
// (passed in from the rest of the project's open backlog/todo) that looks
// independent enough to run alongside this one instead of waiting — the
// per-task, LLM-reasoned sibling of the fleet-level heuristic in
// derive/parallelism.ts ("idle runners + deep backlog → spin up more?").
// Both rules are only ever a hint on THIS task, same dismissible shape as the
// v0 concerns — never a claim that dependsOnTaskIds is wrong, never an
// auto-edit.
//
// Same structured-output discipline as review-verdict.ts: ask the model for a
// JSON verdict and read the FIELD — never classify its free text with
// string/regex heuristics. An unreadable reply just means "no concerns
// surfaced", the same as a genuinely clean task — never a thrown error, since
// that would make an assistive feature capable of disrupting task creation.

import { oneShotText } from "@skynet/runner-sdk/claude";
import type { TaskLintConcern } from "@skynet/shared";

// A short classification pass, not a code judgment — this runs on every task,
// so the cheapest model keeps it affordable. Override for a stronger read.
const MODEL = process.env.SKYNET_LINT_MODEL || "haiku";

const CONCERN_KINDS = new Set<TaskLintConcern["kind"]>([
  "vague",
  "multi-module",
  "no-done-definition",
  "missing-dependency",
  "parallel-candidate",
]);

// A handful of titles is plenty context for "does this look unrelated to
// that" — more would just inflate the prompt for a cheap advisory pass.
const MAX_SIBLINGS = 8;

function prompt(text: string, description: string | null, siblingTitles: string[]): string {
  const siblings = siblingTitles.slice(0, MAX_SIBLINGS);
  return [
    "You are a terse task-quality linter for a software team's backlog. Look at ONE task and flag concrete quality concerns. Do not solve the task or suggest an implementation.",
    "",
    `Task title: ${text}`,
    `Task description: ${description?.trim() || "(none)"}`,
    "",
    siblings.length
      ? `Other open tasks in the same project right now (backlog/todo, unrelated unless noted otherwise):\n${siblings.map((s) => `- ${s}`).join("\n")}`
      : "(no other open tasks in this project right now)",
    "",
    "Flag a concern only when you're genuinely confident, using exactly these kinds:",
    '- "vague": too underspecified to start on — no concrete target or unclear scope.',
    '- "multi-module": clearly spans several distinct modules/areas and would go faster split into smaller tasks.',
    '- "no-done-definition": no way to tell when it is finished — no acceptance criteria or concrete outcome.',
    '- "missing-dependency": the text implies this depends on or is blocked by other work (e.g. "once X ships", "after Y lands") but names nothing concrete enough to link — flag so the operator can record the real dependency.',
    '- "parallel-candidate": ONLY when the list of other open tasks above is non-empty — one of them looks fully independent of this task (no shared module, no obvious ordering between them) and could be worked on in parallel instead of assumed serial. Name that other task in the note.',
    "",
    "Don't invent problems the text doesn't show. A short, clear, single-purpose task with an obvious outcome and no false assumptions about sequencing should get zero concerns.",
    "",
    'Respond with ONLY a JSON object and nothing else: {"concerns":[{"kind":"vague"|"multi-module"|"no-done-definition"|"missing-dependency"|"parallel-candidate","note":"<one short line>"}]}. Use an empty array when nothing stands out.',
  ].join("\n");
}

/** Pull the last balanced top-level `{…}` object out of a reply that may be
 *  wrapped in prose or a ```json fence. Returns the parsed object or null.
 *  Mirrors review-verdict.ts's extractJsonObject — kept local rather than
 *  shared, same as judge.ts's own independent parser. */
function extractJsonObject(reply: string): Record<string, unknown> | null {
  const text = (reply ?? "").trim().replace(/^```[a-zA-Z]*\s*/g, "").replace(/```\s*$/g, "");
  const end = text.lastIndexOf("}");
  if (end === -1) return null;
  let depth = 0;
  for (let i = end; i >= 0; i--) {
    if (text[i] === "}") depth++;
    else if (text[i] === "{") {
      depth--;
      if (depth === 0) {
        try {
          const obj = JSON.parse(text.slice(i, end + 1)) as unknown;
          return obj && typeof obj === "object" ? (obj as Record<string, unknown>) : null;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/** Read the model's structured concerns list, dropping anything that doesn't
 *  read as a valid concern. An unparseable reply (or a missing/malformed
 *  `concerns` field) reads as "no concerns" — the same safe default
 *  parseReviewVerdict uses for an unreadable review reply, just pointed at
 *  "nothing to report" instead of "flag for a human" (this is advisory-only,
 *  so silence is the safe fallback, not an escalation). */
export function parseTaskLint(reply: string): TaskLintConcern[] {
  const obj = extractJsonObject(reply);
  const raw = obj && Array.isArray(obj.concerns) ? obj.concerns : [];
  const concerns: TaskLintConcern[] = [];
  for (const c of raw) {
    if (!c || typeof c !== "object") continue;
    const kind = (c as Record<string, unknown>).kind;
    const note = (c as Record<string, unknown>).note;
    if (typeof kind === "string" && CONCERN_KINDS.has(kind as TaskLintConcern["kind"]) && typeof note === "string" && note.trim()) {
      concerns.push({ kind: kind as TaskLintConcern["kind"], note: note.trim().slice(0, 200) });
    }
    if (concerns.length >= 5) break; // a hint, not a report — cap it short
  }
  return concerns;
}

/**
 * Lint one task's text + description, optionally against a short list of
 * sibling task titles still open in the same project (backlog/todo, this task
 * excluded — see `lintTaskNow` in operations.ts) for the v5 dependency/
 * parallel-candidate rules. Never throws — a missing credential, a CLI
 * failure, or an unreadable reply all resolve to `[]` (no concerns), same as
 * a genuinely clean task. Callers must treat this as advisory and never block
 * on it (see `maybeLintTask` in operations.ts).
 */
export async function lintTask(
  text: string,
  description: string | null,
  siblingTitles: string[] = [],
): Promise<TaskLintConcern[]> {
  try {
    const out = await oneShotText({ prompt: prompt(text, description, siblingTitles), model: MODEL });
    return parseTaskLint(out);
  } catch {
    return [];
  }
}
