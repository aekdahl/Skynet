// `inform` — a third interaction type alongside chat (a real extra turn) and
// resolve (a HITL decision): select a set of runs (explicit ids, a whole
// project's live runs, or both) and attach a note that rides each one's NEXT
// prompt — no extra turn of its own, no reply expected, never routed through a
// HITL gate (see ROADMAP.md "Mass inform"). This exercises the Orchestrator/
// Operations wiring against a real store + hub; the SDK-level delivery
// mechanics (Claude's shouldQuery:false, the CLI buffer+prepend) are covered
// in claude-inform.test.ts and cli-inform.test.ts.
import { describe, it, expect, beforeEach } from "vitest";
import type { ProviderId, Agent, Project, Task, ServerEvent } from "@skynet/shared";
import { DEFAULT_WORKSPACE } from "@skynet/shared";
import { Hub } from "../apps/server/src/hub.js";
import { Orchestrator } from "../apps/server/src/orchestrator.js";
import { NotFoundError, Operations } from "../apps/server/src/operations.js";
import { MemoryStore } from "../apps/server/src/store/memory.js";
import type { Bus } from "../apps/server/src/bus.js";
import type { RunnerEvents, RunnerHandle, RunnerProvider, StartSpec } from "@skynet/runner-sdk";

class NullBus implements Bus {
  events: ServerEvent[] = [];
  publish(_ws: string, event: ServerEvent): void {
    this.events.push(event);
  }
  subscribe(): () => void {
    return () => {};
  }
}

/** A quiet, always-running provider whose handles record every `inform()`
 *  call — (runId, text) pairs — so a test can assert exactly which run got
 *  which note, with no cross-contamination. */
class RecordingProvider implements RunnerProvider {
  readonly id: ProviderId = "claude";
  informCalls: Array<{ runId: string; text: string }> = [];
  async start(spec: StartSpec, _events: RunnerEvents): Promise<RunnerHandle> {
    const runId = spec.runId;
    return {
      runId,
      provider: this.id,
      async pause() {},
      async resume() {},
      async message() {},
      async stop() {},
      inform: async (text: string) => {
        this.informCalls.push({ runId, text });
      },
    };
  }
}

const mkProject = (id: string): Project => ({
  id, workspaceId: DEFAULT_WORKSPACE, name: id, goal: "", runIds: [], status: "active",
});
const mkAgent = (id: string): Agent => ({
  id, workspaceId: DEFAULT_WORKSPACE, name: id, provider: "claude", model: "opus-4.8", status: "idle", idleSince: 0,
});
const mkTask = (id: string, projectId: string): Task => ({
  id, workspaceId: DEFAULT_WORKSPACE, projectId, text: `do ${id}`, state: "backlog", runId: null,
});

describe("Orchestrator.inform", () => {
  let store: MemoryStore;
  let hub: Hub;
  let provider: RecordingProvider;
  let orchestrator: Orchestrator;

  beforeEach(async () => {
    store = new MemoryStore();
    hub = new Hub(store, new NullBus());
    provider = new RecordingProvider();
    orchestrator = new Orchestrator(store, hub, provider);
    await store.putProject(mkProject("p1"));
    await store.putAgent(mkAgent("r1"));
    await store.putTask(mkTask("t1", "p1"));
  });

  it("queues a note on a live run's handle and logs it, without touching the run's status", async () => {
    const run = await orchestrator.assignTask("p1", "t1");
    const before = (await store.getRun(run.id))!.status;

    const delivered = await orchestrator.inform(run.id, "heads up: auth moved");

    expect(delivered).toEqual({ ok: true });
    expect(provider.informCalls).toEqual([{ runId: run.id, text: "heads up: auth moved" }]);
    // inform is not a turn and not a HITL gate — the run's own status is untouched.
    expect((await store.getRun(run.id))!.status).toBe(before);
    const log = (await store.getRun(run.id))!.log.map((l) => l.line);
    expect(log.some((l) => l.includes("queued for the next turn") && l.includes("heads up: auth moved"))).toBe(true);
  });

  it("a run with no live session reports not-delivered (never fakes success)", async () => {
    const delivered = await orchestrator.inform("no-such-run", "hello?");
    expect(delivered).toEqual({ ok: false, reason: "not-live" });
    const log = (await store.getRun("no-such-run").catch(() => undefined))?.log ?? [];
    expect(log.length).toBe(0); // nothing to attach a log to — the run doesn't exist
  });

  it("a live run whose provider doesn't implement inform() is honestly skipped WITH a distinct reason, not lumped in with 'not live'", async () => {
    // `inform` is an OPTIONAL RunnerHandle member — a bare provider (like the
    // mock/quiet ones other suites use) simply never attaches it.
    const bareProvider: RunnerProvider = {
      id: "claude",
      async start(spec) {
        return {
          runId: spec.runId, provider: "claude",
          async pause() {}, async resume() {}, async message() {}, async stop() {},
        };
      },
    };
    const bareStore = new MemoryStore();
    const bareHub = new Hub(bareStore, new NullBus());
    const bareOrch = new Orchestrator(bareStore, bareHub, bareProvider);
    await bareStore.putProject(mkProject("p1"));
    await bareStore.putAgent(mkAgent("r1"));
    await bareStore.putTask(mkTask("t1", "p1"));

    const run = await bareOrch.assignTask("p1", "t1");
    const delivered = await bareOrch.inform(run.id, "note");

    expect(delivered).toEqual({ ok: false, reason: "unsupported", provider: "claude" });
    const log = (await bareStore.getRun(run.id))!.log.map((l) => l.line);
    expect(log.some((l) => l.includes("not delivered") && l.includes("note"))).toBe(true);
  });

  it("liveRunIdsForProject resolves only THIS project's live runs, not another's", async () => {
    await store.putProject(mkProject("p2"));
    await store.putAgent(mkAgent("r2"));
    await store.putTask(mkTask("t2", "p2"));
    const runA = await orchestrator.assignTask("p1", "t1");
    const runB = await orchestrator.assignTask("p2", "t2");

    expect(await orchestrator.liveRunIdsForProject("p1")).toEqual([runA.id]);
    expect(await orchestrator.liveRunIdsForProject("p2")).toEqual([runB.id]);
  });
});

describe("Operations.informRuns", () => {
  let store: MemoryStore;
  let hub: Hub;
  let provider: RecordingProvider;
  let orchestrator: Orchestrator;
  let ops: Operations;

  beforeEach(async () => {
    store = new MemoryStore();
    hub = new Hub(store, new NullBus());
    provider = new RecordingProvider();
    orchestrator = new Orchestrator(store, hub, provider);
    ops = new Operations({ store, hub, orchestrator });
    await store.putProject(mkProject("p1"));
    await store.putProject(mkProject("p2"));
    await store.putAgent(mkAgent("r1"));
    await store.putAgent(mkAgent("r2"));
    await store.putAgent(mkAgent("r3"));
    await store.putTask(mkTask("t1", "p1"));
    await store.putTask(mkTask("t2", "p1"));
    await store.putTask(mkTask("t3", "p2"));
  });

  it("multiple explicit run ids each get their OWN note — no cross-contamination", async () => {
    const runA = await orchestrator.assignTask("p1", "t1");
    const runB = await orchestrator.assignTask("p1", "t2");

    const result = await ops.informRuns(DEFAULT_WORKSPACE, {
      note: "shared note for both",
      runIds: [runA.id, runB.id],
    });

    expect(new Set(result.informed)).toEqual(new Set([runA.id, runB.id]));
    expect(result.skipped).toEqual([]);
    expect(provider.informCalls).toContainEqual({ runId: runA.id, text: "shared note for both" });
    expect(provider.informCalls).toContainEqual({ runId: runB.id, text: "shared note for both" });
    expect(provider.informCalls.length).toBe(2);
  });

  it("a run with no live session is reported as skipped, not thrown", async () => {
    const runA = await orchestrator.assignTask("p1", "t1");
    const result = await ops.informRuns(DEFAULT_WORKSPACE, {
      note: "note",
      runIds: [runA.id, "not-a-real-run"],
    });
    expect(result.informed).toEqual([runA.id]);
    expect(result.skipped).toEqual([{ runId: "not-a-real-run", reason: "not found" }]);
  });

  it("a live run whose provider doesn't support inform gets a DIFFERENT skip reason than a not-live run — the operator can tell them apart", async () => {
    const bareProvider: RunnerProvider = {
      id: "claude",
      async start(spec) {
        return {
          runId: spec.runId, provider: "claude",
          async pause() {}, async resume() {}, async message() {}, async stop() {},
        };
      },
    };
    const bareStore = new MemoryStore();
    const bareHub = new Hub(bareStore, new NullBus());
    const bareOrch = new Orchestrator(bareStore, bareHub, bareProvider);
    const bareOps = new Operations({ store: bareStore, hub: bareHub, orchestrator: bareOrch });
    await bareStore.putProject(mkProject("p1"));
    await bareStore.putAgent(mkAgent("r1"));
    await bareStore.putTask(mkTask("t1", "p1"));
    const run = await bareOrch.assignTask("p1", "t1");

    const result = await bareOps.informRuns(DEFAULT_WORKSPACE, { note: "note", runIds: [run.id] });

    expect(result.informed).toEqual([]);
    expect(result.skipped).toEqual([{ runId: run.id, reason: "claude doesn't support inform yet" }]);
  });

  it("projectId targets only that project's live runs, not the whole workspace", async () => {
    const runA = await orchestrator.assignTask("p1", "t1");
    const runB = await orchestrator.assignTask("p1", "t2");
    const runC = await orchestrator.assignTask("p2", "t3");

    const result = await ops.informRuns(DEFAULT_WORKSPACE, { note: "project-wide note", projectId: "p1" });

    expect(new Set(result.informed)).toEqual(new Set([runA.id, runB.id]));
    expect(provider.informCalls.some((c) => c.runId === runC.id)).toBe(false);
  });

  it("runIds and projectId union without delivering the note twice to an overlapping run", async () => {
    const runA = await orchestrator.assignTask("p1", "t1");
    const runB = await orchestrator.assignTask("p1", "t2");

    const result = await ops.informRuns(DEFAULT_WORKSPACE, {
      note: "note",
      runIds: [runA.id], // also a member of p1's live set
      projectId: "p1",
    });

    expect(new Set(result.informed)).toEqual(new Set([runA.id, runB.id]));
    // runA appears exactly once in the delivered calls, not twice.
    expect(provider.informCalls.filter((c) => c.runId === runA.id).length).toBe(1);
  });

  it("throws when there's nothing to inform (no ids, no live runs in the project)", async () => {
    await expect(ops.informRuns(DEFAULT_WORKSPACE, { note: "note" })).rejects.toThrow(/no runs to inform/i);
    // p2 exists but has no live runs yet.
    await expect(ops.informRuns(DEFAULT_WORKSPACE, { note: "note", projectId: "p2" })).rejects.toThrow(/no runs to inform/i);
  });

  it("rejects an unknown/cross-workspace project id (404)", async () => {
    await expect(ops.informRuns(DEFAULT_WORKSPACE, { note: "note", projectId: "no-such-project" })).rejects.toBeInstanceOf(
      NotFoundError,
    );
  });

  it("rejects empty note text", async () => {
    const runA = await orchestrator.assignTask("p1", "t1");
    await expect(ops.informRuns(DEFAULT_WORKSPACE, { note: "   ", runIds: [runA.id] })).rejects.toThrow(/note text/i);
  });
});
