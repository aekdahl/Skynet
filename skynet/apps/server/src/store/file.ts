// ─── File-backed store ──────────────────────────────────────────────────────
// Zero-dependency durable persistence for single-user / desktop installs: the
// in-memory store, snapshotted to a JSON file on disk. No database, no native
// modules — which keeps the desktop app trivial to package and auto-update.
// Reads serve from memory (fast); writes are coalesced and flushed atomically.
// Drops in behind the Store interface (STORE=file); Postgres remains the option
// for multi-replica/server deployments.

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import type { GithubConnection, WorkspaceSettings } from "@skynet/shared";
import { Agent, AuditRecord, Checkpoint, Dependency, Feature, HitlItem, Milestone, Module, Project, Task, TaskRun } from "@skynet/shared";
import type { z } from "zod";
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
      // Load each snapshot-feeding collection THROUGH its contract, dropping any
      // record that no longer validates. The client parses the whole snapshot
      // atomically, so a single legacy record blanks the entire UI ("Connecting…"
      // forever). A half-applied schema migration is exactly when this bites —
      // e.g. the agentId→runId rename on HitlItem, or a Task state ("assigned")
      // the enum later dropped. Dropping the few bad rows (with a warning) keeps
      // the workspace usable; `repair` fixes the mechanical renames we know about.
      const fill = <T extends HasId>(
        m: Map<string, T>,
        arr: unknown,
        schema: z.ZodType<T>,
        label: string,
        repair?: (x: Record<string, unknown>) => Record<string, unknown>,
      ) => {
        if (!Array.isArray(arr)) return;
        for (const raw of arr as Record<string, unknown>[]) {
          const parsed = schema.safeParse(repair ? repair(raw) : raw);
          if (parsed.success) m.set(parsed.data.id, parsed.data);
          else console.warn(`[file-store] dropped invalid ${label} ${String(raw.id ?? "(no id)")}: ${parsed.error.issues.map((i) => i.path.join(".")).join(", ")}`);
        }
      };
      const fillArray = <T>(arr: unknown, schema: z.ZodType<T>, label: string): T[] => {
        if (!Array.isArray(arr)) return [];
        return (arr as unknown[]).flatMap((raw) => {
          const parsed = schema.safeParse(raw);
          if (parsed.success) return [parsed.data];
          console.warn(`[file-store] dropped invalid ${label}: ${parsed.error.issues.map((i) => i.path.join(".")).join(", ")}`);
          return [];
        });
      };

      fill(this.runs, d.runs, TaskRun, "run");
      fill(this.checkpoints, d.checkpoints, Checkpoint, "checkpoint");
      // Legacy repair: the agentId→runId rename shipped without a data migration.
      fill(this.queue, d.queue, HitlItem, "HITL item", (x) =>
        x.runId == null && typeof x.agentId === "string" ? { ...x, runId: x.agentId } : x,
      );
      fill(this.projects, d.projects, Project, "project");
      fill(this.tasks, d.tasks, Task, "task");
      fill(this.features, d.features, Feature, "feature");
      fill(this.milestones, d.milestones, Milestone, "milestone");
      fill(this.fleet, d.fleet, Agent, "agent");
      this.modules = fillArray(d.modules, Module, "module");
      this.deps = fillArray(d.deps, Dependency, "dependency");
      // Validate audit rows on load, like every other collection — the earlier
      // raw cast let a legacy/half-migrated row survive here, then the client's
      // strict `AuditRecord.array().parse()` on /api/audit blew up on the whole
      // list and blanked the audit page (approvals looked lost). fillArray drops
      // the few bad rows with a warning; the rest still show.
      this.audit = fillArray(d.audit, AuditRecord, "audit record");
      // GitHub connections are keyed by workspaceId (not id), so fill directly.
      if (Array.isArray(d.github)) for (const c of d.github as GithubConnection[]) this.github.set(c.workspaceId, c);
      if (Array.isArray(d.workspaceSettings)) for (const s of d.workspaceSettings as WorkspaceSettings[]) this.workspaceSettings.set(s.workspaceId, s);
      if (d.githubTokens && typeof d.githubTokens === "object")
        for (const [ws, ct] of Object.entries(d.githubTokens as Record<string, string>)) this.githubTokens.set(ws, ct);
      // Service tokens hold a hash (never the raw secret) — a plain array keyed
      // by id. Server-internal (no shared zod contract), so fill directly with a
      // light shape guard and drop anything malformed.
      if (Array.isArray(d.serviceTokens))
        for (const t of d.serviceTokens as import("../auth/service-tokens.js").StoredServiceToken[])
          if (t && typeof t.id === "string" && typeof t.tokenHash === "string" && t.principal) this.serviceTokens.set(t.id, t);
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
      checkpoints: [...this.checkpoints.values()],
      queue: [...this.queue.values()],
      projects: [...this.projects.values()],
      tasks: [...this.tasks.values()],
      features: [...this.features.values()],
      milestones: [...this.milestones.values()],
      fleet: [...this.fleet.values()],
      modules: this.modules,
      deps: this.deps,
      audit: this.audit,
      github: [...this.github.values()],
      workspaceSettings: [...this.workspaceSettings.values()],
      githubTokens: Object.fromEntries(this.githubTokens),
      serviceTokens: [...this.serviceTokens.values()],
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
