// ─── Agent-authored diff walkthrough (structured output) ────────────────────
// Before a diff HITL is raised, ask the run's own provider to explain its
// change in plain English, grounded on the REAL git diff — so a reviewer gets
// a walkthrough instead of a bare patch. Same discipline as the auto-review
// verdict (review-verdict.ts): read a structured field, never classify free
// prose. An unreadable reply means no walkthrough — it never blocks the
// review, which always still has the raw diff.

import { extractJsonObject } from "./review-verdict.js";
import type { DiffWalkthrough, DiffWalkthroughComment } from "@skynet/shared";

/** A finished agent explaining its own diff, unprompted by an operator — this
 *  frames the model's ROLE directly (via ConsultSpec.system) rather than the
 *  default "answering an operator follow-up" wrapper, which doesn't fit. */
export const DIFF_WALKTHROUGH_SYSTEM =
  "You are an AI coding agent. A human reviewer is about to look at the diff you just " +
  "produced, before deciding whether to merge it. Write them a short walkthrough grounded " +
  "ONLY in the diff below — never describe a file or change that isn't actually in it.";

export const DIFF_WALKTHROUGH_INSTRUCTION =
  'Respond with ONLY a JSON object and nothing else: {"summary":"<2-4 plain-English sentences on what this diff does and why>",' +
  '"comments":[{"file":"<path exactly as it appears in the diff>","line":<new-file line number, or null for a file-level note>,"note":"<one short line>"}],' +
  '"least_sure_about":"<1-2 sentences on what YOU are least confident is correct in this diff — required, never empty. ' +
  'If you are genuinely confident in everything, name the one thing most worth a human double-checking anyway (an edge case, an assumption, a place you couldn\'t fully verify).>"}. ' +
  "Include a comment only where it adds insight beyond the summary — a risk, a non-obvious choice, a gap. Omit boilerplate ones. At most 8 comments.";

/**
 * Read the model's structured walkthrough. Comments are dropped (not the
 * whole walkthrough) when they name a file the diff didn't actually touch —
 * we trust the model's prose but not its citations. A missing/empty summary
 * means the reply wasn't readable as a walkthrough: returns null so the diff
 * HITL raises with no walkthrough, same as before this existed.
 */
export function parseDiffWalkthrough(reply: string, touchedFiles: string[]): DiffWalkthrough | null {
  const obj = extractJsonObject(reply);
  const summary = obj && typeof obj.summary === "string" ? obj.summary.trim().slice(0, 1000) : "";
  if (!summary) return null;
  const valid = new Set(touchedFiles);
  const rawComments = Array.isArray(obj?.comments) ? (obj.comments as unknown[]) : [];
  const comments: DiffWalkthroughComment[] = [];
  for (const c of rawComments) {
    if (comments.length >= 8) break;
    if (!c || typeof c !== "object") continue;
    const rec = c as Record<string, unknown>;
    const file = typeof rec.file === "string" ? rec.file.trim() : "";
    const note = typeof rec.note === "string" ? rec.note.trim().slice(0, 300) : "";
    if (!file || !note || !valid.has(file)) continue; // never trust a hallucinated file
    const line = typeof rec.line === "number" && Number.isInteger(rec.line) && rec.line > 0 ? rec.line : null;
    comments.push({ file, line, note });
  }
  // Required by the prompt above, but never trusted to actually be present —
  // an older reply (or a model that ignores the instruction) just falls back
  // to an honest placeholder rather than dropping the whole walkthrough.
  const rawUncertainty = obj && typeof obj.least_sure_about === "string" ? obj.least_sure_about.trim().slice(0, 500) : "";
  const uncertainty = rawUncertainty || "Not stated by the agent.";
  return { summary, comments, uncertainty };
}
