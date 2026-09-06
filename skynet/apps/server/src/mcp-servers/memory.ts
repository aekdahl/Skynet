// ─── In-memory MCP server store ───────────────────────────────────────────
// STORE=memory backend (dev/test — resets on restart, by design). Same shape
// as ../secrets/memory.ts: holds sealed records keyed by workspace + id;
// `persist()` is a no-op hook overridden by FileMcpServerStore (STORE=file) to
// debounce-flush every mutation to disk. Extend, don't fork.

import type { McpServerRecord, McpServerStore } from "./types.js";

const key = (ws: string, id: string) => `${ws}:${id}`;

export class MemoryMcpServerStore implements McpServerStore {
  protected rows = new Map<string, McpServerRecord>();

  /** Hook for a durable subclass (FileMcpServerStore) to persist on every
   *  mutation. No-op here — an in-memory store has nothing to flush. */
  protected persist(): void {}

  async put(record: McpServerRecord): Promise<void> {
    this.rows.set(key(record.workspaceId, record.id), record);
    this.persist();
  }
  async get(workspaceId: string, id: string): Promise<McpServerRecord | undefined> {
    return this.rows.get(key(workspaceId, id));
  }
  async list(workspaceId: string): Promise<McpServerRecord[]> {
    return [...this.rows.values()].filter((r) => r.workspaceId === workspaceId);
  }
  async delete(workspaceId: string, id: string): Promise<void> {
    this.rows.delete(key(workspaceId, id));
    this.persist();
  }
}
