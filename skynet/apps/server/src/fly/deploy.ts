// ─── Fly.io deploy engine ───────────────────────────────────────────────────
// A REAL, persistent deployment — distinct from the ephemeral local live
// preview (project-preview.ts): the resulting app survives independent of the
// local Skynet process, and is only ever torn down by an explicit operator
// action (destroy()) — never automatically, and never on a Skynet restart.
// See docs/live-preview.md §"Deploy to Fly.io".
//
// Reuses the SAME worktree provisioning as the local preview (prepareWorktree
// / ensureDeps, from ./../preview/worktree.js) — a warm worktree + correct
// deps are the same prerequisite either way. What differs is what runs AFTER:
// instead of spawning a local dev server, this builds (for a static site) or
// defers entirely to flyctl's own builder (for a backend "service"), then
// ships to Fly via the `flyctl` CLI (mirrors git-bin.ts wrapping a real git
// binary — shelling out to a real, already-battle-tested tool rather than
// reimplementing Fly's Machines API client).
//
// Explicit operator action ONLY: nothing here is called from the autonomy
// loop, the merge queue, or any automatic trigger — see operations.ts's
// flyDeploy* methods, which are the sole callers, themselves gated behind a
// human-clicked "Deploy to Fly.io" button in the UI.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { FlyDeployStatus } from "@skynet/shared";
import { flyctlBin } from "./fly-bin.js";
import { generateFlyToml, generateStaticDockerfile, nextAppNameAttempt, resolveFlyConfig } from "./descriptor.js";
import { ensureDeps, git, prepareWorktree, readDescriptorRaw, runToCompletion } from "../preview/worktree.js";

const LOG_CAP = 400;
const DEPLOY_TIMEOUT_MS = 10 * 60_000; // flyctl's remote builder can be slow
const MAX_NAME_COLLISION_RETRIES = 3;

export interface FlyDeployState {
  status: FlyDeployStatus;
  appName: string | null;
  region: string | null;
  url: string | null;
  branch: string | null;
  sha: string | null;
  error: string | null;
  logs: string[];
  deployedAt: number | null;
}

interface Live {
  key: string;
  status: FlyDeployStatus;
  dir: string;
  appName: string | null;
  region: string | null;
  url: string | null;
  branch: string | null;
  sha: string | null;
  error: string | null;
  logs: string[];
  deployedAt: number | null;
}

export interface FlyDeployStartOpts {
  /** projectId (the project-level "integration branch" target), or
   *  `run:<runId>` (a single run's branch, for pre-merge verification). */
  key: string;
  gitRepo: string;
  ref: string; // detach-checkout target (branch or sha)
  branch: string; // human-readable label stored on the deployment record
  projectId: string;
  projectName: string;
  flyApiToken: string;
}

/** The tail of flyctl's own output, as a " — …" suffix for a failure message —
 *  so a failed deploy says WHY, not just an opaque exit code. */
function logTail(logs: string[]): string {
  const lines = logs.filter((l) => l.trim());
  if (!lines.length) return "";
  const tail = lines.slice(-5).join(" / ");
  return ` — ${tail.length > 500 ? "…" + tail.slice(-500) : tail}`;
}

export class FlyDeployManager {
  private deployments = new Map<string, Live>();

  constructor(private worktreesDir?: string) {}

  private deployDir(key: string): string {
    const root = this.worktreesDir ?? resolve(process.cwd(), ".skynet-worktrees");
    // Namespaced separately from preview-<key> so a local preview and a Fly
    // deploy of the SAME project/run can run side by side without colliding.
    return join(root, `fly-${key.replace(/[^a-zA-Z0-9._-]/g, "_")}`);
  }

  private log(p: Live, line: string): void {
    for (const l of line.split("\n")) if (l.trim()) p.logs.push(l);
    if (p.logs.length > LOG_CAP) p.logs.splice(0, p.logs.length - LOG_CAP);
  }

  /** A serializable snapshot for the API/UI. */
  state(key: string): FlyDeployState {
    const p = this.deployments.get(key);
    if (!p) return { status: "idle", appName: null, region: null, url: null, branch: null, sha: null, error: null, logs: [], deployedAt: null };
    return {
      status: p.status,
      appName: p.appName,
      region: p.region,
      url: p.url,
      branch: p.branch,
      sha: p.sha,
      error: p.error,
      logs: p.logs.slice(-120),
      deployedAt: p.deployedAt,
    };
  }

  /** Run a flyctl subcommand to completion, streaming output into `p.logs`.
   *  Direct argv spawn (no shell) — every arg is passed as-is, so there is no
   *  interpolation/escaping risk from an operator-supplied app name/region.
   *  Auth is the standard headless flyctl path: FLY_API_TOKEN in the env. */
  private runFlyctl(args: string[], cwd: string, p: Live, flyApiToken: string, timeoutMs = DEPLOY_TIMEOUT_MS): Promise<void> {
    return new Promise((res, rej) => {
      const child = spawn(flyctlBin(), args, { cwd, env: { ...process.env, FLY_API_TOKEN: flyApiToken } });
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        rej(new Error(`flyctl ${args[0]} timed out after ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs);
      child.stdout?.on("data", (b) => this.log(p, b.toString()));
      child.stderr?.on("data", (b) => this.log(p, b.toString()));
      child.on("error", (err) => {
        clearTimeout(timer);
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          rej(new Error("flyctl isn't installed (or not on PATH) — install it from https://fly.io/docs/flyctl/install/, or set SKYNET_FLYCTL_PATH."));
        } else {
          rej(err);
        }
      });
      child.on("exit", (code) => {
        clearTimeout(timer);
        if (code === 0) res();
        else rej(new Error(`flyctl ${args[0]} exited with code ${code ?? "?"}${logTail(p.logs)}`));
      });
    });
  }

  /** True if `name` is an app THIS token can see (i.e. we already own it —
   *  from a prior deploy of this same project). A 404/403 from `status` means
   *  someone else's app holds the name. */
  private async appAccessible(name: string, dir: string, p: Live, flyApiToken: string): Promise<boolean> {
    try {
      await this.runFlyctl(["status", "--app", name], dir, p, flyApiToken, 30_000);
      return true;
    } catch {
      return false;
    }
  }

  /** Create the Fly app if it doesn't exist yet. Fly app names are GLOBALLY
   *  unique, so a name collision (an unrelated app already holds it) is
   *  expected occasionally even with the derived name's hash suffix — retried
   *  with a deterministic bump (see nextAppNameAttempt). A collision with an
   *  app WE already created (a prior deploy of this same project) is not an
   *  error — `apps create` failing but `status` succeeding means we own it. */
  private async ensureApp(baseAppName: string, org: string | null, dir: string, p: Live, flyApiToken: string): Promise<string> {
    let name = baseAppName;
    for (let attempt = 0; attempt <= MAX_NAME_COLLISION_RETRIES; attempt++) {
      if (attempt > 0) {
        name = nextAppNameAttempt(baseAppName, attempt - 1);
        this.log(p, `app name taken — trying "${name}"…`);
      }
      try {
        await this.runFlyctl(["apps", "create", name, ...(org ? ["--org", org] : [])], dir, p, flyApiToken, 60_000);
        return name;
      } catch (err) {
        const msg = (err as Error).message.toLowerCase();
        if (!msg.includes("taken") && !msg.includes("already") && !msg.includes("exist")) throw err;
        if (await this.appAccessible(name, dir, p, flyApiToken)) return name; // ours already
      }
    }
    throw new Error(
      `couldn't find a free Fly app name after ${MAX_NAME_COLLISION_RETRIES + 1} attempts — ` +
        `set "fly": { "app": "…" } in .skynet/preview.json to pick one explicitly.`,
    );
  }

  /**
   * Deploy `ref` (a branch or sha) to Fly. Two paths, chosen by whether
   * `.skynet/preview.json` declares a `build` command (reusing the existing,
   * previously-unused Phase-1 descriptor fields):
   *
   *  • STATIC SITE (`build` set): run the build in the SAME warm worktree the
   *    local preview uses (ensureDeps + the build command), then ship a
   *    minimal static-file image built from `outputDir` — deterministic,
   *    fully testable, no flyctl auto-detection involved.
   *  • SERVICE (no `build`): no local install/build at all — flyctl's own
   *    builder (Dockerfile / buildpack detection via `flyctl launch`)
   *    installs deps and builds INSIDE the Fly build container. This also
   *    sidesteps a real footgun: shipping macOS-built native deps into a
   *    Linux container by reusing local node_modules would silently break at
   *    runtime, so the service path never reuses the local install for the
   *    shipped artifact (ensureDeps is skipped entirely).
   */
  async start(opts: FlyDeployStartOpts): Promise<FlyDeployState> {
    const existing = this.deployments.get(opts.key);
    if (existing?.status === "deploying") throw new Error("A deploy is already in progress for this target.");

    const dir = this.deployDir(opts.key);
    const p: Live = {
      key: opts.key,
      status: "deploying",
      dir,
      appName: existing?.appName ?? null,
      region: existing?.region ?? null,
      url: existing?.url ?? null,
      branch: opts.branch,
      sha: null,
      error: null,
      logs: [],
      deployedAt: existing?.deployedAt ?? null,
    };
    this.deployments.set(opts.key, p);

    try {
      p.dir = await prepareWorktree(opts.gitRepo, dir, opts.ref);
      p.sha = (await git(p.dir, "rev-parse", "HEAD")).stdout.trim();

      const raw = readDescriptorRaw(p.dir);
      const cfg = resolveFlyConfig({ raw, projectName: opts.projectName, projectId: opts.projectId });
      p.region = cfg.region;

      if (cfg.buildCmd) {
        this.log(p, `static-site deploy — building "${cfg.outputDir}" locally, then shipping it`);
        await ensureDeps(p.dir, opts.gitRepo, (l) => this.log(p, l));
        this.log(p, `▸ ${cfg.buildCmd}`);
        await runToCompletion(cfg.buildCmd, p.dir, (l) => this.log(p, l), 5 * 60_000);
        if (!existsSync(join(p.dir, cfg.outputDir))) {
          throw new Error(`build succeeded but "${cfg.outputDir}" wasn't produced — check .skynet/preview.json's "outputDir"`);
        }
        // Never clobber a human-authored Dockerfile/fly.toml already in the repo.
        if (!existsSync(join(p.dir, "Dockerfile"))) await writeFile(join(p.dir, "Dockerfile"), generateStaticDockerfile(cfg.outputDir));
        else this.log(p, "using the repo's own Dockerfile (not overwriting)");
        if (!existsSync(join(p.dir, "fly.toml"))) await writeFile(join(p.dir, "fly.toml"), generateFlyToml(cfg));
        else this.log(p, "using the repo's own fly.toml (not overwriting)");
      } else if (!existsSync(join(p.dir, "fly.toml"))) {
        this.log(p, "service deploy — no fly.toml/Dockerfile in this repo; asking flyctl to detect a builder…");
        await this.runFlyctl(
          ["launch", "--no-deploy", "--auto-confirm", "--copy-config", "--name", cfg.appName, "--region", cfg.region, ...(cfg.org ? ["--org", cfg.org] : [])],
          p.dir,
          p,
          opts.flyApiToken,
          5 * 60_000,
        );
      }

      p.appName = await this.ensureApp(cfg.appName, cfg.org, p.dir, p, opts.flyApiToken);
      this.log(p, `▸ flyctl deploy --app ${p.appName}`);
      await this.runFlyctl(["deploy", "--app", p.appName, "--region", cfg.region, "--now", "--remote-only"], p.dir, p, opts.flyApiToken);

      p.status = "live";
      p.url = `https://${p.appName}.fly.dev`;
      p.deployedAt = Date.now();
      p.error = null;
    } catch (err) {
      p.status = "failed";
      p.error = (err as Error).message;
    }
    return this.state(opts.key);
  }

  /** Explicit teardown — the ONLY way a Fly deployment ever goes away. Never
   *  called automatically (not on Skynet restart, not on project delete) —
   *  see operations.ts. Works even with no in-memory record for this key
   *  (e.g. after a server restart): the caller supplies `appName` from the
   *  persisted Project/TaskRun record, since the in-memory map is ephemeral
   *  but the Fly app itself — the whole point — is not. */
  async destroy(opts: { key: string; appName: string; flyApiToken: string; gitRepo?: string }): Promise<FlyDeployState> {
    const dir = this.deployDir(opts.key);
    // `apps destroy` is a pure account-level call — it needs no repo context —
    // but the worktree dir may not exist (a fresh manager post-restart, or a
    // deploy that never got past provisioning). spawn() needs a real cwd.
    const cwd = existsSync(dir) ? dir : tmpdir();
    const p: Live = this.deployments.get(opts.key) ?? {
      key: opts.key, status: "deploying", dir, appName: opts.appName,
      region: null, url: null, branch: null, sha: null, error: null, logs: [], deployedAt: null,
    };
    p.status = "deploying"; // reuse as a "busy" marker during teardown
    this.deployments.set(opts.key, p);
    try {
      await this.runFlyctl(["apps", "destroy", opts.appName, "--yes"], cwd, p, opts.flyApiToken, 60_000);
      p.status = "stopped";
      p.url = null;
      p.appName = null;
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
      if (opts.gitRepo) await git(opts.gitRepo, "worktree", "remove", "--force", dir).catch(() => undefined);
    } catch (err) {
      p.status = "failed";
      p.error = `couldn't destroy the Fly app: ${(err as Error).message}`;
    }
    return this.state(opts.key);
  }
}

export const flyDeploy = new FlyDeployManager(process.env.SKYNET_WORKTREES_DIR || undefined);
