// Regression test for the "every ongoing card stuck on 'starting…'" bug: Hub's
// run-row mutators (runProgress, runHeartbeat, ...) are each an unlocked
// read-modify-write (getRun → spread → putRun). orchestrator.ts's events()
// fires several of them concurrently and unawaited for the same run (a 5s
// heartbeat timer, per-tool-call progress updates, usage/status changes). On a
// real network store, two overlapping writes can complete out of order: a
// stale write (e.g. progress still carrying `plan: []` from before the
// agent's first TodoWrite) can land AFTER a later, correct plan write and
// silently clobber it back to empty. hub.ts now serializes every run-row
// mutator per runId (withRunLock, mirroring the pre-existing hitlLocks
// pattern) so the final state always reflects the last-ISSUED call, never
// whichever happened to finish last in the store.
import { describe, it, expect } from "vitest";
import { DEFAULT_WORKSPACE } from "@skynet/shared";
import type { TaskRun } from "@skynet/shared";
import { Hub } from "../apps/server/src/hub.js";
import { MemoryStore } from "../apps/server/src/store/memory.js";
import type { Bus } from "../apps/server/src/bus.js";

class NullBus implements Bus {
  publish(): void {}
  subscribe(): () => void {
    return () => {};
  }
}

/** MemoryStore whose putRun can be delayed per call, so a mutator "issued"
 *  first can be made to finish its write AFTER one issued later — the exact
 *  shape of the real Postgres race, reproduced deterministically. */
class DelayedStore extends MemoryStore {
  putDelaysMs: number[] = [];
  private putCalls = 0;
  async putRun(run: TaskRun) {
    const delay = this.putDelaysMs[this.putCalls] ?? 0;
    this.putCalls++;
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));
    return super.putRun(run);
  }
  /** Seed calls go through putRun too (it's the only write path) and would
   *  otherwise shift every later index off by one — reset once seeding is done. */
  resetPutCounter(): void {
    this.putCalls = 0;
  }
}

const baseRun = (): TaskRun => ({
  id: "r1",
  workspaceId: DEFAULT_WORKSPACE,
  projectId: "p1",
  name: "do the thing",
  status: "running",
  agentId: "a1",
  provider: "claude",
  credentialId: null,
  model: "opus-4.8",
  branch: "agent/r1",
  modules: [],
  progress: 0,
  plan: [],
  usage: null,
  modifiedFiles: [],
  log: [],
  startedAt: Date.now(),
  lastHeartbeatAt: Date.now(),
  visual: false,
  previewUrl: null,
  dependsOn: [],
  parentId: null,
  branchFromStep: null,
  archived: false,
  pr: null,
  mergedAt: null,
  flyDeployment: null,
});

describe("Hub run-row locking", () => {
  it("a stale progress write issued first never clobbers a fresher one issued after it, even if its store write lands late", async () => {
    const store = new DelayedStore();
    const hub = new Hub(store, new NullBus());
    await store.putRun(baseRun());
    store.resetPutCounter();

    // Call A ("stale", empty plan — the pre-TodoWrite bump()) is issued first,
    // but its underlying putRun is slow. Call B (the real TodoWrite-derived
    // plan) is issued right after, with an instant putRun. Without the lock,
    // B's getRun could read the row before A has written, then B's fast write
    // could land, and A's slow write could land AFTER — clobbering B's plan
    // back to empty. With the lock, B cannot even start its getRun until A's
    // entire mutation (including the slow write) has completed.
    store.putDelaysMs = [50, 0];
    await Promise.all([
      hub.runProgress("r1", 0.1, []),
      hub.runProgress("r1", 0.4, [{ text: "writing the fix", state: "now" }]),
    ]);

    const final = await store.getRun("r1");
    expect(final?.plan).toEqual([{ text: "writing the fix", state: "now" }]);
    expect(final?.progress).toBe(0.4);
  });

  it("a heartbeat and a progress update racing the same run never lose each other's field", async () => {
    const store = new DelayedStore();
    const hub = new Hub(store, new NullBus());
    await store.putRun(baseRun());
    store.resetPutCounter();

    store.putDelaysMs = [50, 0];
    const plan = [{ text: "writing the fix", state: "now" as const }];
    await Promise.all([hub.runHeartbeat("r1"), hub.runProgress("r1", 0.4, plan)]);

    const final = await store.getRun("r1");
    // Both fields must survive — neither mutator's read-modify-write may have
    // been based on a snapshot that predates the other's write.
    expect(final?.plan).toEqual(plan);
    expect(final?.progress).toBe(0.4);
    expect(final?.lastHeartbeatAt).toBeGreaterThan(0);
  });
});
