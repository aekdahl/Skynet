// HITL idempotency: resolveHitl is first-writer-wins (Backend Brief §05). A
// double-click or a racing second operator must NOT overwrite the decision,
// re-publish, or double-record the audit trail. The Hub owns that guarantee.
import { describe, it, expect, beforeEach } from "vitest";
import type { ServerEvent, HitlItem, Resolution } from "@skynet/shared";
import { DEFAULT_WORKSPACE } from "@skynet/shared";
import { Hub } from "../apps/server/src/hub.js";
import { MemoryStore } from "../apps/server/src/store/memory.js";
import type { Bus } from "../apps/server/src/bus.js";

// Capturing bus — records every published event so we can assert publish counts.
class CapturingBus implements Bus {
  events: { workspaceId: string; event: ServerEvent }[] = [];
  publish(workspaceId: string, event: ServerEvent): void {
    this.events.push({ workspaceId, event });
  }
  subscribe(): () => void {
    return () => {};
  }
  resolved() {
    return this.events.filter((e) => e.event.type === "hitl.resolved");
  }
}

const item: HitlItem = {
  id: "q-test", workspaceId: DEFAULT_WORKSPACE, runId: "billing", kind: "approval",
  title: "Run migration", why: "needs approval", risk: "medium",
  raisedAt: 1_000, resolvedAt: null, resolution: null,
  command: "migrate", options: null, recommended: null, steps: null, diff: null,
};

const approve: Resolution = { action: "approve", optionIndex: null, guidance: null, targetBranch: null, memoryNote: null, by: "op-1", at: 5_000 };
const reject: Resolution = { action: "reject", optionIndex: null, guidance: "no", targetBranch: null, memoryNote: null, by: "op-2", at: 6_000 };

describe("HITL idempotency (first-writer-wins)", () => {
  let store: MemoryStore;
  let bus: CapturingBus;
  let hub: Hub;

  beforeEach(async () => {
    store = new MemoryStore();
    bus = new CapturingBus();
    hub = new Hub(store, bus);
    await hub.raiseHitl({ ...item });
  });

  it("first resolution persists, publishes once, and records one audit entry", async () => {
    const resolved = await hub.resolveHitl("q-test", approve);
    expect(resolved?.resolution).toEqual(approve);
    expect(resolved?.resolvedAt).toBe(approve.at);

    expect((await store.getHitl("q-test"))?.resolution).toEqual(approve);
    expect(bus.resolved()).toHaveLength(1);
    expect(await store.listAudit(DEFAULT_WORKSPACE)).toHaveLength(1);
  });

  it("a second, conflicting resolution is a no-op — original wins", async () => {
    await hub.resolveHitl("q-test", approve);
    const second = await hub.resolveHitl("q-test", reject);

    // Returns the EXISTING (first) decision, not the second.
    expect(second?.resolution).toEqual(approve);
    expect((await store.getHitl("q-test"))?.resolution).toEqual(approve);

    // No second publish, no second audit record.
    expect(bus.resolved()).toHaveLength(1);
    expect(await store.listAudit(DEFAULT_WORKSPACE)).toHaveLength(1);
  });

  // REGRESSION (Core / hub.ts): resolveHitl reads the item, then writes, with an
  // `await` in between. Truly concurrent resolves all observe resolution === null
  // before any persists, so each would record an audit entry — the first-writer-
  // wins guard would only hold for sequential calls (the double-click path above).
  // Reachable because HTTP resolves interleave on the event loop. The Hub now
  // serializes per-id so overlapping resolves are ordered and only the first wins.
  it("concurrent resolves should still produce exactly one audit record", async () => {
    const before = (await store.listAudit(DEFAULT_WORKSPACE)).length;

    // Fire N truly concurrent resolves for the same open item.
    const resolutions: Resolution[] = Array.from({ length: 8 }, (_, i) => ({
      action: i % 2 === 0 ? "approve" : "reject",
      optionIndex: null,
      guidance: null,
      memoryNote: null,
      by: `op-${i}`,
      at: 5_000 + i,
    }));
    const results = await Promise.all(resolutions.map((r) => hub.resolveHitl("q-test", r)));

    // The audit trail grew by exactly one, and only one resolution was delivered.
    expect((await store.listAudit(DEFAULT_WORKSPACE)).length - before).toBe(1);
    expect(bus.resolved()).toHaveLength(1);

    // The item ends with exactly one resolution and every caller observes it.
    const stored = await store.getHitl("q-test");
    expect(stored?.resolution).not.toBeNull();
    for (const r of results) {
      expect(r?.resolution).toEqual(stored?.resolution);
    }
  });

  it("resolving an unknown HITL id returns undefined and records nothing", async () => {
    const res = await hub.resolveHitl("does-not-exist", approve);
    expect(res).toBeUndefined();
    expect(bus.resolved()).toHaveLength(0);
    expect(await store.listAudit(DEFAULT_WORKSPACE)).toHaveLength(0);
  });
});
