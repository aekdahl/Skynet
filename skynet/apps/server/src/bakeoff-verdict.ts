import { extractJsonObject } from "./review-verdict.js";

// ─── Comparative bake-off verdict (structured output) ───────────────────────
// Same "the MODEL expresses a decision as a machine-readable field, we never
// classify its prose" contract as review-verdict.ts's single-diff verdict —
// extended to an N-way comparison. The model is shown each bake-off sibling
// under an opaque label ("A"/"B"/...), never the real runId (keeps the prompt
// short and avoids the model echoing back a malformed id). An unreadable
// reply, a missing field, or a label that doesn't match any candidate all
// resolve to `winnerRunId: null` — the judge simply couldn't pick, exactly
// like an unreadable single-diff verdict is flagged rather than guessed.

export interface ComparativeVerdict {
  /** The candidate the judge picked, or null if it couldn't confidently pick
   *  one — never guessed from an unreadable/unknown label. */
  winnerRunId: string | null;
  /** The judge's rationale — always non-empty, so a "couldn't pick" always states why. */
  reason: string;
}

/** The instruction appended to the comparison consult so the model returns a
 *  verdict we can read as a field, not parse out of prose. `labels` is the
 *  ordered list of opaque candidate labels actually offered (e.g. ["A","B","C"]). */
export function comparativeReviewInstruction(labels: string[]): string {
  const options = labels.map((l) => `"${l}"`).join("|");
  return (
    `Respond with ONLY a JSON object and nothing else: {"winner":${options}|null,"reason":"<one short line>"}. ` +
    `Pick the single candidate that best satisfies the task. Use null ONLY if you genuinely cannot tell them ` +
    "apart or none satisfies the task — a human will look instead. Always give a one-line reason, even for null."
  );
}

/**
 * Read the model's structured comparative verdict. The `winner` FIELD is the
 * decision — validated against the actual candidate labels offered, never
 * pattern-matched from prose. An unreadable / missing / unknown label is NOT
 * resolved to any candidate: it's treated as "couldn't pick," with a reason
 * that says why, so the bake-off stays open for a human.
 */
export function parseComparativeVerdict(reply: string, labelToRunId: Map<string, string>): ComparativeVerdict {
  const obj = extractJsonObject(reply);
  const stated = obj && typeof obj.reason === "string" ? obj.reason.trim().slice(0, 300) : "";
  const label = obj && typeof obj.winner === "string" ? obj.winner.trim() : null;
  if (label !== null) {
    const winnerRunId = labelToRunId.get(label);
    if (winnerRunId) {
      return { winnerRunId, reason: stated || "picked by an agent judge." };
    }
    return { winnerRunId: null, reason: stated || "flagged for review — the judge's reply named an unknown candidate." };
  }
  const winnerIsExplicitNull = obj && "winner" in obj && obj.winner === null;
  if (winnerIsExplicitNull) {
    return { winnerRunId: null, reason: stated || "flagged for review — the judge couldn't confidently pick a winner." };
  }
  return { winnerRunId: null, reason: stated || "flagged for review — the judge's reply wasn't a readable verdict." };
}
