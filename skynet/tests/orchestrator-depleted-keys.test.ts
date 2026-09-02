// TASK 23 hardening — closes the "provider rate-limit/quota errors surface as
// ONE fleet-level banner, never duplicated per-run" checklist item. Before
// this, tripKeyBreaker's depletedKeys Map (orchestrator.ts) had no public read
// path at all — the only visible signal was a per-run billing escalation,
// duplicated once per run sharing the depleted key. listDepletedKeys is the
// new, additive read the banner polls; the per-run escalation is untouched.
import { describe, it, expect, beforeEach } from "vitest";
import type { ServerEvent } from "@skynet/shared";
import { DEFAULT_WORKSPACE } from "@skynet/shared";
import { Hub } from "../apps/server/src/hub.js";
import { MemoryStore } from "../apps/server/src/store/memory.js";
import { Orchestrator } from "../apps/server/src/orchestrator.js";
import { Operations } from "../apps/server/src/operations.js";
import type { Bus } from "../apps/server/src/bus.js";

class NullBus implements Bus {
  publish(_ws: string, _e: ServerEvent): void {}
  subscribe(): () => void {
    return () => undefined;
  }
}

const WS = DEFAULT_WORKSPACE;

describe("Orchestrator.listDepletedKeys", () => {
  let orch: Orchestrator;
  let ops: Operations;
  let store: MemoryStore;

  beforeEach(() => {
    store = new MemoryStore();
    const hub = new Hub(store, new NullBus());
    orch = new Orchestrator(store, hub);
    ops = new Operations({ store, hub, orchestrator: orch });
  });

  // depletedKeys is private — poked directly the same way credential-pause.test.ts
  // already does, rather than driving a real billing failure through a live run.
  const setDepleted = (o: Orchestrator, key: string, reason: string, at: number) =>
    (o as unknown as { depletedKeys: Map<string, { reason: string; at: number }> }).depletedKeys.set(key, { reason, at });

  it("returns nothing when no key is depleted", () => {
    expect(orch.listDepletedKeys(WS)).toEqual([]);
  });

  it("lists a depleted key with its credential id, reason, and timestamp", () => {
    setDepleted(orch, `${WS}:claude`, "quota exceeded", 1_000);
    expect(orch.listDepletedKeys(WS)).toEqual([{ credentialId: "claude", reason: "quota exceeded", at: 1_000 }]);
  });

  it("lists every depleted key for the workspace, not just the first", () => {
    setDepleted(orch, `${WS}:claude`, "quota exceeded", 1_000);
    setDepleted(orch, `${WS}:cred-openai-abc123`, "insufficient credit", 2_000);
    const listed = orch.listDepletedKeys(WS);
    expect(listed).toHaveLength(2);
    expect(listed.map((k) => k.credentialId).sort()).toEqual(["claude", "cred-openai-abc123"]);
  });

  it("never leaks another workspace's depleted key", () => {
    setDepleted(orch, `${WS}:claude`, "quota exceeded", 1_000);
    setDepleted(orch, "other-workspace:claude", "quota exceeded", 1_000);
    expect(orch.listDepletedKeys(WS)).toHaveLength(1);
    expect(orch.listDepletedKeys("other-workspace")).toHaveLength(1);
  });

  it("Operations.listDepletedKeys is a thin passthrough to the orchestrator", () => {
    setDepleted(orch, `${WS}:claude`, "quota exceeded", 1_000);
    expect(ops.listDepletedKeys(WS)).toEqual(orch.listDepletedKeys(WS));
  });
});
