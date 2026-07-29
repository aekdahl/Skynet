// ─── In-memory store ──────────────────────────────────────────────────────
// Phase 0 persistence: Maps seeded from fixtures. Implements the Store
// interface so the Postgres adapter is a drop-in replacement. Lists are
// scoped by workspace; reference data is global for now.

import type {
  TaskRun,
  Dependency,
  GithubConnection,
  HitlItem,
  Module,
  Project,
  ProviderInfo,
  Agent,
  Snapshot,
  Task,
} from "@skynet/shared";
import type { AuditRecord } from "@skynet/shared";
import { now } from "../config.js";
import type { Store } from "./store.js";
import type { StoredServiceToken } from "../auth/service-tokens.js";
import { providerCatalog } from "./providers.js";

export class MemoryStore implements Store {
  // `protected` so a persistence subclass (FileStore) can load/serialize them.
  protected runs = new Map<string, TaskRun>();
  protected queue = new Map<string, HitlItem>();
  protected projects = new Map<string, Project>();
  protected tasks = new Map<string, Task>();
  protected fleet = new Map<string, Agent>();
  protected modules: Module[] = [];
  protected deps: Dependency[] = [];
  protected audit: AuditRecord[] = [];
  protected github = new Map<string, GithubConnection>(); // keyed by workspaceId
  protected githubTokens = new Map<string, string>(); // workspaceId → sealed PAT ciphertext
  protected serviceTokens = new Map<string, StoredServiceToken>(); // keyed by id (holds a hash, never the raw token)

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
      fleet: await this.listAgents(workspaceId),
      modules: this.modules,
      deps: this.deps,
      providers: providerCatalog(),
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

  async listAgents(ws: string) { return [...this.fleet.values()].filter((r) => r.workspaceId === ws); }
  async listAllAgents() { return [...this.fleet.values()]; }
  async getAgent(id: string) { return this.fleet.get(id); }
  async putAgent(runner: Agent) { this.fleet.set(runner.id, runner); this.persist(); return runner; }
  async deleteAgent(id: string) { this.fleet.delete(id); this.persist(); }

  async listModules(_ws: string) { return this.modules; }
  async listDeps(_ws: string) { return this.deps; }
  async listProviders() { return providerCatalog(); }

  async recordAudit(entry: AuditRecord) { this.audit.push(entry); this.persist(); }
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
