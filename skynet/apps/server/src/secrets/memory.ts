// ─── In-memory secret store ───────────────────────────────────────────────
// STORE=memory backend (dev/test — resets on restart, by design). Holds
// sealed ciphertext (already encrypted by the service) keyed by workspace +
// credential id. `persist()` is a no-op hook here, overridden by
// FileSecretStore (STORE=file) to debounce-flush every mutation to disk —
// same shape as the main Store/FileStore split (store/memory.ts,
// store/file.ts). Extend, don't fork: FileSecretStore subclasses this rather
// than reimplementing the Map bookkeeping.

import type { SecretAuditEntry, SecretRecord, SecretStore } from "./types.js";

const key = (ws: string, id: string) => `${ws}:${id}`;

export class MemorySecretStore implements SecretStore {
  protected rows = new Map<string, SecretRecord>();
  /** Lifecycle events, oldest first (listAudit reverses on read). Kept past a
   *  credential's deletion — this is the only record of who removed it. */
  protected audit: SecretAuditEntry[] = [];

  /** Hook for a durable subclass (FileSecretStore) to persist on every
   *  mutation. No-op here — an in-memory store has nothing to flush. */
  protected persist(): void {}

  async put(record: SecretRecord): Promise<void> {
    this.rows.set(key(record.workspaceId, record.id), record);
    this.persist();
  }
  async get(workspaceId: string, id: string): Promise<SecretRecord | undefined> {
    return this.rows.get(key(workspaceId, id));
  }
  async list(workspaceId: string): Promise<SecretRecord[]> {
    return [...this.rows.values()].filter((r) => r.workspaceId === workspaceId);
  }
  async delete(workspaceId: string, id: string): Promise<void> {
    this.rows.delete(key(workspaceId, id));
    this.persist();
  }
  async recordAudit(entry: SecretAuditEntry): Promise<void> {
    this.audit.push(entry);
    this.persist();
  }
  async listAudit(workspaceId: string): Promise<SecretAuditEntry[]> {
    return this.audit
      .filter((e) => e.workspaceId === workspaceId)
      .slice()
      .reverse();
  }
}
