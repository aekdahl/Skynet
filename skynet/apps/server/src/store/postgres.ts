// ─── Postgres store ───────────────────────────────────────────────────────
// Durable Store implementation (Backend Brief §11). Entities are stored as
// JSONB keyed by id + workspace_id; the activity log is an append-only table
// (streamed, not rewritten); decisions land in an append-only hitl_audit
// trail. Drops in behind the Store interface — Hub/API/orchestrator unchanged.

import { Pool } from "pg";
import type {
  TaskRun,
  AuditRecord,
  AutonomyBreaker,
  AutonomyOverride,
  Checkpoint,
  Dependency,
  Feature,
  GithubConnection,
  HitlItem,
  LogLine,
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
  RoadmapProposal,
  RoadmapProposalState,
  Rule,
  Snapshot,
  SolutionBrief,
  Task,
  Transition,
  WorkspaceSettings,
} from "@skynet/shared";
import { chainAuditRecord } from "../audit-chain.js";
import { now } from "../config.js";
import type { Store } from "./store.js";
import type { StoredServiceToken } from "../auth/service-tokens.js";
import { PROVIDERS } from "./providers.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS runs     (id text PRIMARY KEY, workspace_id text NOT NULL, data jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS checkpoints (id text PRIMARY KEY, run_id text NOT NULL, workspace_id text NOT NULL, data jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS hitl_queue (id text PRIMARY KEY, workspace_id text NOT NULL, data jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS projects   (id text PRIMARY KEY, workspace_id text NOT NULL, data jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS tasks      (id text PRIMARY KEY, workspace_id text NOT NULL, data jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS features   (id text PRIMARY KEY, workspace_id text NOT NULL, data jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS milestones (id text PRIMARY KEY, workspace_id text NOT NULL, data jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS context_entries (id text PRIMARY KEY, workspace_id text NOT NULL, data jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS solution_briefs (id text PRIMARY KEY, workspace_id text NOT NULL, data jsonb NOT NULL);
-- Momentum Rollout kanban rebuild, Phase 0 (see @skynet/shared's Transition/Rule/Proposal).
CREATE TABLE IF NOT EXISTS transitions (id text PRIMARY KEY, workspace_id text NOT NULL, project_id text NOT NULL, task_id text NOT NULL, at bigint NOT NULL, data jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS rules      (id text PRIMARY KEY, workspace_id text NOT NULL, project_id text NOT NULL, data jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS proposals  (id text PRIMARY KEY, workspace_id text NOT NULL, project_id text NOT NULL, status text NOT NULL, data jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS pending_rule_actions (id text PRIMARY KEY, workspace_id text NOT NULL, project_id text NOT NULL, status text NOT NULL, ready_at bigint NOT NULL, data jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS agents    (id text PRIMARY KEY, workspace_id text NOT NULL, data jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS modules    (id text PRIMARY KEY, workspace_id text NOT NULL, data jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS deps       (id bigserial PRIMARY KEY, workspace_id text NOT NULL, data jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS run_log  (id bigserial PRIMARY KEY, run_id text NOT NULL, at bigint NOT NULL, line text NOT NULL, detail text);
ALTER TABLE run_log ADD COLUMN IF NOT EXISTS detail text;
ALTER TABLE run_log ADD COLUMN IF NOT EXISTS verb text;
ALTER TABLE run_log ADD COLUMN IF NOT EXISTS result_kind text;
CREATE TABLE IF NOT EXISTS hitl_audit (id bigserial PRIMARY KEY, workspace_id text NOT NULL, hitl_id text NOT NULL,
                                       run_id text NOT NULL, action text NOT NULL, operator_id text NOT NULL,
                                       at bigint NOT NULL, payload jsonb);
ALTER TABLE hitl_audit ADD COLUMN IF NOT EXISTS archived boolean NOT NULL DEFAULT false;
ALTER TABLE hitl_audit ADD COLUMN IF NOT EXISTS hash text;
ALTER TABLE hitl_audit ADD COLUMN IF NOT EXISTS prev_hash text;
CREATE TABLE IF NOT EXISTS github_connections (workspace_id text PRIMARY KEY, data jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS workspace_settings (workspace_id text PRIMARY KEY, data jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS command_policy_versions (id text PRIMARY KEY, workspace_id text NOT NULL, version int NOT NULL, active boolean NOT NULL DEFAULT false, data jsonb NOT NULL);
CREATE INDEX IF NOT EXISTS command_policy_versions_ws ON command_policy_versions(workspace_id);
CREATE TABLE IF NOT EXISTS github_tokens      (workspace_id text PRIMARY KEY, ciphertext text NOT NULL);
CREATE TABLE IF NOT EXISTS service_tokens     (id text PRIMARY KEY, token_hash text NOT NULL, workspace_id text NOT NULL, data jsonb NOT NULL);
CREATE INDEX IF NOT EXISTS service_tokens_hash ON service_tokens(token_hash);
CREATE INDEX IF NOT EXISTS service_tokens_ws   ON service_tokens(workspace_id);
-- Autonomy breaker/override (TASK 19) — one row per project, replacing the
-- old in-memory autonomyStreaks Map so a restart mid-streak doesn't reset it.
CREATE TABLE IF NOT EXISTS autonomy_breakers  (project_id text PRIMARY KEY, data jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS autonomy_overrides (project_id text PRIMARY KEY, data jsonb NOT NULL);
-- Roadmap doc cache (Phase 24) — one parsed RoadmapDoc per project, replaced
-- wholesale on every sync.
CREATE TABLE IF NOT EXISTS roadmap_docs (project_id text PRIMARY KEY, workspace_id text NOT NULL, data jsonb NOT NULL);
-- Roadmap proposal governance (Phase 25 -- TASK 28) -- an agent's proposed
-- edit to a project's roadmap doc; project-scoped like proposals above but
-- a distinct collection (see @skynet/shared's RoadmapProposal).
CREATE TABLE IF NOT EXISTS roadmap_proposals (id text PRIMARY KEY, workspace_id text NOT NULL, project_id text NOT NULL, state text NOT NULL, data jsonb NOT NULL);
CREATE INDEX IF NOT EXISTS roadmap_proposals_project ON roadmap_proposals(project_id, state);
CREATE INDEX IF NOT EXISTS runs_ws   ON runs(workspace_id);
CREATE INDEX IF NOT EXISTS checkpoints_run ON checkpoints(run_id);
CREATE INDEX IF NOT EXISTS hitl_ws     ON hitl_queue(workspace_id);
CREATE INDEX IF NOT EXISTS projects_ws ON projects(workspace_id);
CREATE INDEX IF NOT EXISTS tasks_ws    ON tasks(workspace_id);
CREATE INDEX IF NOT EXISTS features_ws   ON features(workspace_id);
CREATE INDEX IF NOT EXISTS milestones_ws ON milestones(workspace_id);
CREATE INDEX IF NOT EXISTS context_entries_ws ON context_entries(workspace_id);
CREATE INDEX IF NOT EXISTS solution_briefs_ws ON solution_briefs(workspace_id);
CREATE INDEX IF NOT EXISTS transitions_task    ON transitions(task_id);
CREATE INDEX IF NOT EXISTS transitions_project ON transitions(project_id, at DESC);
CREATE INDEX IF NOT EXISTS transitions_ws      ON transitions(workspace_id, at DESC);
CREATE INDEX IF NOT EXISTS rules_project        ON rules(project_id);
CREATE INDEX IF NOT EXISTS rules_ws             ON rules(workspace_id);
CREATE INDEX IF NOT EXISTS proposals_project    ON proposals(project_id, status);
CREATE INDEX IF NOT EXISTS proposals_ws         ON proposals(workspace_id);
CREATE INDEX IF NOT EXISTS pending_actions_project ON pending_rule_actions(project_id, status);
CREATE INDEX IF NOT EXISTS pending_actions_ready   ON pending_rule_actions(status, ready_at);
CREATE INDEX IF NOT EXISTS agents_ws  ON agents(workspace_id);
CREATE INDEX IF NOT EXISTS log_run   ON run_log(run_id);
`;

const J = (v: unknown) => JSON.stringify(v);

export class PostgresStore implements Store {
  private constructor(private pool: Pool) {}

  /** Connect and migrate. The store starts empty — no demo fixtures. */
  static async create(connectionString: string): Promise<PostgresStore> {
    const pool = new Pool({ connectionString });
    await pool.query(SCHEMA);
    return new PostgresStore(pool);
  }

  // ── runs (log lives in the append-only run_log table) ─────────────────
  private async logsFor(runIds: string[]): Promise<Map<string, LogLine[]>> {
    const map = new Map<string, LogLine[]>();
    if (!runIds.length) return map;
    const { rows } = await this.pool.query<{
      run_id: string;
      at: string;
      line: string;
      detail: string | null;
      verb: string | null;
      result_kind: string | null;
    }>(
      "SELECT run_id, at, line, detail, verb, result_kind FROM run_log WHERE run_id = ANY($1) ORDER BY at ASC, id ASC",
      [runIds],
    );
    for (const r of rows) {
      const list = map.get(r.run_id) ?? [];
      list.push({
        at: Number(r.at),
        line: r.line,
        ...(r.detail != null ? { detail: r.detail } : {}),
        ...(r.verb != null ? { verb: r.verb as LogVerb } : {}),
        ...(r.result_kind != null ? { resultKind: r.result_kind as "ok" | "error" } : {}),
      });
      map.set(r.run_id, list);
    }
    return map;
  }

  private hydrate(data: TaskRun, logs: Map<string, { at: number; line: string; detail?: string }[]>): TaskRun {
    return { ...data, log: logs.get(data.id) ?? [] };
  }

  async listRuns(ws: string): Promise<TaskRun[]> {
    const { rows } = await this.pool.query<{ data: TaskRun }>("SELECT data FROM runs WHERE workspace_id=$1", [ws]);
    const logs = await this.logsFor(rows.map((r) => r.data.id));
    return rows.map((r) => this.hydrate(r.data, logs));
  }
  async listAllRuns(): Promise<TaskRun[]> {
    // Maintenance sweep (reaper): status/heartbeat/runner only — logs not hydrated.
    const { rows } = await this.pool.query<{ data: TaskRun }>("SELECT data FROM runs");
    return rows.map((r) => ({ ...r.data, log: [] }));
  }
  async getRun(id: string): Promise<TaskRun | undefined> {
    const { rows } = await this.pool.query<{ data: TaskRun }>("SELECT data FROM runs WHERE id=$1", [id]);
    if (!rows[0]) return undefined;
    const logs = await this.logsFor([id]);
    return this.hydrate(rows[0].data, logs);
  }
  async putRun(agent: TaskRun): Promise<TaskRun> {
    const { log, ...rest } = agent;
    const data = { ...rest, log: [] as typeof log };
    await this.pool.query(
      "INSERT INTO runs(id,workspace_id,data) VALUES($1,$2,$3::jsonb) ON CONFLICT(id) DO UPDATE SET workspace_id=$2, data=$3::jsonb",
      [agent.id, agent.workspaceId, J(data)],
    );
    // Seed-time: persist any log lines the fixture carried.
    for (const l of log) await this.appendLog(agent.id, l.at, l.line);
    return agent;
  }
  async appendLog(runId: string, at: number, line: string, detail?: string, meta?: { verb?: LogVerb; resultKind?: "ok" | "error" }): Promise<void> {
    await this.pool.query("INSERT INTO run_log(run_id,at,line,detail,verb,result_kind) VALUES($1,$2,$3,$4,$5,$6)", [
      runId,
      at,
      line,
      detail ?? null,
      meta?.verb ?? null,
      meta?.resultKind ?? null,
    ]);
  }

  // ── checkpoints (run-scoped, not workspace-scoped — the generic list/get/put
  // trio below keys on workspace_id, so this needs its own run_id-filtered list
  // and a put with the extra column, same shape as runs). ─────────────────────
  async listCheckpoints(runId: string): Promise<Checkpoint[]> {
    const { rows } = await this.pool.query<{ data: Checkpoint }>(
      "SELECT data FROM checkpoints WHERE run_id=$1 ORDER BY (data->>'createdAt')::bigint ASC",
      [runId],
    );
    return rows.map((r) => r.data);
  }
  async getCheckpoint(id: string): Promise<Checkpoint | undefined> {
    const { rows } = await this.pool.query<{ data: Checkpoint }>("SELECT data FROM checkpoints WHERE id=$1", [id]);
    return rows[0]?.data;
  }
  async putCheckpoint(checkpoint: Checkpoint): Promise<Checkpoint> {
    await this.pool.query(
      "INSERT INTO checkpoints(id,run_id,workspace_id,data) VALUES($1,$2,$3,$4::jsonb) ON CONFLICT(id) DO UPDATE SET run_id=$2, workspace_id=$3, data=$4::jsonb",
      [checkpoint.id, checkpoint.runId, checkpoint.workspaceId, J(checkpoint)],
    );
    return checkpoint;
  }

  // ── generic JSONB collections ─────────────────────────────────────────────
  private async list<T>(table: string, ws: string): Promise<T[]> {
    const { rows } = await this.pool.query<{ data: T }>(`SELECT data FROM ${table} WHERE workspace_id=$1`, [ws]);
    return rows.map((r) => r.data);
  }
  private async get<T>(table: string, id: string): Promise<T | undefined> {
    const { rows } = await this.pool.query<{ data: T }>(`SELECT data FROM ${table} WHERE id=$1`, [id]);
    return rows[0]?.data;
  }
  private async put(table: string, id: string, ws: string, data: unknown): Promise<void> {
    await this.pool.query(
      `INSERT INTO ${table}(id,workspace_id,data) VALUES($1,$2,$3::jsonb) ON CONFLICT(id) DO UPDATE SET workspace_id=$2, data=$3::jsonb`,
      [id, ws, J(data)],
    );
  }
  private async del(table: string, id: string): Promise<void> {
    await this.pool.query(`DELETE FROM ${table} WHERE id=$1`, [id]);
  }

  listQueue(ws: string) { return this.list<HitlItem>("hitl_queue", ws); }
  getHitl(id: string) { return this.get<HitlItem>("hitl_queue", id); }
  async putHitl(item: HitlItem) { await this.put("hitl_queue", item.id, item.workspaceId, item); return item; }

  listProjects(ws: string) { return this.list<Project>("projects", ws); }
  async listAllProjects(): Promise<Project[]> {
    const { rows } = await this.pool.query<{ data: Project }>("SELECT data FROM projects");
    return rows.map((r) => r.data);
  }
  getProject(id: string) { return this.get<Project>("projects", id); }
  async putProject(p: Project) { await this.put("projects", p.id, p.workspaceId, p); return p; }
  deleteProject(id: string) { return this.del("projects", id); }

  listTasks(ws: string) { return this.list<Task>("tasks", ws); }
  getTask(id: string) { return this.get<Task>("tasks", id); }
  async putTask(t: Task) { await this.put("tasks", t.id, t.workspaceId, t); return t; }
  deleteTask(id: string) { return this.del("tasks", id); }

  listFeatures(ws: string) { return this.list<Feature>("features", ws); }
  getFeature(id: string) { return this.get<Feature>("features", id); }
  async putFeature(f: Feature) { await this.put("features", f.id, f.workspaceId, f); return f; }
  deleteFeature(id: string) { return this.del("features", id); }

  listMilestones(ws: string) { return this.list<Milestone>("milestones", ws); }
  getMilestone(id: string) { return this.get<Milestone>("milestones", id); }
  async putMilestone(m: Milestone) { await this.put("milestones", m.id, m.workspaceId, m); return m; }
  deleteMilestone(id: string) { return this.del("milestones", id); }

  listContextEntries(ws: string) { return this.list<ProjectContextEntry>("context_entries", ws); }
  getContextEntry(id: string) { return this.get<ProjectContextEntry>("context_entries", id); }
  async putContextEntry(e: ProjectContextEntry) { await this.put("context_entries", e.id, e.workspaceId, e); return e; }
  deleteContextEntry(id: string) { return this.del("context_entries", id); }

  listSolutionBriefs(ws: string) { return this.list<SolutionBrief>("solution_briefs", ws); }
  getSolutionBrief(id: string) { return this.get<SolutionBrief>("solution_briefs", id); }
  async putSolutionBrief(b: SolutionBrief) { await this.put("solution_briefs", b.id, b.workspaceId, b); return b; }
  deleteSolutionBrief(id: string) { return this.del("solution_briefs", id); }

  // ── transitions (Momentum Rollout kanban rebuild, Phase 0 — append-only) ──
  async createTransition(t: Transition): Promise<Transition> {
    await this.pool.query(
      "INSERT INTO transitions(id,workspace_id,project_id,task_id,at,data) VALUES($1,$2,$3,$4,$5,$6::jsonb) " +
        "ON CONFLICT(id) DO UPDATE SET workspace_id=$2, project_id=$3, task_id=$4, at=$5, data=$6::jsonb",
      [t.id, t.workspaceId, t.projectId, t.taskId, t.at, J(t)],
    );
    return t;
  }
  async listTransitionsForTask(taskId: string): Promise<Transition[]> {
    const { rows } = await this.pool.query<{ data: Transition }>(
      "SELECT data FROM transitions WHERE task_id=$1 ORDER BY at ASC",
      [taskId],
    );
    return rows.map((r) => r.data);
  }
  async listTransitionsForProject(projectId: string, opts: { since?: number; limit?: number } = {}): Promise<Transition[]> {
    const params: unknown[] = [projectId];
    let sql = "SELECT data FROM transitions WHERE project_id=$1";
    if (opts.since != null) { params.push(opts.since); sql += ` AND at >= $${params.length}`; }
    sql += " ORDER BY at DESC"; // newest first, matching listAudit's convention
    if (opts.limit != null) { params.push(opts.limit); sql += ` LIMIT $${params.length}`; }
    const { rows } = await this.pool.query<{ data: Transition }>(sql, params);
    return rows.map((r) => r.data);
  }
  async listTransitionsForWorkspace(ws: string, opts: { since?: number; limit?: number } = {}): Promise<Transition[]> {
    const params: unknown[] = [ws];
    let sql = "SELECT data FROM transitions WHERE workspace_id=$1";
    if (opts.since != null) { params.push(opts.since); sql += ` AND at >= $${params.length}`; }
    sql += " ORDER BY at DESC";
    if (opts.limit != null) { params.push(opts.limit); sql += ` LIMIT $${params.length}`; }
    const { rows } = await this.pool.query<{ data: Transition }>(sql, params);
    return rows.map((r) => r.data);
  }

  // ── rules (Momentum Rollout kanban rebuild, Phase 0 — project-scoped) ─────
  async getRule(id: string): Promise<Rule | undefined> {
    const { rows } = await this.pool.query<{ data: Rule }>("SELECT data FROM rules WHERE id=$1", [id]);
    return rows[0]?.data;
  }
  async putRule(rule: Rule): Promise<Rule> {
    await this.pool.query(
      "INSERT INTO rules(id,workspace_id,project_id,data) VALUES($1,$2,$3,$4::jsonb) " +
        "ON CONFLICT(id) DO UPDATE SET workspace_id=$2, project_id=$3, data=$4::jsonb",
      [rule.id, rule.workspaceId, rule.projectId, J(rule)],
    );
    return rule;
  }
  async deleteRule(id: string): Promise<void> { await this.pool.query("DELETE FROM rules WHERE id=$1", [id]); }
  async listRulesForProject(projectId: string): Promise<Rule[]> {
    const { rows } = await this.pool.query<{ data: Rule }>("SELECT data FROM rules WHERE project_id=$1", [projectId]);
    return rows.map((r) => r.data);
  }
  listRulesForWorkspace(ws: string) { return this.list<Rule>("rules", ws); }

  // ── proposals (Momentum Rollout kanban rebuild, Phase 0 — project-scoped) ─
  async getProposal(id: string): Promise<Proposal | undefined> {
    const { rows } = await this.pool.query<{ data: Proposal }>("SELECT data FROM proposals WHERE id=$1", [id]);
    return rows[0]?.data;
  }
  async putProposal(proposal: Proposal): Promise<Proposal> {
    await this.pool.query(
      "INSERT INTO proposals(id,workspace_id,project_id,status,data) VALUES($1,$2,$3,$4,$5::jsonb) " +
        "ON CONFLICT(id) DO UPDATE SET workspace_id=$2, project_id=$3, status=$4, data=$5::jsonb",
      [proposal.id, proposal.workspaceId, proposal.projectId, proposal.status, J(proposal)],
    );
    return proposal;
  }
  async deleteProposal(id: string): Promise<void> { await this.pool.query("DELETE FROM proposals WHERE id=$1", [id]); }
  async listProposalsForProject(projectId: string, opts: { status?: ProposalStatus } = {}): Promise<Proposal[]> {
    const params: unknown[] = [projectId];
    let sql = "SELECT data FROM proposals WHERE project_id=$1";
    if (opts.status != null) { params.push(opts.status); sql += ` AND status=$${params.length}`; }
    const { rows } = await this.pool.query<{ data: Proposal }>(sql, params);
    return rows.map((r) => r.data);
  }
  listProposalsForWorkspace(ws: string) { return this.list<Proposal>("proposals", ws); }

  // ── pending rule actions (Momentum Rollout Phase 1b, project-scoped) ──────
  async getPendingRuleAction(id: string): Promise<PendingRuleAction | undefined> {
    const { rows } = await this.pool.query<{ data: PendingRuleAction }>("SELECT data FROM pending_rule_actions WHERE id=$1", [id]);
    return rows[0]?.data;
  }
  async putPendingRuleAction(action: PendingRuleAction): Promise<PendingRuleAction> {
    await this.pool.query(
      "INSERT INTO pending_rule_actions(id,workspace_id,project_id,status,ready_at,data) VALUES($1,$2,$3,$4,$5,$6::jsonb) " +
        "ON CONFLICT(id) DO UPDATE SET workspace_id=$2, project_id=$3, status=$4, ready_at=$5, data=$6::jsonb",
      [action.id, action.workspaceId, action.projectId, action.status, action.readyAt, J(action)],
    );
    return action;
  }
  async deletePendingRuleAction(id: string): Promise<void> {
    await this.pool.query("DELETE FROM pending_rule_actions WHERE id=$1", [id]);
  }
  async listPendingActionsForProject(projectId: string, opts: { status?: PendingRuleActionStatus } = {}): Promise<PendingRuleAction[]> {
    const params: unknown[] = [projectId];
    let sql = "SELECT data FROM pending_rule_actions WHERE project_id=$1";
    if (opts.status != null) { params.push(opts.status); sql += ` AND status=$${params.length}`; }
    const { rows } = await this.pool.query<{ data: PendingRuleAction }>(sql, params);
    return rows.map((r) => r.data);
  }
  async listAllPendingActions(): Promise<PendingRuleAction[]> {
    const { rows } = await this.pool.query<{ data: PendingRuleAction }>("SELECT data FROM pending_rule_actions");
    return rows.map((r) => r.data);
  }

  listAgents(ws: string) { return this.list<Agent>("agents", ws); }
  async listAllAgents(): Promise<Agent[]> {
    const { rows } = await this.pool.query<{ data: Agent }>("SELECT data FROM agents");
    return rows.map((r) => r.data);
  }
  getAgent(id: string) { return this.get<Agent>("agents", id); }
  async putAgent(r: Agent) { await this.put("agents", r.id, r.workspaceId, r); return r; }
  deleteAgent(id: string) { return this.del("agents", id); }

  listModules(ws: string) { return this.list<Module>("modules", ws); }
  listDeps(ws: string) { return this.list<Dependency>("deps", ws); }
  async listProviders(): Promise<ProviderInfo[]> { return PROVIDERS; }

  async recordAudit(e: AuditRecord): Promise<void> {
    // Fetch the last hash in the workspace chain, then insert the chained record.
    // Single-process + Node.js event-loop serialization means no concurrent
    // writes interleave between the SELECT and INSERT for a given workspace.
    const { rows: lastRows } = await this.pool.query<{ hash: string | null }>(
      "SELECT hash FROM hitl_audit WHERE workspace_id=$1 ORDER BY id DESC LIMIT 1",
      [e.workspaceId],
    );
    const prevHash = lastRows[0]?.hash ?? null;
    const chained = chainAuditRecord(e, prevHash);
    await this.pool.query(
      "INSERT INTO hitl_audit(workspace_id,hitl_id,run_id,action,operator_id,at,payload,archived,hash,prev_hash) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10)",
      [chained.workspaceId, chained.hitlId, chained.runId, chained.action, chained.operatorId, chained.at, J(chained.payload), chained.archived ?? false, chained.hash ?? null, chained.prevHash ?? null],
    );
  }

  async listAudit(ws: string): Promise<AuditRecord[]> {
    const { rows } = await this.pool.query<{
      workspace_id: string; hitl_id: string; run_id: string; action: string; operator_id: string; at: string; payload: unknown; archived: boolean; hash: string | null; prev_hash: string | null;
    }>(
      "SELECT workspace_id,hitl_id,run_id,action,operator_id,at,payload,archived,hash,prev_hash FROM hitl_audit WHERE workspace_id=$1 ORDER BY at DESC, id DESC",
      [ws],
    );
    return rows.map((r) => ({
      workspaceId: r.workspace_id, hitlId: r.hitl_id, runId: r.run_id,
      action: r.action, operatorId: r.operator_id, at: Number(r.at), payload: r.payload, archived: r.archived,
      // Include hash/prevHash only for chained records (hash present). A chained
      // genesis record has hash set + prev_hash=null, and both must be included so
      // verifyAuditChain can compare prevHash===null against its expectedPrev===null.
      ...(r.hash != null ? { hash: r.hash, prevHash: r.prev_hash } : {}),
    }));
  }

  async setAuditArchived(ws: string, hitlId: string, archived: boolean): Promise<void> {
    await this.pool.query("UPDATE hitl_audit SET archived=$3 WHERE workspace_id=$1 AND hitl_id=$2", [ws, hitlId, archived]);
  }
  async deleteAudit(ws: string, hitlId: string): Promise<void> {
    await this.pool.query("DELETE FROM hitl_audit WHERE workspace_id=$1 AND hitl_id=$2", [ws, hitlId]);
  }
  async archiveAllAudit(ws: string): Promise<void> {
    await this.pool.query("UPDATE hitl_audit SET archived=true WHERE workspace_id=$1", [ws]);
  }
  async clearAudit(ws: string): Promise<void> {
    await this.pool.query("DELETE FROM hitl_audit WHERE workspace_id=$1", [ws]);
  }

  async getGithubConnection(ws: string): Promise<GithubConnection | undefined> {
    const { rows } = await this.pool.query<{ data: GithubConnection }>(
      "SELECT data FROM github_connections WHERE workspace_id=$1",
      [ws],
    );
    return rows[0]?.data;
  }
  async putGithubConnection(connection: GithubConnection): Promise<void> {
    await this.pool.query(
      "INSERT INTO github_connections(workspace_id,data) VALUES($1,$2::jsonb) ON CONFLICT(workspace_id) DO UPDATE SET data=$2::jsonb",
      [connection.workspaceId, J(connection)],
    );
  }
  async deleteGithubConnection(ws: string): Promise<void> {
    await this.pool.query("DELETE FROM github_connections WHERE workspace_id=$1", [ws]);
  }

  async getWorkspaceSettings(ws: string): Promise<WorkspaceSettings | undefined> {
    const { rows } = await this.pool.query<{ data: WorkspaceSettings }>(
      "SELECT data FROM workspace_settings WHERE workspace_id=$1",
      [ws],
    );
    return rows[0]?.data;
  }
  async putWorkspaceSettings(settings: WorkspaceSettings): Promise<void> {
    await this.pool.query(
      "INSERT INTO workspace_settings(workspace_id,data) VALUES($1,$2::jsonb) ON CONFLICT(workspace_id) DO UPDATE SET data=$2::jsonb",
      [settings.workspaceId, J(settings)],
    );
  }

  async getAutonomyBreaker(projectId: string): Promise<AutonomyBreaker | undefined> {
    const { rows } = await this.pool.query<{ data: AutonomyBreaker }>(
      "SELECT data FROM autonomy_breakers WHERE project_id=$1",
      [projectId],
    );
    return rows[0]?.data;
  }
  async putAutonomyBreaker(breaker: AutonomyBreaker): Promise<void> {
    await this.pool.query(
      "INSERT INTO autonomy_breakers(project_id,data) VALUES($1,$2::jsonb) ON CONFLICT(project_id) DO UPDATE SET data=$2::jsonb",
      [breaker.projectId, J(breaker)],
    );
  }
  async deleteAutonomyBreaker(projectId: string): Promise<void> {
    await this.pool.query("DELETE FROM autonomy_breakers WHERE project_id=$1", [projectId]);
  }

  async getRoadmapDoc(projectId: string): Promise<RoadmapDoc | undefined> {
    const { rows } = await this.pool.query<{ data: RoadmapDoc }>("SELECT data FROM roadmap_docs WHERE project_id=$1", [projectId]);
    return rows[0]?.data;
  }
  async putRoadmapDoc(doc: RoadmapDoc): Promise<RoadmapDoc> {
    await this.pool.query(
      "INSERT INTO roadmap_docs(project_id,workspace_id,data) VALUES($1,$2,$3::jsonb) ON CONFLICT(project_id) DO UPDATE SET workspace_id=$2, data=$3::jsonb",
      [doc.projectId, doc.workspaceId, J(doc)],
    );
    return doc;
  }

  // ── roadmap proposals (Phase 25 — TASK 28, project-scoped) ────────────────
  async getRoadmapProposal(id: string): Promise<RoadmapProposal | undefined> {
    const { rows } = await this.pool.query<{ data: RoadmapProposal }>("SELECT data FROM roadmap_proposals WHERE id=$1", [id]);
    return rows[0]?.data;
  }
  async putRoadmapProposal(proposal: RoadmapProposal): Promise<RoadmapProposal> {
    await this.pool.query(
      "INSERT INTO roadmap_proposals(id,workspace_id,project_id,state,data) VALUES($1,$2,$3,$4,$5::jsonb) " +
        "ON CONFLICT(id) DO UPDATE SET workspace_id=$2, project_id=$3, state=$4, data=$5::jsonb",
      [proposal.id, proposal.workspaceId, proposal.projectId, proposal.state, J(proposal)],
    );
    return proposal;
  }
  async deleteRoadmapProposal(id: string): Promise<void> {
    await this.pool.query("DELETE FROM roadmap_proposals WHERE id=$1", [id]);
  }
  async listRoadmapProposalsForProject(projectId: string, opts: { state?: RoadmapProposalState } = {}): Promise<RoadmapProposal[]> {
    const params: unknown[] = [projectId];
    let sql = "SELECT data FROM roadmap_proposals WHERE project_id=$1";
    if (opts.state != null) { params.push(opts.state); sql += ` AND state=$${params.length}`; }
    const { rows } = await this.pool.query<{ data: RoadmapProposal }>(sql, params);
    return rows.map((r) => r.data);
  }

  async getAutonomyOverride(projectId: string): Promise<AutonomyOverride | undefined> {
    const { rows } = await this.pool.query<{ data: AutonomyOverride }>(
      "SELECT data FROM autonomy_overrides WHERE project_id=$1",
      [projectId],
    );
    return rows[0]?.data;
  }
  async putAutonomyOverride(override: AutonomyOverride): Promise<void> {
    await this.pool.query(
      "INSERT INTO autonomy_overrides(project_id,data) VALUES($1,$2::jsonb) ON CONFLICT(project_id) DO UPDATE SET data=$2::jsonb",
      [override.projectId, J(override)],
    );
  }
  async deleteAutonomyOverride(projectId: string): Promise<void> {
    await this.pool.query("DELETE FROM autonomy_overrides WHERE project_id=$1", [projectId]);
  }

  // ── command policy versions (workspace-scoped, versioned — see store.ts) ──
  async listPolicyVersions(ws: string): Promise<PolicyVersion[]> {
    const { rows } = await this.pool.query<{ data: PolicyVersion }>(
      "SELECT data FROM command_policy_versions WHERE workspace_id=$1 ORDER BY version DESC",
      [ws],
    );
    return rows.map((r) => r.data);
  }
  async getPolicyVersion(id: string): Promise<PolicyVersion | undefined> {
    const { rows } = await this.pool.query<{ data: PolicyVersion }>("SELECT data FROM command_policy_versions WHERE id=$1", [id]);
    return rows[0]?.data;
  }
  async getActivePolicyVersion(ws: string): Promise<PolicyVersion | undefined> {
    const { rows } = await this.pool.query<{ data: PolicyVersion }>(
      "SELECT data FROM command_policy_versions WHERE workspace_id=$1 AND active=true",
      [ws],
    );
    return rows[0]?.data;
  }
  async putPolicyVersion(version: PolicyVersion): Promise<PolicyVersion> {
    if (version.active) {
      await this.pool.query(
        "UPDATE command_policy_versions SET active=false WHERE workspace_id=$1 AND id<>$2 AND active=true",
        [version.workspaceId, version.id],
      );
    }
    await this.pool.query(
      "INSERT INTO command_policy_versions(id,workspace_id,version,active,data) VALUES($1,$2,$3,$4,$5::jsonb) " +
        "ON CONFLICT(id) DO UPDATE SET workspace_id=$2, version=$3, active=$4, data=$5::jsonb",
      [version.id, version.workspaceId, version.version, version.active, J(version)],
    );
    return version;
  }

  async getGithubToken(ws: string): Promise<string | undefined> {
    const { rows } = await this.pool.query<{ ciphertext: string }>(
      "SELECT ciphertext FROM github_tokens WHERE workspace_id=$1",
      [ws],
    );
    return rows[0]?.ciphertext;
  }
  async putGithubToken(ws: string, ciphertext: string): Promise<void> {
    await this.pool.query(
      "INSERT INTO github_tokens(workspace_id,ciphertext) VALUES($1,$2) ON CONFLICT(workspace_id) DO UPDATE SET ciphertext=$2",
      [ws, ciphertext],
    );
  }
  async deleteGithubToken(ws: string): Promise<void> {
    await this.pool.query("DELETE FROM github_tokens WHERE workspace_id=$1", [ws]);
  }

  async putServiceToken(t: StoredServiceToken): Promise<void> {
    await this.pool.query(
      "INSERT INTO service_tokens(id,token_hash,workspace_id,data) VALUES($1,$2,$3,$4) ON CONFLICT(id) DO UPDATE SET token_hash=$2, workspace_id=$3, data=$4",
      [t.id, t.tokenHash, t.principal.workspaceId, t],
    );
  }
  async getServiceTokenByHash(tokenHash: string): Promise<StoredServiceToken | undefined> {
    const { rows } = await this.pool.query<{ data: StoredServiceToken }>(
      "SELECT data FROM service_tokens WHERE token_hash=$1",
      [tokenHash],
    );
    return rows[0]?.data;
  }
  async listServiceTokens(ws: string): Promise<StoredServiceToken[]> {
    const { rows } = await this.pool.query<{ data: StoredServiceToken }>(
      "SELECT data FROM service_tokens WHERE workspace_id=$1",
      [ws],
    );
    return rows.map((r) => r.data);
  }
  async deleteServiceToken(id: string): Promise<boolean> {
    const { rowCount } = await this.pool.query("DELETE FROM service_tokens WHERE id=$1", [id]);
    return (rowCount ?? 0) > 0;
  }

  async snapshot(ws: string): Promise<Snapshot> {
    const [runs, queue, projects, tasks, features, milestones, solutionBriefs, fleet, modules, deps, rules, proposals] = await Promise.all([
      this.listRuns(ws),
      this.listQueue(ws),
      this.listProjects(ws),
      this.listTasks(ws),
      this.listFeatures(ws),
      this.listMilestones(ws),
      this.listSolutionBriefs(ws),
      this.listAgents(ws),
      this.listModules(ws),
      this.listDeps(ws),
      this.listRulesForWorkspace(ws),
      this.listProposalsForWorkspace(ws),
    ]);
    return { runs, queue, projects, tasks, features, milestones, solutionBriefs, fleet, modules, deps, rules, proposals, providers: PROVIDERS, serverTime: now() };
  }
}
