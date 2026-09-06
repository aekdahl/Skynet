// ─── Postgres MCP server store ────────────────────────────────────────────
// Durable backend for custom MCP server configs. Stores ONLY the sealed spec
// ciphertext + safe metadata (no plaintext secrets, no master key) in its own
// table. Connects lazily on first use so the store can be constructed
// synchronously from config — same shape as ../secrets/postgres.ts.

import { Pool } from "pg";
import type { McpServerRecord, McpServerStore, McpServerTransport } from "./types.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS workspace_mcp_servers (
  workspace_id     text NOT NULL,
  id               text NOT NULL,
  name             text NOT NULL,
  transport        text NOT NULL,
  command          text NOT NULL DEFAULT '',
  args             jsonb NOT NULL DEFAULT '[]',
  url              text NOT NULL DEFAULT '',
  env_keys         jsonb NOT NULL DEFAULT '[]',
  header_keys      jsonb NOT NULL DEFAULT '[]',
  spec_ciphertext  text NOT NULL,
  updated_at       bigint NOT NULL,
  updated_by       text NOT NULL,
  PRIMARY KEY (workspace_id, id)
);
`;

interface Row {
  id: string;
  workspace_id: string;
  name: string;
  transport: string;
  command: string;
  args: string[];
  url: string;
  env_keys: string[];
  header_keys: string[];
  spec_ciphertext: string;
  updated_at: string;
  updated_by: string;
}

const toRecord = (r: Row): McpServerRecord => ({
  id: r.id,
  workspaceId: r.workspace_id,
  name: r.name,
  transport: r.transport as McpServerTransport,
  command: r.command,
  args: r.args,
  url: r.url,
  envKeys: r.env_keys,
  headerKeys: r.header_keys,
  specCiphertext: r.spec_ciphertext,
  updatedAt: Number(r.updated_at),
  updatedBy: r.updated_by,
});

export class PostgresMcpServerStore implements McpServerStore {
  private pool?: Pool;
  private ready?: Promise<Pool>;

  constructor(private connectionString: string) {}

  private async db(): Promise<Pool> {
    if (!this.ready) {
      this.ready = (async () => {
        const pool = new Pool({ connectionString: this.connectionString });
        await pool.query(SCHEMA);
        this.pool = pool;
        return pool;
      })();
    }
    return this.ready;
  }

  async put(r: McpServerRecord): Promise<void> {
    const pool = await this.db();
    await pool.query(
      `INSERT INTO workspace_mcp_servers(workspace_id,id,name,transport,command,args,url,env_keys,header_keys,spec_ciphertext,updated_at,updated_by)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT(workspace_id,id)
       DO UPDATE SET name=$3, transport=$4, command=$5, args=$6, url=$7, env_keys=$8, header_keys=$9, spec_ciphertext=$10, updated_at=$11, updated_by=$12`,
      [
        r.workspaceId, r.id, r.name, r.transport, r.command, JSON.stringify(r.args), r.url,
        JSON.stringify(r.envKeys), JSON.stringify(r.headerKeys), r.specCiphertext, r.updatedAt, r.updatedBy,
      ],
    );
  }

  async get(workspaceId: string, id: string): Promise<McpServerRecord | undefined> {
    const pool = await this.db();
    const { rows } = await pool.query<Row>(
      "SELECT * FROM workspace_mcp_servers WHERE workspace_id=$1 AND id=$2",
      [workspaceId, id],
    );
    return rows[0] ? toRecord(rows[0]) : undefined;
  }

  async list(workspaceId: string): Promise<McpServerRecord[]> {
    const pool = await this.db();
    const { rows } = await pool.query<Row>(
      "SELECT * FROM workspace_mcp_servers WHERE workspace_id=$1 ORDER BY name",
      [workspaceId],
    );
    return rows.map(toRecord);
  }

  async delete(workspaceId: string, id: string): Promise<void> {
    const pool = await this.db();
    await pool.query("DELETE FROM workspace_mcp_servers WHERE workspace_id=$1 AND id=$2", [workspaceId, id]);
  }
}
