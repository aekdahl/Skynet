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
import { mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { get as httpGet } from "node:http";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { wrapForSandbox } from "@skynet/runner-sdk/sandbox";
import { oneShotRepoAssistant } from "@skynet/runner-sdk/claude";
import { gitBin } from "../git-bin.js";
import { secretService } from "../secrets/index.js";

const exec = promisify(execFile);

export type PreviewStatus = "idle" | "starting" | "live" | "failed" | "stopped";

export interface PreviewRecipe {
  /** The command line to start the server, e.g. "npm run dev". */
  cmd: string;
  /** Where the app will listen; injected as PORT and used to health-check. */
  port: number;
  source: "descriptor" | "heuristic" | "agent";
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
  // Cache an agent-proposed recipe per project so a restart doesn't re-ask the
  // model (persisting it to a committed .skynet/preview.json is the next step).
  private agentRecipe = new Map<string, { cmd: string }>();

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

  /** Deterministic recipe: `.skynet/preview.json` descriptor, then a
   *  package.json script heuristic. No I/O beyond reading two files. */
  private resolveRecipeStatic(dir: string, port: number): PreviewRecipe | null {
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

  /**
   * Resolve HOW to start the preview: descriptor → heuristic → agent. When the
   * deterministic checks can't tell (no descriptor, no obvious dev script), ask
   * the repo-aware assistant — the same BYOK agent behind "Ask about this
   * project" — to read the repo and PROPOSE a start command. It's cached per
   * project (a restart doesn't re-ask) and used with the current free port.
   */
  private async resolveRecipe(
    dir: string,
    port: number,
    projectId: string,
    workspaceId?: string,
    repoPath?: string,
    log?: (line: string) => void,
  ): Promise<PreviewRecipe | null> {
    const cached = this.agentRecipe.get(projectId);
    if (cached) return { cmd: cached.cmd, port, source: "agent" };
    const stat = this.resolveRecipeStatic(dir, port);
    if (stat) return stat;
    if (!workspaceId) return null; // no key context → can't ask the agent
    const apiKey = (await secretService.resolve(workspaceId, "claude").catch(() => undefined)) ?? undefined;
    if (!apiKey) return null;
    const cmd = await this.askAgentForRecipe(dir, apiKey);
    if (!cmd) return null;
    this.agentRecipe.set(projectId, { cmd });
    // Persist the proposal to the operator's repo so it becomes the deterministic
    // descriptor — reviewable, editable, and (once committed) used everywhere
    // without re-asking. Never clobber a descriptor a human already wrote.
    if (repoPath) await this.persistRecipe(repoPath, cmd, log);
    return { cmd, port, source: "agent" };
  }

  /** Write the agent's proposal to `<repo>/.skynet/preview.json` (if absent) so
   *  a human can review + commit it; committing makes it the descriptor. */
  private async persistRecipe(repoPath: string, cmd: string, log?: (line: string) => void): Promise<void> {
    const descPath = join(repoPath, ".skynet", "preview.json");
    if (existsSync(descPath)) return; // respect an existing human-authored descriptor
    try {
      await mkdir(join(repoPath, ".skynet"), { recursive: true });
      await writeFile(
        descPath,
        JSON.stringify({ dev: cmd, _note: "Proposed by the Skynet preview assistant — edit or commit to keep." }, null, 2) + "\n",
      );
      log?.(`wrote .skynet/preview.json (dev: ${cmd}) — commit it to make this the default preview command`);
    } catch (err) {
      log?.(`couldn't write .skynet/preview.json: ${(err as Error).message}`);
    }
  }

  /** Ask the repo-aware assistant to propose a dev/serve command as strict JSON.
   *  `$PORT` in the command is honoured — we inject PORT into the child env. */
  private async askAgentForRecipe(dir: string, apiKey: string): Promise<string | null> {
    const prompt =
      "You are configuring a LIVE PREVIEW for this web project. Inspect the repo (package.json, " +
      "framework config, an index.html, etc.) and decide the single command that starts its web dev " +
      "server or serves the site for local viewing. The server MUST listen on the port given by the " +
      "$PORT environment variable (use $PORT literally in the command).\n\n" +
      'Reply with ONLY a JSON object, no prose, no code fence: {"cmd": "<command>"}. ' +
      'If you cannot determine one, reply {"cmd": null}.';
    let text = "";
    try {
      text = await oneShotRepoAssistant({ prompt, cwd: dir, apiKey });
    } catch {
      return null;
    }
    // Tolerant parse: strip fences, take the first {...} block.
    const m = text.replace(/```(?:json)?/gi, "").match(/\{[\s\S]*?\}/);
    if (!m) return null;
    try {
      const obj = JSON.parse(m[0]) as { cmd?: unknown };
      const cmd = typeof obj.cmd === "string" ? obj.cmd.trim() : "";
      // Guard: must look like a runnable command that references the port.
      return cmd && /\$PORT|\bPORT\b|\d{2,5}/.test(cmd) ? cmd : cmd || null;
    } catch {
      return null;
    }
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

  async start(projectId: string, repoPath: string, workspaceId?: string): Promise<PreviewState> {
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
      if (this.previews.get(projectId) === p && !this.resolveRecipeStatic(p.dir, port) && !this.agentRecipe.has(projectId)) {
        this.log(p, "no dev/start script found — asking the assistant how to run this project…");
      }
      const recipe = await this.resolveRecipe(p.dir, port, projectId, workspaceId, repoPath, (l) => this.log(p, l));
      if (this.previews.get(projectId) !== p) return this.state(projectId); // superseded during async resolve
      if (!recipe) {
        p.status = "failed";
        p.error =
          "Couldn't tell how to start this project — no dev/start script, and the assistant couldn't propose one " +
          "(add a provider key so it can, or a .skynet/preview.json with a \"dev\" command).";
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

  async restart(projectId: string, repoPath: string, workspaceId?: string): Promise<PreviewState> {
    return this.start(projectId, repoPath, workspaceId);
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
