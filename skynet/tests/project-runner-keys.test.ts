// A project can be confined to a set of provider KEYS (secret-store credential
// ids). Assignment to that project may then only land on a fleet runner whose
// key (credentialId ?? provider) is in the set — enforced in the orchestrator so
// it holds for EVERY caller (human, autonomy loop, or MCP token), not just one.
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

// Keeps every run "running" so a started agent stays live. Used as the provider
// override, which also short-circuits providerUsable() to true — so the test
// exercises KEY confinement in isolation, not credential resolution.
class RunningProvider implements RunnerProvider {
  readonly id: ProviderId = "claude";
  async start(spec: StartSpec, _events: RunnerEvents): Promise<RunnerHandle> {
    return { runId: spec.runId, provider: this.id, async pause() {}, async resume() {}, async message() {}, async stop() {} };
  }
}

// Two idle runners on DIFFERENT keys (both provider-default, so effective key ===
// provider id): a claude one and a gemini one.
function seed(store: MemoryStore, enabledRunnerCredentialIds: string[]) {
  const project: Project = {
    id: "p1", workspaceId: DEFAULT_WORKSPACE, name: "Proj", goal: "", runIds: [], status: "active", enabledRunnerCredentialIds,
  } as Project;
  const task: Task = { id: "t1", workspaceId: DEFAULT_WORKSPACE, projectId: "p1", text: "do it", state: "backlog", runId: null } as Task;
  const runners: Agent[] = [
    { id: "r-claude", workspaceId: DEFAULT_WORKSPACE, name: "r-claude", provider: "claude", credentialId: null, model: "opus", status: "idle", idleSince: 0 },
    { id: "r-gemini", workspaceId: DEFAULT_WORKSPACE, name: "r-gemini", provider: "gemini", credentialId: null, model: "g", status: "idle", idleSince: 0 },
  ];
  return Promise.all([store.putProject(project), store.putTask(task), ...runners.map((r) => store.putAgent(r))]);
}

const build = (store: MemoryStore) => new Orchestrator(store, new Hub(store, new NullBus()), new RunningProvider());

describe("project runner-key confinement (assignment gating)", () => {
  it("assigns only onto a runner whose key is enabled for the project", async () => {
    const store = new MemoryStore({ seed: false });
    await seed(store, ["claude"]); // project may only run on the claude key
    const run = await build(store).assignTask("p1", "t1");
    expect(run.provider).toBe("claude");
    // The gemini runner was skipped even though it was idle & usable.
    expect((await store.getAgent("r-gemini"))?.status).toBe("idle");
    expect((await store.getAgent("r-claude"))?.status).toBe("busy");
  });

  it("refuses assignment when no idle runner is on an enabled key", async () => {
    const store = new MemoryStore({ seed: false });
    await seed(store, ["codex"]); // neither runner is on the codex key
    await expect(build(store).assignTask("p1", "t1")).rejects.toThrow(/provider key enabled for this project/);
    // Nothing was acquired — both runners stay idle.
    expect((await store.listAgents(DEFAULT_WORKSPACE)).every((r) => r.status === "idle")).toBe(true);
  });

  it("an empty allowlist means any key (unchanged behavior)", async () => {
    const store = new MemoryStore({ seed: false });
    await seed(store, []); // no confinement
    const run = await build(store).assignTask("p1", "t1");
    // Falls to the first idle runner in fleet order (the claude one).
    expect(run.provider).toBe("claude");
  });
});
