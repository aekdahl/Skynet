// Product Steward Phase 1 (docs/product-steward.md) — the living Plan
// entity: store CRUD, Operations' default-empty-until-first-save read, the
// optimistic-concurrency write, and the HTTP routes. Same Fastify + real
// Orchestrator + MemoryStore harness as tests/gate-batching-server.test.ts.
import { describe, it, expect, beforeEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import type { Project, ServerEvent } from "@skynet/shared";
import { DEFAULT_WORKSPACE } from "@skynet/shared";
import { registerApi } from "../apps/server/src/api.js";
import { Hub } from "../apps/server/src/hub.js";
import { Orchestrator } from "../apps/server/src/orchestrator.js";
import { Operations, NotFoundError } from "../apps/server/src/operations.js";
import { MemoryStore } from "../apps/server/src/store/memory.js";
import { VersionConflictError } from "../apps/server/src/store/store.js";
import type { Bus } from "../apps/server/src/bus.js";
import type { RunnerProvider } from "@skynet/runner-sdk";

class NullBus implements Bus {
  publish(): void {}
  subscribe(): () => void {
    return () => {};
  }
}
class CapturingBus implements Bus {
  events: { workspaceId: string; event: ServerEvent }[] = [];
  publish(workspaceId: string, event: ServerEvent): void {
    this.events.push({ workspaceId, event });
  }
  subscribe(): () => void {
    return () => {};
  }
}
const provider = {} as RunnerProvider;
const AUTH = { authorization: "Bearer dev-cyberdyne" }; // → DEFAULT_WORKSPACE

const project: Project = {
  id: "p1", workspaceId: DEFAULT_WORKSPACE, name: "P", goal: "", runIds: [],
  status: "active", repoPath: null, gitBacked: false, repo: null,
} as Project;

let store: MemoryStore;
let hub: Hub;
let ops: Operations;
let app: FastifyInstance;

beforeEach(async () => {
  store = new MemoryStore({ seed: false });
  hub = new Hub(store, new NullBus());
  const orch = new Orchestrator(store, hub, provider);
  ops = new Operations({ store, hub, orchestrator: orch });
  await store.putProject(project);

  app = Fastify();
  await registerApi(app, { operations: ops, orchestrator: orch });
  app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: "Not found" }));
  await app.ready();
});

describe("store: getPlan/putPlan", () => {
  it("getPlan returns undefined when nothing's been saved yet", async () => {
    expect(await store.getPlan("p1")).toBeUndefined();
  });

  it("putPlan with no expectedVersion always succeeds, starting at version 1", async () => {
    const saved = await store.putPlan({ projectId: "p1", workspaceId: DEFAULT_WORKSPACE, markdown: "# hi", version: 0, updatedBy: "jordan", updatedAt: 1000 });
    expect(saved.version).toBe(1);
    expect((await store.getPlan("p1"))?.markdown).toBe("# hi");
  });

  it("putPlan with a matching expectedVersion bumps the version", async () => {
    await store.putPlan({ projectId: "p1", workspaceId: DEFAULT_WORKSPACE, markdown: "v1", version: 0, updatedBy: "a", updatedAt: 1 }, 0);
    const saved = await store.putPlan({ projectId: "p1", workspaceId: DEFAULT_WORKSPACE, markdown: "v2", version: 0, updatedBy: "a", updatedAt: 2 }, 1);
    expect(saved.version).toBe(2);
    expect(saved.markdown).toBe("v2");
  });

  it("putPlan with a stale expectedVersion throws VersionConflictError, leaving the stored Plan untouched", async () => {
    await store.putPlan({ projectId: "p1", workspaceId: DEFAULT_WORKSPACE, markdown: "v1", version: 0, updatedBy: "a", updatedAt: 1 }, 0);
    await expect(
      store.putPlan({ projectId: "p1", workspaceId: DEFAULT_WORKSPACE, markdown: "clobber", version: 0, updatedBy: "b", updatedAt: 2 }, 0),
    ).rejects.toThrow(VersionConflictError);
    expect((await store.getPlan("p1"))?.markdown).toBe("v1");
  });
});

describe("Operations.getProjectPlan / updateProjectPlan", () => {
  it("returns an ephemeral empty Plan (version 0) before anything's ever been saved", async () => {
    const plan = await ops.getProjectPlan(DEFAULT_WORKSPACE, "p1");
    expect(plan).toMatchObject({ projectId: "p1", markdown: "", version: 0 });
  });

  it("404s a project outside the workspace, or that doesn't exist", async () => {
    await expect(ops.getProjectPlan(DEFAULT_WORKSPACE, "nope")).rejects.toThrow(NotFoundError);
    await expect(ops.getProjectPlan("other-ws", "p1")).rejects.toThrow(NotFoundError);
  });

  it("the first update (baseVersion: 0) creates the Plan at version 1, attributed to the caller", async () => {
    const plan = await ops.updateProjectPlan(DEFAULT_WORKSPACE, "p1", { markdown: "# Plan v1", baseVersion: 0 }, "jordan");
    expect(plan).toMatchObject({ projectId: "p1", markdown: "# Plan v1", version: 1, updatedBy: "jordan" });
    expect(plan.updatedAt).toBeGreaterThan(0);
  });

  it("a second update against the now-stale baseVersion 0 is refused — 'someone else' (or the same tab twice) can't clobber", async () => {
    await ops.updateProjectPlan(DEFAULT_WORKSPACE, "p1", { markdown: "v1", baseVersion: 0 }, "jordan");
    await expect(
      ops.updateProjectPlan(DEFAULT_WORKSPACE, "p1", { markdown: "clobber", baseVersion: 0 }, "alex"),
    ).rejects.toThrow(VersionConflictError);
    // The rejected write never landed.
    expect((await ops.getProjectPlan(DEFAULT_WORKSPACE, "p1")).markdown).toBe("v1");
  });

  it("an update against the CURRENT version succeeds and bumps it again", async () => {
    const v1 = await ops.updateProjectPlan(DEFAULT_WORKSPACE, "p1", { markdown: "v1", baseVersion: 0 }, "jordan");
    const v2 = await ops.updateProjectPlan(DEFAULT_WORKSPACE, "p1", { markdown: "v2", baseVersion: v1.version }, "jordan");
    expect(v2.version).toBe(2);
    expect(v2.markdown).toBe("v2");
  });

  it("publishes a plan.upserted event through the hub on every write", async () => {
    const bus = new CapturingBus();
    const localHub = new Hub(store, bus);
    const localOrch = new Orchestrator(store, localHub, provider);
    const localOps = new Operations({ store, hub: localHub, orchestrator: localOrch });
    await localOps.updateProjectPlan(DEFAULT_WORKSPACE, "p1", { markdown: "v1", baseVersion: 0 }, "jordan");
    expect(bus.events.some((e) => e.event.type === "plan.upserted")).toBe(true);
  });
});

describe("HTTP: GET/PATCH /api/projects/:id/plan", () => {
  it("GET returns the ephemeral empty Plan before anything's saved", async () => {
    const res = await app.inject({ method: "GET", url: "/api/projects/p1/plan", headers: AUTH });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ projectId: "p1", markdown: "", version: 0 });
  });

  it("GET 404s a project outside the workspace", async () => {
    const res = await app.inject({ method: "GET", url: "/api/projects/nope/plan", headers: AUTH });
    expect(res.statusCode).toBe(404);
  });

  it("PATCH writes the Plan and the very next GET reflects it", async () => {
    const patch = await app.inject({ method: "PATCH", url: "/api/projects/p1/plan", headers: AUTH, payload: { markdown: "# Real plan", baseVersion: 0 } });
    expect(patch.statusCode).toBe(200);
    expect(patch.json()).toMatchObject({ markdown: "# Real plan", version: 1 });

    const get = await app.inject({ method: "GET", url: "/api/projects/p1/plan", headers: AUTH });
    expect(get.json()).toMatchObject({ markdown: "# Real plan", version: 1 });
  });

  it("PATCH 409s a stale baseVersion", async () => {
    await app.inject({ method: "PATCH", url: "/api/projects/p1/plan", headers: AUTH, payload: { markdown: "v1", baseVersion: 0 } });
    const stale = await app.inject({ method: "PATCH", url: "/api/projects/p1/plan", headers: AUTH, payload: { markdown: "clobber", baseVersion: 0 } });
    expect(stale.statusCode).toBe(409);
  });

  it("PATCH 400s a missing baseVersion", async () => {
    const res = await app.inject({ method: "PATCH", url: "/api/projects/p1/plan", headers: AUTH, payload: { markdown: "no version" } });
    expect(res.statusCode).toBe(400);
  });
});
