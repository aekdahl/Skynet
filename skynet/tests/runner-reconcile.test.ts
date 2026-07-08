// An "orphaned busy" runner — persisted busy but held by no live agent (a
// restart empties the in-memory live map while the store still says busy) —
// must be reclaimable. reconcileRunners() resets it to idle at boot, and the
// retire guard keys on the LIVE map (isBusy), so such a runner is removable.
import { describe, it, expect } from "vitest";
import { DEFAULT_WORKSPACE, type Runner, type ServerEvent } from "@skynet/shared";
import { Hub } from "../apps/server/src/hub.js";
import { Orchestrator } from "../apps/server/src/orchestrator.js";
import { MemoryStore } from "../apps/server/src/store/memory.js";
import type { Bus } from "../apps/server/src/bus.js";

class NullBus implements Bus {
  events: ServerEvent[] = [];
  publish(_ws: string, ev: ServerEvent) { this.events.push(ev); }
  subscribe() { return () => undefined; }
}

const busyRunner = (id: string): Runner => ({
  id, workspaceId: DEFAULT_WORKSPACE, name: id, provider: "claude", model: "opus-4.8",
  status: "busy", idleSince: null,
});

describe("orphaned busy runner", () => {
  it("is not counted busy when no live agent holds it", async () => {
    const store = new MemoryStore();
    const orch = new Orchestrator(store, new Hub(store, new NullBus()));
    await store.putRunner(busyRunner("r-orphan"));
    // Nothing is live → the runner is not actually executing.
    expect(orch.isBusy("r-orphan")).toBe(false);
  });

  it("reconcileRunners() resets it to idle", async () => {
    const store = new MemoryStore();
    const orch = new Orchestrator(store, new Hub(store, new NullBus()));
    await store.putRunner(busyRunner("r-orphan"));

    await orch.reconcileRunners();

    const after = await store.getRunner("r-orphan");
    expect(after?.status).toBe("idle");
    expect(after?.idleSince).not.toBeNull();
  });

  it("leaves an already-idle runner untouched", async () => {
    const store = new MemoryStore();
    const orch = new Orchestrator(store, new Hub(store, new NullBus()));
    const idle: Runner = { ...busyRunner("r-idle"), status: "idle", idleSince: 123 };
    await store.putRunner(idle);

    await orch.reconcileRunners();

    const after = await store.getRunner("r-idle");
    expect(after?.status).toBe("idle");
    expect(after?.idleSince).toBe(123); // not rewritten
  });
});
