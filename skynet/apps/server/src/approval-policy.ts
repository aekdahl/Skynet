// ─── Approval policy — auto-resolve gated agent actions ─────────────────────
// Decides whether a command-approval gate can be auto-approved WITHOUT a human,
// given the project's approval level + its standing "approve always" rules. This
// is the layer that turns "confirm every command" into "gate only at the trust
// boundary": low/medium commands run inside the agent's isolated worktree and are
// reversible until the (always-gated) diff review, while everything genuinely
// dangerous or outward-facing classifies as high-risk / deny and always gates.
//
// Pure + safety-first — no I/O, unit-testable, and it re-derives risk from the
// live classifier so a stale rule can never widen what actually runs.

import type { ApprovalLevel, ApprovalRule, CommandPolicy, Risk } from "@skynet/shared";
import { classifyCommand, DEFAULT_COMMAND_POLICY } from "./command-safety.js";

const RANK: Record<Risk, number> = { low: 0, medium: 1, high: 2 };

/** Collapse whitespace so "npm  test\n" and "npm test" are the same command. */
export function normalizeCommand(command: string): string {
  return command.trim().replace(/\s+/g, " ");
}

/** null = must gate (ask a human). Otherwise the audit-trail attribution. */
export type AutoApproval = { by: string } | null;

/**
 * Decide auto-approval for a command-approval gate. Only `approval` gates that
 * carry a real command are ever eligible; the caller passes the command string
 * (commandless approvals from non-Claude runners return null → always gate).
 *
 * Order (safety-first):
 *  1. hard-DENY command → null (never auto-approve; also blocked at approve time).
 *  2. a standing rule matching the EXACT command → approve, but only while the
 *     command's CURRENT risk is still within the rule's cap (a rule can't widen).
 *  3. risk TIER: manual approves nothing; assisted approves low; trusted approves
 *     low+medium. high-risk always gates (the trust boundary).
 */
export function decideAutoApproval(input: {
  command: string | null | undefined;
  level: ApprovalLevel;
  rules: ApprovalRule[];
  /** The workspace's active CommandPolicy — defaults to the shipped classifier. */
  policy?: CommandPolicy;
}): AutoApproval {
  if (!input.command) return null; // commandless approval → always gate
  const command = normalizeCommand(input.command);
  if (!command) return null;

  const verdict = classifyCommand(command, input.policy ?? DEFAULT_COMMAND_POLICY);
  if (verdict.decision === "deny") return null; // safety floor — never auto-approve

  // A standing "approve always" allowance: exact match, current risk within cap.
  const rule = input.rules.find(
    (r) => normalizeCommand(r.command) === command && RANK[verdict.risk] <= RANK[r.riskCap],
  );
  if (rule) return { by: `policy:rule:${rule.id}` };

  // Risk tier.
  if (input.level === "manual") return null;
  if (verdict.risk === "high") return null; // boundary op — always a human decision
  if (input.level === "assisted" && verdict.risk !== "low") return null;
  return { by: `policy:${input.level}` };
}

/**
 * May the operator REMEMBER this command as a standing auto-approval? Only for
 * low/medium, non-deny commands — high-risk / boundary ops (push, merge, infra,
 * destructive git) must always be a fresh human decision, so they can never be
 * turned into a persistent auto-approval. Returns the risk cap to store, or null
 * if the command isn't rememberable.
 */
export function rememberableRisk(command: string, policy: CommandPolicy = DEFAULT_COMMAND_POLICY): Risk | null {
  const verdict = classifyCommand(normalizeCommand(command), policy);
  if (verdict.decision === "deny" || verdict.risk === "high") return null;
  return verdict.risk;
}
