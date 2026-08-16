// ─── Guided merge brief (structured output) ──────────────────────────────────
// ROADMAP: "Guided merge — understand-then-merge, to any branch." Before a
// diff HITL is raised, ask the run's own provider to synthesize a plain-
// English risk briefing grounded on the REAL git diff — so an operator
// UNDERSTANDS the merge (blast radius, risks, mitigations already in place)
// rather than eyeballing a patch. Same discipline as the auto-review verdict
// and the diff walkthrough (review-verdict.ts / diff-walkthrough.ts): read a
// structured field, never classify free prose. An unreadable reply means no
// brief — it never blocks the review, which always still has the raw diff.
//
// Deliberately does NOT fold the verifier-gate result or the auto-review
// verdict into this prompt: both are typically produced AFTER this brief is
// drafted (the auto-review verdict is written by a second agent reacting to
// the diff HITL this brief is PART OF raising — a chicken-and-egg order, not
// an oversight), so baking a stale or absent signal into the model's prompt
// would be dishonest. Instead the caller composes them at the SURFACE level —
// rendered live alongside this brief from their own always-fresh source
// (Task.reviewVerdict; the verifier gate once it lands) — exactly the
// "composes ... into one review→merge surface" framing in the roadmap entry.

import { extractJsonObject } from "./review-verdict.js";
import type { MergeBrief } from "@skynet/shared";

/** A finished agent's OWN diff, unprompted by an operator — frames the
 *  model's ROLE directly, same pattern as DIFF_WALKTHROUGH_SYSTEM. */
export const MERGE_BRIEF_SYSTEM =
  "You are helping a human operator decide whether to merge a coding agent's finished change. " +
  "Write a short, honest risk briefing grounded ONLY in the diff below — never invent a risk or " +
  "mitigation that isn't actually supported by what's actually in it.";

export const MERGE_BRIEF_INSTRUCTION =
  'Respond with ONLY a JSON object and nothing else: {"summary":"<2-4 plain-English sentences: what this change does and its blast radius>",' +
  '"risks":["<short, concrete risk — e.g. writes outside the worktree, touches secrets, a DB migration, a public API/contract change, a new dependency, a history-destructive op>", ...],' +
  '"mitigations":["<short, concrete mitigation ALREADY in place — a passing test, a scoped diff, an existing gate>", ...]}. ' +
  "Omit a risk/mitigation you're not confident about — an empty list is honest, a fabricated entry is not. At most 6 of each.";

/**
 * Read the model's structured brief. A missing/empty summary means the reply
 * wasn't readable as a brief: returns null so the diff HITL raises with no
 * brief, same as before this existed. `risks`/`mitigations` are read
 * defensively — non-string or over-cap entries are dropped, never thrown on.
 */
export function parseMergeBrief(reply: string): MergeBrief | null {
  const obj = extractJsonObject(reply);
  const summary = obj && typeof obj.summary === "string" ? obj.summary.trim().slice(0, 1000) : "";
  if (!summary) return null;
  const strings = (v: unknown, cap: number): string[] => {
    if (!Array.isArray(v)) return [];
    const out: string[] = [];
    for (const item of v) {
      if (out.length >= cap) break;
      if (typeof item === "string" && item.trim()) out.push(item.trim().slice(0, 300));
    }
    return out;
  };
  return {
    summary,
    risks: strings(obj?.risks, 6),
    mitigations: strings(obj?.mitigations, 6),
  };
}
