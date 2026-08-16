// Resolve an absolute path to the `flyctl` binary once, and reuse it for every
// Fly spawn (launch, deploy, apps destroy, status). Mirrors git-bin.ts: a
// GUI-launched app (Electron on macOS) does NOT inherit your login-shell PATH,
// and flyctl's own installer drops the binary in `~/.fly/bin`, which a bare
// GUI PATH never includes either way.
//
// Resolution order: explicit override → PATH → common install dirs → give up
// and return "flyctl" (so the caller's existing ENOENT surfaces as-is, with a
// clear "flyctl not found — install it from fly.io/docs/flyctl" hint upstream).

import { accessSync, constants } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const isWin = process.platform === "win32";
const EXE = isWin ? "flyctl.exe" : "flyctl";

function commonDirs(): string[] {
  const home = homedir();
  return isWin
    ? [join(home, ".fly", "bin")]
    : [join(home, ".fly", "bin"), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"];
}

let cached: string | null = null;

function isExecutable(p: string): boolean {
  try {
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** Absolute path to flyctl, memoized. Falls back to "flyctl" if nothing is
 *  found so a missing binary fails with the same ENOENT it would have without
 *  us — the caller turns that into an operator-readable "flyctl isn't
 *  installed" message. */
export function flyctlBin(): string {
  if (cached) return cached;

  const override = process.env.SKYNET_FLYCTL_PATH?.trim();
  if (override && isExecutable(override)) return (cached = override);

  const pathDirs = (process.env.PATH ?? "").split(isWin ? ";" : ":").filter(Boolean);
  for (const dir of [...pathDirs, ...commonDirs()]) {
    const candidate = join(dir, EXE);
    if (isExecutable(candidate)) return (cached = candidate);
  }

  return (cached = EXE);
}

/** Test-only: forget the memoized path so a test can re-resolve under a new env. */
export function resetFlyctlBinCache(): void {
  cached = null;
}
