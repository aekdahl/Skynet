// ─── Postgres secret store ────────────────────────────────────────────────
// Durable backend for sealed provider keys. Stores ONLY ciphertext + metadata
// (no plaintext, no master key) in its own table. Connects lazily on first use
// so the store can be constructed synchronously from config.
//
// Keyed by (workspace_id, id) where `id` is the credential id — the default
// credential per provider has id === provider. The migration block below adds
// the id/name columns and backfills id = provider for pre-credential rows, so
// existing keys survive with no manual step. (Hosted path; the local desktop /
// tests use the memory store.)

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
  id           text,
  name         text NOT NULL DEFAULT ''
);
-- Backfill the credential id for rows created before named credentials existed:
-- the default credential's id is its provider.
UPDATE workspace_secrets SET id = provider WHERE id IS NULL;
ALTER TABLE workspace_secrets ALTER COLUMN id SET NOT NULL;
-- Re-key on (workspace_id, id). Drop whatever PK exists first (idempotent).
ALTER TABLE workspace_secrets DROP CONSTRAINT IF EXISTS workspace_secrets_pkey;
ALTER TABLE workspace_secrets ADD CONSTRAINT workspace_secrets_pkey PRIMARY KEY (workspace_id, id);
`;

interface Row {
  id: string;
  name: string;
  workspace_id: string;
  provider: string;
  ciphertext: string;
  last4: string;
  updated_at: string;
  updated_by: string;
}

const toRecord = (r: Row): SecretRecord => ({
  id: r.id,
  name: r.name ?? "",
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
      `INSERT INTO workspace_secrets(workspace_id,id,name,provider,ciphertext,last4,updated_at,updated_by)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT(workspace_id,id)
       DO UPDATE SET name=$3, provider=$4, ciphertext=$5, last4=$6, updated_at=$7, updated_by=$8`,
      [r.workspaceId, r.id, r.name, r.provider, r.ciphertext, r.last4, r.updatedAt, r.updatedBy],
    );
  }

  async get(workspaceId: string, id: string): Promise<SecretRecord | undefined> {
    const pool = await this.db();
    const { rows } = await pool.query<Row>(
      "SELECT * FROM workspace_secrets WHERE workspace_id=$1 AND id=$2",
      [workspaceId, id],
    );
    return rows[0] ? toRecord(rows[0]) : undefined;
  }

  async list(workspaceId: string): Promise<SecretRecord[]> {
    const pool = await this.db();
    const { rows } = await pool.query<Row>(
      "SELECT * FROM workspace_secrets WHERE workspace_id=$1 ORDER BY provider, name",
      [workspaceId],
    );
    return rows.map(toRecord);
  }

  async delete(workspaceId: string, id: string): Promise<void> {
    const pool = await this.db();
    await pool.query("DELETE FROM workspace_secrets WHERE workspace_id=$1 AND id=$2", [
      workspaceId,
      id,
    ]);
  }
}
