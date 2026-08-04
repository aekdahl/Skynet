// ─── In-memory secret store ───────────────────────────────────────────────
// Dev/default backend. Holds sealed ciphertext (already encrypted by the
// service) keyed by workspace + credential id. Resets on restart — fine for
// local dev.

import type { SecretRecord, SecretStore } from "./types.js";

const key = (ws: string, id: string) => `${ws}:${id}`;

export class MemorySecretStore implements SecretStore {
  private rows = new Map<string, SecretRecord>();

  async put(record: SecretRecord): Promise<void> {
    this.rows.set(key(record.workspaceId, record.id), record);
  }
  async get(workspaceId: string, id: string): Promise<SecretRecord | undefined> {
    return this.rows.get(key(workspaceId, id));
  }
  async list(workspaceId: string): Promise<SecretRecord[]> {
    return [...this.rows.values()].filter((r) => r.workspaceId === workspaceId);
  }
  async delete(workspaceId: string, id: string): Promise<void> {
    this.rows.delete(key(workspaceId, id));
  }
}
