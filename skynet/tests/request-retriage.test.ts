// Manual "Request re-triage" — force a fresh triage pass on a task already
// parked in `triage`, instead of waiting for it to cycle back through
// Backlog on its own (the only path the periodic tick picks up). Shares
// `Orchestrator.triageOne` with the periodic tick's own triage step (see
// autonomy.test.ts), so this only needs to cover the entry point itself
// (which tasks it accepts, the honest failure modes) — the assessment
// write-logic (including the clarification loop breaker) is already
// regression-proofed there.
import { describe, it, expect, beforeEach } from "vitest";
import type { Agent, Project, ServerEvent, Task } from "@skynet/shared";
import { DEFAULT_WORKSPACE } from "@skynet/shared";
import { Hub } from "../apps/server/src/hub.js";
import { NoCapacityError, NoTriageTargetError, Orchestrator } from "../apps/server/src/orchestrator.js";
import { Operations, NotFoundError } from "../apps/server/src/operations.js";
import { MemoryStore } from "../apps/server/src/store/memory.js";
import type { Bus } from "../apps/server/src/bus.js";
import type { RunnerEvents, RunnerHandle, RunnerProvider, StartSpec } from "@skynet/runner-sdk";

class NullBus implements Bus {
  publish(_ws: string, _e: ServerEvent): void {}
  subscribe(): () => void { return () => {}; }
}

class AutoProvider implements RunnerProvider {
  readonly id = "claude" as const;
  consults = 0;
  constructor(private reply = "ok") {}
  async start(spec: StartSpec, _e: RunnerEvents): Promise<RunnerHandle> {
    return { runId: spec.runId, provider: this.id, async pause() {}, async resume() {}, async message() {}, async stop() {} };
  }
  async consult(): Promise<string> { this.consults++; return this.reply; }
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
  id: "t1", workspaceId: DEFAULT_WORKSPACE, projectId: "p1", text: "do X", state: "triage",
  runId: null, autoPick: false, assessment: "stale read", reviewVerdict: null, lint: null,
  assignment: { mode: "any", agentIds: [] }, ...over,
});

const setup = async (reply?: string) => {
  const store = new MemoryStore({ seed: false });
  const hub = new Hub(store, new NullBus());
  const provider = new AutoProvider(reply);
  const orch = new Orchestrator(store, hub, provider);
  const ops = new Operations({ store, hub, orchestrator: orch });
  await store.putProject(project);
  return { store, orch, ops, provider };
};

describe("requestRetriage", () => {
  it("re-runs triage on a parked task and applies the fresh read (clear → promotes to todo)", async () => {
    const { store, ops } = await setup('Now well-scoped.\n{"estMinutes":10,"clarity":"clear"}');
    await store.putAgent(idleAgent);
    await store.putTask(mkTask({}));

    await ops.requestRetriage(DEFAULT_WORKSPACE, "t1");

    const t = await store.getTask("t1");
    expect(t?.state).toBe("todo");
    expect(t?.assessment).toContain("Now well-scoped");
  });

  it("re-runs triage and stays in triage with a fresh clarification when still unclear", async () => {
    const { store, ops } = await setup('Still missing something.\n{"clarity":"unclear","questions":["Which flow?"]}');
    await store.putAgent(idleAgent);
    await store.putTask(mkTask({}));

    await ops.requestRetriage(DEFAULT_WORKSPACE, "t1");

    const t = await store.getTask("t1");
    expect(t?.state).toBe("triage");
    expect(t?.clarification?.questions).toEqual(["Which flow?"]);
  });

  it("throws NoTriageTargetError for a task that isn't in triage", async () => {
    const { store, ops } = await setup();
    await store.putAgent(idleAgent);
    await store.putTask(mkTask({ state: "backlog" }));
    await expect(ops.requestRetriage(DEFAULT_WORKSPACE, "t1")).rejects.toThrow(NoTriageTargetError);
  });

  it("throws NoCapacityError when no agent is idle", async () => {
    const { store, ops, provider } = await setup();
    await store.putAgent({ ...idleAgent, status: "busy" });
    await store.putTask(mkTask({}));
    await expect(ops.requestRetriage(DEFAULT_WORKSPACE, "t1")).rejects.toThrow(NoCapacityError);
    expect(provider.consults).toBe(0); // never even asked
  });

  it("a task that doesn't exist (or belongs to another workspace) 404s via NotFoundError, not a triage-specific error", async () => {
    const { ops } = await setup();
    await expect(ops.requestRetriage(DEFAULT_WORKSPACE, "nonexistent")).rejects.toThrow(NotFoundError);
  });
});
