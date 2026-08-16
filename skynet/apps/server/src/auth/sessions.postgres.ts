// ─── Postgres session store ───────────────────────────────────────────────
// Durable sessions: survive a server restart and are shared across replicas
// that point at the same database. Expiry is enforced in the query (and expired
// rows are swept on access). Connects lazily so it can be constructed
// synchronously from config. Drops in behind SessionStore.

import { Pool } from "pg";
import { now } from "../config.js";
import type { Principal, Scope } from "../auth.js";
import { newSession, type Session, type SessionStore } from "./sessions.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  token       text PRIMARY KEY,
  workspace_id text NOT NULL,
  operator_id  text NOT NULL,
  created_at   bigint NOT NULL,
  expires_at   bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_expires ON sessions(expires_at);
-- scopes: NULL = full authority (admin humans, dev tokens) — mirrors
-- Principal.scopes' own undefined-means-unrestricted convention, so a NULL
-- read back needs no special-casing before reaching hasScope(). Without this
-- column a viewer's restricted scopes were silently dropped on every
-- resolve() — a Postgres-backed viewer login resolved as full authority.
-- Added after the initial release; ADD COLUMN IF NOT EXISTS upgrades an
-- existing table in place (this table has no other migration yet).
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS scopes jsonb;
`;

interface Row {
  workspace_id: string;
  operator_id: string;
  expires_at: string;
  scopes: Scope[] | null;
}

export class PostgresSessionStore implements SessionStore {
  private ready?: Promise<Pool>;

  constructor(private connectionString: string) {}

  private async db(): Promise<Pool> {
    if (!this.ready) {
      this.ready = (async () => {
        const pool = new Pool({ connectionString: this.connectionString });
        await pool.query(SCHEMA);
        return pool;
      })();
    }
    return this.ready;
  }

  async create(principal: Principal, ttlMs: number): Promise<Session> {
    const session = newSession(principal, ttlMs);
    const pool = await this.db();
    await pool.query(
      `INSERT INTO sessions(token,workspace_id,operator_id,created_at,expires_at,scopes)
       VALUES($1,$2,$3,$4,$5,$6)`,
      [
        session.token,
        principal.workspaceId,
        principal.operatorId,
        session.createdAt,
        session.expiresAt,
        principal.scopes ? JSON.stringify(principal.scopes) : null,
      ],
    );
    return session;
  }

  async resolve(token: string): Promise<Principal | undefined> {
    const pool = await this.db();
    const { rows } = await pool.query<Row>("SELECT * FROM sessions WHERE token=$1", [token]);
    const row = rows[0];
    if (!row) return undefined;
    if (now() >= Number(row.expires_at)) {
      await pool.query("DELETE FROM sessions WHERE token=$1", [token]); // sweep on access
      return undefined;
    }
    return {
      workspaceId: row.workspace_id,
      operatorId: row.operator_id,
      ...(row.scopes ? { scopes: row.scopes } : {}),
    };
  }

  async destroy(token: string): Promise<void> {
    const pool = await this.db();
    await pool.query("DELETE FROM sessions WHERE token=$1", [token]);
  }
}
