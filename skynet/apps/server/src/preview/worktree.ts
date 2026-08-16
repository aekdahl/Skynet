// ─── Shared worktree provisioning ──────────────────────────────────────────
// Prepare a detached git worktree at a ref, and make its dependencies
// available — used by BOTH the local dev-server preview (project-preview.ts)
// and the Fly deploy engine (../fly/deploy.ts). A warm worktree + installed
// deps are the same prerequisite either way; only what runs AFTER differs
// (spawn a dev server vs. build a static bundle / hand off to `flyctl`).
//
// Extracted from project-preview.ts (which now delegates here) so the two
// callers never drift — see docs/live-preview.md §"Deploy to Fly.io".

import { execFile, spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { gitBin } from "../git-bin.js";

const exec = promisify(execFile);

export function git(cwd: string, ...args: string[]): Promise<{ stdout: string }> {
  return exec(gitBin(), ["-C", cwd, ...args]);
}

/** Read `.skynet/preview.json` if present (tolerant of a malformed file) —
 *  the raw JSON object, untyped; callers pick the fields they care about. */
export function readDescriptorRaw(dir: string): Record<string, unknown> | null {
  const descPath = join(dir, ".skynet", "preview.json");
  if (!existsSync(descPath)) return null;
  try {
    return JSON.parse(readFileSync(descPath, "utf8")) as Record<string, unknown>;
  } catch {
    return null; // malformed → callers fall back to heuristics
  }
}

/** Infer the install command: descriptor override, then the lockfile's package
 *  manager, else npm. */
export function installCmd(dir: string): string {
  const desc = readDescriptorRaw(dir);
  const override = typeof desc?.install === "string" ? desc.install : undefined;
  if (override) return override;
  if (existsSync(join(dir, "pnpm-lock.yaml"))) return "pnpm install";
  if (existsSync(join(dir, "yarn.lock"))) return "yarn install";
  if (existsSync(join(dir, "bun.lockb"))) return "bun install";
  return "npm install";
}

/** Prepare (or refresh) a detached worktree at `ref`. Detached so it never
 *  collides with a worktree that HOLDS the branch (the merge engine on the
 *  integration branch, or the agent's own worktree on a run branch). Reuses an
 *  existing worktree dir (via checkout + reset) so a restart keeps node_modules
 *  warm — untracked deps survive the reset; only a broken worktree is recreated. */
export async function prepareWorktree(gitRepo: string, dir: string, ref: string): Promise<string> {
  if (existsSync(join(dir, ".git"))) {
    try {
      await git(gitRepo, "worktree", "repair", dir).catch(() => undefined);
      await git(dir, "checkout", "--detach", ref);
      await git(dir, "reset", "--hard", ref);
      return dir; // reused — node_modules (real or symlink) is preserved
    } catch {
      /* stale/broken worktree → fall through and recreate it fresh */
    }
  }
  await git(gitRepo, "worktree", "remove", "--force", dir).catch(() => undefined);
  await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  await git(gitRepo, "worktree", "add", "--force", "--detach", dir, ref);
  return dir;
}

/** Run a setup command (e.g. install / build) to completion, streaming every
 *  line to `log`. Not sandboxed — install needs the registry; the untrusted
 *  app runtime (a dev server, or the app inside its own Fly build) is handled
 *  separately. Rejects on non-zero exit or timeout. */
export function runToCompletion(cmd: string, cwd: string, log: (line: string) => void, timeoutMs: number, env?: NodeJS.ProcessEnv): Promise<void> {
  return new Promise((res, rej) => {
    const child = spawn("/bin/sh", ["-c", cmd], { cwd, env: env ?? process.env });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      rej(new Error(`\`${cmd}\` timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
    child.stdout?.on("data", (b) => log(b.toString()));
    child.stderr?.on("data", (b) => log(b.toString()));
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

/** Make dependencies available in a worktree before running an install-gated
 *  command (a dev server, or a local `build` step). Fast path: symlink the
 *  operator's already-installed node_modules (desktop folder-bound projects
 *  always have it). Fresh clones with none anywhere fall back to a real
 *  install. No-op once present (a warm reused worktree, or a prior symlink). */
export async function ensureDeps(dir: string, gitRepo: string, log: (line: string) => void, env?: NodeJS.ProcessEnv): Promise<void> {
  if (!existsSync(join(dir, "package.json"))) return; // not a node project
  if (existsSync(join(dir, "node_modules"))) return; // already provisioned (warm/symlinked)
  const repoNodeModules = join(gitRepo, "node_modules");
  if (existsSync(repoNodeModules)) {
    try {
      await symlink(repoNodeModules, join(dir, "node_modules"), "dir");
      log("linked node_modules from the project checkout (no install needed)");
      return;
    } catch (err) {
      log(`couldn't link node_modules (${(err as Error).message}) — installing instead`);
    }
  }
  const install = installCmd(dir);
  log(`installing dependencies — ${install} (first run for this project may take a minute)`);
  await runToCompletion(install, dir, log, 5 * 60_000, env);
}
