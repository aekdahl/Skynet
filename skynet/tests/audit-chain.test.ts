// ─── Tamper-evident hash-chained audit trail tests ──────────────────────────
// Three properties this suite exists to prove:
//   1. Each record written to the memory store carries a stable, deterministic
//      hash over its immutable decision fields.
//   2. prevHash correctly links each record to the one before it — the chain
//      forms correctly across sequential writes.
//   3. Any alteration to a record's fields or position is caught by
//      verifyAuditChain(); pre-chain records (hash absent) are skipped
//      without breaking validation of the rest.
import { describe, it, expect } from "vitest";
import type { AuditRecord } from "@skynet/shared";
import { chainAuditRecord, computeAuditHash, verifyAuditChain } from "../apps/server/src/audit-chain.js";
import { MemoryStore } from "../apps/server/src/store/memory.js";

const WS = "ws-chain-test";

function rec(hitlId: string, extra: Partial<AuditRecord> = {}): AuditRecord {
  return {
    workspaceId: WS,
    hitlId,
    runId: "run-1",
    action: "approve",
    operatorId: "op",
    at: 1_000 + Number(hitlId.replace(/\D/g, "") || "0"),
    payload: { kind: "approval", command: `echo ${hitlId}` },
    ...extra,
  };
}

describe("computeAuditHash", () => {
  it("is deterministic — same input always produces the same hash", () => {
    const fields = { workspaceId: WS, hitlId: "h1", runId: "run-1", action: "approve", operatorId: "op", at: 1000, payload: { x: 1 }, prevHash: null };
    expect(computeAuditHash(fields)).toBe(computeAuditHash(fields));
  });

  it("changes when any field changes", () => {
    const base = { workspaceId: WS, hitlId: "h1", runId: "run-1", action: "approve", operatorId: "op", at: 1000, payload: { x: 1 }, prevHash: null };
    const h = computeAuditHash(base);
    expect(computeAuditHash({ ...base, action: "reject" })).not.toBe(h);
    expect(computeAuditHash({ ...base, at: 1001 })).not.toBe(h);
    expect(computeAuditHash({ ...base, operatorId: "op2" })).not.toBe(h);
    expect(computeAuditHash({ ...base, prevHash: "abc" })).not.toBe(h);
  });

  it("payload is canonicalized — key order does not matter", () => {
    const a = { workspaceId: WS, hitlId: "h1", runId: "r", action: "a", operatorId: "o", at: 1, payload: { b: 2, a: 1 }, prevHash: null };
    const b = { ...a, payload: { a: 1, b: 2 } };
    expect(computeAuditHash(a)).toBe(computeAuditHash(b));
  });
});

describe("chainAuditRecord", () => {
  it("genesis record has prevHash=null and a non-empty hash", () => {
    const chained = chainAuditRecord(rec("h1"), null);
    expect(chained.prevHash).toBeNull();
    expect(typeof chained.hash).toBe("string");
    expect(chained.hash!.length).toBeGreaterThan(10);
  });

  it("second record's prevHash equals first record's hash", () => {
    const first = chainAuditRecord(rec("h1"), null);
    const second = chainAuditRecord(rec("h2"), first.hash!);
    expect(second.prevHash).toBe(first.hash);
  });

  it("archived field does not affect the hash — archiving never breaks the chain", () => {
    const a = chainAuditRecord(rec("h1"), null);
    const b = chainAuditRecord({ ...rec("h1"), archived: true }, null);
    expect(a.hash).toBe(b.hash); // archived is excluded from the hash
  });
});

describe("MemoryStore hash chain", () => {
  it("writes form a valid chain — verifyAuditChain passes on the full ordered list", async () => {
    const store = new MemoryStore();
    await store.recordAudit(rec("h1"));
    await store.recordAudit(rec("h2"));
    await store.recordAudit(rec("h3"));
    const records = (await store.listAudit(WS)).reverse(); // oldest-first
    expect(verifyAuditChain(records)).toBeNull();
  });

  it("genesis record has prevHash=null", async () => {
    const store = new MemoryStore();
    await store.recordAudit(rec("h1"));
    const [r] = (await store.listAudit(WS)).reverse();
    expect(r.prevHash).toBeNull();
    expect(r.hash).toBeTruthy();
  });

  it("each record's prevHash links to the preceding record's hash", async () => {
    const store = new MemoryStore();
    await store.recordAudit(rec("h1"));
    await store.recordAudit(rec("h2"));
    await store.recordAudit(rec("h3"));
    const [r1, r2, r3] = (await store.listAudit(WS)).reverse();
    expect(r1.prevHash).toBeNull();
    expect(r2.prevHash).toBe(r1.hash);
    expect(r3.prevHash).toBe(r2.hash);
  });

  it("different workspaces have independent chains — no cross-contamination", async () => {
    const store = new MemoryStore();
    await store.recordAudit(rec("h1"));
    await store.recordAudit({ ...rec("h2"), workspaceId: "other-ws" });
    const ws1 = (await store.listAudit(WS)).reverse();
    const ws2 = (await store.listAudit("other-ws")).reverse();
    expect(ws1[0].prevHash).toBeNull(); // genesis for WS
    expect(ws2[0].prevHash).toBeNull(); // genesis for other-ws — not chained to ws1
  });
});

describe("verifyAuditChain", () => {
  it("returns null on an empty list", () => {
    expect(verifyAuditChain([])).toBeNull();
  });

  it("returns null on a single valid record", () => {
    const r = chainAuditRecord(rec("h1"), null);
    expect(verifyAuditChain([r])).toBeNull();
  });

  it("returns null when pre-chain records (no hash) are mixed in", () => {
    const old = rec("h0"); // no hash — pre-chain
    const r1 = chainAuditRecord(rec("h1"), null);
    const r2 = chainAuditRecord(rec("h2"), r1.hash!);
    expect(verifyAuditChain([old, r1, r2])).toBeNull();
  });

  it("detects a tampered payload", () => {
    const r1 = chainAuditRecord(rec("h1"), null);
    const r2 = chainAuditRecord(rec("h2"), r1.hash!);
    const tampered: AuditRecord = { ...r1, payload: { kind: "approval", command: "rm -rf /" } };
    const result = verifyAuditChain([tampered, r2]);
    expect(result).toMatch(/tampered.*h1/i);
  });

  it("detects a broken prevHash link", () => {
    const r1 = chainAuditRecord(rec("h1"), null);
    const r2 = chainAuditRecord(rec("h2"), r1.hash!);
    const broken: AuditRecord = { ...r2, prevHash: "deadbeef" };
    const result = verifyAuditChain([r1, broken]);
    expect(result).toMatch(/broken.*h2/i);
  });

  it("detects a reordered record (different prevHash)", () => {
    const r1 = chainAuditRecord(rec("h1"), null);
    const r2 = chainAuditRecord(rec("h2"), r1.hash!);
    const r3 = chainAuditRecord(rec("h3"), r2.hash!);
    // Swap r2 and r3 — r3's prevHash now points to r1, but we present r2 first.
    const result = verifyAuditChain([r1, r3, r2]);
    expect(result).not.toBeNull(); // chain is broken
  });
});
