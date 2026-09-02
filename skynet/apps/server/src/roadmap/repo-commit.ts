// ─── Local repo HEAD sha (Phase 24) ─────────────────────────────────────────
// Small, standalone helper — same execFile/gitBin convention as
// local-repo-write.ts/merge.ts — for the one thing Operations.syncProjectRoadmap
// needs from a local checkout that the webhook payload doesn't already supply:
// "what commit is this repoPath actually on right now."

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { gitBin } from "../git-bin.js";

const exec = promisify(execFile);

/** `git rev-parse HEAD` for `repoPath`, or `null` if it isn't a git checkout
 *  (or the command fails for any other reason) — never throws. */
export async function localRepoHeadSha(repoPath: string): Promise<string | null> {
  try {
    const { stdout } = await exec(gitBin(), ["-C", repoPath, "rev-parse", "HEAD"]);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}
