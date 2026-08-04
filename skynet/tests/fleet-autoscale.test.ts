// The workspace fleet policy: when `autoProvisionRunners` is on, assigning a task
// with no free runner clones a busy eligible one instead of waiting — bounded by
// `maxRunners` so it can't run away. The cap is a hard ceiling on EVERY creation
// path (auto-scale, fork/retry, explicit configure). Persisted per workspace.
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderId, Agent, Project, Task, WorkspaceSettings } from "@skynet/shared";
import { DEFAULT_WORKSPACE, WorkspaceSettings as WorkspaceSettingsSchema } from "@skynet/shared";
import { Hub } from "../apps/server/src/hub.js";
import { Operations } from "../apps/server/src/operations.js";
import { Orchestrator, NoCapacityError } from "../apps/server/src/orchestrator.js";
import { MemoryStore } from "../apps/server/src/store/memory.js";
import { FileStore } from "../apps/server/src/store/file.js";
import type { Bus } from "../apps/server/src/bus.js";
import type { RunnerEvents, RunnerHandle, RunnerProvider, StartSpec } from "@skynet/runner-sdk";

class NullBus implements Bus {
  publish(): void {}
  subscribe(): () => void {
    return () => {};
  }
}
// Keeps every run live so runners stay busy; as the provider override it also
// makes providerUsable() true, isolating the auto-scale logic under test.
class RunningProvider implements RunnerProvider {
  readonly id: ProviderId = "claude";
  async start(spec: StartSpec, _events: RunnerEvents): Promise<RunnerHandle> {
    return { runId: spec.runId, provider: this.id, async pause() {}, async resume() {}, async message() {}, async stop() {} };
  }
}

const WS = DEFAULT_WORKSPACE;
// One project, two tasks, ONE idle runner — so the second assignment finds the
// fleet fully busy and must either auto-scale or wait.
async function seed(store: MemoryStore, policy: Partial<WorkspaceSettings>) {
  await store.putProject({ id: "p1", workspaceId: WS, name: "P", goal: "", runIds: [], status: "active", enabledRunnerCredentialIds: [] } as Project);
  await store.putTask({ id: "t1", workspaceId: WS, projectId: "p1", text: "one", state: "backlog", runId: null } as Task);
  await store.putTask({ id: "t2", workspaceId: WS, projectId: "p1", text: "two", state: "backlog", runId: null } as Task);
  await store.putAgent({ id: "r1", workspaceId: WS, name: "r1", provider: "claude", credentialId: null, model: "opus", status: "idle", idleSince: 0 });
  await store.putWorkspaceSettings({ workspaceId: WS, autoProvisionRunners: false, maxRunners: 0, ...policy });
}
const build = (store: MemoryStore) => new Orchestrator(store, new Hub(store, new NullBus()), new RunningProvider());
const fleetSize = async (store: MemoryStore) => (await store.listAgents(WS)).length;

describe("fleet auto-scale (assignment)", () => {
  it("auto-provisions a runner (cloned) when enabled and all are busy", async () => {
    const store = new MemoryStore({ seed: false });
    await seed(store, { autoProvisionRunners: true, maxRunners: 0 }); // on, no cap
    const orch = build(store);
    await orch.assignTask("p1", "t1"); // takes r1
    const second = await orch.assignTask("p1", "t2"); // r1 busy → auto-provision
    expect(second.provider).toBe("claude"); // cloned from r1
    expect(await fleetSize(store)).toBe(2); // a fresh runner was added
    expect((await store.getTask("t2"))?.runId).toBe(second.id);
  });

  it("waits (NoCapacityError) when auto-scale is OFF", async () => {
    const store = new MemoryStore({ seed: false });
    await seed(store, { autoProvisionRunners: false });
    const orch = build(store);
    await orch.assignTask("p1", "t1");
    await expect(orch.assignTask("p1", "t2")).rejects.toBeInstanceOf(NoCapacityError);
    expect(await fleetSize(store)).toBe(1); // nothing provisioned
  });

  it("respects the max cap — at the ceiling it waits instead of growing", async () => {
    const store = new MemoryStore({ seed: false });
    await seed(store, { autoProvisionRunners: true, maxRunners: 1 }); // on, but capped at 1
    const orch = build(store);
    await orch.assignTask("p1", "t1"); // fleet is now at its cap of 1
    await expect(orch.assignTask("p1", "t2")).rejects.toBeInstanceOf(NoCapacityError);
    expect(await fleetSize(store)).toBe(1); // cap held
  });
});

describe("fleet cap on explicit runner creation", () => {
  it("configureRunner refuses once the fleet is at maxRunners", async () => {
    const store = new MemoryStore({ seed: false });
    const hub = new Hub(store, new NullBus());
    const operations = new Operations({ store, hub, orchestrator: build(store) });
    await store.putWorkspaceSettings({ workspaceId: WS, autoProvisionRunners: false, maxRunners: 1 });
    await operations.configureRunner(WS, { provider: "claude", model: "opus" }); // 1st → ok (fleet now 1)
    await expect(operations.configureRunner(WS, { provider: "claude", model: "opus" })).rejects.toThrow(/maximum of 1 runner/);
    expect(await fleetSize(store)).toBe(1);
  });
});

describe("idle-runner reaper (auto-decommission)", () => {
  const agent = (over: Partial<Agent>): Agent => ({
    id: "x", workspaceId: WS, name: "x", provider: "claude", credentialId: null, model: "opus",
    status: "idle", idleSince: 0, autoProvisioned: false, ...over,
  });

  it("retires auto-provisioned runners idle past the TTL, sparing everything else", async () => {
    const store = new MemoryStore({ seed: false });
    const orch = build(store);
    await store.putWorkspaceSettings({ workspaceId: WS, autoProvisionRunners: true, maxRunners: 100, retireIdleRunnersAfterMinutes: 30 });
    await store.putAgent(agent({ id: "auto-stale", autoProvisioned: true, status: "idle", idleSince: 0 })); // reaped
    await store.putAgent(agent({ id: "auto-fresh", autoProvisioned: true, status: "idle", idleSince: Date.now() })); // kept — still fresh
    await store.putAgent(agent({ id: "auto-busy", autoProvisioned: true, status: "busy", idleSince: null })); // kept — busy
    await store.putAgent(agent({ id: "manual-stale", autoProvisioned: false, status: "idle", idleSince: 0 })); // kept — operator's

    expect(await orch.reapIdleRunners()).toBe(1);
    expect((await store.listAgents(WS)).map((a) => a.id).sort()).toEqual(["auto-busy", "auto-fresh", "manual-stale"]);
  });

  it("does nothing when the workspace's TTL is 0 (disabled)", async () => {
    const store = new MemoryStore({ seed: false });
    const orch = build(store);
    await store.putWorkspaceSettings({ workspaceId: WS, autoProvisionRunners: true, maxRunners: 100, retireIdleRunnersAfterMinutes: 0 });
    await store.putAgent(agent({ id: "auto-stale", autoProvisioned: true, status: "idle", idleSince: 0 }));
    expect(await orch.reapIdleRunners()).toBe(0);
    expect(await fleetSize(store)).toBe(1);
  });
});

describe("fleet policy defaults", () => {
  it("defaults maxRunners to 100 — a bound, never unlimited", () => {
    expect(WorkspaceSettingsSchema.parse({ workspaceId: WS })).toMatchObject({
      autoProvisionRunners: false,
      maxRunners: 100,
      retireIdleRunnersAfterMinutes: 30,
    });
  });
});

describe("workspace settings persistence", () => {
  it("survives the durable store round-trip", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "skynet-ws-")), "db.json");
    const fs = FileStore.create(path);
    const saved = { workspaceId: WS, autoProvisionRunners: true, maxRunners: 7, retireIdleRunnersAfterMinutes: 45 };
    await fs.putWorkspaceSettings(saved);
    fs.flush();
    const reopened = FileStore.create(path);
    expect(await reopened.getWorkspaceSettings(WS)).toEqual(saved);
  });
});
