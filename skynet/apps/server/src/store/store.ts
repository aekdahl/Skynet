// ─── Store interface ──────────────────────────────────────────────────────
// The authoritative domain state. Phase 0 ships an in-memory implementation
// (store/memory.ts); a Postgres adapter drops in behind this same interface
// without touching the API, orchestrator, or WS gateway.

import type {
  TaskRun,
  AuditRecord,
  Checkpoint,
  Dependency,
  Feature,
  GithubConnection,
  HitlItem,
  Milestone,
  Module,
  PendingRuleAction,
  PendingRuleActionStatus,
  PolicyVersion,
  Project,
  ProjectContextEntry,
  Proposal,
  ProposalStatus,
  ProviderInfo,
  Agent,
  Rule,
  Snapshot,
  SolutionBrief,
  Task,
  Transition,
  WorkspaceSettings,
} from "@skynet/shared";
import type { StoredServiceToken } from "../auth/service-tokens.js";

export type { AuditRecord };

export interface Store {
  /** Full connect-time snapshot of one workspace's collections. */
  snapshot(workspaceId: string): Promise<Snapshot>;

  // runs — list is workspace-scoped; get/put/delete carry workspaceId on the entity
  listRuns(workspaceId: string): Promise<TaskRun[]>;
  /** Every agent across all workspaces — for maintenance sweeps (e.g. the reaper). */
  listAllRuns(): Promise<TaskRun[]>;
  getRun(id: string): Promise<TaskRun | undefined>;
  putRun(agent: TaskRun): Promise<TaskRun>;
  appendLog(runId: string, at: number, line: string, detail?: string): Promise<void>;

  // checkpoints — snapshot/restore for a run (extends fork/resume). Scoped by
  // runId rather than workspaceId: always fetched through a run whose
  // ownership was already checked, so a per-run list is what callers need.
  listCheckpoints(runId: string): Promise<Checkpoint[]>;
  getCheckpoint(id: string): Promise<Checkpoint | undefined>;
  putCheckpoint(checkpoint: Checkpoint): Promise<Checkpoint>;

  // HITL queue
  listQueue(workspaceId: string): Promise<HitlItem[]>;
  getHitl(id: string): Promise<HitlItem | undefined>;
  putHitl(item: HitlItem): Promise<HitlItem>;

  // projects
  listProjects(workspaceId: string): Promise<Project[]>;
  // Cross-workspace sweep (mirrors listAllRuns/listAllAgents) — the inbound
  // GitHub webhook has no workspace context (GitHub doesn't send one), so it
  // resolves the owning project(s) by matching `repo` across every workspace.
  listAllProjects(): Promise<Project[]>;
  getProject(id: string): Promise<Project | undefined>;
  putProject(project: Project): Promise<Project>;
  deleteProject(id: string): Promise<void>;

  // tasks
  listTasks(workspaceId: string): Promise<Task[]>;
  getTask(id: string): Promise<Task | undefined>;
  putTask(task: Task): Promise<Task>;
  deleteTask(id: string): Promise<void>;

  // features (task grouping)
  listFeatures(workspaceId: string): Promise<Feature[]>;
  getFeature(id: string): Promise<Feature | undefined>;
  putFeature(feature: Feature): Promise<Feature>;
  deleteFeature(id: string): Promise<void>;

  // milestones (roadmap grouping)
  listMilestones(workspaceId: string): Promise<Milestone[]>;
  getMilestone(id: string): Promise<Milestone | undefined>;
  putMilestone(milestone: Milestone): Promise<Milestone>;
  deleteMilestone(id: string): Promise<void>;

  // project context entries (pasted/uploaded notes — see steward/context.ts)
  listContextEntries(workspaceId: string): Promise<ProjectContextEntry[]>;
  getContextEntry(id: string): Promise<ProjectContextEntry | undefined>;
  putContextEntry(entry: ProjectContextEntry): Promise<ProjectContextEntry>;
  deleteContextEntry(id: string): Promise<void>;

  // solution briefs (pre-work planning docs)
  listSolutionBriefs(workspaceId: string): Promise<SolutionBrief[]>;
  getSolutionBrief(id: string): Promise<SolutionBrief | undefined>;
  putSolutionBrief(brief: SolutionBrief): Promise<SolutionBrief>;
  deleteSolutionBrief(id: string): Promise<void>;

  // transitions (Momentum Rollout kanban rebuild, Phase 0 — append-only move
  // history; see @skynet/shared's Transition). Never updated in place, only
  // created — same idiom as appendLog/recordAudit.
  createTransition(t: Transition): Promise<Transition>;
  listTransitionsForTask(taskId: string): Promise<Transition[]>;
  listTransitionsForProject(projectId: string, opts?: { since?: number; limit?: number }): Promise<Transition[]>;

  // rules (Momentum Rollout kanban rebuild, Phase 0 — project-scoped kanban
  // automation; see @skynet/shared's Rule). Project-scoped only (no
  // workspace-wide list) — a rule always belongs to exactly one project.
  getRule(id: string): Promise<Rule | undefined>;
  putRule(rule: Rule): Promise<Rule>;
  deleteRule(id: string): Promise<void>;
  listRulesForProject(projectId: string): Promise<Rule[]>;

  // proposals (Momentum Rollout kanban rebuild, Phase 0 — drafts / suggested
  // subtasks / suggested rules / suggested reassignments; see @skynet/shared's
  // Proposal). Project-scoped only, same reasoning as Rule above.
  getProposal(id: string): Promise<Proposal | undefined>;
  putProposal(proposal: Proposal): Promise<Proposal>;
  deleteProposal(id: string): Promise<void>;
  listProposalsForProject(projectId: string, opts?: { status?: ProposalStatus }): Promise<Proposal[]>;

  // pending rule actions (Momentum Rollout Phase 1b — the RuleEngine's
  // announce-before-acting hold; see @skynet/shared's PendingRuleAction).
  // `listAllPendingActions` (no scoping — like listAllRuns/listAllProjects)
  // is what the resolver sweep scans every tick.
  getPendingRuleAction(id: string): Promise<PendingRuleAction | undefined>;
  putPendingRuleAction(action: PendingRuleAction): Promise<PendingRuleAction>;
  deletePendingRuleAction(id: string): Promise<void>;
  listPendingActionsForProject(projectId: string, opts?: { status?: PendingRuleActionStatus }): Promise<PendingRuleAction[]>;
  listAllPendingActions(): Promise<PendingRuleAction[]>;

  // fleet
  listAgents(workspaceId: string): Promise<Agent[]>;
  /** Every runner across all workspaces — for maintenance sweeps (reconcile). */
  listAllAgents(): Promise<Agent[]>;
  getAgent(id: string): Promise<Agent | undefined>;
  putAgent(runner: Agent): Promise<Agent>;
  deleteAgent(id: string): Promise<void>;

  // workspace-scoped reference data
  listModules(workspaceId: string): Promise<Module[]>;
  listDeps(workspaceId: string): Promise<Dependency[]>;
  listProviders(): Promise<ProviderInfo[]>;

  /** Append a decision to the audit trail (who/what/when/payload). */
  recordAudit(entry: AuditRecord): Promise<void>;
  /** Read the workspace's decision audit trail, newest first (W8). */
  listAudit(workspaceId: string): Promise<AuditRecord[]>;
  /** Soft-hide (or restore) a single decision — keeps it in the trail. */
  setAuditArchived(workspaceId: string, hitlId: string, archived: boolean): Promise<void>;
  /** Permanently remove a single decision from the trail. */
  deleteAudit(workspaceId: string, hitlId: string): Promise<void>;
  /** Soft-hide every decision in the workspace's trail. */
  archiveAllAudit(workspaceId: string): Promise<void>;
  /** Permanently remove the entire workspace trail. */
  clearAudit(workspaceId: string): Promise<void>;

  // GitHub connection (one per workspace) — non-secret metadata, so it persists
  // through the same Store the deployment uses (file for the desktop app,
  // Postgres for hosted, memory for dev). The App private key is NOT here.
  getGithubConnection(workspaceId: string): Promise<GithubConnection | undefined>;
  putGithubConnection(connection: GithubConnection): Promise<void>;
  deleteGithubConnection(workspaceId: string): Promise<void>;

  // Workspace settings (one per workspace) — the live fleet policy. Same
  // durable-Store pattern as the GitHub connection; undefined until first set.
  getWorkspaceSettings(workspaceId: string): Promise<WorkspaceSettings | undefined>;
  putWorkspaceSettings(settings: WorkspaceSettings): Promise<void>;

  // Command policy versions — versioned, per-workspace, git-like history of the
  // command-safety classification policy. listPolicyVersions is newest-first;
  // exactly one version per workspace has `active: true`. putPolicyVersion, when
  // given an `active: true` version, deactivates any other active version for
  // that workspace as part of the same write (so callers never see two actives).
  listPolicyVersions(workspaceId: string): Promise<PolicyVersion[]>;
  getPolicyVersion(id: string): Promise<PolicyVersion | undefined>;
  getActivePolicyVersion(workspaceId: string): Promise<PolicyVersion | undefined>;
  putPolicyVersion(version: PolicyVersion): Promise<PolicyVersion>;
  // A PAT's sealed ciphertext (pat auth mode). Server-side only; never part of
  // the GithubConnection contract. Sealed/opened by the GithubService.
  getGithubToken(workspaceId: string): Promise<string | undefined>;
  putGithubToken(workspaceId: string, ciphertext: string): Promise<void>;
  deleteGithubToken(workspaceId: string): Promise<void>;

  // Service tokens (MCP / programmatic auth). Persisted as a SHA-256 hash + a
  // last-4 fingerprint — the raw bearer secret is never stored (shown once at
  // mint). Backs StoreServiceTokenStore so tokens survive a restart.
  putServiceToken(t: StoredServiceToken): Promise<void>;
  getServiceTokenByHash(tokenHash: string): Promise<StoredServiceToken | undefined>;
  listServiceTokens(workspaceId: string): Promise<StoredServiceToken[]>;
  deleteServiceToken(id: string): Promise<boolean>;
}
