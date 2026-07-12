// ─── File-backed store ──────────────────────────────────────────────────────
// Zero-dependency durable persistence for single-user / desktop installs: the
// in-memory store, snapshotted to a JSON file on disk. No database, no native
// modules — which keeps the desktop app trivial to package and auto-update.
// Reads serve from memory (fast); writes are coalesced and flushed atomically.
// Drops in behind the Store interface (STORE=file); Postgres remains the option
// for multi-replica/server deployments.

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import type { AuditRecord, Dependency, GithubConnection, Module } from "@skynet/shared";
import { HitlItem } from "@skynet/shared";
import { MemoryStore } from "./memory.js";

interface HasId { id: string }

export class FileStore extends MemoryStore {
  private saveTimer?: ReturnType<typeof setTimeout>;

  private constructor(private path: string) {
    super();
  }

  /** Load from `path` if it exists, else create it as an empty store. */
  static create(path: string): FileStore {
    const exists = existsSync(path);
    const store = new FileStore(path);
    if (exists) {
      store.load();
    } else {
      mkdirSync(dirname(path), { recursive: true });
      store.flush(); // materialize the initial (empty) state
    }
    return store;
  }

  private load(): void {
    try {
      const d = JSON.parse(readFileSync(this.path, "utf8")) as Record<string, unknown>;
      const fill = <T extends HasId>(m: Map<string, T>, arr: unknown) => {
        if (Array.isArray(arr)) for (const x of arr) m.set((x as T).id, x as T);
      };
      fill(this.runs, d.runs);
      // Migrate + validate persisted HITL items. The agentId→runId rename shipped
      // without a data migration, so a store written before it has queue items
      // with `agentId` and no `runId`. The Snapshot contract now REQUIRES runId,
      // and the client parses the whole snapshot atomically — so a single legacy
      // item fails validation and blanks the entire UI ("Connecting…" forever).
      // Backfill runId from the legacy agentId, then drop anything that still
      // fails the contract so one bad record can't wedge the app.
      if (Array.isArray(d.queue)) {
        for (const raw of d.queue as Record<string, unknown>[]) {
          const item = raw.runId == null && typeof raw.agentId === "string" ? { ...raw, runId: raw.agentId } : raw;
          const parsed = HitlItem.safeParse(item);
          if (parsed.success) this.queue.set(parsed.data.id, parsed.data);
          else console.warn(`[file-store] dropped unparseable HITL item ${String(raw.id ?? "(no id)")}: ${parsed.error.issues.map((i) => i.path.join(".")).join(", ")}`);
        }
      }
      fill(this.projects, d.projects);
      fill(this.tasks, d.tasks);
      fill(this.fleet, d.fleet);
      if (Array.isArray(d.modules)) this.modules = d.modules as Module[];
      if (Array.isArray(d.deps)) this.deps = d.deps as Dependency[];
      if (Array.isArray(d.audit)) this.audit = d.audit as AuditRecord[];
      // GitHub connections are keyed by workspaceId (not id), so fill directly.
      if (Array.isArray(d.github)) for (const c of d.github as GithubConnection[]) this.github.set(c.workspaceId, c);
      if (d.githubTokens && typeof d.githubTokens === "object")
        for (const [ws, ct] of Object.entries(d.githubTokens as Record<string, string>)) this.githubTokens.set(ws, ct);
    } catch {
      // Corrupt or empty file → start fresh; the next flush rewrites it cleanly.
    }
  }

  // Coalesce bursts (e.g. rapid appendLog) into a single debounced write.
  protected override persist(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      this.flush();
    }, 150);
  }

  /** Write the full state atomically (temp file + rename). */
  flush(): void {
    const data = {
      runs: [...this.runs.values()],
      queue: [...this.queue.values()],
      projects: [...this.projects.values()],
      tasks: [...this.tasks.values()],
      fleet: [...this.fleet.values()],
      modules: this.modules,
      deps: this.deps,
      audit: this.audit,
      github: [...this.github.values()],
      githubTokens: Object.fromEntries(this.githubTokens),
    };
    try {
      const tmp = `${this.path}.tmp`;
      writeFileSync(tmp, JSON.stringify(data));
      renameSync(tmp, this.path);
    } catch {
      // best-effort; an unwritable path shouldn't crash the server
    }
  }
}
