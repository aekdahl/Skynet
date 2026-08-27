// tickAutonomy's any-agent eligibility step (Orchestrator.suggestAnyAgentForOne):
// the periodic-tick counterpart to steward/organize.ts's suggestAnyAgentEligible,
// which "Organize board" already runs on click. This closes the same gap
// automatically, one unassigned backlog task per tick, so a freshly created
// task doesn't sit invisible to triage/auto-pick just because nobody clicked a
// button.
//
// Drives the real Orchestrator/MemoryStore. The standalone one-shot consult
// (@skynet/runner-sdk/claude's oneShotText) is a real network call, not
// something injected via a RunnerProvider — and it's resolved through Node's
// real module loader for a workspace package, so `vi.mock` can't reliably
// intercept it here. Orchestrator's constructor gained a test seam for it
// instead (`anyAgentAskOverride`), mirroring the existing providerOverride /
// previewOverride pattern — see its own doc comment.
import { describe, it, expect } from "vitest";
import type { Agent, Project, ServerEvent, Task } from "@skynet/shared";
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
class NoopProvider implements RunnerProvider {
  readonly id = "claude" as const;
  async start(spec: StartSpec, _e: RunnerEvents): Promise<RunnerHandle> {
    return { runId: spec.runId, provider: this.id, async pause() {}, async resume() {}, async message() {}, async stop() {} };
  }
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
  id: "t1", workspaceId: DEFAULT_WORKSPACE, projectId: "p1", text: "rename a config key", state: "backlog",
  runId: null, autoPick: false, assessment: null, reviewVerdict: null, lint: null,
  assignment: { mode: "unassigned", agentIds: [] }, ...over,
});

const setup = async (ask?: (prompt: string) => Promise<string>) => {
  const store = new MemoryStore({ seed: false });
  const hub = new Hub(store, new NullBus());
  const orch = new Orchestrator(store, hub, new NoopProvider(), undefined, undefined, ask);
  await store.putProject(project);
  await store.putAgent(idleAgent);
  return { store, orch };
};

describe("tickAutonomy — any-agent eligibility for one unassigned backlog task", () => {
  it("sets {mode: 'any'} when the consult vouches for the task", async () => {
    const { store, orch } = await setup(async () => JSON.stringify({ anyAgent: ["t1"] }));
    await store.putTask(mkTask({}));

    await orch.tickAutonomy();

    expect((await store.getTask("t1"))?.assignment).toEqual({ mode: "any", agentIds: [] });
  });

  it("leaves the task unassigned when the consult doesn't vouch for it", async () => {
    const { store, orch } = await setup(async () => JSON.stringify({ anyAgent: [] }));
    await store.putTask(mkTask({}));

    await orch.tickAutonomy();

    expect((await store.getTask("t1"))?.assignment?.mode).toBe("unassigned");
  });

  it("never even asks the consult about a task that already has an eligibility choice", async () => {
    let asked = false;
    const { store, orch } = await setup(async () => {
      asked = true;
      return JSON.stringify({ anyAgent: ["t1"] });
    });
    await store.putTask(mkTask({ assignment: { mode: "any", agentIds: [] } }));

    await orch.tickAutonomy();

    expect(asked).toBe(false);
  });

  it("leaves the task unassigned when no credential resolves — never guesses, never calls the consult", async () => {
    // No `ask` override AND no ANTHROPIC_API_KEY in this process's env — the
    // real fallback path throws "no usable credential" before ever reaching
    // the network, which the consult's own try/catch degrades to "nothing
    // suggested" rather than surfacing.
    const prevKey = process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    try {
      const { store, orch } = await setup();
      await store.putTask(mkTask({}));

      await orch.tickAutonomy();

      expect((await store.getTask("t1"))?.assignment?.mode).toBe("unassigned");
    } finally {
      if (prevKey !== undefined) process.env.ANTHROPIC_API_KEY = prevKey;
    }
  });

  it("an unreadable reply degrades to leaving it unassigned — never throws, never guesses", async () => {
    const { store, orch } = await setup(async () => "not json at all");
    await store.putTask(mkTask({}));

    await orch.tickAutonomy();

    expect((await store.getTask("t1"))?.assignment?.mode).toBe("unassigned");
  });

  it("a made-up id in the reply is discarded, not assigned", async () => {
    const { store, orch } = await setup(async () => JSON.stringify({ anyAgent: ["ghost"] }));
    await store.putTask(mkTask({}));

    await orch.tickAutonomy();

    expect((await store.getTask("t1"))?.assignment?.mode).toBe("unassigned");
  });
});
