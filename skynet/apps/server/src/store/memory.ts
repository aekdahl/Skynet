// ─── In-memory store ──────────────────────────────────────────────────────
// Phase 0 persistence: Maps seeded from fixtures. Implements the Store
// interface so the Postgres adapter is a drop-in replacement. Lists are
// scoped by workspace; reference data is global for now.

import type {
  TaskRun,
  AutonomyBreaker,
  AutonomyOverride,
  Checkpoint,
  Dependency,
  Feature,
  GithubConnection,
  HitlItem,
  LogVerb,
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
  RoadmapDoc,
  RoadmapLineClaim,
  RoadmapProposal,
  RoadmapProposalState,
  Rule,
  Snapshot,
  SolutionBrief,
  Task,
  Transition,
  WorkspaceSettings,
} from "@skynet/shared";
import type { AuditRecord } from "@skynet/shared";
import { chainAuditRecord } from "../audit-chain.js";
import { now } from "../config.js";
import { VersionConflictError, type Store } from "./store.js";
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
  protected contextEntries = new Map<string, ProjectContextEntry>();
  protected solutionBriefs = new Map<string, SolutionBrief>();
  protected transitions = new Map<string, Transition>();
  protected rules = new Map<string, Rule>();
  protected proposals = new Map<string, Proposal>();
  protected pendingRuleActions = new Map<string, PendingRuleAction>();
  protected fleet = new Map<string, Agent>();
  protected modules: Module[] = [];
  protected deps: Dependency[] = [];
  protected audit: AuditRecord[] = [];
  protected github = new Map<string, GithubConnection>(); // keyed by workspaceId
  protected workspaceSettings = new Map<string, WorkspaceSettings>(); // keyed by workspaceId
  protected roadmapDocs = new Map<string, RoadmapDoc>(); // keyed by projectId
  protected roadmapProposals = new Map<string, RoadmapProposal>();
  protected roadmapLineClaims = new Map<string, RoadmapLineClaim>(); // keyed by `${projectId}:${lineId}`
  protected policyVersions = new Map<string, PolicyVersion>(); // keyed by id
  protected githubTokens = new Map<string, string>(); // workspaceId → sealed PAT ciphertext
  protected serviceTokens = new Map<string, StoredServiceToken>(); // keyed by id (holds a hash, never the raw token)
  protected autonomyBreakers = new Map<string, AutonomyBreaker>(); // keyed by projectId
  protected autonomyOverrides = new Map<string, AutonomyOverride>(); // keyed by projectId
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
      rules: await this.listRulesForWorkspace(workspaceId),
      proposals: await this.listProposalsForWorkspace(workspaceId),
      serverTime: now(),
    };
  }

  async listRuns(ws: string) { return [...this.runs.values()].filter((a) => a.workspaceId === ws); }
  async listAllRuns() { return [...this.runs.values()]; }
  async getRun(id: string) { return this.runs.get(id); }
  async putRun(agent: TaskRun) { this.runs.set(agent.id, agent); this.persist(); return agent; }
  async appendLog(runId: string, at: number, line: string, detail?: string, meta?: { verb?: LogVerb; resultKind?: "ok" | "error" }) {
    const a = this.runs.get(runId);
    if (a) {
      a.log.push({ at, line, ...(detail ? { detail } : {}), ...(meta?.verb ? { verb: meta.verb } : {}), ...(meta?.resultKind ? { resultKind: meta.resultKind } : {}) });
      this.persist();
    }
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
  async listAllProjects() { return [...this.projects.values()]; }
  async getProject(id: string) { return this.projects.get(id); }
  async putProject(project: Project) { this.projects.set(project.id, project); this.persist(); return project; }
  async deleteProject(id: string) { this.projects.delete(id); this.persist(); }

  async listTasks(ws: string) { return [...this.tasks.values()].filter((t) => t.workspaceId === ws); }
  async getTask(id: string) { return this.tasks.get(id); }
  // No `await` between the version check and the write below — Node's single
  // thread means nothing else can interleave a conflicting write in between,
  // so this synchronous check-then-set is genuinely atomic.
  async putTask(task: Task, expectedVersion?: number) {
    const current = this.tasks.get(task.id);
    if (expectedVersion !== undefined && (current?.version ?? 0) !== expectedVersion) {
      throw new VersionConflictError("task", task.id);
    }
    const next = { ...task, version: (current?.version ?? 0) + 1 };
    this.tasks.set(task.id, next);
    this.persist();
    return next;
  }
  async deleteTask(id: string) { this.tasks.delete(id); this.persist(); }

  async listFeatures(ws: string) { return [...this.features.values()].filter((f) => f.workspaceId === ws); }
  async getFeature(id: string) { return this.features.get(id); }
  async putFeature(f: Feature) { this.features.set(f.id, f); this.persist(); return f; }
  async deleteFeature(id: string) { this.features.delete(id); this.persist(); }

  async listMilestones(ws: string) { return [...this.milestones.values()].filter((m) => m.workspaceId === ws); }
  async getMilestone(id: string) { return this.milestones.get(id); }
  async putMilestone(m: Milestone) { this.milestones.set(m.id, m); this.persist(); return m; }
  async deleteMilestone(id: string) { this.milestones.delete(id); this.persist(); }

  async listContextEntries(ws: string) { return [...this.contextEntries.values()].filter((e) => e.workspaceId === ws); }
  async getContextEntry(id: string) { return this.contextEntries.get(id); }
  async putContextEntry(e: ProjectContextEntry) { this.contextEntries.set(e.id, e); this.persist(); return e; }
  async deleteContextEntry(id: string) { this.contextEntries.delete(id); this.persist(); }

  async listSolutionBriefs(ws: string) { return [...this.solutionBriefs.values()].filter((b) => b.workspaceId === ws); }
  async getSolutionBrief(id: string) { return this.solutionBriefs.get(id); }
  async putSolutionBrief(b: SolutionBrief) { this.solutionBriefs.set(b.id, b); this.persist(); return b; }
  async deleteSolutionBrief(id: string) { this.solutionBriefs.delete(id); this.persist(); }

  async createTransition(t: Transition) { this.transitions.set(t.id, t); this.persist(); return t; }
  async listTransitionsForTask(taskId: string) {
    return [...this.transitions.values()].filter((t) => t.taskId === taskId).sort((a, b) => a.at - b.at);
  }
  async listTransitionsForProject(projectId: string, opts: { since?: number; limit?: number } = {}) {
    let list = [...this.transitions.values()]
      .filter((t) => t.projectId === projectId)
      .sort((a, b) => b.at - a.at); // newest first, matching listAudit's convention
    if (opts.since != null) list = list.filter((t) => t.at >= opts.since!);
    if (opts.limit != null) list = list.slice(0, opts.limit);
    return list;
  }
  async listTransitionsForWorkspace(ws: string, opts: { since?: number; limit?: number } = {}) {
    let list = [...this.transitions.values()]
      .filter((t) => t.workspaceId === ws)
      .sort((a, b) => b.at - a.at); // newest first, matching listTransitionsForProject's convention
    if (opts.since != null) list = list.filter((t) => t.at >= opts.since!);
    if (opts.limit != null) list = list.slice(0, opts.limit);
    return list;
  }

  async getRule(id: string) { return this.rules.get(id); }
  async putRule(rule: Rule) { this.rules.set(rule.id, rule); this.persist(); return rule; }
  async deleteRule(id: string) { this.rules.delete(id); this.persist(); }
  async listRulesForProject(projectId: string) { return [...this.rules.values()].filter((r) => r.projectId === projectId); }
  async listRulesForWorkspace(ws: string) { return [...this.rules.values()].filter((r) => r.workspaceId === ws); }

  async getProposal(id: string) { return this.proposals.get(id); }
  async putProposal(proposal: Proposal) { this.proposals.set(proposal.id, proposal); this.persist(); return proposal; }
  async deleteProposal(id: string) { this.proposals.delete(id); this.persist(); }
  async listProposalsForProject(projectId: string, opts: { status?: ProposalStatus } = {}) {
    let list = [...this.proposals.values()].filter((p) => p.projectId === projectId);
    if (opts.status != null) list = list.filter((p) => p.status === opts.status);
    return list;
  }
  async listProposalsForWorkspace(ws: string) { return [...this.proposals.values()].filter((p) => p.workspaceId === ws); }

  async getPendingRuleAction(id: string) { return this.pendingRuleActions.get(id); }
  async putPendingRuleAction(action: PendingRuleAction) { this.pendingRuleActions.set(action.id, action); this.persist(); return action; }
  async deletePendingRuleAction(id: string) { this.pendingRuleActions.delete(id); this.persist(); }
  async listPendingActionsForProject(projectId: string, opts: { status?: PendingRuleActionStatus } = {}) {
    let list = [...this.pendingRuleActions.values()].filter((a) => a.projectId === projectId);
    if (opts.status != null) list = list.filter((a) => a.status === opts.status);
    return list;
  }
  async listAllPendingActions() { return [...this.pendingRuleActions.values()]; }

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

  async getRoadmapDoc(projectId: string) { return this.roadmapDocs.get(projectId); }
  async putRoadmapDoc(doc: RoadmapDoc) { this.roadmapDocs.set(doc.projectId, doc); this.persist(); return doc; }

  async getRoadmapProposal(id: string) { return this.roadmapProposals.get(id); }
  async putRoadmapProposal(proposal: RoadmapProposal) { this.roadmapProposals.set(proposal.id, proposal); this.persist(); return proposal; }
  async deleteRoadmapProposal(id: string) { this.roadmapProposals.delete(id); this.persist(); }
  async listRoadmapProposalsForProject(projectId: string, opts: { state?: RoadmapProposalState } = {}) {
    let list = [...this.roadmapProposals.values()].filter((p) => p.projectId === projectId);
    if (opts.state != null) list = list.filter((p) => p.state === opts.state);
    return list;
  }

  async getRoadmapLineClaim(projectId: string, lineId: string) { return this.roadmapLineClaims.get(`${projectId}:${lineId}`); }
  async putRoadmapLineClaim(claim: RoadmapLineClaim) {
    this.roadmapLineClaims.set(`${claim.projectId}:${claim.lineId}`, claim);
    this.persist();
    return claim;
  }
  async listRoadmapLineClaimsForProject(projectId: string) {
    return [...this.roadmapLineClaims.values()].filter((c) => c.projectId === projectId);
  }

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

  async getAutonomyBreaker(projectId: string) { return this.autonomyBreakers.get(projectId); }
  async putAutonomyBreaker(breaker: AutonomyBreaker) { this.autonomyBreakers.set(breaker.projectId, breaker); this.persist(); }
  async deleteAutonomyBreaker(projectId: string) { this.autonomyBreakers.delete(projectId); this.persist(); }

  async getAutonomyOverride(projectId: string) { return this.autonomyOverrides.get(projectId); }
  async putAutonomyOverride(override: AutonomyOverride) { this.autonomyOverrides.set(override.projectId, override); this.persist(); }
  async deleteAutonomyOverride(projectId: string) { this.autonomyOverrides.delete(projectId); this.persist(); }
}
