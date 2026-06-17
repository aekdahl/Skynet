// ─── In-memory store ──────────────────────────────────────────────────────
// Phase 0 persistence: Maps seeded from fixtures. Implements the Store
// interface so the Postgres adapter is a drop-in replacement. Lists are
// scoped by workspace; reference data is global for now.

import type {
  Agent,
  Dependency,
  HitlItem,
  Module,
  Project,
  ProviderInfo,
  Runner,
  Snapshot,
  Task,
} from "@skynet/shared";
import { now } from "../config.js";
import type { AuditEntry, Store } from "./store.js";
import { buildSeed, PROVIDERS } from "./seed.js";

export class MemoryStore implements Store {
  private agents = new Map<string, Agent>();
  private queue = new Map<string, HitlItem>();
  private projects = new Map<string, Project>();
  private tasks = new Map<string, Task>();
  private fleet = new Map<string, Runner>();
  private modules: Module[];
  private deps: Dependency[];
  private providers: ProviderInfo[] = PROVIDERS;
  private audit: AuditEntry[] = [];

  constructor() {
    const seed = buildSeed(now());
    for (const a of seed.agents) this.agents.set(a.id, a);
    for (const q of seed.queue) this.queue.set(q.id, q);
    for (const p of seed.projects) this.projects.set(p.id, p);
    for (const t of seed.tasks) this.tasks.set(t.id, t);
    for (const r of seed.fleet) this.fleet.set(r.id, r);
    this.modules = seed.modules;
    this.deps = seed.deps;
  }

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
  async putAgent(agent: Agent) { this.agents.set(agent.id, agent); return agent; }
  async appendLog(agentId: string, at: number, line: string) {
    const a = this.agents.get(agentId);
    if (a) a.log.push({ at, line });
  }

  async listQueue(ws: string) { return [...this.queue.values()].filter((q) => q.workspaceId === ws); }
  async getHitl(id: string) { return this.queue.get(id); }
  async putHitl(item: HitlItem) { this.queue.set(item.id, item); return item; }

  async listProjects(ws: string) { return [...this.projects.values()].filter((p) => p.workspaceId === ws); }
  async getProject(id: string) { return this.projects.get(id); }
  async putProject(project: Project) { this.projects.set(project.id, project); return project; }
  async deleteProject(id: string) { this.projects.delete(id); }

  async listTasks(ws: string) { return [...this.tasks.values()].filter((t) => t.workspaceId === ws); }
  async getTask(id: string) { return this.tasks.get(id); }
  async putTask(task: Task) { this.tasks.set(task.id, task); return task; }
  async deleteTask(id: string) { this.tasks.delete(id); }

  async listRunners(ws: string) { return [...this.fleet.values()].filter((r) => r.workspaceId === ws); }
  async getRunner(id: string) { return this.fleet.get(id); }
  async putRunner(runner: Runner) { this.fleet.set(runner.id, runner); return runner; }
  async deleteRunner(id: string) { this.fleet.delete(id); }

  async listModules(_ws: string) { return this.modules; }
  async listDeps(_ws: string) { return this.deps; }
  async listProviders() { return this.providers; }

  async recordAudit(entry: AuditEntry) { this.audit.push(entry); }
}
