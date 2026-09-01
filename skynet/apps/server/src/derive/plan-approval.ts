import type { CommandPolicy } from "@skynet/shared";
import { classifyCommand } from "../command-safety.js";

// A step's text sometimes names a real command, e.g. "Run `pnpm db:migrate`" —
// when it does, classify it for real instead of guessing from prose.
const BACKTICK_COMMAND_RE = /`([^`]+)`/;

// Best-effort fallback for the brief's two named non-command gate categories:
// a plan step's prose rarely spells out a shell command for these (e.g. "Merge
// the feature branch", "Run the database migration"), so there's nothing for
// classifyCommand to classify. Narrow and explicit on purpose.
const CATEGORY_RE = /\b(merge|migrat(?:e|ion)|schema|database|db|production|prod|infra(?:structure)?|secret|credential|deploy(?:ment)?)\b/i;

/**
 * Best-effort UI hint only ("does this upcoming plan step look like it'll hit
 * a gate?") — never itself gates, blocks, or auto-approves anything. The real
 * gate is classifyCommand at Orchestrator.raise() time against the actual
 * tool call; this predicts from free-form agent prose ahead of time, so false
 * positives/negatives are expected. See Hub.annotateApproval, its only caller.
 */
export function stepRequiresApproval(text: string, policy: CommandPolicy): boolean {
  // Defensive: runProgress's `plan` arrives from ANY RunnerProvider (and its
  // test doubles), not just ones that satisfy PlanStep's `text: string` at
  // runtime — a malformed step must never crash the whole progress write.
  if (typeof text !== "string" || !text) return false;
  const backtick = text.match(BACKTICK_COMMAND_RE);
  if (backtick?.[1]) return classifyCommand(backtick[1], policy).decision !== "allow";
  return CATEGORY_RE.test(text);
}
