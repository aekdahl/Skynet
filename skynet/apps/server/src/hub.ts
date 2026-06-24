// ─── Hub ──────────────────────────────────────────────────────────────────
// Every domain mutation goes through here so it is *persisted then published*
// as a typed ServerEvent on the entity's workspace channel (Architecture Brief
// §06, steps 1–2). The API and orchestrator call these; the WS gateway just
// forwards the bus for the operator's workspace.

import type {
  Agent,
  HitlItem,
  PlanStep,
  Project,
  Resolution,
  Runner,
  Task,
} from "@skynet/shared";
import { now } from "./config.js";
import type { Bus } from "./bus.js";
import { computeConflicts } from "./derive/conflicts.js";
import type { Store } from "./store/store.js";

export class Hub {
  // Per-workspace set of already-emitted conflict keys, to avoid re-emitting.
  private conflictKeys = new Map<string, Set<string>>();

  constructor(private store: Store, private bus: Bus) {}

  /**
   * Recompute conflicts for a workspace and emit `conflict.detected` for any
   * newly-contested module (Backend Brief §09). Call after agent activity that
   * changes module sets or active status.
   */
  async refreshConflicts(workspaceId: string): Promise<void> {
    const agents = await this.store.listAgents(workspaceId);
    const seen = this.conflictKeys.get(workspaceId) ?? new Set<string>();
    for (const c of computeConflicts(agents)) {
      const key = `${c.moduleId}|${[...c.agentIds].sort().join(",")}`;
      if (seen.has(key)) continue;
      seen.add(key);
      this.bus.publish(workspaceId, { type: "conflict.detected", moduleId: c.moduleId, agentIds: c.agentIds });
    }
    this.conflictKeys.set(workspaceId, seen);
  }

  /** Resolve an agent's workspace so delta-only events land on the right channel. */
  private async wsOf(agentId: string): Promise<string | undefined> {
    return (await this.store.getAgent(agentId))?.workspaceId;
  }

  // ── agents ──────────────────────────────────────────────────────────────
  async createAgent(agent: Agent): Promise<Agent> {
    await this.store.putAgent(agent);
    this.bus.publish(agent.workspaceId, { type: "agent.started", agent });
    return agent;
  }

  async agentLog(agentId: string, line: string, detail?: string): Promise<void> {
    const at = now();
    await this.store.appendLog(agentId, at, line, detail);
    const ws = await this.wsOf(agentId);
    if (ws) this.bus.publish(ws, { type: "agent.log", agentId, at, line, detail });
  }

  async agentProgress(agentId: string, progress: number, plan: PlanStep[]): Promise<void> {
    const a = await this.store.getAgent(agentId);
    if (!a) return;
    await this.store.putAgent({ ...a, progress, plan });
    this.bus.publish(a.workspaceId, { type: "agent.progress", agentId, progress, plan });
  }

  async agentHeartbeat(agentId: string): Promise<void> {
    const a = await this.store.getAgent(agentId);
    if (!a) return;
    const at = now();
    await this.store.putAgent({ ...a, lastHeartbeatAt: at });
    this.bus.publish(a.workspaceId, { type: "agent.heartbeat", agentId, at });
  }

  async agentStatus(agentId: string, status: Agent["status"]): Promise<void> {
    const a = await this.store.getAgent(agentId);
    if (!a) return;
    await this.store.putAgent({ ...a, status });
    this.bus.publish(a.workspaceId, { type: "agent.status", agentId, status });
  }

  async agentCompleted(agentId: string, branch: string): Promise<void> {
    const ws = await this.wsOf(agentId);
    if (ws) this.bus.publish(ws, { type: "agent.completed", agentId, branch });
  }

  // ── HITL ────────────────────────────────────────────────────────────────
  async raiseHitl(item: HitlItem): Promise<HitlItem> {
    await this.store.putHitl(item);
    this.bus.publish(item.workspaceId, { type: "hitl.raised", item });
    return item;
  }

  /** Idempotent, first-writer-wins (Backend Brief §05); records the audit trail. */
  async resolveHitl(id: string, resolution: Resolution): Promise<HitlItem | undefined> {
    const item = await this.store.getHitl(id);
    if (!item) return undefined;
    if (item.resolution) return item; // already resolved — return existing
    const resolved: HitlItem = { ...item, resolution, resolvedAt: resolution.at };
    await this.store.putHitl(resolved);
    await this.store.recordAudit({
      workspaceId: item.workspaceId,
      hitlId: item.id,
      agentId: item.agentId,
      action: resolution.action,
      operatorId: resolution.by,
      at: resolution.at,
      payload: { optionIndex: resolution.optionIndex, guidance: resolution.guidance },
    });
    this.bus.publish(item.workspaceId, { type: "hitl.resolved", id, resolution });
    return resolved;
  }

  // ── collection CRUD ───────────────────────────────────────────────────────
  async upsertProject(project: Project): Promise<Project> {
    await this.store.putProject(project);
    this.bus.publish(project.workspaceId, { type: "project.upserted", project });
    return project;
  }
  async deleteProject(id: string): Promise<void> {
    const existing = await this.store.getProject(id);
    await this.store.deleteProject(id);
    if (existing) this.bus.publish(existing.workspaceId, { type: "project.deleted", id });
  }

  async upsertTask(task: Task): Promise<Task> {
    await this.store.putTask(task);
    this.bus.publish(task.workspaceId, { type: "task.upserted", task });
    return task;
  }
  async deleteTask(id: string): Promise<void> {
    const existing = await this.store.getTask(id);
    await this.store.deleteTask(id);
    if (existing) this.bus.publish(existing.workspaceId, { type: "task.deleted", id });
  }

  async upsertRunner(runner: Runner): Promise<Runner> {
    await this.store.putRunner(runner);
    this.bus.publish(runner.workspaceId, { type: "runner.upserted", runner });
    return runner;
  }
  async deleteRunner(id: string): Promise<void> {
    const existing = await this.store.getRunner(id);
    await this.store.deleteRunner(id);
    if (existing) this.bus.publish(existing.workspaceId, { type: "runner.deleted", id });
  }
}
