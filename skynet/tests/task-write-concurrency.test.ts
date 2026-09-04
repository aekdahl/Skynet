// Regression test for a live incident (2026-08): a batch task-update lost
// `description` on 7 tasks, and manual recovery of one of them
// (t-skynet-mt0ebjfq-10) raced against the autonomous triage step writing the
// SAME task concurrently — triage's write (built the same way every Task
// write in this codebase was: fetch, spread `{...current, ...patch}`, write
// the whole record back, no version check) silently clobbered the recovery.
//
// Store.putTask now takes an optional `expectedVersion` and does a real
// compare-and-swap (throws VersionConflictError on a stale write); Hub's new
// patchTask is the one place every caller now goes through — it reads
// fresh, applies a patch (object or a function of the fresh read), CAS-writes,
// and transparently retries on a version conflict. This file proves the race
// from the incident is actually closed, not just that the primitive exists.
import { describe, it, expect } from "vitest";
import { DEFAULT_WORKSPACE } from "@skynet/shared";
import type { Task } from "@skynet/shared";
import { Hub } from "../apps/server/src/hub.js";
import { MemoryStore } from "../apps/server/src/store/memory.js";
import { VersionConflictError } from "../apps/server/src/store/store.js";
import type { Bus } from "../apps/server/src/bus.js";

class NullBus implements Bus {
  publish(): void {}
  subscribe(): () => void {
    return () => {};
  }
}

/** MemoryStore whose putTask can be delayed per call, so a write "issued"
 *  first can be made to land AFTER one issued later — the exact shape of a
 *  real race between two concurrent request handlers, reproduced
 *  deterministically (mirrors tests/hub-run-lock.test.ts's DelayedStore). */
class DelayedStore extends MemoryStore {
  putDelaysMs: number[] = [];
  private putCalls = 0;
  async putTask(task: Task, expectedVersion?: number) {
    const delay = this.putDelaysMs[this.putCalls] ?? 0;
    this.putCalls++;
    if (delay > 0) await new Promise((r) => setTimeout(r, delay));
    return super.putTask(task, expectedVersion);
  }
  resetPutCounter(): void {
    this.putCalls = 0;
  }
}

const baseTask = (over: Partial<Task> = {}): Task => ({
  id: "t1",
  workspaceId: DEFAULT_WORKSPACE,
  projectId: "p1",
  version: 1,
  text: "fix the thing",
  description: "original description",
  state: "backlog",
  runId: null,
  autoPick: false,
  assessment: null,
  assessmentEffort: null,
  assessmentRisks: [],
  clarification: null,
  reviewVerdict: null,
  assignment: { mode: "unassigned", agentIds: [] },
  order: 0,
  archived: false,
  estimatedDurationMs: null,
  plannedStartAt: null,
  featureId: null,
  milestoneId: null,
  source: null,
  dependsOnTaskIds: [],
  parentTaskId: null,
  priority: null,
  lint: null,
  preferredProvider: null,
  preferredModel: null,
  ...over,
});

describe("Store.putTask — compare-and-swap", () => {
  it("rejects a write against a stale expectedVersion instead of silently applying it", async () => {
    const store = new MemoryStore({ seed: false });
    await store.putTask(baseTask());
    const stale = await store.getTask("t1");
    // Someone else writes first — version moves from 1 to 2.
    await store.putTask({ ...stale!, text: "someone else's edit" }, 1);
    // The caller's own copy is now stale (still thinks version 1).
    await expect(store.putTask({ ...stale!, text: "my edit" }, 1)).rejects.toThrow(VersionConflictError);
    // The rejected write left no trace — the other writer's edit stands.
    expect((await store.getTask("t1"))?.text).toBe("someone else's edit");
  });

  it("bumps version on every successful write, and an unguarded write (no expectedVersion) never resets it", async () => {
    const store = new MemoryStore({ seed: false });
    const t1 = await store.putTask(baseTask());
    expect(t1.version).toBe(1);
    const t2 = await store.putTask({ ...t1, text: "v2" }, 1);
    expect(t2.version).toBe(2);
    const t3 = await store.putTask({ ...t2, text: "v3" }); // no CAS check
    expect(t3.version).toBe(3);
  });
});

describe("Hub.patchTask — the incident, reproduced", () => {
  it("a recovery write and a concurrent autonomous (triage-shaped) write on the SAME task both survive — neither clobbers the other's field", async () => {
    const store = new DelayedStore();
    const hub = new Hub(store, new NullBus());
    await store.putTask(baseTask({ description: "CORRUPTED — needs recovery" }));
    store.resetPutCounter();

    // Recovery (a human/scripted fix, restoring `description`) is issued
    // first but its underlying store write is slow — exactly the shape of
    // the incident: triage's write landed while recovery's own write was
    // still in flight. Triage (setting `state`+`assessment`, the
    // "autonomous writer" from the incident) is issued right after, with an
    // instant store write.
    store.putDelaysMs = [50, 0];
    const [recovered, triaged] = await Promise.all([
      hub.patchTask("t1", { description: "restored by an operator" }),
      hub.patchTask("t1", { state: "todo", assessment: "small, clear" }),
    ]);

    // Triage's own write lands FIRST here (its store call is the fast one),
    // so ITS return value correctly reflects state as of THAT moment — it
    // never saw recovery's field, because recovery genuinely hadn't landed
    // yet. That's correct CAS semantics, not a bug: a caller's return value
    // is "as of my own write", not omniscient about writes that land later.
    expect(triaged?.state).toBe("todo");
    expect(triaged?.assessment).toBe("small, clear");
    // Recovery's write raced onto a stale version (triage moved it first),
    // got VersionConflictError, and transparently retried — re-reading
    // fresh (now carrying triage's fields) and reapplying ITS OWN patch on
    // top. Its return value proves the retry actually happened and merged
    // correctly, not that it clobbered triage's write to land.
    expect(recovered?.description).toBe("restored by an operator");
    expect(recovered?.state).toBe("todo");
    expect(recovered?.assessment).toBe("small, clear");

    // The one invariant that actually matters regardless of interleaving
    // order: the store's FINAL record carries BOTH fields. This is the
    // actual regression — the old `{...task, ...patch}` full-object
    // overwrite would have had whichever write landed LAST in the store
    // silently discard the other's field, even though both were issued (and
    // individually awaited/returned) validly.
    const final = await store.getTask("t1");
    expect(final?.description).toBe("restored by an operator");
    expect(final?.state).toBe("todo");
    expect(final?.assessment).toBe("small, clear");
  });

  it("a guard-function patch re-evaluates against the truly-current value on a version-conflict retry, not the snapshot it started with", async () => {
    const store = new DelayedStore();
    const hub = new Hub(store, new NullBus());
    await store.putTask(baseTask({ state: "review" }));
    store.resetPutCounter();

    // Call A: "only mark done if still in review" — issued first, slow write.
    // Call B: moves the task OUT of review first, fast write, lands before A.
    store.putDelaysMs = [50, 0];
    const [markedDone, movedToTodo] = await Promise.all([
      hub.patchTask("t1", (t) => (t.state === "review" ? { state: "done" } : null)),
      hub.patchTask("t1", { state: "todo", runId: null, reviewVerdict: null }),
    ]);

    // B's write lands first (fast). A retries after the conflict, re-reads,
    // finds state is now "todo" (not "review"), and its guard correctly
    // declines — it must NOT blindly reapply "done" against a stale
    // snapshot that still said "review".
    expect(movedToTodo?.state).toBe("todo");
    expect(markedDone?.state).toBe("todo"); // guard declined — task stayed where B left it

    const final = await store.getTask("t1");
    expect(final?.state).toBe("todo");
  });

  it("retries a genuine version conflict up to maxRetries, then gives up loudly rather than silently dropping the write", async () => {
    const store = new MemoryStore({ seed: false });
    await store.putTask(baseTask());
    const hub = new Hub(store, new NullBus());

    // A patch function whose OWN side effect writes a competing update on
    // every invocation — guaranteed to re-collide on every retry attempt,
    // so patchTask exhausts its retry budget rather than eventually landing.
    let attempts = 0;
    await expect(
      hub.patchTask(
        "t1",
        (t) => {
          attempts++;
          void store.putTask({ ...t, text: `interloper ${attempts}` }); // fire-and-forget collision
          return { text: "the patch under test" };
        },
        { maxRetries: 2 },
      ),
    ).rejects.toThrow(VersionConflictError);
    expect(attempts).toBe(3); // the initial attempt + 2 retries
  });
});
