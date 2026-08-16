// ─── Guided merge brief (structured output) ──────────────────────────────────
// Before a diff HITL is raised, ask the run's own provider to name the RISKS
// in its own change — grounded on the real git diff, same discipline as the
// auto-review verdict and the agent-authored walkthrough (review-verdict.ts /
// diff-walkthrough.ts): read a structured field, never classify free prose.
// An unreadable reply means no brief — it never blocks the review, which
// always still has the raw diff and the walkthrough (when drafted).
//
// The model is asked ONLY for what it can genuinely see in the diff (risks +
// suggested mitigations) — `filesTouched` and the system-known facts (the
// recorded auto-review verdict, whether the project runs checks after merge)
// are supplied by the CALLER from data already in hand, never trusted from
// the model. See Orchestrator.draftMergeBrief.

import { extractJsonObject } from "./review-verdict.js";

/** A finished agent naming the risks in its own diff, for a human who's about
 *  to decide whether to MERGE it — distinct framing from the walkthrough
 *  (which explains WHAT changed), so a separate system prompt. */
export const MERGE_BRIEF_SYSTEM =
  "You are an AI coding agent. A human reviewer is deciding whether to MERGE the diff you just " +
  "produced. Identify concrete risks a reviewer should know about before merging — grounded ONLY " +
  "in the diff below. Never describe a risk that isn't actually visible in the diff.";

export const MERGE_BRIEF_INSTRUCTION =
  'Respond with ONLY a JSON object and nothing else: {"summary":"<1-2 plain-English sentences on what this change does, written for a merge decision>",' +
  '"risks":["<one short line per concrete risk — e.g. writes outside the worktree, touches secrets/credentials, a DB/schema migration, a public API or contract change, a new dependency, a history-destructive git operation>"],' +
  '"mitigations":["<one short line per thing that makes this change SAFER to merge, grounded in the diff — e.g. covered by an added test, behind a feature flag, additive with no existing call sites changed>"]}. ' +
  "Omit a risks/mitigations entry unless it is concretely grounded in the diff — empty arrays are fine for a small, safe change. At most 6 entries each.";

function shortStrings(v: unknown, cap: number): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const x of v) {
    if (out.length >= cap) break;
    if (typeof x === "string" && x.trim()) out.push(x.trim().slice(0, 300));
  }
  return out;
}

/**
 * Read the model's structured brief. A missing/empty summary means the reply
 * wasn't readable as a brief: returns null so the diff HITL raises with no
 * brief, same as an unreadable walkthrough. `risks`/`mitigations` entries
 * that aren't strings are dropped rather than failing the whole brief.
 */
export function parseMergeBrief(reply: string): { summary: string; risks: string[]; mitigations: string[] } | null {
  const obj = extractJsonObject(reply);
  const summary = obj && typeof obj.summary === "string" ? obj.summary.trim().slice(0, 500) : "";
  if (!summary) return null;
  return { summary, risks: shortStrings(obj?.risks, 6), mitigations: shortStrings(obj?.mitigations, 6) };
}
