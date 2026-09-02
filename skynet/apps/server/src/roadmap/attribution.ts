// ─── Roadmap proposal commit attribution (Phase 25 — TASK 28) ───────────────
// Turns an operatorId (Skynet's auth/session system's entire identity concept
// — see apps/server/src/auth.ts's Principal; there's no separate profile/
// display-name/email store anywhere in this codebase) and an Agent into the
// {authorName, authorEmail, coAuthor} shape both commit paths
// (local-repo-write.ts's CommitAttribution, github/types.ts's
// GitCommitAttribution) accept. Scoped strictly to the roadmap-proposal apply
// path (Operations.applyRoadmapProposal) — no other commit path in this
// codebase derives an identity this way, and every other caller of those two
// commit functions is unaffected (attribution is optional there).

import type { Agent } from "@skynet/shared";

/** A human operator's git identity for a roadmap-proposal commit they
 *  approved. `operatorId` is the whole of what Skynet's auth/session system
 *  carries per operator (Principal.operatorId — a bare handle like "jordan",
 *  see auth.ts), so the email is a synthetic-but-stable
 *  `<operatorId>@operators.skynet.local` — the same "never depend on
 *  anything outside Skynet's own state" reasoning as local-repo-write.ts's
 *  existing flat `skynet@local` identity, just per-operator instead of fixed. */
export function operatorGitIdentity(operatorId: string): { authorName: string; authorEmail: string } {
  return { authorName: operatorId, authorEmail: `${operatorId}@operators.skynet.local` };
}

/** The identity a fully-autonomous apply (no human clicked approve — only
 *  reachable for a diff Rule 2 didn't flag, on a project at the `unattended`
 *  autonomy detent) commits as. Deliberately distinct from BOTH
 *  `operatorGitIdentity` (a real human) and local-repo-write.ts's flat
 *  `Skynet`/`skynet@local` (an ordinary Steward-drafted edit) — so a commit
 *  log never conflates "a human approved this" with "nobody did". */
export const AUTONOMOUS_APPLY_IDENTITY = { authorName: "Skynet Autonomy", authorEmail: "autonomy@skynet.local" };

/** The proposing agent's Co-authored-by identity — `<agent id>@agents.skynet.local`,
 *  same synthetic-but-stable convention as `operatorGitIdentity` above (an
 *  Agent has no email field either — see @skynet/shared's Agent contract). */
export function agentCoAuthor(agent: Pick<Agent, "id" | "name">): { name: string; email: string } {
  return { name: agent.name, email: `${agent.id}@agents.skynet.local` };
}
