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
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { gitBin } from "./git-bin.js";

const exec = promisify(execFile);

/** The only paths this helper will ever write — a fixed allowlist, never
 *  arbitrary caller input, mirroring the read side's ROADMAP_PATHS.
 *  CHANGELOG.md/README.md added for the feature-ship handoff's
 *  change-manager/docs-writer roles (see feature-handoff.ts's
 *  HANDOFF_TARGET_FILE — same fixed-target-per-role scoping this allowlist
 *  already enforces for roadmap edits). */
export const WRITABLE_REPO_PATHS = new Set(["ROADMAP.md", "docs/ROADMAP.md", "CHANGELOG.md", "README.md"]);

/** Memory v0's own writable prefix — `.skynet/memory/workspace.md` plus every
 *  scope-specific file under `projects/`/`areas/`/`agents/` (see
 *  memory-paths.ts's memoryFilePath). A prefix, not a fixed set, since the
 *  agent/area/project slug segment is caller-derived — but always via
 *  memoryFilePath, never raw input, so the prefix carries the same "server
 *  constructs it, not the caller" trust WRITABLE_REPO_PATHS itself relies on. */
const MEMORY_WRITE_PREFIX = ".skynet/memory/";

function isWritablePath(relPath: string): boolean {
  return WRITABLE_REPO_PATHS.has(relPath) || relPath.startsWith(MEMORY_WRITE_PREFIX);
}

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
 * Real commit attribution for a write ATTRIBUTABLE to a specific actor —
 * currently only the roadmap-proposal apply path (Operations.applyRoadmapProposal).
 * Every other caller of `commitLocalRepoFile` (a plain Steward doc edit) omits
 * this and keeps the flat `user.name=Skynet` identity below unchanged.
 * `coAuthor`, when set, is appended as a trailing `Co-authored-by:` trailer —
 * git/GitHub's own convention, so it renders as real co-authorship rather
 * than a free-text mention.
 */
export interface CommitAttribution {
  authorName: string;
  authorEmail: string;
  coAuthor?: { name: string; email: string };
}

function messageWithTrailer(message: string, attribution?: CommitAttribution): string {
  if (!attribution?.coAuthor) return message;
  // A trailer must sit in its own paragraph at the end of the message (git's
  // own trailer convention) — a blank line first guarantees that even when
  // `message` is already multi-paragraph.
  return `${message}\n\nCo-authored-by: ${attribution.coAuthor.name} <${attribution.coAuthor.email}>`;
}

/**
 * Write `content` to `relPath` inside `repoPath` and commit it directly onto
 * whatever branch is currently checked out. Refuses if the file's current
 * on-disk content doesn't match `baseline` — the local analog of GitHub's sha
 * check, so an edit drafted against stale content can't silently clobber a
 * change made since. No-ops (returns `{ committed: false }`) if `content`
 * already matches what's on disk.
 *
 * `baseline: null` means "this file must not exist yet" (TASK 32's roadmap
 * scaffold — `readFile` below resolves to `null` for a missing file, so the
 * same `current !== baseline` check that guards a normal edit against drift
 * also guards a create against "huh, it's already there" with no separate
 * branch).
 *
 * `attribution`, when given, sets the commit's AUTHOR identity (default:
 * the operator's git identity is otherwise left to the flat Skynet identity
 * below) and appends a `Co-authored-by:` trailer — see `CommitAttribution`'s
 * own doc comment for the one caller that passes this.
 */
export async function commitLocalRepoFile(
  repoPath: string,
  relPath: string,
  content: string,
  baseline: string | null,
  message: string,
  attribution?: CommitAttribution,
): Promise<{ committed: boolean; sha?: string }> {
  if (!isWritablePath(relPath)) {
    throw new LocalRepoWriteError(`Refusing to write an unlisted path: ${relPath}`);
  }
  if (!existsSync(join(repoPath, ".git"))) {
    throw new LocalRepoWriteError(`${repoPath} doesn't look like a git checkout (no .git).`);
  }
  const current = await readFile(join(repoPath, relPath), "utf8").catch(() => null);
  if (current !== baseline) {
    throw new LocalRepoWriteError(
      baseline === null ? `${relPath} already exists — refusing to scaffold over it.` : `${relPath} changed on disk since this edit was drafted.`,
    );
  }
  if (current === content) return { committed: false };

  // ROADMAP.md's own parent directories always already exist (repo root,
  // docs/); Memory v0's nested paths (areas/<project>/<area>.md, etc.) do
  // not — a brand-new scope's first fact needs its directory created, same
  // as `git` itself would on the next `add`.
  await mkdir(dirname(join(repoPath, relPath)), { recursive: true });
  await writeFile(join(repoPath, relPath), content, "utf8");
  await git(repoPath, "add", "--", relPath);
  // Inline identity so this never depends on the operator's global git config.
  // COMMITTER is always Skynet's own service identity — it's what actually
  // ran the write, same as every other commit path in this codebase. AUTHOR
  // is the approving human when `attribution` is set (real commit attribution
  // — TASK 28), via `--author` (there is no `[author]` git-config section to
  // `-c` the way `user.*`/committer identity works — this is git's own way to
  // set author independently of committer).
  const commitArgs = ["-c", "user.name=Skynet", "-c", "user.email=skynet@local", "commit"];
  if (attribution) commitArgs.push(`--author=${attribution.authorName} <${attribution.authorEmail}>`);
  commitArgs.push("-m", messageWithTrailer(message, attribution), "--", relPath);
  await git(repoPath, ...commitArgs);
  const sha = await git(repoPath, "rev-parse", "HEAD");
  return { committed: true, sha };
}

/**
 * `git revert <sha> --no-edit` against `repoPath`'s current HEAD — a real
 * inverse commit, not a hand-rolled undo, so it plays correctly with
 * whatever else has happened to the file since (a clean revert, or a real
 * conflict git itself reports rather than one silently mis-resolved).
 * `attribution.authorName/authorEmail` sets the revert's AUTHOR (the
 * operator who clicked "revert the commit" — TASK 29's roadmap-line revert);
 * committer stays the flat Skynet identity, same convention as
 * `commitLocalRepoFile` above.
 *
 * Unlike `git commit`, `git revert` has NO `--author` flag — the only way to
 * override just the author (leaving the committer as Skynet's own service
 * identity) is the `GIT_AUTHOR_NAME`/`GIT_AUTHOR_EMAIL` env vars git itself
 * reads, which `-c user.name=/-c user.email=` alone would set for BOTH
 * author and committer. `GIT_COMMITTER_*` stays unset here so the inherited
 * `-c user.name=Skynet -c user.email=skynet@local` config keeps governing
 * the committer, exactly as `commitLocalRepoFile`'s plain (no-attribution)
 * commits already do.
 *
 * On a conflict, aborts the revert (leaves the worktree exactly as it was)
 * and throws `LocalRepoWriteError` with git's own message rather than
 * leaving a half-applied revert on disk.
 */
export async function revertCommitInLocalRepo(
  repoPath: string,
  sha: string,
  attribution?: CommitAttribution,
): Promise<{ committed: boolean; sha?: string }> {
  if (!existsSync(join(repoPath, ".git"))) {
    throw new LocalRepoWriteError(`${repoPath} doesn't look like a git checkout (no .git).`);
  }
  const env = attribution
    ? { ...process.env, GIT_AUTHOR_NAME: attribution.authorName, GIT_AUTHOR_EMAIL: attribution.authorEmail }
    : undefined;
  try {
    await exec(gitBin(), ["-C", repoPath, "-c", "user.name=Skynet", "-c", "user.email=skynet@local", "revert", "--no-edit", sha], { env });
  } catch (err) {
    await git(repoPath, "revert", "--abort").catch(() => undefined);
    throw new LocalRepoWriteError(`Couldn't cleanly revert ${sha.slice(0, 8)}: ${(err as Error).message}`);
  }
  const newSha = await git(repoPath, "rev-parse", "HEAD");
  return { committed: true, sha: newSha };
}
