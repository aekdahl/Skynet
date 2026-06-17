// ─── Store interface ──────────────────────────────────────────────────────
// The authoritative domain state. Phase 0 ships an in-memory implementation
// (store/memory.ts); a Postgres adapter drops in behind this same interface
// without touching the API, orchestrator, or WS gateway.

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

export interface Store {
  /** Full connect-time snapshot of one workspace's collections. */
  snapshot(workspaceId: string): Promise<Snapshot>;

  // agents — list is workspace-scoped; get/put/delete carry workspaceId on the entity
  listAgents(workspaceId: string): Promise<Agent[]>;
  getAgent(id: string): Promise<Agent | undefined>;
  putAgent(agent: Agent): Promise<Agent>;
  appendLog(agentId: string, at: number, line: string): Promise<void>;

  // HITL queue
  listQueue(workspaceId: string): Promise<HitlItem[]>;
  getHitl(id: string): Promise<HitlItem | undefined>;
  putHitl(item: HitlItem): Promise<HitlItem>;

  // projects
  listProjects(workspaceId: string): Promise<Project[]>;
  getProject(id: string): Promise<Project | undefined>;
  putProject(project: Project): Promise<Project>;
  deleteProject(id: string): Promise<void>;

  // tasks
  listTasks(workspaceId: string): Promise<Task[]>;
  getTask(id: string): Promise<Task | undefined>;
  putTask(task: Task): Promise<Task>;
  deleteTask(id: string): Promise<void>;

  // fleet
  listRunners(workspaceId: string): Promise<Runner[]>;
  getRunner(id: string): Promise<Runner | undefined>;
  putRunner(runner: Runner): Promise<Runner>;
  deleteRunner(id: string): Promise<void>;

  // workspace-scoped reference data
  listModules(workspaceId: string): Promise<Module[]>;
  listDeps(workspaceId: string): Promise<Dependency[]>;
  listProviders(): Promise<ProviderInfo[]>;

  /** Append a decision to the audit trail (who/what/when/payload). */
  recordAudit(entry: AuditEntry): Promise<void>;
}

/** Decision audit record — Backend Brief §11. */
export interface AuditEntry {
  workspaceId: string;
  hitlId: string;
  agentId: string;
  action: string;
  operatorId: string;
  at: number;
  payload: unknown;
}
