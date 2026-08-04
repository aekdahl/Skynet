// ─── Auto-review verdict (structured output) ────────────────────────────────
// The autonomous reviewer (a fleet agent) decides whether a finished run should
// be approved or held for a human. That decision is the MODEL's to make and
// express as a machine-readable field — we do NOT classify its prose with
// string heuristics (the earlier `includes("FLAG")` matched the word "flagged"
// inside an APPROVE's reasoning and false-flagged it). We ask for a JSON verdict
// and read the field; if the reply can't be read as one, we FLAG for a human
// (never auto-approve on an unreadable verdict).

export interface ReviewVerdict {
  approve: boolean;
  /** The reviewer's rationale — always non-empty, so a flag always states why. */
  reason: string;
}

/** The instruction appended to the review consult so the model returns a verdict
 *  we can read as a field, not parse out of prose. */
export const REVIEW_OUTPUT_INSTRUCTION =
  'Respond with ONLY a JSON object and nothing else: {"verdict":"approve"|"flag","reason":"<one short line>"}. ' +
  'Use "approve" if the run satisfies the task, "flag" if a human should look.';

/** Pull the last balanced top-level `{…}` object out of a reply that may be
 *  wrapped in prose or a ```json fence. Returns the parsed object or null. */
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

/**
 * Read the model's structured verdict. The `verdict` FIELD is the decision — we
 * validate it's one of the two allowed values and take the `reason` field. An
 * unreadable / missing / unknown verdict is NOT auto-approved: it's flagged for a
 * human, with a reason that says why.
 */
export function parseReviewVerdict(reply: string): ReviewVerdict {
  const obj = extractJsonObject(reply);
  const verdict = obj && typeof obj.verdict === "string" ? obj.verdict.trim().toLowerCase() : "";
  if (verdict === "approve" || verdict === "flag") {
    const approve = verdict === "approve";
    const stated = obj && typeof obj.reason === "string" ? obj.reason.trim() : "";
    const reason = stated.slice(0, 300) || (approve ? "auto-approved by an agent." : "flagged for review — no reason given.");
    return { approve, reason };
  }
  return { approve: false, reason: "flagged for review — the reviewer's reply wasn't a readable verdict." };
}
