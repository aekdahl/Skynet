// TASK 15 — cross-project decision backbone. Two things this proves:
//  1. GET /api/decisions returns every OPEN HitlItem across every project in
//     the caller's workspace (not just one project), joined with
//     {projectId, projectName, taskTitle} and sorted by cost-of-waiting
//     (the longest-idle item first — every project currently weighs ×1, see
//     Operations.listDecisions's own TODO for TASK 19's composed detent).
//  2. A single subscription to the workspace's bus channel already receives
//     hitl.raised/resolved events for every project under it — the channel
//     was never project-scoped to begin with (bus.ts), so this is a
//     confirmation test, not new plumbing.
import { describe, it, expect, beforeEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import type { HitlItem, ProviderId, Project, ServerEvent } from "@skynet/shared";
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
const WS = DEFAULT_WORKSPACE;

/** A minimal, fully-formed TaskRun — same shape credential-pause.test.ts seeds directly via hub.upsertRun. */
function runFor(id: string, projectId: string): Parameters<Hub["upsertRun"]>[0] {
  return {
    id, workspaceId: WS, projectId, name: id, status: "running",
    agentId: null, provider: "claude", credentialId: null, model: "sonnet",
    endpoint: null, branch: `agent/${id}`, modules: [], progress: 0, plan: [], modifiedFiles: [],
    log: [], startedAt: 1, lastHeartbeatAt: 1,
  };
}

function hitlFor(id: string, runId: string, raisedAt: number): HitlItem {
  return {
    id, workspaceId: WS, runId, bakeoffId: null, kind: "approval",
    title: `Approve ${id}`, why: "needs approval", risk: "medium",
    raisedAt, expiresAt: null, resolvedAt: null, resolution: null,
    rationale: null, command: "do it", options: null, recommended: null,
    steps: null, diff: null, output: null, flags: [], sourceBranchOverride: null,
  };
}

describe("cross-project decision backbone (TASK 15)", () => {
  let app: FastifyInstance;
  let store: MemoryStore;
  let ops: Operations;
  let bus: InProcessBus;
  let hub: Hub;
  let p1: Project;
  let p2: Project;

  beforeEach(async () => {
    store = new MemoryStore();
    bus = new InProcessBus();
    hub = new Hub(store, bus);
    const orchestrator = new Orchestrator(store, hub, new NullProvider());
    ops = new Operations({ store, hub, orchestrator });
    app = Fastify();
    await registerApi(app, { operations: ops, orchestrator });
    app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: "Not found" }));
    await app.ready();

    p1 = await ops.createProject(WS, { name: "Checkout", goal: "" });
    p2 = await ops.createProject(WS, { name: "Search", goal: "" });
  });

  it("GET /api/decisions returns open decisions from every project, joined and sorted by cost-of-waiting", async () => {
    const t1 = await ops.createTask(WS, p1.id, { text: "Migrate billing" });
    const t2 = await ops.createTask(WS, p2.id, { text: "Reindex catalog" });
    await hub.upsertRun(runFor("r1", p1.id));
    await hub.upsertRun(runFor("r2", p2.id));
    await hub.upsertTask({ ...t1, state: "ongoing", runId: "r1" });
    await hub.upsertTask({ ...t2, state: "ongoing", runId: "r2" });

    const nowTs = Date.now();
    // r1's decision has waited far longer than r2's — by construction, so the
    // sort assertion below can't be timing-flaky regardless of wall-clock drift
    // during the test run.
    await hub.raiseHitl(hitlFor("q-old", "r1", nowTs - 10_000));
    await hub.raiseHitl(hitlFor("q-new", "r2", nowTs - 1_000));
    // A resolved item must NOT appear on the list even though it's still in the queue.
    await hub.raiseHitl(hitlFor("q-resolved", "r1", nowTs - 20_000));
    await hub.resolveHitl("q-resolved", { action: "approve", optionIndex: null, guidance: null, targetBranch: null, memoryNote: null, by: "op", at: nowTs });

    const res = await app.inject({ method: "GET", url: "/api/decisions", headers: AUTH });
    expect(res.statusCode).toBe(200);
    const decisions = res.json() as Array<Record<string, unknown>>;

    expect(decisions.map((d) => d.id)).toEqual(["q-old", "q-new"]); // sorted, resolved excluded

    const old = decisions.find((d) => d.id === "q-old")!;
    expect(old.projectId).toBe(p1.id);
    expect(old.projectName).toBe("Checkout");
    expect(old.taskTitle).toBe("Migrate billing");
    expect(old.runId).toBe("r1");

    const fresh = decisions.find((d) => d.id === "q-new")!;
    expect(fresh.projectId).toBe(p2.id);
    expect(fresh.projectName).toBe("Search");
    expect(fresh.taskTitle).toBe("Reindex catalog");

    // Cost-of-waiting: longer-idle item ranks strictly higher (every project
    // weighs ×1 today — see the TODO in Operations.listDecisions for TASK 19).
    expect(old.costOfWaiting as number).toBeGreaterThan(fresh.costOfWaiting as number);
    expect(old.costOfWaiting as number).toBeGreaterThanOrEqual(9_000); // ~10s idle, minus test runtime slack
    expect(fresh.costOfWaiting as number).toBeGreaterThanOrEqual(500); // ~1s idle
  });

  it("a decision for a run whose task has no title yet still lists, with taskTitle null", async () => {
    // No Task at all points at this run — an edge the join must degrade
    // gracefully on rather than throw or drop the item.
    await hub.upsertRun(runFor("r-orphan", p1.id));
    await hub.raiseHitl(hitlFor("q-orphan", "r-orphan", Date.now() - 500));

    const res = await app.inject({ method: "GET", url: "/api/decisions", headers: AUTH });
    expect(res.statusCode).toBe(200);
    const [d] = res.json() as Array<Record<string, unknown>>;
    expect(d.id).toBe("q-orphan");
    expect(d.taskTitle).toBeNull();
    expect(d.projectId).toBe(p1.id);
  });

  it("a single workspace-level bus subscription receives hitl.raised for every project, not just one", async () => {
    const t1 = await ops.createTask(WS, p1.id, { text: "A" });
    const t2 = await ops.createTask(WS, p2.id, { text: "B" });
    await hub.upsertRun(runFor("r1", p1.id));
    await hub.upsertRun(runFor("r2", p2.id));
    await hub.upsertTask({ ...t1, state: "ongoing", runId: "r1" });
    await hub.upsertTask({ ...t2, state: "ongoing", runId: "r2" });

    const received: ServerEvent[] = [];
    const unsubscribe = bus.subscribe(WS, (e) => received.push(e));

    await hub.raiseHitl(hitlFor("q-p1", "r1", Date.now()));
    await hub.raiseHitl(hitlFor("q-p2", "r2", Date.now()));

    const raised = received.filter((e): e is Extract<ServerEvent, { type: "hitl.raised" }> => e.type === "hitl.raised");
    expect(raised.map((e) => e.item.id).sort()).toEqual(["q-p1", "q-p2"]);
    expect(raised.map((e) => e.item.runId).sort()).toEqual(["r1", "r2"]); // r1→p1, r2→p2 — two different projects, one subscription

    unsubscribe();
  });
});
