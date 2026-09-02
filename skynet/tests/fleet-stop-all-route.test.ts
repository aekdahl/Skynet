// TASK 24 — the command palette's "Pause the whole fleet" destructive action.
// orchestrator.stopAll itself is already covered end-to-end by
// orchestrator-stopall.test.ts; this just proves the NEW route/Operations
// wrapper this task added actually reaches it, over a real HTTP call.
import { describe, it, expect, beforeEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import type { ProviderId } from "@skynet/shared";
import { DEFAULT_WORKSPACE } from "@skynet/shared";
import { registerApi } from "../apps/server/src/api.js";
import { InProcessBus } from "../apps/server/src/bus.js";
import { Hub } from "../apps/server/src/hub.js";
import { Orchestrator } from "../apps/server/src/orchestrator.js";
import { Operations } from "../apps/server/src/operations.js";
import { MemoryStore } from "../apps/server/src/store/memory.js";
import type { RunnerEvents, RunnerHandle, RunnerProvider, StartSpec } from "@skynet/runner-sdk";

class NullProvider implements RunnerProvider {
  readonly id: ProviderId = "claude";
  async start(spec: StartSpec, _events: RunnerEvents): Promise<RunnerHandle> {
    return { runId: spec.runId, provider: this.id, async pause() {}, async resume() {}, async message() {}, async stop() {} };
  }
}

const AUTH = { authorization: "Bearer dev-cyberdyne" }; // → DEFAULT_WORKSPACE

describe("POST /api/fleet/stop-all", () => {
  let app: FastifyInstance;
  let store: MemoryStore;
  let ops: Operations;
  let orchestrator: Orchestrator;

  beforeEach(async () => {
    store = new MemoryStore();
    const bus = new InProcessBus();
    const hub = new Hub(store, bus);
    orchestrator = new Orchestrator(store, hub, new NullProvider());
    ops = new Operations({ store, hub, orchestrator });
    app = Fastify();
    await registerApi(app, { operations: ops, orchestrator });
    await app.ready();
  });

  it("returns 0 stopped when nothing is running", async () => {
    const res = await app.inject({ method: "POST", url: "/api/fleet/stop-all", headers: AUTH });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ stopped: 0 });
  });

  it("actually halts a running run and pauses autonomy — the real kill switch, not a stub", async () => {
    const project = await ops.createProject(DEFAULT_WORKSPACE, { name: "P", goal: "" });
    await store.putRun({
      id: "r1", workspaceId: DEFAULT_WORKSPACE, projectId: project.id, name: "t", status: "running",
      agentId: "a1", provider: "claude", credentialId: null, model: "sonnet-5", branch: "b",
      modules: [], progress: 0, plan: [], usage: null, modifiedFiles: [], log: [],
      startedAt: 0, lastHeartbeatAt: Date.now(), visual: false, previewUrl: null, dependsOn: [],
      parentId: null, branchFromStep: null, archived: false, pr: null, mergedAt: null, flyDeployment: null,
    } as never);

    expect(orchestrator.isPaused()).toBe(false);
    const res = await app.inject({ method: "POST", url: "/api/fleet/stop-all", headers: AUTH });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ stopped: 1 });
    expect(orchestrator.isPaused()).toBe(true);

    const run = await store.getRun("r1");
    expect(run?.status).not.toBe("running");
  });
});
