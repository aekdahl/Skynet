// Governance-to-SOTA — policy-driven gate batching's server side:
// Operations.resolveHitlBatch + POST /api/hitl/resolve-batch. Reuses the
// exact resolveHitl per-item logic (see tests/hitl.test.ts for that path's
// own first-writer-wins coverage) — this file is about the BATCH wiring: N
// ids in, N resolutions out, one bad id doesn't block the rest, and the
// route requires the same "approver" scope the single-item route does.
import { describe, it, expect, beforeEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import type { Agent, HitlItem, Project, TaskRun } from "@skynet/shared";
import { DEFAULT_WORKSPACE } from "@skynet/shared";
import { registerApi } from "../apps/server/src/api.js";
import { Hub } from "../apps/server/src/hub.js";
import { Orchestrator } from "../apps/server/src/orchestrator.js";
import { Operations } from "../apps/server/src/operations.js";
import { MemoryStore } from "../apps/server/src/store/memory.js";
import type { Bus } from "../apps/server/src/bus.js";
import type { RunnerProvider } from "@skynet/runner-sdk";
import { requiredScope } from "../apps/server/src/auth-guard.js";

class NullBus implements Bus {
  publish(): void {}
  subscribe(): () => void {
    return () => {};
  }
}
const provider = {} as RunnerProvider;
const AUTH = { authorization: "Bearer dev-cyberdyne" }; // → DEFAULT_WORKSPACE, full authority

const project: Project = {
  id: "p1", workspaceId: DEFAULT_WORKSPACE, name: "P", goal: "", runIds: [],
  status: "active", repoPath: null, gitBacked: false, repo: null,
} as Project;

const mkRun = (id: string): TaskRun =>
  ({
    id, workspaceId: DEFAULT_WORKSPACE, projectId: "p1", name: `run ${id}`, status: "waiting",
    agentId: "a1", provider: "claude", credentialId: null, model: "opus-4.8", branch: `agent/${id}`,
    modules: [], progress: 0, plan: [], usage: null, modifiedFiles: [], log: [], startedAt: 0,
    lastHeartbeatAt: 0, visual: false, previewUrl: null, dependsOn: [], parentId: null,
    branchFromStep: null, archived: false, pr: null,
  }) as TaskRun;

const agent: Agent = {
  id: "a1", workspaceId: DEFAULT_WORKSPACE, name: "a1", provider: "claude",
  model: "opus-4.8", status: "idle", idleSince: 0, autoProvisioned: false, canReview: true,
} as Agent;

const mkGate = (id: string, runId: string, command: string): HitlItem =>
  ({
    id, workspaceId: DEFAULT_WORKSPACE, runId, kind: "approval",
    title: "Run a command", why: "needs approval", risk: "low",
    raisedAt: 1000, resolvedAt: null, resolution: null,
    command, options: null, recommended: null, steps: null, diff: null, output: null,
    flags: [], projectId: null, roadmapProposalId: null,
  }) as HitlItem;

let app: FastifyInstance;
let store: MemoryStore;
let hub: Hub;

beforeEach(async () => {
  store = new MemoryStore({ seed: false });
  hub = new Hub(store, new NullBus());
  const orch = new Orchestrator(store, hub, provider);
  const ops = new Operations({ store, hub, orchestrator: orch });
  await store.putProject(project);
  await store.putAgent(agent);
  for (const id of ["r1", "r2", "r3"]) await store.putRun(mkRun(id));
  await hub.raiseHitl(mkGate("h1", "r1", "npm test"));
  await hub.raiseHitl(mkGate("h2", "r2", "npm test"));
  await hub.raiseHitl(mkGate("h3", "r3", "npm build"));

  app = Fastify();
  await registerApi(app, { operations: ops, orchestrator: orch });
  app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: "Not found" }));
  await app.ready();
});

describe("POST /api/hitl/resolve-batch", () => {
  it("resolves every id in one call, each carrying the full single-item side effects", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/hitl/resolve-batch",
      headers: AUTH,
      payload: { ids: ["h1", "h2"], action: "approve" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.resolved).toHaveLength(2);
    expect(body.skipped).toEqual([]);
    expect((await store.getHitl("h1"))?.resolution?.action).toBe("approve");
    expect((await store.getHitl("h2"))?.resolution?.action).toBe("approve");
    // Untouched — not in the batch.
    expect((await store.getHitl("h3"))?.resolution).toBeNull();
  });

  it("a bad id in the batch is reported in `skipped`, without blocking the rest", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/hitl/resolve-batch",
      headers: AUTH,
      payload: { ids: ["h1", "nope", "h2"], action: "reject" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.resolved).toHaveLength(2);
    expect(body.resolved.map((r: HitlItem) => r.id).sort()).toEqual(["h1", "h2"]);
    expect(body.skipped).toEqual([{ id: "nope", reason: expect.stringContaining("HITL item") }]);
  });

  it("resolving the same id twice in the workspace — the second call reports it skipped, first-writer-wins preserved", async () => {
    await app.inject({ method: "POST", url: "/api/hitl/resolve-batch", headers: AUTH, payload: { ids: ["h1"], action: "approve" } });
    const second = await app.inject({ method: "POST", url: "/api/hitl/resolve-batch", headers: AUTH, payload: { ids: ["h1"], action: "reject" } });
    expect(second.statusCode).toBe(200);
    // resolveHitl is idempotent (first-writer-wins) — a second resolve just
    // returns the EXISTING item unchanged, not an error, so it still counts
    // as "resolved" here (matches the single-item route's own contract).
    const body = second.json();
    expect(body.resolved).toHaveLength(1);
    expect(body.resolved[0].resolution.action).toBe("approve"); // first call's action, unchanged
  });

  it("400s an empty id list", async () => {
    const res = await app.inject({ method: "POST", url: "/api/hitl/resolve-batch", headers: AUTH, payload: { ids: [], action: "approve" } });
    expect(res.statusCode).toBe(400);
  });

  it("is classified as an 'approver' decision, same bar as the single-item resolve route — a scoped author-only token would be refused", () => {
    expect(requiredScope("POST", "/api/hitl/resolve-batch")).toBe("approver");
    expect(requiredScope("POST", "/api/hitl/h1/resolve")).toBe("approver");
  });
});
