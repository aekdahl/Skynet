// ─── Autonomy dial (TASK 19) ────────────────────────────────────────────────
// A 4-detent composite read over two already-existing, independently-editable
// Project fields (`autonomy`, `approvalLevel`) — not a new stored field, so
// there's nothing to keep in sync: the detent is always exactly what these two
// fields say right now. Shared so the server's GET endpoint and the web dial
// derive the SAME notch and the SAME "who's required for what" rows from the
// SAME two fields, never a second re-derivation that can drift.
//
// Distinct from `Project.breakerReview` (an unrelated opt-in third adversarial-
// reviewer agent run, scored via apps/server/src/breaker-verdict.ts) — never
// conflate the two. The breaker types below back a DIFFERENT thing: the
// session circuit-breaker (orchestrator.ts's old in-memory `autonomyStreaks`
// Map), now persisted. Internally called `autonomyBreaker` everywhere to keep
// the naming boundary obvious.

import { z } from "zod";
import { ApprovalLevel, Timestamp } from "./contracts.js";

export const AUTONOMY_DETENTS = ["shadow", "assisted", "earned", "unattended"] as const;
export const AutonomyDetent = z.enum(AUTONOMY_DETENTS);
export type AutonomyDetent = z.infer<typeof AutonomyDetent>;

/** Display metadata for the 4 dial cards — index/name/one-line consequence. */
export const AUTONOMY_DETENT_INFO: Record<AutonomyDetent, { index: 1 | 2 | 3 | 4; name: string; consequence: string }> = {
  shadow: {
    index: 1,
    name: "Shadow",
    consequence: "Fully human-driven — nothing starts, runs, or merges without you.",
  },
  assisted: {
    index: 2,
    name: "Assisted",
    consequence: "Autonomy picks up work, but every command and every diff still needs a person.",
  },
  earned: {
    index: 3,
    name: "Earned",
    consequence: "Low + medium-risk commands run unattended; diffs and high-risk actions still gate.",
  },
  unattended: {
    index: 4,
    name: "Unattended",
    consequence: "Finished diffs merge on their own too — only high-risk actions still gate.",
  },
};

/** Compose the 4-detent value from the two underlying fields. Pure, no I/O —
 *  the single source of truth for "what notch is this project actually on"
 *  (Backend Brief TASK 19). `approvalLevel: "manual"` with autonomy on still
 *  reads as `assisted` (manual only differs from assisted in what it gates,
 *  not in which notch it belongs to — see autonomyGateRows, which derives
 *  gating from the real fields, not the notch). */
export function detentFor(project: { autonomy: boolean; approvalLevel: ApprovalLevel }): AutonomyDetent {
  if (!project.autonomy) return "shadow";
  if (project.approvalLevel === "full") return "unattended";
  if (project.approvalLevel === "trusted") return "earned";
  return "assisted";
}

/** Cost-of-waiting weight per notch (TASK 15's `Operations.listDecisions`,
 *  which shipped ahead of this file with every project hardcoded to ×1 — a
 *  higher notch means less human attention is already in the loop, so an
 *  open decision sitting idle there is COSTLIER, not cheaper, hence the
 *  weight rises with the notch rather than falling. */
export const AUTONOMY_DETENT_COST_WEIGHT: Record<AutonomyDetent, number> = {
  shadow: 1,
  assisted: 1,
  earned: 1.5,
  unattended: 2,
};

/** Reverse mapping: the underlying field values a chosen target notch writes.
 *  `shadow` only ever turns `autonomy` off — it deliberately leaves
 *  `approvalLevel` untouched (there's no canonical level for "off"; whatever
 *  it's set to next time autonomy comes back on is what re-derives the notch). */
export function fieldsForDetent(detent: AutonomyDetent): { autonomy: boolean; approvalLevel?: ApprovalLevel } {
  switch (detent) {
    case "shadow":
      return { autonomy: false };
    case "assisted":
      return { autonomy: true, approvalLevel: "assisted" };
    case "earned":
      return { autonomy: true, approvalLevel: "trusted" };
    case "unattended":
      return { autonomy: true, approvalLevel: "full" };
  }
}

export interface AutonomyGateRow {
  key: string;
  label: string;
  /** true = a person is required for this today; false = it's handled with no gate. */
  gated: boolean;
}

/** "At this notch, a person is required for" — live-derived from the ACTUAL
 *  `{autonomy, approvalLevel}` pair (not the simplified 4-value notch), so an
 *  unusual combination (e.g. autonomy on + approvalLevel still "manual") shows
 *  its real gating instead of the canonical notch's. Mirrors the documented
 *  ApprovalLevel semantics (contracts.ts) exactly — command-risk auto-approve
 *  is approvalLevel-only; only the own-diff auto-merge additionally needs
 *  autonomy on; high-risk/boundary commands are NEVER auto-approved. */
export function autonomyGateRows(state: { autonomy: boolean; approvalLevel: ApprovalLevel }): AutonomyGateRow[] {
  const { autonomy, approvalLevel } = state;
  const lowAuto = approvalLevel === "assisted" || approvalLevel === "trusted" || approvalLevel === "full";
  const mediumAuto = approvalLevel === "trusted" || approvalLevel === "full";
  const ownDiffAutoMerge = approvalLevel === "full" && autonomy;
  return [
    { key: "pickup", label: "Picking up new work (triage, auto-pick)", gated: !autonomy },
    { key: "low-risk", label: "Low-risk commands (read / list / build / test-style actions)", gated: !lowAuto },
    { key: "medium-risk", label: "Medium-risk commands (writes inside the sandboxed worktree)", gated: !mediumAuto },
    { key: "high-risk", label: "High-risk & boundary actions (push, merge, infra CLIs, destructive git)", gated: true },
    { key: "merge", label: "Merging a finished diff into the base branch", gated: !ownDiffAutoMerge },
  ];
}

// ─── Autonomy breaker (persisted) ───────────────────────────────────────────
// Replaces orchestrator.ts's old in-memory `autonomyStreaks` Map so a restart
// mid-streak doesn't reset progress toward the trip threshold
// (config.autonomyMaxConsecutiveFailures). One record per project; absent
// (no row) = no accumulated streak, same meaning as a Map miss before.
export const AutonomyBreaker = z.object({
  projectId: z.string(),
  count: z.number().int().nonnegative(),
  entries: z.array(z.string()),
  // Set once `count` reaches the trip threshold and `Project.autonomy` is
  // forced off; null while still accumulating (not yet tripped). The only
  // signal that distinguishes "actually tripped" from "a partial streak that
  // got cleared before reaching threshold" — only the former is audited as a
  // "lift" when it's cleared.
  trippedAt: Timestamp.nullable(),
  // The run whose bad outcome tripped the breaker — reused as the `runId` on
  // the eventual "lift" AuditRecord (AuditRecord.runId is required, and the
  // triggering run is the most relevant reference available for it).
  trippedByRunId: z.string().nullable(),
});
export type AutonomyBreaker = z.infer<typeof AutonomyBreaker>;

// A temporary manual bypass of a TRIPPED breaker — "I'll watch it": autonomy
// resumes immediately, but only until `expiresAt`, when it automatically
// reverts to whatever the breaker's CURRENT trip state says (still tripped →
// back off; cleared in the meantime by a real lift → stays on, this record
// just expires as a no-op). One per project; absent = no active override.
export const AutonomyOverride = z.object({
  projectId: z.string(),
  overriddenBy: z.string(),
  overriddenAt: Timestamp,
  expiresAt: Timestamp,
});
export type AutonomyOverride = z.infer<typeof AutonomyOverride>;

export const SetAutonomyDetentRequest = z.object({ detent: AutonomyDetent });
export type SetAutonomyDetentRequest = z.infer<typeof SetAutonomyDetentRequest>;

/** GET /api/projects/:id/autonomy-detent response — everything the dial +
 *  breaker panel render, in one round trip. */
export const AutonomyDetentState = z.object({
  detent: AutonomyDetent,
  autonomy: z.boolean(),
  approvalLevel: ApprovalLevel,
  // config.autonomyMaxConsecutiveFailures at read time — the progress ladder's
  // denominator; 0 means the breaker is disabled server-wide.
  maxConsecutiveFailures: z.number().int().nonnegative(),
  breaker: AutonomyBreaker.nullable(),
  override: AutonomyOverride.nullable(),
});
export type AutonomyDetentState = z.infer<typeof AutonomyDetentState>;
