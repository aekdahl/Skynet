// ─── Hub ──────────────────────────────────────────────────────────────────
// Every domain mutation goes through here so it is *persisted then published*
// as a typed ServerEvent on the entity's workspace channel (Architecture Brief
// §06, steps 1–2). The API and orchestrator call these; the WS gateway just
// forwards the bus for the operator's workspace.

import type {
  TaskRun,
  Feature,
  HitlItem,
  Milestone,
  PlanStep,
  Project,
  Resolution,
  Agent,
  Task,
  Usage,
} from "@skynet/shared";
import { now } from "./config.js";
import type { Bus } from "./bus.js";
import { computeConflicts } from "./derive/conflicts.js";
import type { Store } from "./store/store.js";

/** The real change reviewed at a diff/merge gate, captured into the audit record
 *  at resolve time (the worktree is gone once merged, so it can't be re-fetched).
 *  The patch is size-capped by the worktree layer that produces it. */
export interface CapturedDiff {
  patch: string;
  files: string[];
}

export class Hub {
  // Per-workspace set of already-emitted conflict keys, to avoid re-emitting.
  private conflictKeys = new Map<string, Set<string>>();
  // Per-hitl-id promise chain so overlapping resolves of the same id run
  // serially — the read-check-write in resolveHitl is otherwise a TOCTOU race.
  private hitlLocks = new Map<string, Promise<unknown>>();

  constructor(private store: Store, private bus: Bus) {}

  /**
   * Recompute conflicts for a workspace and emit `conflict.detected` for any
   * newly-contested module (Backend Brief §09). Call after agent activity that
   * changes module sets or active status.
   */
  async refreshConflicts(workspaceId: string): Promise<void> {
    const runs = await this.store.listRuns(workspaceId);
    const seen = this.conflictKeys.get(workspaceId) ?? new Set<string>();
    for (const c of computeConflicts(runs)) {
      const key = `${c.moduleId}|${[...c.runIds].sort().join(",")}`;
      if (seen.has(key)) continue;
      seen.add(key);
      this.bus.publish(workspaceId, { type: "conflict.detected", moduleId: c.moduleId, runIds: c.runIds });
    }
    this.conflictKeys.set(workspaceId, seen);
  }

  /** Resolve an agent's workspace so delta-only events land on the right channel. */
  private async wsOf(runId: string): Promise<string | undefined> {
    return (await this.store.getRun(runId))?.workspaceId;
  }

  // ── runs ──────────────────────────────────────────────────────────────
  async createRun(run: TaskRun): Promise<TaskRun> {
    await this.store.putRun(run);
    this.bus.publish(run.workspaceId, { type: "run.started", run });
    return run;
  }

  async runLog(runId: string, line: string, detail?: string): Promise<void> {
    const at = now();
    await this.store.appendLog(runId, at, line, detail);
    const ws = await this.wsOf(runId);
    if (ws) this.bus.publish(ws, { type: "run.log", runId, at, line, detail });
  }

  /** Token-level "typing" delta — bus-only, deliberately no store.appendLog.
   *  Called once per streamed chunk (far more often than runLog), so a store
   *  write here would multiply DB writes per run by the token count. The
   *  finalized line still gets exactly one appendLog via runLog() above once
   *  the message completes — this is a live preview, not a second record. */
  async runLogDelta(runId: string, delta: string): Promise<void> {
    const ws = await this.wsOf(runId);
    if (ws) this.bus.publish(ws, { type: "run.log.delta", runId, delta });
  }

  async runProgress(runId: string, progress: number, plan: PlanStep[]): Promise<void> {
    const a = await this.store.getRun(runId);
    if (!a) return;
    await this.store.putRun({ ...a, progress, plan });
    this.bus.publish(a.workspaceId, { type: "run.progress", runId, progress, plan });
  }

  async runUsage(runId: string, usage: Usage): Promise<void> {
    const a = await this.store.getRun(runId);
    if (!a) return;
    await this.store.putRun({ ...a, usage });
    this.bus.publish(a.workspaceId, { type: "run.usage", runId, usage });
  }

  /** Persist the files a finished run actually changed (surfaced to the UI as
   *  modules, never raw paths). The store is the source of truth every view is
   *  derived from, so this is what makes the run reflect its real footprint. No
   *  dedicated delta event: modifiedFiles rides along in the run snapshot, and
   *  it's written alongside the run.status→review delta raised at review time. */
  async runModifiedFiles(runId: string, files: string[]): Promise<void> {
    const a = await this.store.getRun(runId);
    if (!a) return;
    await this.store.putRun({ ...a, modifiedFiles: files });
  }

  async runHeartbeat(runId: string): Promise<void> {
    const a = await this.store.getRun(runId);
    if (!a) return;
    const at = now();
    await this.store.putRun({ ...a, lastHeartbeatAt: at });
    this.bus.publish(a.workspaceId, { type: "run.heartbeat", runId, at });
  }

  async runStatus(runId: string, status: TaskRun["status"]): Promise<void> {
    const a = await this.store.getRun(runId);
    if (!a) return;
    await this.store.putRun({ ...a, status });
    this.bus.publish(a.workspaceId, { type: "run.status", runId, status });
  }

  async runCompleted(runId: string, branch: string): Promise<void> {
    const ws = await this.wsOf(runId);
    if (ws) this.bus.publish(ws, { type: "run.completed", runId, branch });
  }

  /** Persist a full run and broadcast a whole-run replace. For fields without a
   *  dedicated event (e.g. `pr`, the ready-to-merge record). */
  async upsertRun(run: TaskRun): Promise<TaskRun> {
    await this.store.putRun(run);
    this.bus.publish(run.workspaceId, { type: "run.updated", run });
    return run;
  }

  async setRunArchived(runId: string, archived: boolean): Promise<TaskRun | undefined> {
    const a = await this.store.getRun(runId);
    if (!a) return undefined;
    const updated = { ...a, archived };
    await this.store.putRun(updated);
    this.bus.publish(a.workspaceId, { type: "run.archived", runId, archived });
    return updated;
  }

  // ── HITL ────────────────────────────────────────────────────────────────
  async raiseHitl(item: HitlItem): Promise<HitlItem> {
    await this.store.putHitl(item);
    this.bus.publish(item.workspaceId, { type: "hitl.raised", item });
    return item;
  }

  /**
   * Insert a HITL item already resolved by policy (e.g. the approval-policy
   * auto-approver), atomically. This is the SILENT variant: we publish only
   * `hitl.resolved` — never `hitl.raised` — so downstream subscribers that treat
   * a raise as a human-facing notification (Telegram 🔔, phone push) don't spam
   * the operator about a decision that was already made. The full audit record
   * is still written, so the trail shows exactly what was auto-approved and by
   * which policy — nothing runs invisibly.
   */
  async raiseAndAutoResolveHitl(item: HitlItem, resolution: Resolution): Promise<HitlItem> {
    const resolved: HitlItem = { ...item, resolution, resolvedAt: resolution.at };
    await this.store.putHitl(resolved);
    await this.store.recordAudit({
      workspaceId: item.workspaceId,
      hitlId: item.id,
      runId: item.runId,
      action: resolution.action,
      operatorId: resolution.by,
      at: resolution.at,
      payload: {
        optionIndex: resolution.optionIndex,
        guidance: resolution.guidance,
        // Guided merge — the branch a policy-driven auto-approve integrated
        // into (diff/merge only; null when the default applied, or n/a).
        targetBranch: resolution.targetBranch,
        memoryNote: resolution.memoryNote,
        kind: item.kind,
        title: item.title,
        why: item.why,
        command: item.command,
        rationale: item.rationale,
        risk: item.risk,
        options: item.options,
        recommended: item.recommended,
        diff: item.diff,
        output: item.output,
      },
    });
    // Only publish `resolved` — a `raised` event here would ping Telegram/push.
    this.bus.publish(item.workspaceId, { type: "hitl.resolved", id: item.id, resolution });
    return resolved;
  }

  /**
   * Idempotent, first-writer-wins (Backend Brief §05); records the audit trail.
   *
   * Serialized per-hitl-id so truly concurrent resolves of the same id are
   * ordered: the read-check-write below has an `await` between the guard and
   * the write, so without this two overlapping resolves would both observe
   * `resolution === null` and each record an audit entry / double-deliver.
   * We chain onto any in-flight resolve for the same id and clean the entry
   * up once this is the tail of the chain.
   */
  async resolveHitl(
    id: string,
    resolution: Resolution,
    capturedDiff?: CapturedDiff,
  ): Promise<HitlItem | undefined> {
    const prior = this.hitlLocks.get(id) ?? Promise.resolve();
    const run = prior
      .catch(() => {}) // a prior failure must not poison the queue
      .then(() => this.doResolveHitl(id, resolution, capturedDiff));
    this.hitlLocks.set(id, run);
    try {
      return await run;
    } finally {
      // Only the last enqueued resolve clears the map, so we never drop a
      // still-pending chain.
      if (this.hitlLocks.get(id) === run) this.hitlLocks.delete(id);
    }
  }

  private async doResolveHitl(
    id: string,
    resolution: Resolution,
    capturedDiff?: CapturedDiff,
  ): Promise<HitlItem | undefined> {
    const item = await this.store.getHitl(id);
    if (!item) return undefined;
    if (item.resolution) return item; // already resolved — return existing
    const resolved: HitlItem = { ...item, resolution, resolvedAt: resolution.at };
    await this.store.putHitl(resolved);
    await this.store.recordAudit({
      workspaceId: item.workspaceId,
      hitlId: item.id,
      runId: item.runId,
      action: resolution.action,
      operatorId: resolution.by,
      at: resolution.at,
      // Snapshot the FULL gate + decision so the audit is self-contained — the
      // live HITL item leaves the queue once resolved, so the view can't re-derive
      // it. Captures the agent's rationale, the risk, and the options (so which
      // one was chosen still renders after the item is gone), not just the action.
      payload: {
        optionIndex: resolution.optionIndex,
        guidance: resolution.guidance,
        // Guided merge — the operator's chosen integration branch (diff/merge
        // approvals only; null otherwise, or when the default was left as-is).
        targetBranch: resolution.targetBranch,
        memoryNote: resolution.memoryNote,
        kind: item.kind,
        title: item.title,
        why: item.why,
        command: item.command,
        rationale: item.rationale,
        risk: item.risk,
        options: item.options,
        recommended: item.recommended,
        diff: item.diff,
        output: item.output,
        // The real change reviewed, captured at decision time — the worktree is
        // retired after merge, so the audit can't re-fetch it later. Only present
        // for diff/merge/verifier decisions; the patch is size-capped upstream.
        files: capturedDiff?.files,
        patch: capturedDiff?.patch,
      },
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

  async upsertFeature(feature: Feature): Promise<Feature> {
    await this.store.putFeature(feature);
    this.bus.publish(feature.workspaceId, { type: "feature.upserted", feature });
    return feature;
  }
  async deleteFeature(id: string): Promise<void> {
    const existing = await this.store.getFeature(id);
    await this.store.deleteFeature(id);
    if (existing) this.bus.publish(existing.workspaceId, { type: "feature.deleted", id });
  }

  async upsertMilestone(milestone: Milestone): Promise<Milestone> {
    await this.store.putMilestone(milestone);
    this.bus.publish(milestone.workspaceId, { type: "milestone.upserted", milestone });
    return milestone;
  }
  async deleteMilestone(id: string): Promise<void> {
    const existing = await this.store.getMilestone(id);
    await this.store.deleteMilestone(id);
    if (existing) this.bus.publish(existing.workspaceId, { type: "milestone.deleted", id });
  }

  async upsertAgent(agent: Agent): Promise<Agent> {
    await this.store.putAgent(agent);
    this.bus.publish(agent.workspaceId, { type: "agent.upserted", agent });
    return agent;
  }
  async deleteAgent(id: string): Promise<void> {
    const existing = await this.store.getAgent(id);
    await this.store.deleteAgent(id);
    if (existing) this.bus.publish(existing.workspaceId, { type: "agent.deleted", id });
  }

  // ── audit trail maintenance ─────────────────────────────────────────────
  // The trail isn't in the snapshot/WS state, so these events carry only
  // identity — clients re-fetch /api/audit when one lands. Workspace is passed
  // in (no getAudit(id)); callers resolve it from the request.
  async archiveAudit(workspaceId: string, hitlId: string, archived: boolean): Promise<void> {
    await this.store.setAuditArchived(workspaceId, hitlId, archived);
    this.bus.publish(workspaceId, { type: "audit.archived", hitlId, archived });
  }
  async deleteAudit(workspaceId: string, hitlId: string): Promise<void> {
    await this.store.deleteAudit(workspaceId, hitlId);
    this.bus.publish(workspaceId, { type: "audit.deleted", hitlId });
  }
  async archiveAllAudit(workspaceId: string): Promise<void> {
    await this.store.archiveAllAudit(workspaceId);
    this.bus.publish(workspaceId, { type: "audit.archived-all" });
  }
  async clearAudit(workspaceId: string): Promise<void> {
    await this.store.clearAudit(workspaceId);
    this.bus.publish(workspaceId, { type: "audit.cleared" });
  }
}
