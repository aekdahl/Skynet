// ─── Project live preview (Phase-1 v0: web/sites) ──────────────────────────
// Runs a project's web dev/serve command so the operator can SEE the app the
// fleet is building — split-screen beside the board — and watch it update as
// changes merge in. See docs/live-preview.md.
//
// Two flavours, same machinery:
//   • PROJECT preview — a DETACHED worktree of the integration branch (the
//     cumulative merged fleet state). Refreshes on merge so a dev server's HMR
//     shows the change (the overwatch loop).
//   • RUN preview ("Preview this change") — a DETACHED worktree of a single
//     run's branch (`agent/<runId>`), so an operator can SEE a proposed change
//     BEFORE approving its merge. Pinned to that branch (no refresh-on-merge);
//     manual reload/restart pick up new commits.
//
// Previews are keyed (projectId, or `run:<runId>`) so a project preview and a
// run preview can run side by side on different ports. The recipe (how to start
// it) resolves from `.skynet/preview.json` → a package.json heuristic → the
// repo-aware assistant, and is cached per project. The child is spawned through
// the opt-in OS sandbox (write-confined when enabled) on a loopback port; the
// SPA iframes that port directly (desktop = same machine, no proxy).

import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync, lstatSync, readFileSync } from "node:fs";
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { get as httpGet } from "node:http";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { wrapForSandbox } from "@skynet/runner-sdk/sandbox";
import { oneShotRepoAssistant } from "@skynet/runner-sdk/claude";
import { gitBin } from "../git-bin.js";
import { secretService } from "../secrets/index.js";

const exec = promisify(execFile);

/**
 * Environment for preview subprocesses (dependency install + the dev server).
 * A live preview is a DEV run, so force `NODE_ENV=development`: otherwise a
 * production server (NODE_ENV=production, as on staging) makes `npm`/`pnpm`/`yarn`
 * **skip devDependencies** at install time, so tooling the dev script needs
 * (concurrently, vite, …) is never installed and `npm run dev` fails with
 * "<tool>: not found". Also clear npm's production-omit signals in case they were
 * inherited. Overrides here apply only to the child — the server keeps its own env.
 */
export function previewEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: "development", ...extra };
  delete env.npm_config_production; // legacy "--production" signal
  delete env.npm_config_omit; // "--omit=dev"
  return env;
}

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
  key: string; // map key: projectId, or `run:<runId>`
  dir: string; // detached worktree dir
  gitRepo: string; // repo the worktree was added in (for cleanup)
  recipeKey: string; // agentRecipe cache key (the project id)
  refreshBranch?: string; // moving branch to re-point to on merge (project previews only)
  logs: string[];
  error: string | null;
  startedAt: number | null;
  lastTouched: number;
  idleTimer?: ReturnType<typeof setTimeout>;
}

/** What to start — the parameterization shared by project + run previews. */
interface StartSpec {
  key: string;
  gitRepo: string;
  ref: string; // detach-checkout target (branch or HEAD)
  recipeKey: string; // per-project recipe cache key
  workspaceId?: string; // for BYOK key resolution (agent recipe)
  persistTo?: string; // repo working tree to write .skynet/preview.json (project previews only)
  refreshBranch?: string; // branch to re-point to on refresh (project previews only)
}

// Files whose change (when a merge is folded into the preview) means the
// worktree's dependencies may be stale.
const DEP_MANIFESTS = new Set(["package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lockb"]);

const LOG_CAP = 200;
const IDLE_MS = 15 * 60 * 1000; // auto-stop a preview no one is watching
const HEALTH_TIMEOUT_MS = 45_000;

/** The tail of the dev server's own output, as a " — …" suffix for a failure
 *  message. So a failed preview says WHY (e.g. "sh: vite: command not found")
 *  instead of an opaque code. PURE — unit-tested. */
export function previewLogTail(logs: string[]): string {
  const lines = logs.filter((l) => l.trim());
  if (!lines.length) return "";
  const tail = lines.slice(-3).join(" / ");
  return ` — ${tail.length > 400 ? "…" + tail.slice(-400) : tail}`;
}

/** A non-zero exit turned into an operator-readable reason (code + output tail). */
export function previewExitReason(code: number | null, logs: string[]): string {
  return `preview process exited (code ${code ?? "?"})${previewLogTail(logs)}`;
}

export class ProjectPreviewManager {
  private previews = new Map<string, Live>();
  // Cache an agent-proposed recipe per project so a restart (or a run preview of
  // the same project) doesn't re-ask the model. Committing the persisted
  // .skynet/preview.json makes it the deterministic descriptor instead.
  private agentRecipe = new Map<string, { cmd: string }>();

  constructor(private worktreesDir?: string) {}

  private git(cwd: string, ...args: string[]): Promise<{ stdout: string }> {
    return exec(gitBin(), ["-C", cwd, ...args]);
  }

  private previewDir(key: string): string {
    const root = this.worktreesDir ?? resolve(process.cwd(), ".skynet-worktrees");
    return join(root, `preview-${key.replace(/[^a-zA-Z0-9._-]/g, "_")}`);
  }

  private integrationBranch(projectId: string): string {
    return `skynet/integration/${projectId}`;
  }

  /** A serializable snapshot for the API/UI. */
  state(key: string): PreviewState {
    const p = this.previews.get(key);
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

  /** Read `.skynet/preview.json` if present (tolerant of a malformed file). */
  private readDescriptor(dir: string): { dev?: string; start?: string; port?: number; install?: string } | null {
    const descPath = join(dir, ".skynet", "preview.json");
    if (!existsSync(descPath)) return null;
    try {
      return JSON.parse(readFileSync(descPath, "utf8"));
    } catch {
      return null; // malformed → callers fall back to heuristics
    }
  }

  /** Deterministic recipe: `.skynet/preview.json` descriptor, then a
   *  package.json script heuristic. No I/O beyond reading two files. */
  private resolveRecipeStatic(dir: string, port: number): PreviewRecipe | null {
    const d = this.readDescriptor(dir);
    if (d) {
      const cmd = d.dev || d.start;
      if (cmd) return { cmd, port: d.port ?? port, source: "descriptor" };
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
   * project" — to read the repo and PROPOSE a start command. Cached per project
   * (a restart, or a run preview of the same project, doesn't re-ask).
   */
  private async resolveRecipe(
    dir: string,
    port: number,
    recipeKey: string,
    workspaceId?: string,
    persistTo?: string,
    log?: (line: string) => void,
  ): Promise<PreviewRecipe | null> {
    const cached = this.agentRecipe.get(recipeKey);
    if (cached) return { cmd: cached.cmd, port, source: "agent" };
    const stat = this.resolveRecipeStatic(dir, port);
    if (stat) return stat;
    if (!workspaceId) return null; // no key context → can't ask the agent
    const apiKey = (await secretService.resolve(workspaceId, "claude").catch(() => undefined)) ?? undefined;
    if (!apiKey) return null;
    const cmd = await this.askAgentForRecipe(dir, apiKey);
    if (!cmd) return null;
    this.agentRecipe.set(recipeKey, { cmd });
    // Persist the proposal to the operator's repo so it becomes the deterministic
    // descriptor — reviewable, editable, and (once committed) used everywhere
    // without re-asking. Never clobber a descriptor a human already wrote. Only
    // for project previews (persistTo set) — a pre-merge run preview must not
    // write into the shared repo.
    if (persistTo) await this.persistRecipe(persistTo, cmd, log);
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
  private waitForPort(port: number, until: number, alive: () => boolean = () => true): Promise<boolean> {
    return new Promise((res) => {
      const tick = () => {
        if (!alive()) return res(false); // the process died — stop polling a dead port
        const req = httpGet({ host: "127.0.0.1", port, path: "/", timeout: 1500 }, (r) => {
          r.resume();
          res(true);
        });
        req.on("error", () => (Date.now() > until || !alive() ? res(false) : setTimeout(tick, 400)));
        req.on("timeout", () => req.destroy());
      };
      tick();
    });
  }

  /** Prepare (or refresh) a detached worktree at `ref`. Detached so it never
   *  collides with a worktree that HOLDS the branch (the merge engine on the
   *  integration branch, or the agent's own worktree on a run branch). Reuses an
   *  existing worktree dir (via checkout + reset) so a restart keeps node_modules
   *  warm — untracked deps survive the reset; only a broken worktree is recreated. */
  private async prepareWorktree(key: string, gitRepo: string, ref: string): Promise<string> {
    const dir = this.previewDir(key);
    if (existsSync(join(dir, ".git"))) {
      try {
        await this.git(gitRepo, "worktree", "repair", dir).catch(() => undefined);
        await this.git(dir, "checkout", "--detach", ref);
        await this.git(dir, "reset", "--hard", ref);
        return dir; // reused — node_modules (real or symlink) is preserved
      } catch {
        /* stale/broken worktree → fall through and recreate it fresh */
      }
    }
    await this.git(gitRepo, "worktree", "remove", "--force", dir).catch(() => undefined);
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    await this.git(gitRepo, "worktree", "add", "--force", "--detach", dir, ref);
    return dir;
  }

  /** Make dependencies available in the preview worktree before we run the dev
   *  command. A fresh detached checkout has no node_modules, so a script like
   *  `concurrently`/`vite` isn't found. Fast path: symlink the operator's already
   *  installed node_modules (desktop folder-bound projects always have it). Fresh
   *  clones with none anywhere fall back to a real install. No-op once present
   *  (a warm reused worktree, or a prior symlink). */
  private async ensureDeps(p: Live, gitRepo: string): Promise<void> {
    if (!existsSync(join(p.dir, "package.json"))) return; // not a node project
    if (existsSync(join(p.dir, "node_modules"))) return; // already provisioned (warm/symlinked)
    const repoNodeModules = join(gitRepo, "node_modules");
    if (existsSync(repoNodeModules)) {
      try {
        await symlink(repoNodeModules, join(p.dir, "node_modules"), "dir");
        this.log(p, "linked node_modules from the project checkout (no install needed)");
        return;
      } catch (err) {
        this.log(p, `couldn't link node_modules (${(err as Error).message}) — installing instead`);
      }
    }
    const install = this.installCmd(p.dir);
    this.log(p, `installing dependencies — ${install} (first preview of this project may take a minute)`);
    await this.runToCompletion(install, p.dir, p, 5 * 60_000);
  }

  /** A fresh detached worktree has no `.env`, yet many dev scripts assume one —
   *  e.g. `node --watch --env-file-if-exists=.env` CRASHES because `--watch` tries
   *  to watch a path that doesn't exist, and dotenv-based scripts abort. Drop an
   *  empty `.env` (only when absent) so those start cleanly. Harmless for apps that
   *  ignore it; the worktree is ephemeral, never the operator's real checkout. */
  private async ensureEnvFile(p: Live): Promise<void> {
    if (!existsSync(join(p.dir, "package.json"))) return; // not a node project
    const envPath = join(p.dir, ".env");
    if (existsSync(envPath)) return; // respect a real one (e.g. a symlinked checkout's)
    try {
      await writeFile(envPath, "");
      this.log(p, "created an empty .env (fresh worktree) so dev scripts that expect one start cleanly");
    } catch {
      /* best-effort — not fatal */
    }
  }

  /** Infer the install command: descriptor override, then the lockfile's package
   *  manager, else npm. */
  private installCmd(dir: string): string {
    const desc = this.readDescriptor(dir);
    if (desc?.install) return desc.install;
    if (existsSync(join(dir, "pnpm-lock.yaml"))) return "pnpm install";
    if (existsSync(join(dir, "yarn.lock"))) return "yarn install";
    if (existsSync(join(dir, "bun.lockb"))) return "bun install";
    return "npm install";
  }

  /** Run a setup command (e.g. install) to completion, streaming to the logs.
   *  Not sandboxed — install needs the registry; the untrusted app runtime (the
   *  dev server) is the wrapped one. Rejects on non-zero exit or timeout. */
  private runToCompletion(cmd: string, cwd: string, p: Live, timeoutMs: number): Promise<void> {
    return new Promise((res, rej) => {
      const child = spawn("/bin/sh", ["-c", cmd], { cwd, env: previewEnv() });
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        rej(new Error(`\`${cmd}\` timed out after ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);
      child.stdout?.on("data", (b) => this.log(p, b.toString()));
      child.stderr?.on("data", (b) => this.log(p, b.toString()));
      child.on("error", (err) => {
        clearTimeout(timer);
        rej(err);
      });
      child.on("exit", (code) => {
        clearTimeout(timer);
        if (code === 0) res();
        else rej(new Error(`\`${cmd}\` exited with code ${code ?? "?"}`));
      });
    });
  }

  /** Kill a preview's dev-server child + idle timer, WITHOUT removing its
   *  worktree (so a restart keeps node_modules warm). Full teardown is stop(). */
  private killChild(p: Live) {
    if (p.idleTimer) clearTimeout(p.idleTimer);
    if (p.child && !p.child.killed) p.child.kill("SIGTERM");
  }

  /** Start the PROJECT preview — the integration branch (cumulative merged fleet
   *  state), refreshed on merge. */
  async start(projectId: string, repoPath: string, workspaceId?: string): Promise<PreviewState> {
    if (!repoPath) throw new Error("This project has no local folder to preview.");
    const branch = this.integrationBranch(projectId);
    const hasBranch = (await this.git(repoPath, "branch", "--list", branch).catch(() => ({ stdout: "" }))).stdout.trim();
    return this.startSpec({
      key: projectId,
      gitRepo: repoPath,
      ref: hasBranch ? branch : "HEAD",
      recipeKey: projectId,
      workspaceId,
      persistTo: repoPath,
      refreshBranch: hasBranch ? branch : undefined,
    });
  }

  /** Start a per-run PRE-MERGE preview — the run's own branch, so an operator
   *  can SEE a change before approving its merge. Pinned to the branch (no
   *  refresh-on-merge); reload/restart pick up new commits the run makes. */
  async startRun(
    runId: string,
    opts: { repoPath: string; projectId: string; branch: string; workspaceId?: string },
  ): Promise<PreviewState> {
    const key = `run:${runId}`;
    if (!opts.repoPath) throw new Error("This project has no local folder to preview.");
    // The run branch must exist (the agent has to have committed at least once).
    // Guard here so the operator sees a clear reason rather than a raw git error.
    const hasBranch = (await this.git(opts.repoPath, "branch", "--list", opts.branch).catch(() => ({ stdout: "" }))).stdout.trim();
    if (!hasBranch) {
      await this.stop(key);
      const p: Live = {
        status: "failed", key, dir: this.previewDir(key), gitRepo: opts.repoPath, recipeKey: opts.projectId,
        logs: [], error: `This run has no commits to preview yet (branch ${opts.branch} doesn't exist).`,
        startedAt: Date.now(), lastTouched: Date.now(),
      };
      this.previews.set(key, p);
      return this.state(key);
    }
    return this.startSpec({
      key,
      gitRepo: opts.repoPath,
      ref: opts.branch,
      recipeKey: opts.projectId,
      workspaceId: opts.workspaceId,
      // No persistTo (don't write into the shared repo for a pre-merge preview);
      // no refreshBranch (pinned to the change under review).
    });
  }

  private async startSpec(spec: StartSpec): Promise<PreviewState> {
    // Soft-replace any existing preview for this key: kill its child but KEEP
    // its worktree so node_modules stays warm across restarts. (Full teardown —
    // worktree removal — only happens on an explicit stop / idle / shutdown.)
    const existing = this.previews.get(spec.key);
    if (existing) {
      existing.status = "stopped";
      this.killChild(existing);
      this.previews.delete(spec.key);
    }

    const p: Live = {
      status: "starting", key: spec.key, dir: this.previewDir(spec.key), gitRepo: spec.gitRepo,
      recipeKey: spec.recipeKey, refreshBranch: spec.refreshBranch,
      logs: [], error: null, startedAt: Date.now(), lastTouched: Date.now(),
    };
    this.previews.set(spec.key, p);

    try {
      p.dir = await this.prepareWorktree(spec.key, spec.gitRepo, spec.ref);
      const port = await this.freePort();
      if (this.previews.get(spec.key) === p && !this.resolveRecipeStatic(p.dir, port) && !this.agentRecipe.has(spec.recipeKey)) {
        this.log(p, "no dev/start script found — asking the assistant how to run this project…");
      }
      const recipe = await this.resolveRecipe(p.dir, port, spec.recipeKey, spec.workspaceId, spec.persistTo, (l) => this.log(p, l));
      if (this.previews.get(spec.key) !== p) return this.state(spec.key); // superseded during async resolve
      if (!recipe) {
        p.status = "failed";
        p.error =
          "Couldn't tell how to start this project — no dev/start script, and the assistant couldn't propose one " +
          "(add a provider key so it can, or a .skynet/preview.json with a \"dev\" command).";
        return this.state(spec.key);
      }
      p.recipe = recipe;
      p.port = recipe.port;

      // A fresh checkout has no node_modules → provision them before we run the
      // dev command (else `concurrently`/`vite`/etc. aren't found).
      await this.ensureDeps(p, spec.gitRepo);
      if (this.previews.get(spec.key) !== p) return this.state(spec.key); // superseded during install
      await this.ensureEnvFile(p); // a fresh worktree has no .env — many dev scripts crash without one

      this.log(p, `▸ ${recipe.cmd}  (PORT=${recipe.port}, source: ${recipe.source})`);

      // Spawn via a shell so "npm run dev" etc. work; wrap for the opt-in OS
      // sandbox (no-op unless SKYNET_RUNNER_SANDBOX). PORT is injected two ways
      // (env + common Vite/CRA/Next var) so most dev servers pick it up.
      const wrapped = wrapForSandbox("/bin/sh", ["-c", recipe.cmd], { cwd: p.dir });
      if (wrapped.note) this.log(p, wrapped.note);
      const child = spawn(wrapped.bin, wrapped.args, {
        cwd: p.dir,
        env: previewEnv({ PORT: String(recipe.port), VITE_PORT: String(recipe.port), BROWSER: "none" }),
      });
      p.child = child;
      child.stdout?.on("data", (b) => this.log(p, b.toString()));
      child.stderr?.on("data", (b) => this.log(p, b.toString()));
      // Finalize a failure on "close" (not "exit"): it fires AFTER stdout/stderr
      // have drained, so the captured logs — and thus the surfaced reason — are
      // complete. `closed` also lets the health wait bail the instant it dies.
      let closed = false;
      child.on("close", (code) => {
        closed = true;
        if (this.previews.get(spec.key) !== p) return; // superseded
        if (p.status !== "stopped") {
          p.status = "failed";
          // Include the output tail so the operator sees WHY it exited, not just
          // an opaque code (this is the message the Telegram/UI failure shows).
          p.error = p.error ?? previewExitReason(code, p.logs);
        }
      });
      child.on("error", (err) => {
        p.status = "failed";
        p.error = err.message;
      });

      // Bail the health wait the moment the child dies (else a dev server that
      // exits code 1 in a second still made us wait the full timeout).
      const ok = await this.waitForPort(
        recipe.port,
        Date.now() + HEALTH_TIMEOUT_MS,
        () => this.previews.get(spec.key) === p && !closed && p.status === "starting",
      );
      if (this.previews.get(spec.key) !== p) return this.state(spec.key); // superseded mid-wait
      if (ok && p.status === "starting") {
        p.status = "live";
        this.armIdle(spec.key, p);
      } else if (p.status === "starting") {
        p.status = "failed";
        p.error = p.error ?? `the app didn't start listening on port ${recipe.port} within ${HEALTH_TIMEOUT_MS / 1000}s${previewLogTail(p.logs)}`;
      }
    } catch (err) {
      p.status = "failed";
      p.error = (err as Error).message;
    }
    return this.state(spec.key);
  }

  /** Re-point the worktree at a moving branch tip (called on merge for PROJECT
   *  previews). A dev server's file-watcher then HMR-updates; the UI reloads for
   *  the rest. A no-op for pinned run previews (no refreshBranch). */
  async refresh(key: string): Promise<PreviewState> {
    const p = this.previews.get(key);
    if (!p || p.status !== "live" || !p.refreshBranch) return this.state(key);
    const hasBranch = (await this.git(p.gitRepo, "branch", "--list", p.refreshBranch).catch(() => ({ stdout: "" }))).stdout.trim();
    if (hasBranch) {
      const before = (await this.git(p.dir, "rev-parse", "HEAD").catch(() => ({ stdout: "" }))).stdout.trim();
      await this.git(p.dir, "checkout", "--detach", p.refreshBranch).catch((e) => this.log(p, `refresh: ${(e as Error).message}`));
      this.log(p, "↻ refreshed to integration branch tip");
      const after = (await this.git(p.dir, "rev-parse", "HEAD").catch(() => ({ stdout: "" }))).stdout.trim();
      if (before && after && before !== after) await this.reconcileDepsOnRefresh(p, before, after);
    }
    p.lastTouched = Date.now();
    return this.state(key);
  }

  /** After a refresh folds new merged work into the preview, reconcile deps if a
   *  dependency manifest changed — so a live preview reflects merged dep changes.
   *  Re-installs ONLY when node_modules is a real dir; when it's a symlink to the
   *  operator's checkout we leave it alone (their deps, not ours to modify) and
   *  just note it. Best-effort + time-boxed; never breaks the refresh. */
  private async reconcileDepsOnRefresh(p: Live, before: string, after: string): Promise<void> {
    const changed = (await this.git(p.dir, "diff", "--name-only", before, after).catch(() => ({ stdout: "" }))).stdout.split("\n");
    if (!changed.some((f) => DEP_MANIFESTS.has(f.trim().split("/").pop() ?? ""))) return;
    const nm = join(p.dir, "node_modules");
    let symlink = false;
    try {
      symlink = lstatSync(nm).isSymbolicLink();
    } catch {
      return; // no node_modules at all → nothing to reconcile (started fresh next time)
    }
    if (symlink) {
      this.log(p, "merged changes touched dependencies — this preview uses the project checkout's node_modules; run an install there if the app needs the new deps.");
      return;
    }
    const cmd = this.installCmd(p.dir);
    this.log(p, `merged changes touched dependencies — re-installing (${cmd})…`);
    await this.runToCompletion(cmd, p.dir, p, 3 * 60_000).catch((e) => this.log(p, `re-install failed: ${(e as Error).message}`));
  }

  async restart(projectId: string, repoPath: string, workspaceId?: string): Promise<PreviewState> {
    return this.start(projectId, repoPath, workspaceId);
  }

  /** Restart a run preview — re-adds the worktree at the branch tip (picks up
   *  new commits the run made). Same as startRun (idempotent). */
  async restartRun(
    runId: string,
    opts: { repoPath: string; projectId: string; branch: string; workspaceId?: string },
  ): Promise<PreviewState> {
    return this.startRun(runId, opts);
  }

  async stop(key: string): Promise<PreviewState> {
    const p = this.previews.get(key);
    if (p) {
      p.status = "stopped";
      this.killChild(p);
      // If node_modules is a SYMLINK we created, unlink it first so neither git
      // nor the recursive rm below can ever follow it into the operator's real
      // node_modules. (A real installed dir is removed with the worktree.)
      const nm = join(p.dir, "node_modules");
      try {
        if (lstatSync(nm).isSymbolicLink()) await rm(nm, { force: true });
      } catch {
        /* absent or not a symlink → nothing to unlink */
      }
      await this.git(p.gitRepo, "worktree", "remove", "--force", p.dir).catch(() => undefined);
      await rm(p.dir, { recursive: true, force: true }).catch(() => undefined);
      this.previews.delete(key);
    }
    return { status: "stopped", url: null, port: null, recipe: null, error: null, logs: [], startedAt: null };
  }

  /** Auto-stop a preview nothing has polled in IDLE_MS (bounds resource use). */
  private armIdle(key: string, p: Live) {
    if (p.idleTimer) clearTimeout(p.idleTimer);
    p.idleTimer = setTimeout(() => {
      if (Date.now() - p.lastTouched >= IDLE_MS) void this.stop(key);
      else this.armIdle(key, p);
    }, IDLE_MS);
  }

  /** Stop every preview (server shutdown). */
  async stopAll(): Promise<void> {
    for (const id of [...this.previews.keys()]) await this.stop(id);
  }
}

export const projectPreview = new ProjectPreviewManager(process.env.SKYNET_WORKTREES_DIR || undefined);
