// ─── Project live preview (Phase-1 v0: web/sites) ──────────────────────────
// Runs a project's web dev/serve command so the operator can SEE the app the
// fleet is building — split-screen beside the board — and watch it update as
// changes merge in. See docs/live-preview.md.
//
// Model: one preview process per project, running in a DETACHED worktree of the
// project's integration branch (never the operator's own checkout). The recipe
// (how to start it) resolves from `.skynet/preview.json` → a package.json
// heuristic (the agent-assisted resolver is the documented next step). The child
// is spawned through the opt-in OS sandbox (write-confined when enabled) on a
// loopback port; the SPA iframes that port directly (desktop = same machine, no
// proxy). `refresh()` re-points the worktree at the branch tip on merge so a
// dev server's HMR shows the change; the UI can also reload/restart manually.

import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { createServer } from "node:net";
import { get as httpGet } from "node:http";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { wrapForSandbox } from "@skynet/runner-sdk/sandbox";
import { gitBin } from "../git-bin.js";

const exec = promisify(execFile);

export type PreviewStatus = "idle" | "starting" | "live" | "failed" | "stopped";

export interface PreviewRecipe {
  /** The command line to start the server, e.g. "npm run dev". */
  cmd: string;
  /** Where the app will listen; injected as PORT and used to health-check. */
  port: number;
  source: "descriptor" | "heuristic";
}

export interface PreviewState {
  status: PreviewStatus;
  url: string | null;
  port: number | null;
  recipe: { cmd: string; source: string } | null;
  error: string | null;
  logs: string[];
  startedAt: number | null;
}

interface Live {
  status: PreviewStatus;
  child?: ChildProcess;
  port?: number;
  recipe?: PreviewRecipe;
  dir: string;
  repoPath: string;
  logs: string[];
  error: string | null;
  startedAt: number | null;
  lastTouched: number;
  idleTimer?: ReturnType<typeof setTimeout>;
}

const LOG_CAP = 200;
const IDLE_MS = 15 * 60 * 1000; // auto-stop a preview no one is watching
const HEALTH_TIMEOUT_MS = 45_000;

export class ProjectPreviewManager {
  private previews = new Map<string, Live>();

  constructor(private worktreesDir?: string) {}

  private git(cwd: string, ...args: string[]): Promise<{ stdout: string }> {
    return exec(gitBin(), ["-C", cwd, ...args]);
  }

  private previewDir(projectId: string): string {
    const root = this.worktreesDir ?? resolve(process.cwd(), ".skynet-worktrees");
    return join(root, `preview-${projectId.replace(/[^a-zA-Z0-9._-]/g, "_")}`);
  }

  private integrationBranch(projectId: string): string {
    return `skynet/integration/${projectId}`;
  }

  /** A serializable snapshot for the API/UI. */
  state(projectId: string): PreviewState {
    const p = this.previews.get(projectId);
    if (!p) return { status: "idle", url: null, port: null, recipe: null, error: null, logs: [], startedAt: null };
    p.lastTouched = Date.now(); // polling status counts as "watching" → defers idle stop
    return {
      status: p.status,
      url: p.status === "live" && p.port ? `http://127.0.0.1:${p.port}` : null,
      port: p.port ?? null,
      recipe: p.recipe ? { cmd: p.recipe.cmd, source: p.recipe.source } : null,
      error: p.error,
      logs: p.logs.slice(-80),
      startedAt: p.startedAt,
    };
  }

  private log(p: Live, line: string) {
    for (const l of line.split("\n")) if (l.trim()) p.logs.push(l);
    if (p.logs.length > LOG_CAP) p.logs.splice(0, p.logs.length - LOG_CAP);
  }

  /** Resolve HOW to start the preview: descriptor first, then a package.json
   *  heuristic. (Agent-assisted resolution is the documented next step.) */
  private resolveRecipe(dir: string, port: number): PreviewRecipe | null {
    const descPath = join(dir, ".skynet", "preview.json");
    if (existsSync(descPath)) {
      try {
        const d = JSON.parse(readFileSync(descPath, "utf8")) as { dev?: string; start?: string; port?: number };
        const cmd = d.dev || d.start;
        if (cmd) return { cmd, port: d.port ?? port, source: "descriptor" };
      } catch {
        /* malformed descriptor → fall through to heuristic */
      }
    }
    const pkgPath = join(dir, "package.json");
    if (existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { scripts?: Record<string, string> };
        const scripts = pkg.scripts ?? {};
        const script = ["dev", "start", "serve", "preview"].find((s) => scripts[s]);
        if (script) return { cmd: `npm run ${script}`, port, source: "heuristic" };
      } catch {
        /* malformed package.json */
      }
    }
    return null;
  }

  private freePort(): Promise<number> {
    return new Promise((res, rej) => {
      const srv = createServer();
      srv.on("error", rej);
      srv.listen(0, "127.0.0.1", () => {
        const addr = srv.address();
        const port = typeof addr === "object" && addr ? addr.port : 0;
        srv.close(() => (port ? res(port) : rej(new Error("no free port"))));
      });
    });
  }

  /** Poll the port until the app answers (any HTTP response) or we give up. */
  private waitForPort(port: number, until: number): Promise<boolean> {
    return new Promise((res) => {
      const tick = () => {
        const req = httpGet({ host: "127.0.0.1", port, path: "/", timeout: 1500 }, (r) => {
          r.resume();
          res(true);
        });
        req.on("error", () => (Date.now() > until ? res(false) : setTimeout(tick, 400)));
        req.on("timeout", () => req.destroy());
      };
      tick();
    });
  }

  /** Prepare (or refresh) a detached worktree at the integration branch tip.
   *  Detached so it never collides with the merge engine's own worktree on the
   *  same branch. Falls back to the base branch / HEAD when integration is new. */
  private async prepareWorktree(projectId: string, repoPath: string): Promise<string> {
    const dir = this.previewDir(projectId);
    const branch = this.integrationBranch(projectId);
    const hasBranch = (await this.git(repoPath, "branch", "--list", branch).catch(() => ({ stdout: "" }))).stdout.trim();
    const ref = hasBranch ? branch : "HEAD";
    // Clean any stale worktree, then add fresh, detached at the ref.
    await this.git(repoPath, "worktree", "remove", "--force", dir).catch(() => undefined);
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    await this.git(repoPath, "worktree", "add", "--force", "--detach", dir, ref);
    return dir;
  }

  async start(projectId: string, repoPath: string): Promise<PreviewState> {
    if (!repoPath) throw new Error("This project has no local folder to preview.");
    await this.stop(projectId); // idempotent — a start replaces any existing preview

    const p: Live = {
      status: "starting", dir: this.previewDir(projectId), repoPath,
      logs: [], error: null, startedAt: Date.now(), lastTouched: Date.now(),
    };
    this.previews.set(projectId, p);

    try {
      p.dir = await this.prepareWorktree(projectId, repoPath);
      const port = await this.freePort();
      const recipe = this.resolveRecipe(p.dir, port);
      if (!recipe) {
        p.status = "failed";
        p.error = "Couldn't tell how to start this project — add a dev/start script or a .skynet/preview.json.";
        return this.state(projectId);
      }
      p.recipe = recipe;
      p.port = recipe.port;
      this.log(p, `▸ ${recipe.cmd}  (PORT=${recipe.port}, source: ${recipe.source})`);

      // Spawn via a shell so "npm run dev" etc. work; wrap for the opt-in OS
      // sandbox (no-op unless SKYNET_RUNNER_SANDBOX). PORT is injected two ways
      // (env + common Vite/CRA/Next var) so most dev servers pick it up.
      const wrapped = wrapForSandbox("/bin/sh", ["-c", recipe.cmd], { cwd: p.dir });
      if (wrapped.note) this.log(p, wrapped.note);
      const child = spawn(wrapped.bin, wrapped.args, {
        cwd: p.dir,
        env: { ...process.env, PORT: String(recipe.port), VITE_PORT: String(recipe.port), BROWSER: "none" },
      });
      p.child = child;
      child.stdout?.on("data", (b) => this.log(p, b.toString()));
      child.stderr?.on("data", (b) => this.log(p, b.toString()));
      child.on("exit", (code) => {
        if (this.previews.get(projectId) !== p) return; // superseded
        if (p.status !== "stopped") {
          p.status = "failed";
          p.error = p.error ?? `preview process exited (code ${code ?? "?"})`;
        }
      });
      child.on("error", (err) => {
        p.status = "failed";
        p.error = err.message;
      });

      const ok = await this.waitForPort(recipe.port, Date.now() + HEALTH_TIMEOUT_MS);
      if (this.previews.get(projectId) !== p) return this.state(projectId); // superseded mid-wait
      if (ok && p.status === "starting") {
        p.status = "live";
        this.armIdle(projectId, p);
      } else if (p.status === "starting") {
        p.status = "failed";
        p.error = p.error ?? `the app didn't start listening on port ${recipe.port} within ${HEALTH_TIMEOUT_MS / 1000}s`;
      }
    } catch (err) {
      p.status = "failed";
      p.error = (err as Error).message;
    }
    return this.state(projectId);
  }

  /** Re-point the worktree at the integration branch tip (called on merge). A
   *  dev server's file-watcher then HMR-updates; the UI reloads for the rest. */
  async refresh(projectId: string): Promise<PreviewState> {
    const p = this.previews.get(projectId);
    if (!p || p.status !== "live") return this.state(projectId);
    const branch = this.integrationBranch(projectId);
    const hasBranch = (await this.git(p.repoPath, "branch", "--list", branch).catch(() => ({ stdout: "" }))).stdout.trim();
    if (hasBranch) {
      await this.git(p.dir, "checkout", "--detach", branch).catch((e) => this.log(p, `refresh: ${(e as Error).message}`));
      this.log(p, "↻ refreshed to integration branch tip");
    }
    p.lastTouched = Date.now();
    return this.state(projectId);
  }

  async restart(projectId: string, repoPath: string): Promise<PreviewState> {
    return this.start(projectId, repoPath);
  }

  async stop(projectId: string): Promise<PreviewState> {
    const p = this.previews.get(projectId);
    if (p) {
      p.status = "stopped";
      if (p.idleTimer) clearTimeout(p.idleTimer);
      if (p.child && !p.child.killed) p.child.kill("SIGTERM");
      await this.git(p.repoPath, "worktree", "remove", "--force", p.dir).catch(() => undefined);
      this.previews.delete(projectId);
    }
    return { status: "stopped", url: null, port: null, recipe: null, error: null, logs: [], startedAt: null };
  }

  /** Auto-stop a preview nothing has polled in IDLE_MS (bounds resource use). */
  private armIdle(projectId: string, p: Live) {
    if (p.idleTimer) clearTimeout(p.idleTimer);
    p.idleTimer = setTimeout(() => {
      if (Date.now() - p.lastTouched >= IDLE_MS) void this.stop(projectId);
      else this.armIdle(projectId, p);
    }, IDLE_MS);
  }

  /** Stop every preview (server shutdown). */
  async stopAll(): Promise<void> {
    for (const id of [...this.previews.keys()]) await this.stop(id);
  }
}

export const projectPreview = new ProjectPreviewManager(process.env.SKYNET_WORKTREES_DIR || undefined);
