// ─── Local repo doc writes ───────────────────────────────────────────────────
// Commits a single doc edit straight into a project's bound `repoPath`
// checkout — NOT a per-run worktree. WorktreeProvisioner (worktrees.ts) is
// built around a canonical repo + a pool of per-run scratch worktrees cut for
// the agent pipeline; a project's actual bound folder is a different thing
// (the operator's real checkout, whatever branch they have it on), so this is
// a small standalone helper rather than a WorktreeProvisioner method. Reuses
// the exact git-spawn convention worktrees.ts uses (`execFile`, `gitBin()`,
// inline commit identity).

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gitBin } from "./git-bin.js";

const exec = promisify(execFile);

/** The only paths this helper will ever write — a fixed allowlist, never
 *  arbitrary caller input, mirroring the read side's ROADMAP_PATHS. */
export const WRITABLE_REPO_PATHS = new Set(["ROADMAP.md", "docs/ROADMAP.md"]);

export class LocalRepoWriteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocalRepoWriteError";
  }
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await exec(gitBin(), ["-C", cwd, ...args]);
  return stdout.trim();
}

/**
 * Write `content` to `relPath` inside `repoPath` and commit it directly onto
 * whatever branch is currently checked out. Refuses if the file's current
 * on-disk content doesn't match `baseline` — the local analog of GitHub's sha
 * check, so an edit drafted against stale content can't silently clobber a
 * change made since. No-ops (returns `{ committed: false }`) if `content`
 * already matches what's on disk.
 */
export async function commitLocalRepoFile(
  repoPath: string,
  relPath: string,
  content: string,
  baseline: string,
  message: string,
): Promise<{ committed: boolean; sha?: string }> {
  if (!WRITABLE_REPO_PATHS.has(relPath)) {
    throw new LocalRepoWriteError(`Refusing to write an unlisted path: ${relPath}`);
  }
  if (!existsSync(join(repoPath, ".git"))) {
    throw new LocalRepoWriteError(`${repoPath} doesn't look like a git checkout (no .git).`);
  }
  const current = await readFile(join(repoPath, relPath), "utf8").catch(() => null);
  if (current !== baseline) {
    throw new LocalRepoWriteError(`${relPath} changed on disk since this edit was drafted.`);
  }
  if (current === content) return { committed: false };

  await writeFile(join(repoPath, relPath), content, "utf8");
  await git(repoPath, "add", "--", relPath);
  // Inline identity so this never depends on the operator's global git config.
  await git(repoPath, "-c", "user.name=Skynet", "-c", "user.email=skynet@local", "commit", "-m", message, "--", relPath);
  const sha = await git(repoPath, "rev-parse", "HEAD");
  return { committed: true, sha };
}
