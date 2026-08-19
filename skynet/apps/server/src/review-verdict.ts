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

// ─── Self-replenishing backlog: fleet-authored proposals ────────────────────
// The reviewer (plain consult OR the deep-review run — both funnel through
// this same field-based contract) may notice a discovery worth a new task
// while looking at the change: a defect in what was just built, or a genuine
// gap outside what was asked. Scope taxonomy is the valve — see
// orchestrator.ts's processFleetProposals for what happens to each one.
// Never parsed from prose: an absent/malformed `proposals` field is simply no
// proposals, exactly like an unreadable verdict is simply a flag.
export const PROPOSAL_SCOPE = ["in-scope", "new-scope"] as const;
export type ProposalScope = (typeof PROPOSAL_SCOPE)[number];

export interface ProposedTask {
  title: string;
  why: string;
  scope: ProposalScope;
}

/** Hard cap on how many proposals one review can surface — bounds the fastest
 *  possible growth rate of the backlog to a single number, independent of
 *  every other guardrail (dedup / daily cap / feature size / budget) below.
 *  Extra entries past this are silently ignored, never an error. */
export const MAX_PROPOSALS_PER_REVIEW = 3;

/** The instruction appended to the review consult so the model returns a verdict
 *  we can read as a field, not parse out of prose. */
export const REVIEW_OUTPUT_INSTRUCTION =
  'Respond with ONLY a JSON object and nothing else: {"verdict":"approve"|"flag","reason":"<one short line>",' +
  '"proposals":[{"title":"<task name>","why":"<one short line>","scope":"in-scope"|"new-scope"}]}. ' +
  'Use "approve" if the run satisfies the task, "flag" if a human should look. ' +
  `"proposals" is OPTIONAL and OMIT it entirely unless you genuinely noticed something worth a new task — up to ${MAX_PROPOSALS_PER_REVIEW}, ` +
  '"in-scope" ONLY for a defect/gap in what THIS change just built (something you\'d expect to be fixed as part of the same feature), ' +
  '"new-scope" for anything else — an idea, an unrequested feature, or work outside what was actually asked for. ' +
  'When genuinely unsure which scope applies, use "new-scope" — it always waits for a human either way.';

/** Read the optional `proposals` field the SAME structured reply carries
 *  alongside the verdict. Defensive at every level: a missing/non-array field
 *  is no proposals; a malformed entry (missing title, empty title, unknown
 *  scope) is dropped rather than rejecting the whole batch; the result is
 *  always capped at {@link MAX_PROPOSALS_PER_REVIEW}, silently discarding any
 *  overflow rather than erroring. Never invents a proposal from prose. */
export function parseReviewProposals(reply: string): ProposedTask[] {
  const obj = extractJsonObject(reply);
  const raw = obj && Array.isArray(obj.proposals) ? obj.proposals : [];
  const out: ProposedTask[] = [];
  for (const entry of raw) {
    if (out.length >= MAX_PROPOSALS_PER_REVIEW) break;
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const title = typeof e.title === "string" ? e.title.trim().slice(0, 200) : "";
    if (!title) continue;
    const scope = e.scope === "in-scope" || e.scope === "new-scope" ? e.scope : null;
    if (!scope) continue;
    const why = typeof e.why === "string" ? e.why.trim().slice(0, 500) : "";
    out.push({ title, why, scope });
  }
  return out;
}

/** Pull the last balanced top-level `{…}` object out of a reply that may be
 *  wrapped in prose or a ```json fence. Returns the parsed object or null.
 *  Exported so other structured-consult readers (e.g. diff-walkthrough.ts)
 *  share the same defensive extraction instead of re-parsing prose. */
export function extractJsonObject(reply: string): Record<string, unknown> | null {
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
