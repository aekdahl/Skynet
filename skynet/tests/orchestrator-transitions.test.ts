// Momentum Rollout Phase 1b — the orchestrator's OWN autonomous task moves
// (tickAutonomy's triage auto-promote and auto-pick) write Transition
// records too, actor:"machine" + ruleId:null, so the Transition log is a
// single source of truth for "what moved and why" regardless of whether the
// rule engine or the orchestrator itself made the move. Same lightweight
// chat-only harness as autonomy.test.ts (no real git needed).
import { describe, it, expect } from "vitest";
import type { Agent, Project, Task, ServerEvent } from "@skynet/shared";
import { DEFAULT_WORKSPACE } from "@skynet/shared";
import { Hub } from "../apps/server/src/hub.js";
import { Orchestrator } from "../apps/server/src/orchestrator.js";
import { MemoryStore } from "../apps/server/src/store/memory.js";
import type { Bus } from "../apps/server/src/bus.js";
import type { RunnerEvents, RunnerHandle, RunnerProvider, StartSpec } from "@skynet/runner-sdk";

class NullBus implements Bus {
  publish(_ws: string, _e: ServerEvent): void {}
  subscribe(): () => void { return () => {}; }
}

class AutoProvider implements RunnerProvider {
  readonly id = "claude" as const;
  constructor(private reply = "ok") {}
  async start(spec: StartSpec, _e: RunnerEvents): Promise<RunnerHandle> {
    return { runId: spec.runId, provider: this.id, async pause() {}, async resume() {}, async message() {}, async stop() {} };
  }
  async consult(): Promise<string> { return this.reply; }
}

const project: Project = {
  id: "p1", workspaceId: DEFAULT_WORKSPACE, name: "P", goal: "", runIds: [],
  status: "active", autonomy: true, repoPath: null, gitBacked: false,
};
const idleAgent: Agent = {
  id: "a1", workspaceId: DEFAULT_WORKSPACE, name: "a1", provider: "claude",
  model: "opus-4.8", status: "idle", idleSince: 0,
};
const mkTask = (over: Partial<Task>): Task => ({
  id: "t1", workspaceId: DEFAULT_WORKSPACE, projectId: "p1", text: "do X", state: "backlog",
  runId: null, autoPick: false, assessment: null, reviewVerdict: null, lint: null,
  assignment: { mode: "any", agentIds: [] }, ...over,
});

const setup = async (reply?: string) => {
  const store = new MemoryStore();
  const hub = new Hub(store, new NullBus());
  const provider = new AutoProvider(reply);
  const orch = new Orchestrator(store, hub, provider);
  await store.putProject(project);
  await store.putAgent(idleAgent);
  return { store, orch };
};

describe("orchestrator's own autonomous moves write machine Transitions", () => {
  it("triage auto-promote (backlog → todo) writes a Transition — actor:machine, ruleId:null", async () => {
    const { store, orch } = await setup('Clear scope.\n{"estMinutes":15,"clarity":"clear"}');
    await store.putTask(mkTask({ state: "backlog" }));
    await orch.tickAutonomy();
    expect((await store.getTask("t1"))?.state).toBe("todo");

    const transitions = await store.listTransitionsForTask("t1");
    expect(transitions).toHaveLength(1);
    expect(transitions[0]).toMatchObject({ from: "backlog", to: "todo", actor: "machine", actorId: null, ruleId: null });
  });

  it("triage parking in triage (clarity unclear) ALSO writes a Transition (backlog → triage)", async () => {
    const { store, orch } = await setup('Ambiguous ask.\n{"clarity":"unclear"}');
    await store.putTask(mkTask({ state: "backlog" }));
    await orch.tickAutonomy();
    expect((await store.getTask("t1"))?.state).toBe("triage");

    const transitions = await store.listTransitionsForTask("t1");
    expect(transitions).toHaveLength(1);
    expect(transitions[0]).toMatchObject({ from: "backlog", to: "triage", actor: "machine", ruleId: null });
  });

  it("auto-pick (todo → ongoing) writes a Transition", async () => {
    const { store, orch } = await setup();
    await store.putTask(mkTask({ state: "todo", autoPick: true }));
    await orch.tickAutonomy();
    expect((await store.getTask("t1"))?.state).toBe("ongoing");

    const transitions = await store.listTransitionsForTask("t1");
    expect(transitions).toHaveLength(1);
    expect(transitions[0]).toMatchObject({ from: "todo", to: "ongoing", actor: "machine", actorId: null, ruleId: null });
  });

  it("a manual re-triage (requestRetriage, human-initiated) does NOT write a machine Transition", async () => {
    const { store, orch } = await setup('Clear now.\n{"clarity":"clear"}');
    await store.putTask(mkTask({ state: "triage" }));
    await orch.requestRetriage(DEFAULT_WORKSPACE, "t1");
    expect((await store.getTask("t1"))?.state).toBe("todo");
    // Out of scope for this task: only the orchestrator's OWN autonomous
    // (tickAutonomy) moves are wired — a human-triggered action isn't.
    expect(await store.listTransitionsForTask("t1")).toEqual([]);
  });

  it("an unpicked task (autoPick:false) is left alone by auto-pick — no state change, no Transition", async () => {
    // NOTE: tickAutonomy's triage step only ever fires on a `backlog` task,
    // and per triageOne it always moves it OUT of backlog (→ "todo" when
    // clear, → "triage" when unclear) — there is no path where triage runs
    // and leaves the task's state unchanged. So the "no-op triage" scenario
    // this test was originally named for is not reachable through
    // tickAutonomy at all; writeMachineTransition's own from===to guard is
    // real (see orchestrator.ts) but nothing here can trigger it via triage.
    // What IS reachable and worth covering: a `todo` task with autoPick:false
    // is skipped by the auto-pick step entirely, so it writes no Transition.
    const { store, orch } = await setup();
    await store.putTask(mkTask({ state: "todo", autoPick: false })); // autoPick off → never auto-picked
    await orch.tickAutonomy();
    expect((await store.getTask("t1"))?.state).toBe("todo"); // unchanged
    expect(await store.listTransitionsForTask("t1")).toEqual([]); // nothing moved, nothing written
  });
});
