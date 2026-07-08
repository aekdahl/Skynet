// ─── Postgres store ───────────────────────────────────────────────────────
// Durable Store implementation (Backend Brief §11). Entities are stored as
// JSONB keyed by id + workspace_id; the activity log is an append-only table
// (streamed, not rewritten); decisions land in an append-only hitl_audit
// trail. Drops in behind the Store interface — Hub/API/orchestrator unchanged.

import { Pool } from "pg";
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
import { now } from "../config.js";
import type { Store } from "./store.js";
import { PROVIDERS } from "./providers.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS agents     (id text PRIMARY KEY, workspace_id text NOT NULL, data jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS hitl_queue (id text PRIMARY KEY, workspace_id text NOT NULL, data jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS projects   (id text PRIMARY KEY, workspace_id text NOT NULL, data jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS tasks      (id text PRIMARY KEY, workspace_id text NOT NULL, data jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS runners    (id text PRIMARY KEY, workspace_id text NOT NULL, data jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS modules    (id text PRIMARY KEY, workspace_id text NOT NULL, data jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS deps       (id bigserial PRIMARY KEY, workspace_id text NOT NULL, data jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS agent_log  (id bigserial PRIMARY KEY, agent_id text NOT NULL, at bigint NOT NULL, line text NOT NULL, detail text);
ALTER TABLE agent_log ADD COLUMN IF NOT EXISTS detail text;
CREATE TABLE IF NOT EXISTS hitl_audit (id bigserial PRIMARY KEY, workspace_id text NOT NULL, hitl_id text NOT NULL,
                                       agent_id text NOT NULL, action text NOT NULL, operator_id text NOT NULL,
                                       at bigint NOT NULL, payload jsonb);
CREATE TABLE IF NOT EXISTS github_connections (workspace_id text PRIMARY KEY, data jsonb NOT NULL);
CREATE TABLE IF NOT EXISTS github_tokens      (workspace_id text PRIMARY KEY, ciphertext text NOT NULL);
CREATE INDEX IF NOT EXISTS agents_ws   ON agents(workspace_id);
CREATE INDEX IF NOT EXISTS hitl_ws     ON hitl_queue(workspace_id);
CREATE INDEX IF NOT EXISTS projects_ws ON projects(workspace_id);
CREATE INDEX IF NOT EXISTS tasks_ws    ON tasks(workspace_id);
CREATE INDEX IF NOT EXISTS runners_ws  ON runners(workspace_id);
CREATE INDEX IF NOT EXISTS log_agent   ON agent_log(agent_id);
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

  // ── agents (log lives in the append-only agent_log table) ─────────────────
  private async logsFor(agentIds: string[]): Promise<Map<string, { at: number; line: string; detail?: string }[]>> {
    const map = new Map<string, { at: number; line: string; detail?: string }[]>();
    if (!agentIds.length) return map;
    const { rows } = await this.pool.query<{ agent_id: string; at: string; line: string; detail: string | null }>(
      "SELECT agent_id, at, line, detail FROM agent_log WHERE agent_id = ANY($1) ORDER BY at ASC, id ASC",
      [agentIds],
    );
    for (const r of rows) {
      const list = map.get(r.agent_id) ?? [];
      list.push(r.detail != null ? { at: Number(r.at), line: r.line, detail: r.detail } : { at: Number(r.at), line: r.line });
      map.set(r.agent_id, list);
    }
    return map;
  }

  private hydrate(data: Agent, logs: Map<string, { at: number; line: string; detail?: string }[]>): Agent {
    return { ...data, log: logs.get(data.id) ?? [] };
  }

  async listAgents(ws: string): Promise<Agent[]> {
    const { rows } = await this.pool.query<{ data: Agent }>("SELECT data FROM agents WHERE workspace_id=$1", [ws]);
    const logs = await this.logsFor(rows.map((r) => r.data.id));
    return rows.map((r) => this.hydrate(r.data, logs));
  }
  async listAllAgents(): Promise<Agent[]> {
    // Maintenance sweep (reaper): status/heartbeat/runner only — logs not hydrated.
    const { rows } = await this.pool.query<{ data: Agent }>("SELECT data FROM agents");
    return rows.map((r) => ({ ...r.data, log: [] }));
  }
  async getAgent(id: string): Promise<Agent | undefined> {
    const { rows } = await this.pool.query<{ data: Agent }>("SELECT data FROM agents WHERE id=$1", [id]);
    if (!rows[0]) return undefined;
    const logs = await this.logsFor([id]);
    return this.hydrate(rows[0].data, logs);
  }
  async putAgent(agent: Agent): Promise<Agent> {
    const { log, ...rest } = agent;
    const data = { ...rest, log: [] as typeof log };
    await this.pool.query(
      "INSERT INTO agents(id,workspace_id,data) VALUES($1,$2,$3::jsonb) ON CONFLICT(id) DO UPDATE SET workspace_id=$2, data=$3::jsonb",
      [agent.id, agent.workspaceId, J(data)],
    );
    // Seed-time: persist any log lines the fixture carried.
    for (const l of log) await this.appendLog(agent.id, l.at, l.line);
    return agent;
  }
  async appendLog(agentId: string, at: number, line: string, detail?: string): Promise<void> {
    await this.pool.query("INSERT INTO agent_log(agent_id,at,line,detail) VALUES($1,$2,$3,$4)", [agentId, at, line, detail ?? null]);
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
  getProject(id: string) { return this.get<Project>("projects", id); }
  async putProject(p: Project) { await this.put("projects", p.id, p.workspaceId, p); return p; }
  deleteProject(id: string) { return this.del("projects", id); }

  listTasks(ws: string) { return this.list<Task>("tasks", ws); }
  getTask(id: string) { return this.get<Task>("tasks", id); }
  async putTask(t: Task) { await this.put("tasks", t.id, t.workspaceId, t); return t; }
  deleteTask(id: string) { return this.del("tasks", id); }

  listRunners(ws: string) { return this.list<Runner>("runners", ws); }
  async listAllRunners(): Promise<Runner[]> {
    const { rows } = await this.pool.query<{ data: Runner }>("SELECT data FROM runners");
    return rows.map((r) => r.data);
  }
  getRunner(id: string) { return this.get<Runner>("runners", id); }
  async putRunner(r: Runner) { await this.put("runners", r.id, r.workspaceId, r); return r; }
  deleteRunner(id: string) { return this.del("runners", id); }

  listModules(ws: string) { return this.list<Module>("modules", ws); }
  listDeps(ws: string) { return this.list<Dependency>("deps", ws); }
  async listProviders(): Promise<ProviderInfo[]> { return PROVIDERS; }

  async recordAudit(e: AuditRecord): Promise<void> {
    await this.pool.query(
      "INSERT INTO hitl_audit(workspace_id,hitl_id,agent_id,action,operator_id,at,payload) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)",
      [e.workspaceId, e.hitlId, e.agentId, e.action, e.operatorId, e.at, J(e.payload)],
    );
  }

  async listAudit(ws: string): Promise<AuditRecord[]> {
    const { rows } = await this.pool.query<{
      workspace_id: string; hitl_id: string; agent_id: string; action: string; operator_id: string; at: string; payload: unknown;
    }>(
      "SELECT workspace_id,hitl_id,agent_id,action,operator_id,at,payload FROM hitl_audit WHERE workspace_id=$1 ORDER BY at DESC, id DESC",
      [ws],
    );
    return rows.map((r) => ({
      workspaceId: r.workspace_id, hitlId: r.hitl_id, agentId: r.agent_id,
      action: r.action, operatorId: r.operator_id, at: Number(r.at), payload: r.payload,
    }));
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

  async snapshot(ws: string): Promise<Snapshot> {
    const [agents, queue, projects, tasks, fleet, modules, deps] = await Promise.all([
      this.listAgents(ws),
      this.listQueue(ws),
      this.listProjects(ws),
      this.listTasks(ws),
      this.listRunners(ws),
      this.listModules(ws),
      this.listDeps(ws),
    ]);
    return { agents, queue, projects, tasks, fleet, modules, deps, providers: PROVIDERS, serverTime: now() };
  }
}
