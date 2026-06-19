// ─── Postgres secret store ────────────────────────────────────────────────
// Durable backend for sealed provider keys. Stores ONLY ciphertext + metadata
// (no plaintext, no master key) in its own table. Connects lazily on first use
// so the store can be constructed synchronously from config.

import { Pool } from "pg";
import type { ProviderId } from "@skynet/shared";
import type { SecretRecord, SecretStore } from "./types.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS workspace_secrets (
  workspace_id text NOT NULL,
  provider     text NOT NULL,
  ciphertext   text NOT NULL,
  last4        text NOT NULL,
  updated_at   bigint NOT NULL,
  updated_by   text NOT NULL,
  PRIMARY KEY (workspace_id, provider)
);
`;

interface Row {
  workspace_id: string;
  provider: string;
  ciphertext: string;
  last4: string;
  updated_at: string;
  updated_by: string;
}

const toRecord = (r: Row): SecretRecord => ({
  workspaceId: r.workspace_id,
  provider: r.provider as ProviderId,
  ciphertext: r.ciphertext,
  last4: r.last4,
  updatedAt: Number(r.updated_at),
  updatedBy: r.updated_by,
});

export class PostgresSecretStore implements SecretStore {
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

  async put(r: SecretRecord): Promise<void> {
    const pool = await this.db();
    await pool.query(
      `INSERT INTO workspace_secrets(workspace_id,provider,ciphertext,last4,updated_at,updated_by)
       VALUES($1,$2,$3,$4,$5,$6)
       ON CONFLICT(workspace_id,provider)
       DO UPDATE SET ciphertext=$3, last4=$4, updated_at=$5, updated_by=$6`,
      [r.workspaceId, r.provider, r.ciphertext, r.last4, r.updatedAt, r.updatedBy],
    );
  }

  async get(workspaceId: string, provider: ProviderId): Promise<SecretRecord | undefined> {
    const pool = await this.db();
    const { rows } = await pool.query<Row>(
      "SELECT * FROM workspace_secrets WHERE workspace_id=$1 AND provider=$2",
      [workspaceId, provider],
    );
    return rows[0] ? toRecord(rows[0]) : undefined;
  }

  async list(workspaceId: string): Promise<SecretRecord[]> {
    const pool = await this.db();
    const { rows } = await pool.query<Row>(
      "SELECT * FROM workspace_secrets WHERE workspace_id=$1 ORDER BY provider",
      [workspaceId],
    );
    return rows.map(toRecord);
  }

  async delete(workspaceId: string, provider: ProviderId): Promise<void> {
    const pool = await this.db();
    await pool.query("DELETE FROM workspace_secrets WHERE workspace_id=$1 AND provider=$2", [
      workspaceId,
      provider,
    ]);
  }
}
