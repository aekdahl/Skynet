// ─── Tamper-evident audit hash chain ────────────────────────────────────────
// Every AuditRecord is SHA-256-hashed over its immutable decision fields plus
// the preceding record's hash (prevHash), forming a per-workspace chain where
// any alteration to a record or its position in the trail is detectable offline.
//
// Hashed fields (decision-time facts): workspaceId, hitlId, runId, action,
// operatorId, at, payload, prevHash. The mutable soft-hide flag `archived` is
// deliberately excluded — archiving a record doesn't alter the decision made.
//
// Genesis record: prevHash = null.
// Pre-chain records (written before this feature landed): hash/prevHash absent.

import { createHash } from "node:crypto";
import type { AuditRecord } from "@skynet/shared";

interface ChainFields {
  workspaceId: string;
  hitlId: string;
  runId: string;
  action: string;
  operatorId: string;
  at: number;
  payload: unknown;
  prevHash: string | null;
}

function canonicalJson(value: unknown): string {
  const sorted = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sorted);
    if (v !== null && typeof v === "object") {
      const obj = v as Record<string, unknown>;
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(obj).sort()) out[k] = sorted(obj[k]);
      return out;
    }
    return v;
  };
  return JSON.stringify(sorted(value));
}

export function computeAuditHash(fields: ChainFields): string {
  return createHash("sha256").update(canonicalJson(fields), "utf8").digest("hex");
}

/**
 * Attach hash + prevHash to an AuditRecord before persisting it.
 * prevHash is the hash of the most recently committed record for this workspace,
 * or null for the genesis record.
 */
export function chainAuditRecord(entry: AuditRecord, prevHash: string | null): AuditRecord {
  const hash = computeAuditHash({
    workspaceId: entry.workspaceId,
    hitlId: entry.hitlId,
    runId: entry.runId,
    action: entry.action,
    operatorId: entry.operatorId,
    at: entry.at,
    payload: entry.payload,
    prevHash,
  });
  return { ...entry, hash, prevHash };
}

/**
 * Verify a contiguous slice of AuditRecords in oldest-first order by
 * re-computing each hash and checking that the chain links are intact.
 * Returns null on success, or a human-readable description of the first
 * broken link (tampered content or missing/wrong prevHash).
 *
 * Pre-chain records (hash absent) are skipped — they predate the feature
 * and are not evidence of tampering. The first chained record must be a
 * genesis (prevHash=null); subsequent ones link to the preceding chained
 * record's hash.
 */
export function verifyAuditChain(records: AuditRecord[]): string | null {
  let expectedPrev: string | null = null;
  for (const rec of records) {
    if (rec.hash === undefined) continue; // pre-chain record — skip
    if (rec.prevHash !== expectedPrev) {
      return `broken chain at ${rec.hitlId}: expected prevHash=${String(expectedPrev)} got ${String(rec.prevHash)}`;
    }
    const actual = computeAuditHash({
      workspaceId: rec.workspaceId,
      hitlId: rec.hitlId,
      runId: rec.runId,
      action: rec.action,
      operatorId: rec.operatorId,
      at: rec.at,
      payload: rec.payload,
      prevHash: rec.prevHash ?? null,
    });
    if (actual !== rec.hash) {
      return `tampered record at ${rec.hitlId}: stored hash=${rec.hash} recomputed=${actual}`;
    }
    expectedPrev = rec.hash;
  }
  return null;
}
