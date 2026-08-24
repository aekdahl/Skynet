// ─── File-backed secret store ────────────────────────────────────────────
// STORE=file durable persistence for provider credentials (Fly.io tokens,
// per-project LLM keys, any Settings-added key) — the desktop app's default
// backend for everything ELSE (projects/tasks/GitHub connection, via
// store/file.ts), but until now secrets/service.ts's makeStore() only ever
// checked for "postgres", silently falling through to MemorySecretStore for
// STORE=file too. That meant every Settings-added credential was wiped on
// every server restart, with no warning anywhere that it was ephemeral —
// the exact mechanism behind a real "Fly.io suddenly shows not connected"
// report (GitHub survived because it persists through the main Store; a
// Fly.io token added only through Settings never did).
//
// Same trust model as store/file.ts and the MFA recovery-code file: sealed
// ciphertext only (already encrypted by SecretService before it reaches
// here), never plaintext, on a plain JSON file next to the main data file —
// no native deps, no database, matching the desktop app's whole persistence
// story.

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import type { SecretAuditEntry, SecretRecord } from "./types.js";
import { MemorySecretStore } from "./memory.js";

/** Light shape guard, not a zod schema — SecretRecord is server-internal
 *  (no shared contract), same reasoning store/file.ts already applies to
 *  serviceTokens. Drops a malformed row with a warning rather than corrupting
 *  the whole load. */
function isSecretRecord(x: unknown): x is SecretRecord {
  if (!x || typeof x !== "object") return false;
  const r = x as Record<string, unknown>;
  return (
    typeof r.id === "string" &&
    typeof r.name === "string" &&
    typeof r.workspaceId === "string" &&
    typeof r.provider === "string" &&
    typeof r.ciphertext === "string" &&
    typeof r.last4 === "string" &&
    typeof r.updatedAt === "number" &&
    typeof r.updatedBy === "string"
  );
}

function isSecretAuditEntry(x: unknown): x is SecretAuditEntry {
  if (!x || typeof x !== "object") return false;
  const r = x as Record<string, unknown>;
  return (
    typeof r.id === "string" &&
    typeof r.workspaceId === "string" &&
    typeof r.credentialId === "string" &&
    typeof r.provider === "string" &&
    typeof r.label === "string" &&
    typeof r.action === "string" &&
    typeof r.operatorId === "string" &&
    typeof r.at === "number"
  );
}

export class FileSecretStore extends MemorySecretStore {
  private saveTimer?: ReturnType<typeof setTimeout>;

  private constructor(private path: string) {
    super();
  }

  /** Load from `path` if it exists, else create it as an empty store —
   *  mirrors store/file.ts's FileStore.create exactly. */
  static create(path: string): FileSecretStore {
    const exists = existsSync(path);
    const store = new FileSecretStore(path);
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
      // Pre-audit-log files were a bare array of credential rows; keep reading
      // those alongside the new {rows, audit} shape.
      const rows = Array.isArray(raw) ? raw : Array.isArray((raw as { rows?: unknown })?.rows) ? (raw as { rows: unknown[] }).rows : [];
      const audit = Array.isArray((raw as { audit?: unknown })?.audit) ? (raw as { audit: unknown[] }).audit : [];
      for (const row of rows) {
        if (isSecretRecord(row)) this.rows.set(`${row.workspaceId}:${row.id}`, row);
        else console.warn(`[secrets/file-store] dropped an invalid credential row on load`);
      }
      for (const entry of audit) {
        if (isSecretAuditEntry(entry)) this.audit.push(entry);
        else console.warn(`[secrets/file-store] dropped an invalid audit entry on load`);
      }
    } catch {
      // Corrupt or empty file → start fresh; the next flush rewrites it cleanly.
    }
  }

  // Coalesce bursts into a single debounced write — same shape as
  // store/file.ts's persist()/flush() split.
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
      writeFileSync(tmp, JSON.stringify({ rows: [...this.rows.values()], audit: this.audit }));
      renameSync(tmp, this.path);
    } catch {
      // best-effort; an unwritable path shouldn't crash the server
    }
  }
}
