// ─── File-backed MCP server store ────────────────────────────────────────
// STORE=file durable persistence for custom MCP server configs — same trust
// model and structure as ../secrets/file.ts: sealed ciphertext only (already
// encrypted by McpServerService before it reaches here), never plaintext
// secrets, on a plain JSON file next to the main data file.

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import type { McpServerRecord } from "./types.js";
import { MemoryMcpServerStore } from "./memory.js";

/** Light shape guard, not a zod schema — McpServerRecord is server-internal
 *  (no shared contract), same reasoning secrets/file.ts applies. Drops a
 *  malformed row with a warning rather than corrupting the whole load. */
function isMcpServerRecord(x: unknown): x is McpServerRecord {
  if (!x || typeof x !== "object") return false;
  const r = x as Record<string, unknown>;
  return (
    typeof r.id === "string" &&
    typeof r.workspaceId === "string" &&
    typeof r.name === "string" &&
    (r.transport === "stdio" || r.transport === "remote") &&
    typeof r.command === "string" &&
    Array.isArray(r.args) &&
    typeof r.url === "string" &&
    Array.isArray(r.envKeys) &&
    Array.isArray(r.headerKeys) &&
    typeof r.specCiphertext === "string" &&
    typeof r.updatedAt === "number" &&
    typeof r.updatedBy === "string"
  );
}

export class FileMcpServerStore extends MemoryMcpServerStore {
  private saveTimer?: ReturnType<typeof setTimeout>;

  private constructor(private path: string) {
    super();
  }

  /** Load from `path` if it exists, else create it as an empty store —
   *  mirrors ../secrets/file.ts's FileSecretStore.create exactly. */
  static create(path: string): FileMcpServerStore {
    const exists = existsSync(path);
    const store = new FileMcpServerStore(path);
    if (exists) store.load();
    else {
      mkdirSync(dirname(path), { recursive: true });
      store.flush(); // materialize the initial (empty) state
    }
    return store;
  }

  private load(): void {
    try {
      const raw = JSON.parse(readFileSync(this.path, "utf8")) as unknown;
      const rows = Array.isArray((raw as { rows?: unknown })?.rows) ? (raw as { rows: unknown[] }).rows : [];
      for (const row of rows) {
        if (isMcpServerRecord(row)) this.rows.set(`${row.workspaceId}:${row.id}`, row);
        else console.warn(`[mcp-servers/file-store] dropped an invalid row on load`);
      }
    } catch {
      // Corrupt or empty file → start fresh; the next flush rewrites it cleanly.
    }
  }

  // Coalesce bursts into a single debounced write — same shape as
  // ../secrets/file.ts's persist()/flush() split.
  protected override persist(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      this.flush();
    }, 150);
  }

  /** Write the full state atomically (temp file + rename). */
  flush(): void {
    try {
      const tmp = `${this.path}.tmp`;
      writeFileSync(tmp, JSON.stringify({ rows: [...this.rows.values()] }));
      renameSync(tmp, this.path);
    } catch {
      // best-effort; an unwritable path shouldn't crash the server
    }
  }
}
