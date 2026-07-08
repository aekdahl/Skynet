// ─── Store interface ──────────────────────────────────────────────────────
// The authoritative domain state. Phase 0 ships an in-memory implementation
// (store/memory.ts); a Postgres adapter drops in behind this same interface
// without touching the API, orchestrator, or WS gateway.

import type {
  Agent,
  AuditRecord,
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

export type { AuditRecord };

export interface Store {
  /** Full connect-time snapshot of one workspace's collections. */
  snapshot(workspaceId: string): Promise<Snapshot>;

  // agents — list is workspace-scoped; get/put/delete carry workspaceId on the entity
  listAgents(workspaceId: string): Promise<Agent[]>;
  /** Every agent across all workspaces — for maintenance sweeps (e.g. the reaper). */
  listAllAgents(): Promise<Agent[]>;
  getAgent(id: string): Promise<Agent | undefined>;
  putAgent(agent: Agent): Promise<Agent>;
  appendLog(agentId: string, at: number, line: string, detail?: string): Promise<void>;

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
  /** Every runner across all workspaces — for maintenance sweeps (reconcile). */
  listAllRunners(): Promise<Runner[]>;
  getRunner(id: string): Promise<Runner | undefined>;
  putRunner(runner: Runner): Promise<Runner>;
  deleteRunner(id: string): Promise<void>;

  // workspace-scoped reference data
  listModules(workspaceId: string): Promise<Module[]>;
  listDeps(workspaceId: string): Promise<Dependency[]>;
  listProviders(): Promise<ProviderInfo[]>;

  /** Append a decision to the audit trail (who/what/when/payload). */
  recordAudit(entry: AuditRecord): Promise<void>;
  /** Read the workspace's decision audit trail, newest first (W8). */
  listAudit(workspaceId: string): Promise<AuditRecord[]>;

  // GitHub connection (one per workspace) — non-secret metadata, so it persists
  // through the same Store the deployment uses (file for the desktop app,
  // Postgres for hosted, memory for dev). The App private key is NOT here.
  getGithubConnection(workspaceId: string): Promise<GithubConnection | undefined>;
  putGithubConnection(connection: GithubConnection): Promise<void>;
  deleteGithubConnection(workspaceId: string): Promise<void>;
  // A PAT's sealed ciphertext (pat auth mode). Server-side only; never part of
  // the GithubConnection contract. Sealed/opened by the GithubService.
  getGithubToken(workspaceId: string): Promise<string | undefined>;
  putGithubToken(workspaceId: string, ciphertext: string): Promise<void>;
  deleteGithubToken(workspaceId: string): Promise<void>;
}
