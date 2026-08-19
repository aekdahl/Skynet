// ─── Breaker verdict (structured output) ─────────────────────────────────────
// The breaker (Project.breakerReview) is the ADVERSARIAL second lens, run after
// the deepReview reviewer approves: same bounded-run shape, opposite framing —
// instead of judging whether the change works, it actively tries to make it
// misbehave (malformed input, edge cases, auth boundaries, concurrent actions)
// against the same live preview. Same field-based-parsing discipline as
// review-verdict.ts (we never classify prose — a `broken` finding could mention
// "no issues found" in its own rationale and get misread), and the same
// safe-default philosophy inverted: an unreadable breaker reply must NOT flip a
// verdict the verifier already approved — see parseBreakerVerdict below.

import { Risk } from "@skynet/shared";
import { extractJsonObject } from "./review-verdict.js";

export interface BreakerFindingOut {
  severity: Risk;
  what: string;
  repro: string;
}

export interface BreakerVerdictOut {
  verdict: "clean" | "broken";
  findings: BreakerFindingOut[];
}

/** The instruction appended to the breaker's brief. Explicitly demands repro
 *  steps and forbids speculation — a "finding" with no repro is worthless (and
 *  worse, could false-flag a task a human then has to un-flag by hand). */
export const BREAKER_OUTPUT_INSTRUCTION =
  'Respond with ONLY a JSON object and nothing else: {"findings":[{"severity":"low"|"medium"|"high",' +
  '"what":"<what you attempted / what broke, in one line>","repro":"<exact steps to reproduce it>"}],' +
  '"verdict":"clean"|"broken"}. Only include a finding for something you ACTUALLY did against the live ' +
  'preview and observed the result of — never speculate about what might happen. List every real attempt ' +
  'as a finding, even ones that did NOT break anything (that\'s evidence the change held up), using a low ' +
  'severity for those. "verdict":"broken" only if at least one finding shows genuinely broken/incorrect ' +
  'behavior you personally reproduced; otherwise "clean".';

const VALID_SEVERITY = new Set(["low", "medium", "high"]);

/**
 * Read the breaker's structured reply. Field-based, like parseReviewVerdict —
 * we validate the `verdict` field is one of the two allowed values and that
 * every finding has the three required string fields with a real severity;
 * anything else (missing fields, wrong types, no JSON at all) returns null.
 *
 * Unlike parseReviewVerdict, an unreadable reply here is NOT itself a verdict
 * (there's no "flag for a human" default) — the caller treats null as
 * "clean-with-note" (Do #2: a broken breaker must never block the pipeline;
 * the verifier already approved this change).
 */
export function parseBreakerVerdict(reply: string): BreakerVerdictOut | null {
  const obj = extractJsonObject(reply);
  if (!obj) return null;
  const verdict = typeof obj.verdict === "string" ? obj.verdict.trim().toLowerCase() : "";
  if (verdict !== "clean" && verdict !== "broken") return null;
  const rawFindings = Array.isArray(obj.findings) ? obj.findings : [];
  const findings: BreakerFindingOut[] = [];
  for (const f of rawFindings) {
    if (!f || typeof f !== "object") continue;
    const rec = f as Record<string, unknown>;
    const severity = typeof rec.severity === "string" ? rec.severity.trim().toLowerCase() : "";
    const what = typeof rec.what === "string" ? rec.what.trim() : "";
    const repro = typeof rec.repro === "string" ? rec.repro.trim() : "";
    // A finding without a real severity or without what/repro isn't usable
    // evidence — drop it rather than guess a severity or leave a blank repro
    // a human can't act on (Do #2's "repro steps required, no speculation").
    if (!VALID_SEVERITY.has(severity) || !what || !repro) continue;
    findings.push({ severity: severity as Risk, what: what.slice(0, 300), repro: repro.slice(0, 500) });
  }
  return { verdict: verdict as "clean" | "broken", findings: findings.slice(0, 20) };
}
