// HTTP route-level guard for the run lifecycle controls: POST
// /api/runs/:id/{pause,resume,stop}. The operations layer is unit-tested in
// operations.test.ts, but nothing paired the HTTP path with the client — so
// when the agents→runs rename moved messages/fork/archive to /api/runs/:id but
// left pause/resume/stop registered under /api/agents/:id, every client call
// (web UI + simulation share the same client) 404'd and no test noticed. This
// drives the REAL Fastify app at the paths the client actually posts to.
import { describe, it, expect, beforeEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import type { ProviderId } from "@skynet/shared";
import { DEFAULT_WORKSPACE } from "@skynet/shared";
import { registerApi } from "../apps/server/src/api.js";
import { Hub } from "../apps/server/src/hub.js";
import { Orchestrator } from "../apps/server/src/orchestrator.js";
import { Operations } from "../apps/server/src/operations.js";
import { MemoryStore } from "../apps/server/src/store/memory.js";
import type { Bus } from "../apps/server/src/bus.js";
import type { RunnerEvents, RunnerHandle, RunnerProvider, StartSpec } from "@skynet/runner-sdk";

class NullBus implements Bus {
  publish(): void {}
  subscribe(): () => void {
    return () => {};
  }
}

// Keeps the run (and its busy runner) alive so we can steer it.
class RunningProvider implements RunnerProvider {
  readonly id: ProviderId = "claude";
  async start(spec: StartSpec, _events: RunnerEvents): Promise<RunnerHandle> {
    return { runId: spec.runId, provider: this.id, async pause() {}, async resume() {}, async message() {}, async stop() {} };
  }
}

const AUTH = { authorization: "Bearer dev-cyberdyne" }; // → DEFAULT_WORKSPACE

describe("HTTP routes: run pause / resume / stop live under /api/runs/:id", () => {
  let app: FastifyInstance;
  let store: MemoryStore;
  let ops: Operations;

  beforeEach(async () => {
    store = new MemoryStore({ seed: false });
    const hub = new Hub(store, new NullBus());
    const orchestrator = new Orchestrator(store, hub, new RunningProvider());
    ops = new Operations({ store, hub, orchestrator });
    app = Fastify();
    await registerApi(app, { operations: ops });
    // Mirror the production not-found handler (static.ts) so an unregistered
    // path returns the same {error:"Not found"} it does in the real server.
    app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: "Not found" }));
    await app.ready();
  });

  const spawnRun = async () => {
    await store.putAgent({ id: "r1", workspaceId: DEFAULT_WORKSPACE, name: "r1", provider: "claude", model: "opus-4.8", status: "idle", idleSince: 0 });
    const project = await ops.createProject(DEFAULT_WORKSPACE, { name: "P", goal: "", repo: undefined });
    const task = await ops.createTask(DEFAULT_WORKSPACE, project.id, { text: "x" });
    return ops.assignTask(DEFAULT_WORKSPACE, project.id, task.id);
  };

  it("pauses, resumes, then stops a live run (freeing its runner)", async () => {
    const run = await spawnRun();

    const paused = await app.inject({ method: "POST", url: `/api/runs/${run.id}/pause`, headers: AUTH });
    expect(paused.statusCode).toBe(200);
    expect(paused.json().status).toBe("paused");

    const resumed = await app.inject({ method: "POST", url: `/api/runs/${run.id}/resume`, headers: AUTH });
    expect(resumed.statusCode).toBe(200);
    expect(resumed.json().status).toBe("running");

    const stopped = await app.inject({ method: "POST", url: `/api/runs/${run.id}/stop`, headers: AUTH });
    expect(stopped.statusCode).toBe(200);
    expect(stopped.json().status).toBe("done");
    expect((await store.getAgent("r1"))?.status).toBe("idle"); // runner freed
  });

  // Registered route → the domain 404 from getRun ({error:"TaskRun not found"});
  // a wrong/missing path → the not-found handler ({error:"Not found"}). Assert
  // the former at the client's paths so a future rename that desyncs them fails.
  it.each(["pause", "resume", "stop"])("%s is registered at /api/runs/:id (domain 404, not a missing-route 404)", async (action) => {
    const res = await app.inject({ method: "POST", url: `/api/runs/nope/${action}`, headers: AUTH });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: "TaskRun not found" });
  });

  // Lock the fix: the pre-rename path must NOT resolve, or the drift could recur.
  it.each(["pause", "resume", "stop"])("the old /api/agents/:id/%s path is gone", async (action) => {
    const res = await app.inject({ method: "POST", url: `/api/agents/nope/${action}`, headers: AUTH });
    expect(res.json()).toEqual({ error: "Not found" }); // Skynet's not-found handler
  });
});
