// ─── In-memory store ──────────────────────────────────────────────────────
// Phase 0 persistence: Maps seeded from fixtures. Implements the Store
// interface so the Postgres adapter is a drop-in replacement. Lists are
// scoped by workspace; reference data is global for now.

import type {
  TaskRun,
  Checkpoint,
  Dependency,
  Feature,
  GithubConnection,
  HitlItem,
  Milestone,
  Module,
  PolicyVersion,
  Project,
  ProviderInfo,
  Agent,
  Snapshot,
  SolutionBrief,
  Task,
  WorkspaceSettings,
} from "@skynet/shared";
import type { AuditRecord } from "@skynet/shared";
import { chainAuditRecord } from "../audit-chain.js";
import { now } from "../config.js";
import type { Store } from "./store.js";
import type { StoredServiceToken } from "../auth/service-tokens.js";
import { PROVIDERS } from "./providers.js";

export class MemoryStore implements Store {
  // `protected` so a persistence subclass (FileStore) can load/serialize them.
  protected runs = new Map<string, TaskRun>();
  protected checkpoints = new Map<string, Checkpoint>();
  protected queue = new Map<string, HitlItem>();
  protected projects = new Map<string, Project>();
  protected tasks = new Map<string, Task>();
  protected features = new Map<string, Feature>();
  protected milestones = new Map<string, Milestone>();
  protected solutionBriefs = new Map<string, SolutionBrief>();
  protected fleet = new Map<string, Agent>();
  protected modules: Module[] = [];
  protected deps: Dependency[] = [];
  protected audit: AuditRecord[] = [];
  protected github = new Map<string, GithubConnection>(); // keyed by workspaceId
  protected workspaceSettings = new Map<string, WorkspaceSettings>(); // keyed by workspaceId
  protected policyVersions = new Map<string, PolicyVersion>(); // keyed by id
  protected githubTokens = new Map<string, string>(); // workspaceId → sealed PAT ciphertext
  protected serviceTokens = new Map<string, StoredServiceToken>(); // keyed by id (holds a hash, never the raw token)
  private providers: ProviderInfo[] = PROVIDERS;

  /** Hook called after every mutation. No-op in memory; FileStore overrides it
   *  to schedule a debounced write to disk. */
  protected persist(): void {}

  // The store always starts empty — a fresh install has no projects/runs until
  // the operator creates them. (No demo fixtures; the provider catalog is the
  // only prefilled data, and it's live configuration.)

  async snapshot(workspaceId: string): Promise<Snapshot> {
    return {
      runs: await this.listRuns(workspaceId),
      queue: await this.listQueue(workspaceId),
      projects: await this.listProjects(workspaceId),
      tasks: await this.listTasks(workspaceId),
      features: await this.listFeatures(workspaceId),
      milestones: await this.listMilestones(workspaceId),
      solutionBriefs: await this.listSolutionBriefs(workspaceId),
      fleet: await this.listAgents(workspaceId),
      modules: this.modules,
      deps: this.deps,
      providers: this.providers,
      serverTime: now(),
    };
  }

  async listRuns(ws: string) { return [...this.runs.values()].filter((a) => a.workspaceId === ws); }
  async listAllRuns() { return [...this.runs.values()]; }
  async getRun(id: string) { return this.runs.get(id); }
  async putRun(agent: TaskRun) { this.runs.set(agent.id, agent); this.persist(); return agent; }
  async appendLog(runId: string, at: number, line: string, detail?: string) {
    const a = this.runs.get(runId);
    if (a) { a.log.push(detail ? { at, line, detail } : { at, line }); this.persist(); }
  }

  async listCheckpoints(runId: string) {
    return [...this.checkpoints.values()].filter((c) => c.runId === runId).sort((a, b) => a.createdAt - b.createdAt);
  }
  async getCheckpoint(id: string) { return this.checkpoints.get(id); }
  async putCheckpoint(checkpoint: Checkpoint) { this.checkpoints.set(checkpoint.id, checkpoint); this.persist(); return checkpoint; }

  async listQueue(ws: string) { return [...this.queue.values()].filter((q) => q.workspaceId === ws); }
  async getHitl(id: string) { return this.queue.get(id); }
  async putHitl(item: HitlItem) { this.queue.set(item.id, item); this.persist(); return item; }

  async listProjects(ws: string) { return [...this.projects.values()].filter((p) => p.workspaceId === ws); }
  async getProject(id: string) { return this.projects.get(id); }
  async putProject(project: Project) { this.projects.set(project.id, project); this.persist(); return project; }
  async deleteProject(id: string) { this.projects.delete(id); this.persist(); }

  async listTasks(ws: string) { return [...this.tasks.values()].filter((t) => t.workspaceId === ws); }
  async getTask(id: string) { return this.tasks.get(id); }
  async putTask(task: Task) { this.tasks.set(task.id, task); this.persist(); return task; }
  async deleteTask(id: string) { this.tasks.delete(id); this.persist(); }

  async listFeatures(ws: string) { return [...this.features.values()].filter((f) => f.workspaceId === ws); }
  async getFeature(id: string) { return this.features.get(id); }
  async putFeature(f: Feature) { this.features.set(f.id, f); this.persist(); return f; }
  async deleteFeature(id: string) { this.features.delete(id); this.persist(); }

  async listMilestones(ws: string) { return [...this.milestones.values()].filter((m) => m.workspaceId === ws); }
  async getMilestone(id: string) { return this.milestones.get(id); }
  async putMilestone(m: Milestone) { this.milestones.set(m.id, m); this.persist(); return m; }
  async deleteMilestone(id: string) { this.milestones.delete(id); this.persist(); }

  async listSolutionBriefs(ws: string) { return [...this.solutionBriefs.values()].filter((b) => b.workspaceId === ws); }
  async getSolutionBrief(id: string) { return this.solutionBriefs.get(id); }
  async putSolutionBrief(b: SolutionBrief) { this.solutionBriefs.set(b.id, b); this.persist(); return b; }
  async deleteSolutionBrief(id: string) { this.solutionBriefs.delete(id); this.persist(); }

  async listAgents(ws: string) { return [...this.fleet.values()].filter((r) => r.workspaceId === ws); }
  async listAllAgents() { return [...this.fleet.values()]; }
  async getAgent(id: string) { return this.fleet.get(id); }
  async putAgent(runner: Agent) { this.fleet.set(runner.id, runner); this.persist(); return runner; }
  async deleteAgent(id: string) { this.fleet.delete(id); this.persist(); }

  async listModules(_ws: string) { return this.modules; }
  async listDeps(_ws: string) { return this.deps; }
  async listProviders() { return this.providers; }

  async recordAudit(entry: AuditRecord) {
    const wsAudit = this.audit.filter((e) => e.workspaceId === entry.workspaceId);
    const prevHash = wsAudit.at(-1)?.hash ?? null;
    this.audit.push(chainAuditRecord(entry, prevHash));
    this.persist();
  }
  async listAudit(ws: string) { return this.audit.filter((e) => e.workspaceId === ws).reverse(); }
  async setAuditArchived(ws: string, hitlId: string, archived: boolean) {
    for (const e of this.audit) if (e.workspaceId === ws && e.hitlId === hitlId) e.archived = archived;
    this.persist();
  }
  async deleteAudit(ws: string, hitlId: string) {
    this.audit = this.audit.filter((e) => !(e.workspaceId === ws && e.hitlId === hitlId));
    this.persist();
  }
  async archiveAllAudit(ws: string) {
    for (const e of this.audit) if (e.workspaceId === ws) e.archived = true;
    this.persist();
  }
  async clearAudit(ws: string) {
    this.audit = this.audit.filter((e) => e.workspaceId !== ws);
    this.persist();
  }

  async getGithubConnection(ws: string) { return this.github.get(ws); }
  async putGithubConnection(connection: GithubConnection) { this.github.set(connection.workspaceId, connection); this.persist(); }
  async deleteGithubConnection(ws: string) { this.github.delete(ws); this.persist(); }

  async getWorkspaceSettings(ws: string) { return this.workspaceSettings.get(ws); }
  async putWorkspaceSettings(settings: WorkspaceSettings) { this.workspaceSettings.set(settings.workspaceId, settings); this.persist(); }

  async listPolicyVersions(ws: string) {
    return [...this.policyVersions.values()].filter((v) => v.workspaceId === ws).sort((a, b) => b.version - a.version);
  }
  async getPolicyVersion(id: string) { return this.policyVersions.get(id); }
  async getActivePolicyVersion(ws: string) {
    return [...this.policyVersions.values()].find((v) => v.workspaceId === ws && v.active);
  }
  async putPolicyVersion(version: PolicyVersion) {
    if (version.active) {
      for (const v of this.policyVersions.values()) {
        if (v.workspaceId === version.workspaceId && v.id !== version.id && v.active) v.active = false;
      }
    }
    this.policyVersions.set(version.id, version);
    this.persist();
    return version;
  }

  async getGithubToken(ws: string) { return this.githubTokens.get(ws); }
  async putGithubToken(ws: string, ciphertext: string) { this.githubTokens.set(ws, ciphertext); this.persist(); }
  async deleteGithubToken(ws: string) { this.githubTokens.delete(ws); this.persist(); }

  async putServiceToken(t: StoredServiceToken) { this.serviceTokens.set(t.id, t); this.persist(); }
  async getServiceTokenByHash(tokenHash: string) {
    for (const t of this.serviceTokens.values()) if (t.tokenHash === tokenHash) return t;
    return undefined;
  }
  async listServiceTokens(ws: string) {
    return [...this.serviceTokens.values()].filter((t) => t.principal.workspaceId === ws);
  }
  async deleteServiceToken(id: string) { const had = this.serviceTokens.delete(id); if (had) this.persist(); return had; }
}
