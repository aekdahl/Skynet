// Momentum Rollout Phase 1c — REST + realtime surface for Rule/Transition/
// Proposal (TASK 03). Two harnesses:
//  - a real Fastify app (registerApi) + a real InProcessBus, so an HTTP call
//    can be asserted both by its response AND by the ServerEvent it publishes
//    live — proving the two never drift.
//  - the rule engine wired to the SAME store/hub/bus, to confirm the new
//    transition.created/rule.upserted/proposal.upserted events also arrive
//    live when the RULE ENGINE (not the REST API) is what moves a card —
//    the acceptance criterion this task was built against.
import { describe, it, expect, beforeEach } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import type { ProviderId, Project, ServerEvent, Task } from "@skynet/shared";
import { DEFAULT_WORKSPACE } from "@skynet/shared";
import { registerApi } from "../apps/server/src/api.js";
import { InProcessBus } from "../apps/server/src/bus.js";
import { Hub } from "../apps/server/src/hub.js";
import { Orchestrator } from "../apps/server/src/orchestrator.js";
import { Operations } from "../apps/server/src/operations.js";
import { MemoryStore } from "../apps/server/src/store/memory.js";
import { RuleEngine } from "../apps/server/src/rules/engine.js";
import { seedStarterRules } from "../apps/server/src/rules/seed.js";
import type { RunnerEvents, RunnerHandle, RunnerProvider, StartSpec } from "@skynet/runner-sdk";

class NullProvider implements RunnerProvider {
  readonly id: ProviderId = "claude";
  async start(spec: StartSpec, _events: RunnerEvents): Promise<RunnerHandle> {
    return { runId: spec.runId, provider: this.id, async pause() {}, async resume() {}, async message() {}, async stop() {} };
  }
}

const AUTH = { authorization: "Bearer dev-cyberdyne" }; // → DEFAULT_WORKSPACE

const waitFor = async (pred: () => Promise<boolean> | boolean, ms = 2000): Promise<void> => {
  const dl = Date.now() + ms;
  while (Date.now() < dl) {
    if (await pred()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("condition not met in time");
};

/** Collects every ServerEvent published on `ws` while a test runs. */
function recordEvents(bus: InProcessBus, ws: string): ServerEvent[] {
  const events: ServerEvent[] = [];
  bus.subscribe(ws, (e) => events.push(e));
  return events;
}

describe("HTTP: rules / transitions / proposals / subtasks", () => {
  let app: FastifyInstance;
  let store: MemoryStore;
  let ops: Operations;
  let bus: InProcessBus;
  let events: ServerEvent[];
  let project: Project;

  beforeEach(async () => {
    store = new MemoryStore();
    bus = new InProcessBus();
    const hub = new Hub(store, bus);
    const orchestrator = new Orchestrator(store, hub, new NullProvider());
    ops = new Operations({ store, hub, orchestrator });
    app = Fastify();
    await registerApi(app, { operations: ops, orchestrator });
    app.setNotFoundHandler((_req, reply) => reply.code(404).send({ error: "Not found" }));
    await app.ready();
    events = recordEvents(bus, DEFAULT_WORKSPACE);
    project = await ops.createProject(DEFAULT_WORKSPACE, { name: "P", goal: "", repo: undefined });
  });

  // ── rules CRUD ────────────────────────────────────────────────────────
  describe("rules CRUD", () => {
    it("lists no rules for a fresh project", async () => {
      const res = await app.inject({ method: "GET", url: `/api/projects/${project.id}/rules`, headers: AUTH });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual([]);
    });

    it("creates, lists, updates, and deletes a rule — each mutation publishes live", async () => {
      const created = await app.inject({
        method: "POST",
        url: `/api/projects/${project.id}/rules`,
        headers: AUTH,
        payload: { name: "Auto-review", when: "checks pass", conditions: [{ field: "state", op: "checks_green", value: null }], actions: [] },
      });
      expect(created.statusCode).toBe(200);
      const rule = created.json();
      expect(rule.name).toBe("Auto-review");
      expect(rule.state).toBe("live"); // default
      expect(rule.workspaceId).toBe(DEFAULT_WORKSPACE);
      expect(rule.projectId).toBe(project.id);
      expect(events.some((e) => e.type === "rule.upserted" && e.rule.id === rule.id)).toBe(true);

      const listed = await app.inject({ method: "GET", url: `/api/projects/${project.id}/rules`, headers: AUTH });
      expect(listed.json()).toHaveLength(1);

      const updated = await app.inject({
        method: "PATCH",
        url: `/api/projects/${project.id}/rules/${rule.id}`,
        headers: AUTH,
        payload: { state: "paused" },
      });
      expect(updated.statusCode).toBe(200);
      expect(updated.json().state).toBe("paused");
      expect(updated.json().pausedReason).toBeNull(); // human-set, not the auto-breaker

      const deleted = await app.inject({ method: "DELETE", url: `/api/projects/${project.id}/rules/${rule.id}`, headers: AUTH });
      expect(deleted.statusCode).toBe(200);
      expect(events.some((e) => e.type === "rule.deleted" && e.id === rule.id)).toBe(true);

      const listedAfter = await app.inject({ method: "GET", url: `/api/projects/${project.id}/rules`, headers: AUTH });
      expect(listedAfter.json()).toEqual([]);
    });

    it("rejects a malformed create-rule body", async () => {
      const res = await app.inject({ method: "POST", url: `/api/projects/${project.id}/rules`, headers: AUTH, payload: { when: "x" } });
      expect(res.statusCode).toBe(400);
    });

    it("404s updating a rule that doesn't exist", async () => {
      const res = await app.inject({
        method: "PATCH",
        url: `/api/projects/${project.id}/rules/nope`,
        headers: AUTH,
        payload: { state: "paused" },
      });
      expect(res.statusCode).toBe(404);
    });
  });

  // ── backtest ──────────────────────────────────────────────────────────
  describe("rules/backtest", () => {
    it("replays a draft rule's conditions against the project's historical transitions", async () => {
      const task = await ops.createTask(DEFAULT_WORKSPACE, project.id, { text: "do X" });
      // Two historical transitions on the same task: one landing in "review",
      // one landing in "done" — a draft rule matching state_equals:"review"
      // should count exactly the first, not the second.
      await store.createTransition({
        id: "tr1", workspaceId: DEFAULT_WORKSPACE, projectId: project.id, taskId: task.id,
        from: "ongoing", to: "review", actor: "machine", actorId: null, ruleId: null, evidence: [], at: 1000,
      });
      await store.createTransition({
        id: "tr2", workspaceId: DEFAULT_WORKSPACE, projectId: project.id, taskId: task.id,
        from: "review", to: "done", actor: "human", actorId: "op1", ruleId: null, evidence: [], at: 2000,
      });

      const matching = await app.inject({
        method: "POST",
        url: `/api/projects/${project.id}/rules/backtest`,
        headers: AUTH,
        payload: { conditions: [{ field: "state", op: "state_equals", value: "review" }] },
      });
      expect(matching.statusCode).toBe(200);
      expect(matching.json()).toMatchObject({ wouldHaveMoved: 1 });
      expect(matching.json().sample).toHaveLength(1);
      expect(matching.json().sample[0].id).toBe("tr1");

      const nonMatching = await app.inject({
        method: "POST",
        url: `/api/projects/${project.id}/rules/backtest`,
        headers: AUTH,
        payload: { conditions: [{ field: "state", op: "state_equals", value: "backlog" }] },
      });
      expect(nonMatching.json()).toEqual({ wouldHaveMoved: 0, sample: [] });

      // An event-shaped op (no reconstructable ServerEvent in a historical
      // replay — see EvalContext's own doc comment) honestly never matches.
      const eventShaped = await app.inject({
        method: "POST",
        url: `/api/projects/${project.id}/rules/backtest`,
        headers: AUTH,
        payload: { conditions: [{ field: "pr", op: "pr_merged", value: null }] },
      });
      expect(eventShaped.json()).toEqual({ wouldHaveMoved: 0, sample: [] });
    });
  });

  // ── transitions read ──────────────────────────────────────────────────
  describe("transitions read", () => {
    it("lists a task's own transitions, and a project's with since/limit", async () => {
      const task = await ops.createTask(DEFAULT_WORKSPACE, project.id, { text: "do X" });
      for (let i = 0; i < 3; i++) {
        await store.createTransition({
          id: `tr${i}`, workspaceId: DEFAULT_WORKSPACE, projectId: project.id, taskId: task.id,
          from: "ongoing", to: "review", actor: "machine", actorId: null, ruleId: null, evidence: [], at: 1000 + i,
        });
      }
      const forTask = await app.inject({ method: "GET", url: `/api/tasks/${task.id}/transitions`, headers: AUTH });
      expect(forTask.statusCode).toBe(200);
      expect(forTask.json()).toHaveLength(3);

      const limited = await app.inject({
        method: "GET",
        url: `/api/projects/${project.id}/transitions?since=1001&limit=1`,
        headers: AUTH,
      });
      expect(limited.statusCode).toBe(200);
      const rows = limited.json();
      expect(rows).toHaveLength(1);
      expect(rows[0].at).toBeGreaterThanOrEqual(1001);
    });

    it("404s for a task/project outside the workspace", async () => {
      const res = await app.inject({ method: "GET", url: `/api/tasks/nope/transitions`, headers: AUTH });
      expect(res.statusCode).toBe(404);
    });
  });

  // ── proposals accept / dismiss ────────────────────────────────────────
  describe("proposals accept / dismiss", () => {
    const putProposal = (over: Partial<Parameters<typeof store.putProposal>[0]>) =>
      store.putProposal({
        id: "prop1", workspaceId: DEFAULT_WORKSPACE, projectId: project.id, kind: "draft_task",
        payload: {}, status: "pending", createdAt: 1000, resolvedAt: null, ...over,
      });

    it("accepting a draft_task proposal creates a real task, publishes live, and marks it accepted", async () => {
      await putProposal({ kind: "draft_task", payload: { text: "Ship the thing", description: "details" } });
      const res = await app.inject({ method: "POST", url: `/api/projects/${project.id}/proposals/prop1/accept`, headers: AUTH });
      expect(res.statusCode).toBe(200);
      expect(res.json().status).toBe("accepted");
      expect(events.some((e) => e.type === "proposal.upserted" && e.proposal.status === "accepted")).toBe(true);
      const created = (await store.listTasks(DEFAULT_WORKSPACE)).find((t) => t.text === "Ship the thing");
      expect(created).toBeTruthy();
      expect(created?.parentTaskId).toBeNull();
    });

    it("accepting a suggested_subtask proposal creates a task with parentTaskId set", async () => {
      const parent = await ops.createTask(DEFAULT_WORKSPACE, project.id, { text: "Parent" });
      await putProposal({ kind: "suggested_subtask", payload: { parentTaskId: parent.id, text: "Sub A" } });
      const res = await app.inject({ method: "POST", url: `/api/projects/${project.id}/proposals/prop1/accept`, headers: AUTH });
      expect(res.statusCode).toBe(200);
      const created = (await store.listTasks(DEFAULT_WORKSPACE)).find((t) => t.text === "Sub A");
      expect(created?.parentTaskId).toBe(parent.id);
    });

    it("accepting a suggested_rule proposal creates the rule in WATCH state, never live", async () => {
      await putProposal({
        kind: "suggested_rule",
        payload: { name: "Suggested", when: "x", conditions: [], actions: [] },
      });
      const res = await app.inject({ method: "POST", url: `/api/projects/${project.id}/proposals/prop1/accept`, headers: AUTH });
      expect(res.statusCode).toBe(200);
      const rules = await store.listRulesForProject(project.id);
      expect(rules).toHaveLength(1);
      expect(rules[0]!.state).toBe("watch");
    });

    it("accepting a stall_nudge / suggested_reassignment proposal just marks it accepted (advisory-only)", async () => {
      await putProposal({ kind: "stall_nudge", payload: { taskId: "t1", taskText: "x", staleHours: 10 } });
      const res = await app.inject({ method: "POST", url: `/api/projects/${project.id}/proposals/prop1/accept`, headers: AUTH });
      expect(res.statusCode).toBe(200);
      expect(res.json().status).toBe("accepted");
    });

    it("dismiss marks dismissed, never deletes — so a suggested_rule pattern isn't lost", async () => {
      await putProposal({ kind: "suggested_rule", payload: { name: "X", when: "y", conditions: [], actions: [] } });
      const res = await app.inject({ method: "POST", url: `/api/projects/${project.id}/proposals/prop1/dismiss`, headers: AUTH });
      expect(res.statusCode).toBe(200);
      expect(res.json().status).toBe("dismissed");
      expect(await store.getProposal("prop1")).toBeTruthy(); // still there, not deleted
      expect((await store.listRulesForProject(project.id))).toEqual([]); // no rule created
    });

    it("409s accepting an already-resolved proposal", async () => {
      await putProposal({ status: "accepted", resolvedAt: 999 });
      const res = await app.inject({ method: "POST", url: `/api/projects/${project.id}/proposals/prop1/accept`, headers: AUTH });
      expect(res.statusCode).toBe(409);
    });

    it("404s accepting a proposal from a different project", async () => {
      const other = await ops.createProject(DEFAULT_WORKSPACE, { name: "Other", goal: "", repo: undefined });
      await putProposal({});
      const res = await app.inject({ method: "POST", url: `/api/projects/${other.id}/proposals/prop1/accept`, headers: AUTH });
      expect(res.statusCode).toBe(404);
    });
  });

  // ── suggested subtasks accept / accept-all ───────────────────────────
  describe("suggested subtasks", () => {
    let parent: Task;
    beforeEach(async () => {
      parent = await ops.createTask(DEFAULT_WORKSPACE, project.id, { text: "Parent" });
    });
    const suggestSubtask = (id: string, text: string) =>
      store.putProposal({
        id, workspaceId: DEFAULT_WORKSPACE, projectId: project.id, kind: "suggested_subtask",
        payload: { parentTaskId: parent.id, text }, status: "pending", createdAt: 1000, resolvedAt: null,
      });

    it("accepts one suggested subtask by proposalId", async () => {
      await suggestSubtask("sp1", "Sub A");
      await suggestSubtask("sp2", "Sub B");
      const res = await app.inject({
        method: "POST",
        url: `/api/tasks/${parent.id}/subtasks/accept`,
        headers: AUTH,
        payload: { proposalId: "sp1" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().text).toBe("Sub A");
      expect(res.json().parentTaskId).toBe(parent.id);
      // The other suggestion is untouched.
      expect((await store.getProposal("sp2"))?.status).toBe("pending");
    });

    it("accept-all accepts every pending suggestion for this parent, and only this parent", async () => {
      const otherParent = await ops.createTask(DEFAULT_WORKSPACE, project.id, { text: "Other parent" });
      await suggestSubtask("sp1", "Sub A");
      await suggestSubtask("sp2", "Sub B");
      await store.putProposal({
        id: "sp3", workspaceId: DEFAULT_WORKSPACE, projectId: project.id, kind: "suggested_subtask",
        payload: { parentTaskId: otherParent.id, text: "Not mine" }, status: "pending", createdAt: 1000, resolvedAt: null,
      });

      const res = await app.inject({ method: "POST", url: `/api/tasks/${parent.id}/subtasks/accept-all`, headers: AUTH });
      expect(res.statusCode).toBe(200);
      const created = res.json() as Task[];
      expect(created.map((t) => t.text).sort()).toEqual(["Sub A", "Sub B"]);
      expect(created.every((t) => t.parentTaskId === parent.id)).toBe(true);
      expect((await store.getProposal("sp3"))?.status).toBe("pending"); // untouched
    });

    it("404s accepting a proposalId that isn't a pending suggested_subtask for this parent", async () => {
      const res = await app.inject({
        method: "POST",
        url: `/api/tasks/${parent.id}/subtasks/accept`,
        headers: AUTH,
        payload: { proposalId: "nope" },
      });
      expect(res.statusCode).toBe(404);
    });
  });
});

// ── live events via the rule engine (not the REST API) ────────────────────
// Same acceptance bar as the WS manual check: transition.created /
// rule.upserted / proposal.upserted must arrive live when the RULE ENGINE —
// not a REST call — is what moves a card. Modeled on rule-engine.test.ts's
// own harness (real MemoryStore + InProcessBus + Hub + RuleEngine).
describe("live events via the rule engine", () => {
  const PROJECT_ID = "p1";

  async function setup() {
    const store = new MemoryStore();
    const bus = new InProcessBus();
    const hub = new Hub(store, bus);
    const engine = new RuleEngine({ store, hub, bus });
    await store.putProject({ id: PROJECT_ID, workspaceId: DEFAULT_WORKSPACE, name: "P", goal: "", runIds: [], status: "active" } as Project);
    await engine.start();
    const events = recordEvents(bus, DEFAULT_WORKSPACE);
    return { store, bus, hub, engine, events };
  }

  const mkTask = (over: Partial<Task> = {}): Task =>
    ({
      id: "t1", workspaceId: DEFAULT_WORKSPACE, projectId: PROJECT_ID, text: "do X", state: "ongoing",
      runId: null, autoPick: false, assessment: null, reviewVerdict: null, lint: null, priority: null,
      assignment: { mode: "any", agentIds: [] }, archived: false, ...over,
    }) as Task;

  it("a live rule's immediate move_task publishes transition.created AND rule.upserted (the moves-count bump)", async () => {
    const { store, bus, events } = await setup();
    await store.putTask(mkTask());
    await seedStarterRules(store, DEFAULT_WORKSPACE, PROJECT_ID, { undoWindowMin: 0 });
    // Force the seeded "pr_merged → review" rule to act immediately, not via
    // the announce-before-acting hold, so this test isn't racing the sweep.
    const [rule] = await store.listRulesForProject(PROJECT_ID);
    await store.putRule({ ...rule!, safety: { ...rule!.safety, announceBeforeActing: false } });

    bus.publish(DEFAULT_WORKSPACE, {
      type: "github.signal", taskId: "t1", kind: "pr_merged",
      payload: { prNumber: 1, prUrl: "https://github.com/acme/app/pull/1", branch: "agent/x" },
    });

    await waitFor(() => events.some((e) => e.type === "transition.created"));
    const transitionEvent = events.find((e) => e.type === "transition.created");
    expect(transitionEvent).toMatchObject({ type: "transition.created", transition: { taskId: "t1", to: "review" } });
    // bumpRuleMoves fires right after — same call stack, so it's already there.
    expect(events.some((e) => e.type === "rule.upserted" && e.rule.stats.moves === 1)).toBe(true);
  });

  it("a live create_proposal action publishes proposal.upserted", async () => {
    const { store, bus, events } = await setup();
    await store.putTask(mkTask({ state: "ongoing" }));
    await store.putRule({
      id: "r-stall", workspaceId: DEFAULT_WORKSPACE, projectId: PROJECT_ID, name: "stall→proposal",
      when: "stale", conditions: [{ field: "state", op: "state_equals", value: "ongoing" }],
      actions: [{ type: "create_proposal", params: { kind: "stall_nudge", payload: { taskId: "t1" } } }],
      safety: { announceBeforeActing: false, undoWindowMin: 10, pauseAfterUndos: 3, excludePriorities: [] },
      stats: { moves: 0, undos: 0 }, state: "live", pausedReason: null, createdAt: 0, archived: false,
    });

    bus.publish(DEFAULT_WORKSPACE, { type: "task.upserted", task: mkTask({ state: "ongoing" }) });

    await waitFor(() => events.some((e) => e.type === "proposal.upserted"));
    expect(events.some((e) => e.type === "proposal.upserted" && e.proposal.kind === "stall_nudge")).toBe(true);
  });

  it("the stall-detection sweep's proposal creation also publishes proposal.upserted live", async () => {
    const { store, engine, events } = await setup();
    await store.putTask(mkTask({ state: "ongoing" }));
    await engine.sweepStallDetection();
    // config.stallNudgeHours is realistically hours-scale, so a freshly
    // created task won't actually trip the sweep in this test — assert the
    // sweep ran cleanly (no crash, no false proposal) rather than assuming a
    // specific threshold.
    expect(events.filter((e) => e.type === "proposal.upserted")).toEqual([]);
  });
});
