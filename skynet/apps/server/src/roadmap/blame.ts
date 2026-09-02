// ─── Roadmap doc line blame (Phase 26 — TASK 29) ────────────────────────────
// Real per-line git-blame, local checkout only — the ONLY source this
// codebase has for "who actually wrote this line" (see roadmap-doc.ts's own
// doc comment: author/authorRef/addedAt are forward-declared fields nothing
// populates yet). Reuses the exact git-spawn convention every other roadmap
// module uses (`execFile`, `gitBin()`, `-C <repoPath>`).

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { gitBin } from "../git-bin.js";

const exec = promisify(execFile);

export interface LineBlame {
  sha: string;
  authorName: string;
  authorEmail: string;
  /** epoch seconds, as git reports it — NOT epoch ms. Callers multiply by
   *  1000 if they need it alongside this codebase's usual epoch-ms Timestamp. */
  authorTimeSec: number;
  /** The commit's own subject line — cheap to carry along here (already in
   *  the porcelain output) rather than a second `git log` call per commit. */
  summary: string;
}

const HEADER_RE = /^([0-9a-f]{40}) \d+ (\d+)(?: \d+)?$/;

/** `1-based final line number → blame` for every line CURRENTLY in `relPath`
 *  at the checkout's current HEAD. Best-effort by design (the caller decides
 *  what "no blame" means — a fresh/untracked file, a shallow clone missing
 *  history, or simply not a git repo at all are all real, non-exceptional
 *  cases for a project's bound folder): returns an EMPTY map on any git
 *  failure rather than throwing, so a missing blame source degrades the UI
 *  (no provenance shown) instead of breaking the whole roadmap view. */
export async function blameFile(repoPath: string, relPath: string): Promise<Map<number, LineBlame>> {
  let stdout: string;
  try {
    ({ stdout } = await exec(gitBin(), ["-C", repoPath, "blame", "--porcelain", "--", relPath], { maxBuffer: 16 * 1024 * 1024 }));
  } catch {
    return new Map();
  }

  const lines = stdout.split("\n");
  const result = new Map<number, LineBlame>();
  const metaCache = new Map<string, { authorName?: string; authorEmail?: string; authorTimeSec?: number; summary?: string }>();
  let i = 0;
  while (i < lines.length) {
    const header = HEADER_RE.exec(lines[i] ?? "");
    if (!header) {
      i++;
      continue;
    }
    const sha = header[1]!;
    const finalLine = Number(header[2]);
    if (!metaCache.has(sha)) metaCache.set(sha, {});
    const meta = metaCache.get(sha)!;
    i++;
    // Metadata lines (only present the FIRST time this sha appears anywhere
    // in the output) run until the tab-prefixed source-content line.
    while (i < lines.length && !lines[i]!.startsWith("\t")) {
      const l = lines[i]!;
      if (l.startsWith("author ")) meta.authorName = l.slice(7);
      else if (l.startsWith("author-mail ")) meta.authorEmail = l.slice(12).replace(/^<|>$/g, "");
      else if (l.startsWith("author-time ")) meta.authorTimeSec = Number(l.slice(12));
      else if (l.startsWith("summary ")) meta.summary = l.slice(8);
      i++;
    }
    if (meta.authorName && meta.authorEmail && meta.authorTimeSec != null) {
      result.set(finalLine, { sha, authorName: meta.authorName, authorEmail: meta.authorEmail, authorTimeSec: meta.authorTimeSec, summary: meta.summary ?? "" });
    }
    i++; // consume the \t-prefixed content line itself
  }
  return result;
}

/** The commit message BODY (not just the subject `blameFile` already carries)
 *  for one sha — used only to look for a `Co-authored-by:` trailer naming the
 *  proposing agent (see attribution.ts's `agentCoAuthor`), so an ordinary
 *  flat-`skynet@local` commit can still surface WHICH agent it was, when that
 *  information exists. Best-effort, same reasoning as blameFile. */
export async function commitMessage(repoPath: string, sha: string): Promise<string> {
  try {
    const { stdout } = await exec(gitBin(), ["-C", repoPath, "log", "-1", "--format=%B", sha]);
    return stdout;
  } catch {
    return "";
  }
}
