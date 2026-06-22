// ─── In-memory secret store ───────────────────────────────────────────────
// Dev/default backend. Holds sealed ciphertext (already encrypted by the
// service) keyed by workspace+provider. Resets on restart — fine for local dev.

import type { ProviderId } from "@skynet/shared";
import type { SecretRecord, SecretStore } from "./types.js";

const key = (ws: string, provider: ProviderId) => `${ws}:${provider}`;

export class MemorySecretStore implements SecretStore {
  private rows = new Map<string, SecretRecord>();

  async put(record: SecretRecord): Promise<void> {
    this.rows.set(key(record.workspaceId, record.provider), record);
  }
  async get(workspaceId: string, provider: ProviderId): Promise<SecretRecord | undefined> {
    return this.rows.get(key(workspaceId, provider));
  }
  async list(workspaceId: string): Promise<SecretRecord[]> {
    return [...this.rows.values()].filter((r) => r.workspaceId === workspaceId);
  }
  async delete(workspaceId: string, provider: ProviderId): Promise<void> {
    this.rows.delete(key(workspaceId, provider));
  }
}
