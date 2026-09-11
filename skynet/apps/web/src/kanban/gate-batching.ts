// Gate batching — group open decisions that are the SAME repeatable policy
// call so the Inbox can surface them as one card instead of N. Today that
// means an `approval` gate whose (normalized) command is identical across
// several runs — the same equality approve-with-rule already uses (server:
// approval-policy.ts's normalizeCommand), so "batch these" and "remember
// this command" agree on what counts as the same gate. Pure + unit-tested;
// the Inbox (inbox.tsx) is the only caller.
import type { Decision } from "@skynet/shared";

export interface GateBatch {
  /** Stable across renders for the same command — usable as a React key. */
  key: string;
  kind: "approval";
  /** The normalized command text shown on the card. */
  command: string;
  /** 2+ members, in whatever order `decisions` handed them in. */
  items: Decision[];
}

/** Mirrors server/approval-policy.ts's normalizeCommand exactly (collapse
 *  whitespace) — kept as a small standalone copy rather than a shared
 *  import since the web app can't reach server-only code, same as that
 *  file's own note that it's already duplicated once (command-policy.ts). */
function normalizeCommand(command: string): string {
  return command.trim().replace(/\s+/g, " ");
}

/**
 * Split `decisions` into batchable groups (2+ `approval` gates sharing an
 * identical normalized command) and everything else. A lone gate that
 * happens to match nothing else stays a `single` — batching only earns its
 * keep once there's actually more than one to collapse.
 */
export function groupBatchableDecisions(decisions: Decision[]): { batches: GateBatch[]; singles: Decision[] } {
  const byKey = new Map<string, Decision[]>();
  for (const d of decisions) {
    if (d.kind !== "approval" || !d.command) continue;
    const key = `approval:${normalizeCommand(d.command)}`;
    const bucket = byKey.get(key);
    if (bucket) bucket.push(d);
    else byKey.set(key, [d]);
  }
  const batchedIds = new Set<string>();
  const batches: GateBatch[] = [];
  for (const [key, items] of byKey) {
    if (items.length < 2) continue;
    for (const it of items) batchedIds.add(it.id);
    batches.push({ key, kind: "approval", command: normalizeCommand(items[0]!.command!), items });
  }
  // Highest cost-of-waiting member leads — keeps batch position consistent
  // with the existing "most urgent first" convention singles already use.
  batches.sort((a, b) => Math.max(...b.items.map((i) => i.costOfWaiting)) - Math.max(...a.items.map((i) => i.costOfWaiting)));
  const singles = decisions.filter((d) => !batchedIds.has(d.id));
  return { batches, singles };
}
