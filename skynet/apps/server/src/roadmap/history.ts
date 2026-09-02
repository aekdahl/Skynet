// ─── Roadmap doc commit history (Phase 26 — TASK 29) ────────────────────────
// Real `git log` for one file, local checkout only — backs the HISTORY tab.
// A GitHub-only project has no equivalent implemented here (the Contents/
// Commits API path is a separate, larger surface — the caller checks
// `project.repoPath` before calling this, same gate blame.ts's caller uses).

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { gitBin } from "../git-bin.js";

const exec = promisify(execFile);

export interface RoadmapHistoryEntry {
  sha: string;
  authorName: string;
  authorEmail: string;
  /** epoch ms, this codebase's usual Timestamp convention (unlike blame.ts's
   *  raw epoch-seconds — converted here since this is the client-facing shape). */
  at: number;
  subject: string;
}

// Unit/record separator control chars — git's `%x1f`/`%x1e` format codes emit
// them literally, and neither can appear in a commit's author name/email/
// subject, so splitting on them is unambiguous regardless of what a commit
// message actually contains (unlike a printable delimiter, which a crafted
// subject line could collide with).
const FIELD_SEP = "\x1f";
const RECORD_SEP = "\x1e";

/** Newest-first commit history touching `relPath`, capped at `limit`. Real
 *  `git log`, not a synthetic/derived history — an empty array (never a
 *  throw) for a file with no history yet, or if `repoPath` isn't a git repo
 *  at all (mirrors blame.ts's own best-effort contract). */
export async function roadmapHistory(repoPath: string, relPath: string, limit: number = 50): Promise<RoadmapHistoryEntry[]> {
  let stdout: string;
  try {
    ({ stdout } = await exec(gitBin(), [
      "-C", repoPath, "log",
      `--max-count=${Math.max(1, Math.min(500, limit))}`,
      `--format=%H${FIELD_SEP}%an${FIELD_SEP}%ae${FIELD_SEP}%at${FIELD_SEP}%s${RECORD_SEP}`,
      "--", relPath,
    ]));
  } catch {
    return [];
  }
  return stdout
    .split(RECORD_SEP)
    .map((rec) => rec.replace(/^\n/, ""))
    .filter((rec) => rec.trim().length > 0)
    .map((rec) => {
      const [sha, authorName, authorEmail, atSec, subject] = rec.split(FIELD_SEP);
      return { sha: sha!, authorName: authorName!, authorEmail: authorEmail!, at: Number(atSec) * 1000, subject: subject ?? "" };
    });
}
