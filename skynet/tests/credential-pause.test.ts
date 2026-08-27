// Pausing a credential must mean the work actually STOPS, not merely that no
// new work starts. A key that's leaking, rate-limited or compromised keeps
// doing whatever it's doing until the runs on it end — so "pause" that only
// gates future assignment leaves most of the damage in place.
process.env.SKYNET_MASTER_KEY = Buffer.alloc(32, 3).toString("base64");

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { ProviderId, ServerEvent } from "@skynet/shared";
import { DEFAULT_WORKSPACE } from "@skynet/shared";
import { Hub } from "../apps/server/src/hub.js";
import { MemoryStore } from "../apps/server/src/store/memory.js";
import { Orchestrator } from "../apps/server/src/orchestrator.js";
import { Operations } from "../apps/server/src/operations.js";
import { secretService } from "../apps/server/src/secrets/index.js";
import type { Bus } from "../apps/server/src/bus.js";

class NullBus implements Bus {
  publish(_ws: string, _e: ServerEvent): void {}
  subscribe(): () => void {
    return () => undefined;
  }
}

const WS = DEFAULT_WORKSPACE;

describe("pausing a credential", () => {
  let ops: Operations;
  let orch: Orchestrator;
  let store: MemoryStore;
  let hub: Hub;

  beforeEach(() => {
    store = new MemoryStore();
    hub = new Hub(store, new NullBus());
    orch = new Orchestrator(store, hub);
    ops = new Operations({ store, hub, orchestrator: orch });
  });

  const cred = (name = "vendor") =>
    secretService.createCredential(WS, "claude", name, "sk-x", "op", 1, "https://api.deepseek.com/anthropic");

  it("records who paused it and why — a benched key with no reason is unactionable", async () => {
    const c = await cred();
    const { secret } = await ops.pauseCredential(WS, c.id, "rate limited by the vendor", "jordan");
    expect(secret.paused).toMatchObject({ by: "jordan", reason: "rate limited by the vendor" });
    expect(secret.paused!.at).toBeGreaterThan(0);
  });

  it("refuses new work on a paused key, and allows it again on resume", async () => {
    const c = await cred();
    const usable = () =>
      (orch as unknown as { providerUsable: (w: string, p: ProviderId, c?: string | null) => Promise<boolean> })
        .providerUsable(WS, "claude", c.id);

    expect(await usable()).toBe(true);
    await ops.pauseCredential(WS, c.id, "leaking", "jordan");
    expect(await usable()).toBe(false);
    await ops.resumeCredential(WS, c.id, "jordan");
    expect(await usable()).toBe(true);
  });

  it("stops the runs already on the key and releases their tasks back to To do", async () => {
    const c = await cred();
    const project = await ops.createProject(WS, { name: "p", goal: "g" });
    const task = await ops.createTask(WS, project.id, { text: "t" });
    const run = await hub.upsertRun({
      id: "r1", workspaceId: WS, projectId: project.id, name: "t", status: "running",
      agentId: null, provider: "claude", credentialId: c.id, model: "deepseek-v4-flash",
      endpoint: null, branch: "agent/r1", modules: [], progress: 0, plan: [], modifiedFiles: [],
      log: [], startedAt: 1, lastHeartbeatAt: 1,
    });
    await hub.upsertTask({ ...task, state: "ongoing", runId: run.id });

    const { haltedRunIds } = await ops.pauseCredential(WS, c.id, "compromised", "jordan");

    expect(haltedRunIds).toContain("r1");
    expect((await store.getRun("r1"))!.status).toBe("done");
    const after = (await store.listTasks(WS)).find((t) => t.id === task.id)!;
    expect(after.state).toBe("todo");
    expect(after.runId).toBeNull();
  });

  it("leaves runs on OTHER credentials alone", async () => {
    const paused = await cred("paused-key");
    const other = await cred("other-key");
    const project = await ops.createProject(WS, { name: "p", goal: "g" });
    for (const [id, credentialId] of [["r-paused", paused.id], ["r-other", other.id]] as const) {
      await hub.upsertRun({
        id, workspaceId: WS, projectId: project.id, name: id, status: "running",
        agentId: null, provider: "claude", credentialId, model: "m", endpoint: null,
        branch: `agent/${id}`, modules: [], progress: 0, plan: [], modifiedFiles: [],
        log: [], startedAt: 1, lastHeartbeatAt: 1,
      });
    }
    const { haltedRunIds } = await ops.pauseCredential(WS, paused.id, "x", "jordan");
    expect(haltedRunIds).toEqual(["r-paused"]);
    expect((await store.getRun("r-other"))!.status).toBe("running");
  });

  it("survives a key rotation — replacing the key is not a decision to resume", async () => {
    // A key benched because something was wrong with it must not quietly come
    // back just because someone pasted a new secret in.
    const c = await cred();
    await ops.pauseCredential(WS, c.id, "suspected leak", "jordan");
    await secretService.setKey(WS, c.id, "sk-rotated", "jordan", 2);
    expect(await secretService.isPaused(WS, c.id)).toBe(true);
  });

  it("resuming clears the auto-learned quota breaker too", async () => {
    // An explicit resume is the operator saying the key is good again; a stale
    // "depleted" mark from an earlier billing wall must not keep refusing it.
    const c = await cred();
    (orch as unknown as { depletedKeys: Map<string, unknown> }).depletedKeys.set(`${WS}:${c.id}`, { reason: "quota", at: 1 });
    await ops.resumeCredential(WS, c.id, "jordan");
    expect((orch as unknown as { depletedKeys: Map<string, unknown> }).depletedKeys.has(`${WS}:${c.id}`)).toBe(false);
  });

  it("pausing an unknown credential is an error, not a silent no-op", async () => {
    await expect(ops.pauseCredential(WS, "cred-nope", "x", "jordan")).rejects.toThrow();
  });
});

describe("maxRunners caps concurrency, not roster size", () => {
  let ops: Operations;
  let store: MemoryStore;

  beforeEach(() => {
    store = new MemoryStore();
    const hub = new Hub(store, new NullBus());
    ops = new Operations({ store, hub, orchestrator: new Orchestrator(store, hub) });
  });

  it("never blocks adding a runner, even past the cap", async () => {
    // Blocking creation was the wrong lever: configuring a fleet (one runner
    // per cheap endpoint, a spare on a second key) is not the runaway case the
    // cap defends against — starting them all at once is.
    await ops.updateWorkspaceSettings(WS, { maxRunners: 2 });
    for (let i = 0; i < 5; i++) {
      await ops.configureRunner(WS, { provider: "claude", model: "sonnet-5", name: `r${i}` });
    }
    expect((await store.listAgents(WS)).length).toBe(5);
  });
});
