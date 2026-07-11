// ─── Safety preflight ─────────────────────────────────────────────────────
// Pure evaluation of the guardrails against one push attempt. Runs server-side
// before any write reaches GitHub — an agent or runner cannot route around it.
// Kept dependency-free and side-effect-free so it's exhaustively unit-testable.

import type { SafetyPolicy } from "@skynet/shared";
import type { PushRequest, SafetyViolation } from "./types.js";

/**
 * Evaluate every active guardrail. Returns the violations (empty = allowed).
 * `approveBeforePush` is NOT evaluated here — it gates earlier, as the HITL
 * diff-review the orchestrator already raises before this push runs.
 */
export function evaluateSafety(policy: SafetyPolicy, req: PushRequest): SafetyViolation[] {
  const violations: SafetyViolation[] = [];

  // PR-only: runs may never write the default branch directly.
  if (policy.prOnly && req.branch === req.baseBranch) {
    violations.push({
      rule: "prOnly",
      message: `direct write to the default branch "${req.baseBranch}" is blocked — PR-only is on`,
    });
  }

  // No force-push / history rewrite on agent branches.
  if (policy.noForcePush && req.force) {
    violations.push({
      rule: "noForcePush",
      message: "force-push / history rewrite is blocked — commits are append-only",
    });
  }

  // Module allowlist: every changed path must map to one of the agent's
  // assigned modules. An empty allowlist means "unconstrained" (no scope set).
  if (policy.moduleAllowlist && req.allowedModules.length > 0) {
    const allowed = new Set(req.allowedModules);
    const outside = req.modules.filter((m) => !allowed.has(m));
    if (outside.length > 0) {
      violations.push({
        rule: "moduleAllowlist",
        message: `changes touch out-of-scope module(s): ${outside.join(", ")} (allowed: ${req.allowedModules.join(", ")})`,
      });
    }
  }

  return violations;
}

/** Whether a push/merge must wait for an operator decision first. */
export function requiresApproval(policy: SafetyPolicy): boolean {
  return policy.approveBeforePush;
}
