// Operations is the shared service layer behind both the HTTP API and the MCP
// server. These guard the behaviour the routes used to inline: workspace-scoped
// existence checks (→ NotFoundError), the busy-runner guard (→ RunnerBusyError),
// and idempotent HITL resolution.
import { describe, it, expect } from "vitest";
import type { HitlItem, ProviderId, Runner } from "@skynet/shared";
import { DEFAULT_WORKSPACE } from "@skynet/shared";
import { Hub } from "../apps/server/src/hub.js";
import { Orchestrator } from "../apps/server/src/orchestrator.js";
import { NotFoundError, Operations, RunnerBusyError } from "../apps/server/src/operations.js";
import { MemoryStore } from "../apps/server/src/store/memory.js";
import type { Bus } from "../apps/server/src/bus.js";
import type { RunnerEvents, RunnerHandle, RunnerProvider, StartSpec } from "@skynet/runner-sdk";

class NullBus implements Bus {
  publish(): void {}
  subscribe(): () => void {
    return () => {};
  }
}

// A runner that keeps running — never completes/fails — so an assigned agent
// (and its busy runner) stay put while we exercise operations against them.
class RunningProvider implements RunnerProvider {
  readonly id: ProviderId = "claude";
  async start(spec: StartSpec, _events: RunnerEvents): Promise<RunnerHandle> {
    return { agentId: spec.agentId, provider: this.id, async pause() {}, async resume() {}, async message() {}, async stop() {} };
  }
}

function setup() {
  const store = new MemoryStore({ seed: false });
  const hub = new Hub(store, new NullBus());
  const orchestrator = new Orchestrator(store, hub, new RunningProvider());
  const ops = new Operations({ store, hub, orchestrator });
  return { store, hub, ops };
}

describe("Operations — workspace-scoped domain layer", () => {
  it("runs the project → task → assign flow and scopes reads to the workspace", async () => {
    const { store, ops } = setup();
    await store.putRunner({ id: "r1", workspaceId: DEFAULT_WORKSPACE, name: "r1", provider: "claude", model: "opus-4.8", status: "idle", idleSince: 0 });

    const project = await ops.createProject(DEFAULT_WORKSPACE, { name: "Proj", goal: "ship it", repo: undefined });
    const task = await ops.createTask(DEFAULT_WORKSPACE, project.id, { text: "do the thing" });
    const agent = await ops.assignTask(DEFAULT_WORKSPACE, project.id, task.id);

    expect((await ops.listProjects(DEFAULT_WORKSPACE)).map((p) => p.id)).toContain(project.id);
    expect((await store.getTask(task.id))?.agentId).toBe(agent.id);
    // The agent belongs to this workspace, not another.
    expect((await ops.getAgent(DEFAULT_WORKSPACE, agent.id)).id).toBe(agent.id);
    await expect(ops.getAgent("resistance", agent.id)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("rejects cross-workspace access with NotFoundError", async () => {
    const { ops } = setup();
    const mine = await ops.createProject(DEFAULT_WORKSPACE, { name: "Mine", goal: "", repo: undefined });
    // Same id, wrong workspace → 404, never a cross-tenant mutation.
    await expect(ops.updateProject("resistance", mine.id, { name: "hijack" })).rejects.toBeInstanceOf(NotFoundError);
    await expect(ops.deleteTask(DEFAULT_WORKSPACE, "no-such-task")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("refuses to retire a busy runner", async () => {
    const { store, ops } = setup();
    await store.putRunner({ id: "r1", workspaceId: DEFAULT_WORKSPACE, name: "r1", provider: "claude", model: "opus-4.8", status: "idle", idleSince: 0 } satisfies Runner);
    const project = await ops.createProject(DEFAULT_WORKSPACE, { name: "P", goal: "", repo: undefined });
    const task = await ops.createTask(DEFAULT_WORKSPACE, project.id, { text: "x" });
    await ops.assignTask(DEFAULT_WORKSPACE, project.id, task.id); // r1 → busy

    await expect(ops.retireRunner(DEFAULT_WORKSPACE, "r1")).rejects.toBeInstanceOf(RunnerBusyError);
  });

  it("promotes and demotes backlog tasks, with bounds no-ops", async () => {
    const { store, ops } = setup();
    const project = await ops.createProject(DEFAULT_WORKSPACE, { name: "P", goal: "", repo: undefined });
    // Created in order a, b, c → orders 0, 1, 2 (top → bottom).
    const a = await ops.createTask(DEFAULT_WORKSPACE, project.id, { text: "a" });
    const b = await ops.createTask(DEFAULT_WORKSPACE, project.id, { text: "b" });
    const c = await ops.createTask(DEFAULT_WORKSPACE, project.id, { text: "c" });

    const orderOf = async () => {
      const tasks = await store.listTasks(DEFAULT_WORKSPACE);
      return [a, b, c]
        .map((t) => tasks.find((x) => x.id === t.id)!)
        .sort((x, y) => (x.order ?? 0) - (y.order ?? 0))
        .map((t) => t.text);
    };
    expect(await orderOf()).toEqual(["a", "b", "c"]);

    // Promote c → swaps with b: a, c, b.
    await ops.moveTask(DEFAULT_WORKSPACE, c.id, "up");
    expect(await orderOf()).toEqual(["a", "c", "b"]);

    // Demote a → swaps with c: c, a, b.
    await ops.moveTask(DEFAULT_WORKSPACE, a.id, "down");
    expect(await orderOf()).toEqual(["c", "a", "b"]);

    // Promoting the top task is a no-op; demoting the bottom is a no-op.
    await ops.moveTask(DEFAULT_WORKSPACE, c.id, "up");
    await ops.moveTask(DEFAULT_WORKSPACE, b.id, "down");
    expect(await orderOf()).toEqual(["c", "a", "b"]);

    // Cross-workspace move is a 404, never a silent reorder.
    await expect(ops.moveTask("resistance", a.id, "up")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("pause / resume drive the agent status and are workspace-scoped", async () => {
    const { store, ops } = setup();
    await store.putRunner({ id: "r1", workspaceId: DEFAULT_WORKSPACE, name: "r1", provider: "claude", model: "opus-4.8", status: "idle", idleSince: 0 });
    const project = await ops.createProject(DEFAULT_WORKSPACE, { name: "P", goal: "", repo: undefined });
    const task = await ops.createTask(DEFAULT_WORKSPACE, project.id, { text: "x" });
    const agent = await ops.assignTask(DEFAULT_WORKSPACE, project.id, task.id);

    const paused = await ops.pauseAgent(DEFAULT_WORKSPACE, agent.id);
    expect(paused.status).toBe("paused");
    const resumed = await ops.resumeAgent(DEFAULT_WORKSPACE, agent.id);
    expect(resumed.status).toBe("running");

    // Another workspace can't see (or drive) this agent.
    await expect(ops.pauseAgent("resistance", agent.id)).rejects.toBeInstanceOf(NotFoundError);
    await expect(ops.resumeAgent("resistance", agent.id)).rejects.toBeInstanceOf(NotFoundError);
  });

  it("stop is terminal: marks the agent done AND frees its runner to idle", async () => {
    const { store, ops } = setup();
    await store.putRunner({ id: "r1", workspaceId: DEFAULT_WORKSPACE, name: "r1", provider: "claude", model: "opus-4.8", status: "idle", idleSince: 0 });
    const project = await ops.createProject(DEFAULT_WORKSPACE, { name: "P", goal: "", repo: undefined });
    const task = await ops.createTask(DEFAULT_WORKSPACE, project.id, { text: "x" });
    const agent = await ops.assignTask(DEFAULT_WORKSPACE, project.id, task.id);
    expect((await store.getRunner("r1"))?.status).toBe("busy");

    // The operator-facing stop must halt (terminal + runner freed), NOT the
    // detach-only path that leaves the agent hanging non-terminal.
    const stopped = await ops.stopAgent(DEFAULT_WORKSPACE, agent.id);
    expect(stopped.status).toBe("done");
    expect((await store.getRunner("r1"))?.status).toBe("idle");

    await expect(ops.stopAgent("resistance", "no-such")).rejects.toBeInstanceOf(NotFoundError);
  });

  it("resolves a HITL item once, recording who decided (idempotent)", async () => {
    const { hub, ops, store } = setup();
    const item: HitlItem = {
      id: "q1", workspaceId: DEFAULT_WORKSPACE, agentId: "a1", kind: "approval",
      title: "Run migration?", why: "schema change", risk: "high",
      raisedAt: 0, resolvedAt: null, resolution: null,
      command: "migrate", options: null, recommended: null, steps: null, diff: null,
    };
    await hub.raiseHitl(item);

    const resolved = await ops.resolveHitl(DEFAULT_WORKSPACE, "q1", { action: "approve" }, "jordan");
    expect(resolved.resolution?.by).toBe("jordan");
    expect(resolved.resolvedAt).not.toBeNull();

    // Second resolve is a no-op: the original decision stands (first-writer wins).
    const again = await ops.resolveHitl(DEFAULT_WORKSPACE, "q1", { action: "reject" }, "someone-else");
    expect(again.resolution?.action).toBe("approve");
    expect(again.resolution?.by).toBe("jordan");

    // The decision is on the audit trail exactly once.
    const audit = await store.listAudit(DEFAULT_WORKSPACE);
    expect(audit.filter((a) => a.hitlId === "q1")).toHaveLength(1);

    // A HITL item in another workspace is invisible here.
    await expect(ops.resolveHitl("resistance", "q1", { action: "approve" }, "kyle")).rejects.toBeInstanceOf(NotFoundError);
  });
});
