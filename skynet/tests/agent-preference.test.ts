// A task's saved Start-picker preference (Task.preferredProvider/-Model) is a
// SOFT hint: acquireAgent tries a matching idle+usable runner first, but any
// mismatch — no runner of that provider, or a provider match with no model
// match — falls straight through to the unchanged default pick (first idle,
// usable, fleet order). A preference must never block a task the way
// `agents`-mode eligibility legitimately can.
import { describe, it, expect } from "vitest";
import type { ProviderId, Agent, Project, Task } from "@skynet/shared";
import { DEFAULT_WORKSPACE } from "@skynet/shared";
import { Hub } from "../apps/server/src/hub.js";
import { Orchestrator } from "../apps/server/src/orchestrator.js";
import { MemoryStore } from "../apps/server/src/store/memory.js";
import type { Bus } from "../apps/server/src/bus.js";
import type { RunnerEvents, RunnerHandle, RunnerProvider, StartSpec } from "@skynet/runner-sdk";

class NullBus implements Bus {
  publish(): void {}
  subscribe(): () => void {
    return () => {};
  }
}

// Never completes — keeps the acquired runner "busy" so a test asserting
// which runner got picked doesn't race a completion freeing it back to idle.
class RunningProvider implements RunnerProvider {
  readonly id: ProviderId = "claude";
  async start(spec: StartSpec, _events: RunnerEvents): Promise<RunnerHandle> {
    return { runId: spec.runId, provider: this.id, async pause() {}, async resume() {}, async message() {}, async stop() {} };
  }
}

const WS = DEFAULT_WORKSPACE;
const agent = (over: Partial<Agent>): Agent =>
  ({ id: "r", workspaceId: WS, name: "r", provider: "claude", credentialId: null, model: "opus", status: "idle", idleSince: 0, ...over }) as Agent;
const task = (over: Partial<Task>): Task =>
  ({ id: "t1", workspaceId: WS, projectId: "p1", text: "do it", state: "backlog", runId: null, ...over }) as Task;

async function setup() {
  const store = new MemoryStore({ seed: false });
  const orch = new Orchestrator(store, new Hub(store, new NullBus()), new RunningProvider());
  await store.putProject({ id: "p1", workspaceId: WS, name: "P", goal: "", runIds: [], status: "active", enabledRunnerCredentialIds: [] } as Project);
  return { store, orch };
}

describe("Task.preferredProvider/-Model — soft auto-pick hint", () => {
  it("with no preference, picks the first idle runner (unchanged default order)", async () => {
    const { store, orch } = await setup();
    await store.putAgent(agent({ id: "r-claude-1", provider: "claude" }));
    await store.putAgent(agent({ id: "r-claude-2", provider: "claude" }));
    await store.putTask(task({}));
    const run = await orch.assignTask("p1", "t1");
    expect(run.agentId).toBe("r-claude-1");
  });

  it("prefers an idle runner of the saved provider over an earlier-listed one of a different provider", async () => {
    const { store, orch } = await setup();
    await store.putAgent(agent({ id: "r-claude", provider: "claude" })); // listed first
    await store.putAgent(agent({ id: "r-codex", provider: "codex" }));
    await store.putTask(task({ preferredProvider: "codex" }));
    const run = await orch.assignTask("p1", "t1");
    expect(run.agentId).toBe("r-codex");
    expect(run.provider).toBe("codex");
  });

  it("prefers an exact provider+model match over a provider-only match", async () => {
    const { store, orch } = await setup();
    await store.putAgent(agent({ id: "r-claude-opus", provider: "claude", model: "opus-4.8" }));
    await store.putAgent(agent({ id: "r-claude-sonnet", provider: "claude", model: "sonnet-4.6" }));
    await store.putTask(task({ preferredProvider: "claude", preferredModel: "sonnet-4.6" }));
    const run = await orch.assignTask("p1", "t1");
    expect(run.agentId).toBe("r-claude-sonnet");
  });

  it("falls back to plain auto-pick when no idle runner matches the preferred provider", async () => {
    const { store, orch } = await setup();
    await store.putAgent(agent({ id: "r-claude", provider: "claude" }));
    await store.putTask(task({ preferredProvider: "gemini" })); // nothing idle runs gemini
    const run = await orch.assignTask("p1", "t1");
    expect(run.agentId).toBe("r-claude"); // preference didn't block the start
    expect(run.provider).toBe("claude");
  });

  it("falls back to plain auto-pick when the preferred provider matches but the model doesn't, and no OTHER idle runner exists", async () => {
    const { store, orch } = await setup();
    await store.putAgent(agent({ id: "r-claude-opus", provider: "claude", model: "opus-4.8" }));
    await store.putTask(task({ preferredProvider: "claude", preferredModel: "sonnet-4.6" })); // no sonnet runner idle
    const run = await orch.assignTask("p1", "t1");
    expect(run.agentId).toBe("r-claude-opus"); // the provider-only match still wins over nothing
  });
});
