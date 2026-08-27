// The autonomy tick is TASK-scoped — triage one, pick one, review one. It keeps
// individual tasks moving but never asks the project-level question, so a
// project with an empty backlog, two items stuck in triage and nothing merged
// for days looks exactly like a healthy idle one. This is that question.
//
// Every case here is a state an operator would otherwise have to reconstruct by
// hand from the board, and the ORDER matters: the wrong diagnosis sends someone
// to fix the wrong thing.
import { describe, it, expect } from "vitest";
import type { Agent, Task, TaskRun } from "@skynet/shared";
import { assessProjectDrive, driveNeedsAttention, type DriveInput } from "../apps/server/src/drive.js";

const task = (state: Task["state"], id = state + Math.random()): Task =>
  ({ id, workspaceId: "w", projectId: "p", text: id, state, runId: null }) as Task;
const runner = (status: Agent["status"], usable = true) => ({ agent: { id: "a", status } as Agent, usable });
const run = () => ({ id: "r", status: "running" }) as TaskRun;

const input = (over: Partial<DriveInput>): DriveInput => ({
  project: { id: "p", name: "P", status: "active", autonomy: true },
  tasks: [],
  liveRuns: [],
  runners: [runner("idle")],
  ...over,
});

describe("healthy states stay quiet", () => {
  it("work in flight outranks every other observation", () => {
    // The project IS progressing. Complaining about anything else here would be
    // noise, and a driver that cries wolf gets muted.
    const a = assessProjectDrive(input({ liveRuns: [run()], tasks: [task("triage")], runners: [runner("busy")] }));
    expect(a.state).toBe("working");
    expect(driveNeedsAttention(a)).toBe(false);
  });

  it("everything done is done, not 'empty'", () => {
    const a = assessProjectDrive(input({ tasks: [task("done"), task("done")] }));
    expect(a.state).toBe("done");
    expect(driveNeedsAttention(a)).toBe(false);
  });

  it("ready work with free capacity is just… about to happen", () => {
    expect(assessProjectDrive(input({ tasks: [task("todo")] })).state).toBe("working");
  });
});

describe("it names the SPECIFIC thing in the way", () => {
  it("a review waiting on a human outranks a capacity complaint", () => {
    // The human is the bottleneck. Reporting "no capacity" would send someone
    // to add runners that wouldn't help.
    const a = assessProjectDrive(input({ tasks: [task("review")], runners: [runner("busy")] }));
    expect(a.state).toBe("needs_review");
  });

  it("distinguishes 'no runners can run' from 'runners are busy'", () => {
    // A runner on a paused key is configured but cannot work. Conflating the
    // two tells an operator to free capacity that was never the problem.
    const benched = assessProjectDrive(input({ tasks: [task("todo")], runners: [runner("idle", false)] }));
    expect(benched.state).toBe("no_runners");
    expect(benched.detail).toMatch(/paused or missing/);

    const busy = assessProjectDrive(input({ tasks: [task("todo")], runners: [runner("busy")] }));
    expect(busy.state).toBe("no_capacity");
  });

  it("says when autonomy is the only thing stopping ready work", () => {
    const a = assessProjectDrive(input({
      project: { id: "p", name: "P", status: "active", autonomy: false },
      tasks: [task("todo")],
    }));
    expect(a.state).toBe("autonomy_off");
    expect(a.detail).toMatch(/autonomy is off/);
  });

  it("reports triage when tasks exist but none came out clear", () => {
    const a = assessProjectDrive(input({ tasks: [task("triage"), task("triage")] }));
    expect(a.state).toBe("needs_triage");
    expect(a.detail).toMatch(/parked in triage/);
  });

  it("no runners configured at all reads differently from benched ones", () => {
    const a = assessProjectDrive(input({ tasks: [task("todo")], runners: [] }));
    expect(a.state).toBe("no_runners");
    expect(a.detail).toMatch(/no runners are configured/);
  });
});

describe("refilling from a source", () => {
  it("asks for a refill when the board is empty AND a source is bound", () => {
    const a = assessProjectDrive(input({
      project: { id: "p", name: "P", status: "active", autonomy: true, repo: "acme/x", syncSourceStatus: true },
    }));
    expect(a.state).toBe("empty");
    expect(a.refillFromSource).toBe(true);
  });

  it("does NOT ask when no source is connected — there's nothing to pull from", () => {
    const a = assessProjectDrive(input({}));
    expect(a.state).toBe("empty");
    expect(a.refillFromSource).toBe(false);
    expect(a.detail).toMatch(/connect a source/);
  });

  it("does not ask when sync is off, even with a repo bound", () => {
    const a = assessProjectDrive(input({
      project: { id: "p", name: "P", status: "active", autonomy: true, repo: "acme/x", syncSourceStatus: false },
    }));
    expect(a.refillFromSource).toBe(false);
  });

  it("also refills when everything is stuck in the backlog, not just when empty", () => {
    // "Nothing ready" and "nothing at all" are the same problem to an operator:
    // no work is startable. Both are worth re-checking the source for.
    const a = assessProjectDrive(input({
      project: { id: "p", name: "P", status: "active", autonomy: true, repo: "acme/x", syncSourceStatus: true },
      tasks: [task("backlog")],
    }));
    expect(a.state).toBe("empty");
    expect(a.refillFromSource).toBe(true);
  });
});

describe("every unhealthy state asks for attention", () => {
  it("and every healthy one doesn't", () => {
    const unhealthy: DriveInput[] = [
      input({ tasks: [task("triage")] }),
      input({ tasks: [task("review")], runners: [runner("busy")] }),
      input({ tasks: [task("todo")], runners: [runner("busy")] }),
      input({ tasks: [task("todo")], runners: [] }),
      input({ project: { id: "p", name: "P", status: "active", autonomy: false }, tasks: [task("todo")] }),
      input({}),
    ];
    for (const i of unhealthy) expect(driveNeedsAttention(assessProjectDrive(i)), assessProjectDrive(i).state).toBe(true);
  });
});

// ─── through a real tick ────────────────────────────────────────────────────
// The pure assessment above is worthless if the tick never writes it, or writes
// it so often the record churns. Both are load-bearing.
import { beforeEach } from "vitest";
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

describe("the tick writes the driver state", () => {
  let store: MemoryStore;
  let orch: Orchestrator;
  let ops: Operations;

  beforeEach(() => {
    store = new MemoryStore();
    const hub = new Hub(store, new NullBus());
    orch = new Orchestrator(store, hub);
    ops = new Operations({ store, hub, orchestrator: orch });
  });

  const drive = async (id: string) => (await store.getProject(id))?.drive ?? null;

  it("starts null and is filled in by the first pass", async () => {
    const p = await ops.createProject(DEFAULT_WORKSPACE, { name: "p", goal: "g" });
    expect(p.drive).toBeNull();

    await (orch as unknown as { updateDriveStates: (w: string, ps: unknown[], t: unknown[]) => Promise<void> })
      .updateDriveStates(DEFAULT_WORKSPACE, [await store.getProject(p.id)!], []);

    const d = await drive(p.id);
    expect(d?.state).toBe("empty");
    expect(d?.detail).toMatch(/No tasks yet/);
  });

  it("does NOT rewrite the record when the answer hasn't changed", async () => {
    // It's a state an operator reads, not a log. Re-writing "no capacity" every
    // tick would churn the record and the websocket for no new information.
    const p = await ops.createProject(DEFAULT_WORKSPACE, { name: "p", goal: "g" });
    const step = async () =>
      (orch as unknown as { updateDriveStates: (w: string, ps: unknown[], t: unknown[]) => Promise<void> })
        .updateDriveStates(DEFAULT_WORKSPACE, [await store.getProject(p.id)!], []);

    await step();
    const first = await drive(p.id);
    await step();
    expect((await drive(p.id))?.at).toBe(first?.at);
  });

  it("updates when the answer genuinely changes", async () => {
    const p = await ops.createProject(DEFAULT_WORKSPACE, { name: "p", goal: "g" });
    const step = async () =>
      (orch as unknown as { updateDriveStates: (w: string, ps: unknown[], t: unknown[]) => Promise<void> })
        .updateDriveStates(DEFAULT_WORKSPACE, [await store.getProject(p.id)!], await store.listTasks(DEFAULT_WORKSPACE));

    await step();
    expect((await drive(p.id))?.state).toBe("empty");

    const t = await ops.createTask(DEFAULT_WORKSPACE, p.id, { text: "do a thing" });
    await ops.updateTask(DEFAULT_WORKSPACE, t.id, { state: "todo" });
    await step();
    // Ready work, but this workspace has no runners configured at all.
    expect((await drive(p.id))?.state).toBe("no_runners");
  });
});
