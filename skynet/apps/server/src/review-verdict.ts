// ─── Auto-review verdict parsing (PURE) ─────────────────────────────────────
// The autonomous reviewer (a fleet agent) is asked to reply "APPROVE" or "FLAG"
// on the first line, then a one-line reason. Its REASONING can itself contain
// the word "flag" — e.g. an APPROVE that says "a clearly-flagged deviation" —
// so the verdict must be read from the LEADING word, never a substring match
// anywhere in the line. (The old `head.includes("FLAG")` flagged an APPROVE for
// a human because its reason mentioned "flagged".)
//
// It also strips the leading verdict word from the reason, so a flagged item's
// declared reason reads as prose ("the tests don't cover X") rather than
// "APPROVE — …"/"FLAG — …" under the approved/flagged header.

export interface ReviewVerdict {
  approve: boolean;
  /** The reviewer's rationale, verdict word removed, capped — always non-empty
   *  so a flag ALWAYS carries a stated reason. */
  reason: string;
}

export function parseReviewVerdict(reply: string): ReviewVerdict {
  const trimmed = (reply ?? "").trim();
  // The first alphabetic word is the verdict the reviewer was told to lead with.
  const verdict = (trimmed.match(/[A-Za-z]+/)?.[0] ?? "").toUpperCase();
  const approve = verdict !== "FLAG";
  // Drop a leading APPROVE/FLAG and its separator (—, :, ., -, spaces) so the
  // reason is just the rationale.
  const rationale = trimmed.replace(/^\s*(?:APPROVE|FLAG)\b[\s:.—-]*/i, "").trim();
  const reason =
    rationale.slice(0, 300) ||
    (approve ? "auto-approved by an agent." : "flagged for review — no reason given.");
  return { approve, reason };
}
