// Resolve an absolute path to the `git` binary once, and reuse it for every git
// spawn (clone, worktrees, merge, push, preview).
//
// Why this exists: a GUI-launched app (Electron on macOS) does NOT inherit your
// login-shell PATH — it runs with a bare `/usr/bin:/bin:/usr/sbin:/sbin`. So a
// Homebrew git at `/opt/homebrew/bin/git` (Apple Silicon) or `/usr/local/bin`
// (Intel) is invisible, and `execFile("git", …)` dies with `spawn git ENOENT`.
// Headless server / Docker have a normal PATH, so there the very first candidate
// resolves immediately and this is a no-op.
//
// Resolution order: explicit override → PATH → common install dirs → give up and
// return "git" (so the caller's existing ENOENT surfaces exactly as before).

import { accessSync, constants } from "node:fs";
import { join } from "node:path";

const isWin = process.platform === "win32";
const EXE = isWin ? "git.exe" : "git";

// Dirs a package-manager git commonly lives in that a bare GUI PATH omits.
const COMMON_DIRS = isWin
  ? ["C:\\Program Files\\Git\\cmd", "C:\\Program Files\\Git\\bin"]
  : ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"];

let cached: string | null = null;

function isExecutable(p: string): boolean {
  try {
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Absolute path to git, memoized. Falls back to "git" if nothing is found so a
 *  missing binary fails with the same ENOENT it would have without us. */
export function gitBin(): string {
  if (cached) return cached;

  // 1. Explicit escape hatch (set by the desktop app or an operator).
  const override = process.env.SKYNET_GIT_PATH?.trim();
  if (override && isExecutable(override)) return (cached = override);

  // 2. Walk PATH, then the common install dirs (deduped), for an executable git.
  const pathDirs = (process.env.PATH ?? "").split(isWin ? ";" : ":").filter(Boolean);
  for (const dir of [...pathDirs, ...COMMON_DIRS]) {
    const candidate = join(dir, EXE);
    if (isExecutable(candidate)) return (cached = candidate);
  }

  // 3. Not found — return the bare name; the spawn's ENOENT is the honest signal.
  return (cached = EXE);
}

/** Test-only: forget the memoized path so a test can re-resolve under a new env. */
export function resetGitBinCache(): void {
  cached = null;
}
