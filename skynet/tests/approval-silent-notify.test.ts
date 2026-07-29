// Auto-approved gates are recorded in the audit trail but must NOT publish
// `hitl.raised` — that event is the human-notification signal (Telegram 🔔,
// push). Waking the operator for a decision the policy already made was the
// bug: this pins the SILENT auto-resolve path.
import { describe, it, expect } from "vitest";
import type { HitlItem, Resolution, ServerEvent } from "@skynet/shared";
import { DEFAULT_WORKSPACE } from "@skynet/shared";
import { Hub } from "../apps/server/src/hub.js";
import { MemoryStore } from "../apps/server/src/store/memory.js";
import type { Bus } from "../apps/server/src/bus.js";

class CapturingBus implements Bus {
  events: ServerEvent[] = [];
  publish(_ws: string, ev: ServerEvent): void {
    this.events.push(ev);
  }
  subscribe(): () => void {
    return () => {};
  }
}

const mkItem = (id: string): HitlItem => ({
  id,
  workspaceId: DEFAULT_WORKSPACE,
  runId: "run-1",
  kind: "approval",
  title: "Run: npm test",
  why: "agent wants to run tests",
  raisedAt: 100,
  risk: "medium",
  expiresAt: null,
  resolvedAt: null,
  resolution: null,
  rationale: null,
  command: "npm test",
  options: null,
  recommended: null,
  steps: null,
  diff: null,
  flags: [],
});

const mkResolution = (): Resolution => ({
  action: "approve",
  optionIndex: null,
  guidance: null,
  by: "policy:trusted",
  at: 200,
});

describe("Hub.raiseAndAutoResolveHitl — silent auto-resolve", () => {
  it("publishes ONLY hitl.resolved — never hitl.raised — so Telegram doesn't ping", async () => {
    const store = new MemoryStore({ seed: false });
    const bus = new CapturingBus();
    const hub = new Hub(store, bus);
    const item = mkItem("q-auto");

    await hub.raiseAndAutoResolveHitl(item, mkResolution());

    const kinds = bus.events.map((e) => e.type);
    expect(kinds).not.toContain("hitl.raised");
    expect(kinds).toContain("hitl.resolved");
  });

  it("records a full audit entry (the trail still shows the auto-approval)", async () => {
    const store = new MemoryStore({ seed: false });
    const hub = new Hub(store, new CapturingBus());
    await hub.raiseAndAutoResolveHitl(mkItem("q-auto"), mkResolution());

    const audit = await store.listAudit(DEFAULT_WORKSPACE);
    expect(audit).toHaveLength(1);
    expect(audit[0]!.hitlId).toBe("q-auto");
    expect(audit[0]!.action).toBe("approve");
    expect(audit[0]!.operatorId).toBe("policy:trusted");
  });

  it("stores the item as already-resolved (nothing left in the open queue)", async () => {
    const store = new MemoryStore({ seed: false });
    const hub = new Hub(store, new CapturingBus());
    await hub.raiseAndAutoResolveHitl(mkItem("q-auto"), mkResolution());

    const stored = await store.getHitl("q-auto");
    expect(stored?.resolvedAt).toBe(200);
    expect(stored?.resolution?.action).toBe("approve");
    // The Inbox filters unresolved items — this one is resolved from the start.
    const open = (await store.listQueue(DEFAULT_WORKSPACE)).filter((h) => h.resolvedAt == null);
    expect(open).toHaveLength(0);
  });

  it("regression: raiseHitl (the HUMAN path) STILL publishes hitl.raised", async () => {
    // We didn't touch raiseHitl — this locks that in so a future refactor can't
    // accidentally suppress the notification when a human IS needed.
    const store = new MemoryStore({ seed: false });
    const bus = new CapturingBus();
    const hub = new Hub(store, bus);

    await hub.raiseHitl(mkItem("q-human"));

    const kinds = bus.events.map((e) => e.type);
    expect(kinds).toContain("hitl.raised");
    // Not resolved yet — no resolved event.
    expect(kinds).not.toContain("hitl.resolved");
  });
});
