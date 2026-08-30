// ─── Evidence-gated auto-merge ─────────────────────────────────────────────
// Approving a finished diff is the worst moment to ask a human for judgement:
// they didn't write the code, may not remember the task, and by then all the
// leverage is gone — reject discards hours of work, so the honest options are
// rubber-stamp or feel bad. Skynet already gathers real evidence about a change
// (an independent agent's review verdict, a browser-driven deep review, an
// adversarial breaker pass, a fixed sensitive-path policy, the diff's own size)
// and then largely ignored it at the gate: EVERY merge asked a human, except
// `approvalLevel: "full"`, which jumped straight to merging anything that
// wasn't high-risk — with no review required at all.
//
// There was nothing between "judge every diff yourself" and "trust everything".
// This is that middle: merge unattended when the evidence is there, gate when
// it isn't, and — the part that makes it comprehensible — always say WHICH
// condition sent it to a human.
//
// PURE, so the same decision can be rendered in the UI, asserted in tests, and
// taken by the orchestrator without three implementations drifting apart.

import type { Risk } from "@skynet/shared";

/** Why a diff was sent to a human. Each is a specific, fixable condition — the
 *  point is that "you're being asked because X" beats an unexplained card. */
export type MergeGateReason =
  | "policy-off"
  | "autonomy-off"
  | "sensitive-paths"
  | "high-risk"
  | "no-review"
  | "review-flagged"
  | "deep-review-missing"
  | "breaker-flagged"
  | "too-many-files"
  | "too-many-lines";

/** Operator-facing text for each reason. Kept beside the enum so a new reason
 *  cannot ship without one — an unexplained gate is the thing this replaces. */
export const GATE_REASON_TEXT: Record<MergeGateReason, string> = {
  "policy-off": "auto-merge is off for this project",
  "autonomy-off": "autonomy is off for this project",
  "sensitive-paths": "touches a path that always needs a human",
  "high-risk": "scored high risk",
  "no-review": "no agent reviewed it",
  "review-flagged": "the reviewing agent flagged it",
  "deep-review-missing": "deep review is on for this project but this diff has none",
  "breaker-flagged": "the adversarial breaker found something",
  "too-many-files": "changes more files than the policy allows unattended",
  "too-many-lines": "changes more lines than the policy allows unattended",
};

export interface AutoMergePolicyInput {
  enabled: boolean;
  requireReviewApproval: boolean;
  requireDeepReviewWhenConfigured: boolean;
  requireBreakerCleanWhenConfigured: boolean;
  maxFilesChanged: number;
  maxLinesChanged: number;
}

export interface MergeEvidence {
  policy: AutoMergePolicyInput;
  /** The project's master "let agents act without me" switch. */
  autonomy: boolean;
  risk: Risk;
  /** Fixed path-policy hits (migrations, workflows, auth, dependency manifests). */
  requiresHumanGlobs: string[];
  /** The independent agent review, when one ran. */
  review: { decision: "approve" | "flag" } | null;
  /** Whether the project asks for a browser-driven deep review, and whether
   *  this change actually got one (evidence recorded by that reviewer). */
  deepReviewConfigured: boolean;
  hasDeepReviewEvidence: boolean;
  /** Whether the project runs the adversarial breaker, and whether it came back
   *  clean. Null = configured but no verdict recorded. */
  breakerConfigured: boolean;
  breakerClean: boolean | null;
  stat: { add: number; del: number; files: number };
}

export interface MergeDecision {
  autoMerge: boolean;
  /** Every condition that failed, not just the first — an operator fixing one
   *  should not have to re-run to discover the next. Empty ⇒ autoMerge. */
  reasons: MergeGateReason[];
  /** One line for the card: why this is in front of you. */
  explain: string;
}

export const DEFAULT_AUTO_MERGE_POLICY: AutoMergePolicyInput = {
  // OFF by default. Turning a project's merges over to evidence is a decision
  // its operator makes deliberately, never one inherited from a default.
  enabled: false,
  requireReviewApproval: true,
  requireDeepReviewWhenConfigured: true,
  requireBreakerCleanWhenConfigured: true,
  maxFilesChanged: 20,
  maxLinesChanged: 400,
};

/**
 * PURE: should this diff merge without a human?
 *
 * Collects EVERY failing condition rather than short-circuiting, because the
 * card's whole job is to tell an operator why they're being asked — and
 * "sensitive paths" alone, when the review also flagged it, is a half-truth
 * that invites the wrong fix.
 */
export function decideAutoMerge(e: MergeEvidence): MergeDecision {
  const reasons: MergeGateReason[] = [];

  if (!e.policy.enabled) reasons.push("policy-off");
  if (!e.autonomy) reasons.push("autonomy-off");

  // Non-negotiable regardless of policy: the fixed path list exists precisely
  // because these areas are where an unattended mistake is expensive and hard
  // to notice. Not configurable — a policy that could switch this off would
  // defeat the reason it's a fixed list.
  if (e.requiresHumanGlobs.length > 0) reasons.push("sensitive-paths");
  if (e.risk === "high") reasons.push("high-risk");

  if (e.policy.requireReviewApproval) {
    if (!e.review) reasons.push("no-review");
    else if (e.review.decision !== "approve") reasons.push("review-flagged");
  }

  // Only demanded when the PROJECT asked for that lens. A project that never
  // turned deep review on isn't missing evidence — it chose a cheaper bar, and
  // holding it to one it never opted into would just mean nothing ever merges.
  if (e.policy.requireDeepReviewWhenConfigured && e.deepReviewConfigured && !e.hasDeepReviewEvidence) {
    reasons.push("deep-review-missing");
  }
  if (e.policy.requireBreakerCleanWhenConfigured && e.breakerConfigured && e.breakerClean === false) {
    reasons.push("breaker-flagged");
  }

  if (e.stat.files > e.policy.maxFilesChanged) reasons.push("too-many-files");
  if (e.stat.add + e.stat.del > e.policy.maxLinesChanged) reasons.push("too-many-lines");

  return {
    autoMerge: reasons.length === 0,
    reasons,
    explain: reasons.length === 0 ? autoMergeExplain(e) : `Needs you because it ${joinReasons(reasons)}.`,
  };
}

/** What the evidence actually was, for the audit line on an unattended merge —
 *  so "who approved this?" has an answer better than "the machine did". */
function autoMergeExplain(e: MergeEvidence): string {
  const bits: string[] = [];
  if (e.review) bits.push("an agent reviewed and approved it");
  if (e.deepReviewConfigured && e.hasDeepReviewEvidence) bits.push("deep review exercised it in a browser");
  if (e.breakerConfigured && e.breakerClean) bits.push("the breaker tried to break it and couldn't");
  bits.push(`${e.stat.files} file(s), ${e.stat.add + e.stat.del} line(s) — inside the policy`);
  return `Merged unattended: ${bits.join("; ")}.`;
}

function joinReasons(reasons: MergeGateReason[]): string {
  const text = reasons.map((r) => GATE_REASON_TEXT[r]);
  if (text.length === 1) return text[0]!;
  return `${text.slice(0, -1).join(", ")} and ${text[text.length - 1]}`;
}
