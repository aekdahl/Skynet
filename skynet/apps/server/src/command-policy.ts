// ─── Command policy service ──────────────────────────────────────────────────
// Versioning + dry-run replay for the per-workspace CommandPolicy (see
// contracts.ts). classifyCommand() itself (command-safety.ts) stays pure/sync;
// this module owns the async store round-trips: resolving the active policy,
// saving a new version (git-like — previous versions stay inspectable), and
// replaying historical commands through a proposed-but-unsaved policy so an
// operator can see what would change before committing to it.

import type { CommandPolicy, PolicyDryRunResult, PolicyVersion, Risk } from "@skynet/shared";
import { classifyCommand, DEFAULT_COMMAND_POLICY } from "./command-safety.js";
import { now } from "./config.js";
import type { Store } from "./store/store.js";

/** The policy a workspace actually classifies commands with right now: its
 *  active PolicyVersion, or the shipped default if it has never customized one. */
export async function resolveActivePolicy(store: Store, workspaceId: string): Promise<CommandPolicy> {
  const active = await store.getActivePolicyVersion(workspaceId);
  return active?.policy ?? DEFAULT_COMMAND_POLICY;
}

/** Save `policy` as a new active version for the workspace — the previous
 *  active version (if any) is deactivated but kept, so history stays
 *  inspectable/diffable. Version numbers are monotonic per workspace. */
export async function savePolicyVersion(
  store: Store,
  workspaceId: string,
  policy: CommandPolicy,
  createdBy: string,
  label: string | null = null,
): Promise<PolicyVersion> {
  const existing = await store.listPolicyVersions(workspaceId); // newest-first
  const nextVersion = (existing[0]?.version ?? 0) + 1;
  const version: PolicyVersion = {
    id: `policy-${workspaceId}-${nextVersion}-${now().toString(36)}`,
    workspaceId,
    version: nextVersion,
    policy,
    active: true,
    label,
    createdBy,
    createdAt: now(),
  };
  return store.putPolicyVersion(version);
}

const RANK: Record<Risk, number> = { low: 0, medium: 1, high: 2 };

/** Normalize the way `decideAutoApproval` does — same whitespace collapse — so
 *  the same logical command dedupes across records even if a run's audit
 *  payload carried an extra newline/space. */
function normalize(command: string): string {
  return command.trim().replace(/\s+/g, " ");
}

/**
 * Replay the workspace's historical command decisions (drawn from its HITL
 * audit trail — every audit record for an `approval` gate carries the raw
 * command in `payload.command`, per hub.ts) through `proposedPolicy`, and
 * report every distinct command whose decision/risk/reasons would change
 * relative to the workspace's CURRENTLY active policy. This is what makes
 * editing a policy non-terrifying: see the blast radius before saving.
 */
export async function dryRunPolicy(
  store: Store,
  workspaceId: string,
  proposedPolicy: CommandPolicy,
  limit = 500,
): Promise<PolicyDryRunResult> {
  const currentPolicy = await resolveActivePolicy(store, workspaceId);
  const audit = await store.listAudit(workspaceId);

  const counts = new Map<string, number>();
  for (const record of audit) {
    const payload = record.payload as { command?: unknown } | null | undefined;
    const raw = typeof payload?.command === "string" ? payload.command : null;
    if (!raw) continue;
    const cmd = normalize(raw);
    if (!cmd) continue;
    counts.set(cmd, (counts.get(cmd) ?? 0) + 1);
  }

  // Replay the most-frequent commands first — under a cap, that's the highest-
  // value sample (a command seen 40 times matters more than one seen once).
  const distinct = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit);

  const changed: PolicyDryRunResult["changed"] = [];
  let unchanged = 0;
  for (const [command, occurrences] of distinct) {
    const before = classifyCommand(command, currentPolicy);
    const after = classifyCommand(command, proposedPolicy);
    const same =
      before.decision === after.decision &&
      before.risk === after.risk &&
      before.reasons.join("|") === after.reasons.join("|");
    if (same) {
      unchanged++;
      continue;
    }
    changed.push({
      command,
      occurrences,
      before: { decision: before.decision, risk: before.risk, reasons: before.reasons },
      after: { decision: after.decision, risk: after.risk, reasons: after.reasons },
    });
  }
  // Surface the most consequential changes first: a widened/narrowed decision
  // matters more than a same-decision risk/reason tweak; ties broken by volume.
  changed.sort((a, b) => {
    const aDecisionChanged = a.before.decision !== a.after.decision ? 1 : 0;
    const bDecisionChanged = b.before.decision !== b.after.decision ? 1 : 0;
    if (aDecisionChanged !== bDecisionChanged) return bDecisionChanged - aDecisionChanged;
    const aRisk = RANK[a.after.risk] - RANK[a.before.risk];
    const bRisk = RANK[b.after.risk] - RANK[b.before.risk];
    if (aRisk !== bRisk) return bRisk - aRisk;
    return b.occurrences - a.occurrences;
  });

  return { sampledRecords: distinct.reduce((n, [, c]) => n + c, 0), uniqueCommands: distinct.length, changed, unchanged };
}
