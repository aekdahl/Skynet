// ─── In-memory store ──────────────────────────────────────────────────────
// Phase 0 persistence: Maps seeded from fixtures. Implements the Store
// interface so the Postgres adapter is a drop-in replacement. Lists are
// scoped by workspace; reference data is global for now.

import type {
  Agent,
  Dependency,
  GithubConnection,
  HitlItem,
  Module,
  Project,
  ProviderInfo,
  Runner,
  Snapshot,
  Task,
} from "@skynet/shared";
import type { AuditRecord } from "@skynet/shared";
import { now } from "../config.js";
import type { Store } from "./store.js";
import { PROVIDERS } from "./providers.js";

export class MemoryStore implements Store {
  // `protected` so a persistence subclass (FileStore) can load/serialize them.
  protected agents = new Map<string, Agent>();
  protected queue = new Map<string, HitlItem>();
  protected projects = new Map<string, Project>();
  protected tasks = new Map<string, Task>();
  protected fleet = new Map<string, Runner>();
  protected modules: Module[] = [];
  protected deps: Dependency[] = [];
  protected audit: AuditRecord[] = [];
  protected github = new Map<string, GithubConnection>(); // keyed by workspaceId
  protected githubTokens = new Map<string, string>(); // workspaceId → sealed PAT ciphertext
  private providers: ProviderInfo[] = PROVIDERS;

  /** Hook called after every mutation. No-op in memory; FileStore overrides it
   *  to schedule a debounced write to disk. */
  protected persist(): void {}

  // The store always starts empty — a fresh install has no projects/agents until
  // the operator creates them. (No demo fixtures; the provider catalog is the
  // only prefilled data, and it's live configuration.)

  async snapshot(workspaceId: string): Promise<Snapshot> {
    return {
      agents: await this.listAgents(workspaceId),
      queue: await this.listQueue(workspaceId),
      projects: await this.listProjects(workspaceId),
      tasks: await this.listTasks(workspaceId),
      fleet: await this.listRunners(workspaceId),
      modules: this.modules,
      deps: this.deps,
      providers: this.providers,
      serverTime: now(),
    };
  }

  async listAgents(ws: string) { return [...this.agents.values()].filter((a) => a.workspaceId === ws); }
  async getAgent(id: string) { return this.agents.get(id); }
  async putAgent(agent: Agent) { this.agents.set(agent.id, agent); this.persist(); return agent; }
  async appendLog(agentId: string, at: number, line: string, detail?: string) {
    const a = this.agents.get(agentId);
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

  async listRunners(ws: string) { return [...this.fleet.values()].filter((r) => r.workspaceId === ws); }
  async getRunner(id: string) { return this.fleet.get(id); }
  async putRunner(runner: Runner) { this.fleet.set(runner.id, runner); this.persist(); return runner; }
  async deleteRunner(id: string) { this.fleet.delete(id); this.persist(); }

  async listModules(_ws: string) { return this.modules; }
  async listDeps(_ws: string) { return this.deps; }
  async listProviders() { return this.providers; }

  async recordAudit(entry: AuditRecord) { this.audit.push(entry); this.persist(); }
  async listAudit(ws: string) { return this.audit.filter((e) => e.workspaceId === ws).reverse(); }

  async getGithubConnection(ws: string) { return this.github.get(ws); }
  async putGithubConnection(connection: GithubConnection) { this.github.set(connection.workspaceId, connection); this.persist(); }
  async deleteGithubConnection(ws: string) { this.github.delete(ws); this.persist(); }

  async getGithubToken(ws: string) { return this.githubTokens.get(ws); }
  async putGithubToken(ws: string, ciphertext: string) { this.githubTokens.set(ws, ciphertext); this.persist(); }
  async deleteGithubToken(ws: string) { this.githubTokens.delete(ws); this.persist(); }
}
