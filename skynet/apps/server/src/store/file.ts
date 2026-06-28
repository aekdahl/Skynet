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
import { MemoryStore } from "./memory.js";

interface HasId { id: string }

export class FileStore extends MemoryStore {
  private saveTimer?: ReturnType<typeof setTimeout>;

  private constructor(private path: string, opts: { seed?: boolean }) {
    super(opts);
  }

  /** Load from `path` if it exists, else create it (seeding demo data when asked). */
  static create(path: string, seed = false): FileStore {
    const exists = existsSync(path);
    const store = new FileStore(path, { seed: exists ? false : seed });
    if (exists) {
      store.load();
    } else {
      mkdirSync(dirname(path), { recursive: true });
      store.flush(); // materialize the (possibly seeded) initial state
    }
    return store;
  }

  private load(): void {
    try {
      const d = JSON.parse(readFileSync(this.path, "utf8")) as Record<string, unknown>;
      const fill = <T extends HasId>(m: Map<string, T>, arr: unknown) => {
        if (Array.isArray(arr)) for (const x of arr) m.set((x as T).id, x as T);
      };
      fill(this.agents, d.agents);
      fill(this.queue, d.queue);
      fill(this.projects, d.projects);
      fill(this.tasks, d.tasks);
      fill(this.fleet, d.fleet);
      if (Array.isArray(d.modules)) this.modules = d.modules as Module[];
      if (Array.isArray(d.deps)) this.deps = d.deps as Dependency[];
      if (Array.isArray(d.audit)) this.audit = d.audit as AuditRecord[];
      // GitHub connections are keyed by workspaceId (not id), so fill directly.
      if (Array.isArray(d.github)) for (const c of d.github as GithubConnection[]) this.github.set(c.workspaceId, c);
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
      agents: [...this.agents.values()],
      queue: [...this.queue.values()],
      projects: [...this.projects.values()],
      tasks: [...this.tasks.values()],
      fleet: [...this.fleet.values()],
      modules: this.modules,
      deps: this.deps,
      audit: this.audit,
      github: [...this.github.values()],
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
