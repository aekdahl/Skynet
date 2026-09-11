// ─── Project doc reading ─────────────────────────────────────────────────────
// A single place that knows how to read one file out of a project's bound
// repo, whichever way it's bound: a local `repoPath` checkout is read straight
// off disk; a GitHub-only `repo` is read via the Contents API (honoring the
// project's pinned `githubCredentialId`, not just the workspace default —
// unlike the old inline call this replaces). Shared by Steward's grounding
// prefetch and the project-scoped roadmap endpoint so the local-vs-GitHub
// branch logic lives in exactly one place.

import type { Project } from "@skynet/shared";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { githubService } from "../github/index.js";

/** Docs worth prefetching for Steward's grounding, in priority order. */
export const KEY_DOCS = ["README.md", "ROADMAP.md", "docs/ROADMAP.md", "AGENTS.md", "CLAUDE.md"];
export const MAX_DOC_CHARS = 8000;

/** Candidate locations for the product roadmap doc, in priority order. */
export const ROADMAP_PATHS = ["ROADMAP.md", "docs/ROADMAP.md"] as const;

export type ProjectDocSource = "local" | "github";

export interface ProjectDoc {
  path: string;
  content: string;
  source: ProjectDocSource;
  /** GitHub blob sha — only set when `source === "github"`; needed to commit an edit back. */
  sha?: string;
}

/**
 * Join `relPath` onto `root` and refuse if the resolved result would land
 * outside it. `relPath` here is NOT always a fixed constant (KEY_DOCS /
 * ROADMAP_PATHS) — `resolveRoadmapDoc` passes the operator/Steward-supplied
 * `project.roadmapPath` straight through, and `updateProjectRoadmap` passes
 * the request body's own `path` — so a `../../etc/passwd`-style value must be
 * caught here rather than trusted. Same containment pattern as
 * preview/route.ts's `safeFile` traversal guard (resolve, then verify the
 * result still starts with the root + a separator).
 */
function containedPath(root: string, relPath: string): string | null {
  const base = resolve(root);
  const target = resolve(base, relPath);
  return target === base || target.startsWith(base + sep) ? target : null;
}

/**
 * Read one file from a project's bound repo. Returns `null` when the project
 * is unbound (neither `repoPath` nor `repo`), the file doesn't exist there, or
 * `relPath` would escape `repoPath` (treated as absence, not a distinct error,
 * so a traversal attempt reads no differently from a missing file). A read
 * that fails for another reason (e.g. an expired/missing GitHub credential)
 * THROWS — callers distinguish "no such file" from "can't read the repo at
 * all" rather than treating both as absence.
 */
export async function readProjectDoc(
  workspaceId: string,
  project: Project,
  relPath: string,
  opts: { maxChars?: number } = {},
): Promise<ProjectDoc | null> {
  const maxChars = opts.maxChars ?? Infinity;
  if (project.repoPath) {
    const target = containedPath(project.repoPath, relPath);
    if (!target) return null;
    const content = await readFile(target, "utf8").catch((err: NodeJS.ErrnoException) => {
      if (err?.code === "ENOENT") return null;
      throw err;
    });
    return content == null ? null : { path: relPath, content: content.slice(0, maxChars), source: "local" };
  }
  if (project.repo) {
    const file = await githubService.getRepoFileWithSha(workspaceId, project.repo, relPath, project.githubCredentialId);
    return file ? { path: relPath, content: file.content.slice(0, maxChars), source: "github", sha: file.sha } : null;
  }
  return null;
}

/** Tries each candidate path in order, returning the first that exists. */
export async function readProjectDocFromCandidates(
  workspaceId: string,
  project: Project,
  candidates: readonly string[],
  opts: { maxChars?: number } = {},
): Promise<ProjectDoc | null> {
  for (const rel of candidates) {
    const doc = await readProjectDoc(workspaceId, project, rel, opts);
    if (doc) return doc;
  }
  return null;
}

/**
 * The roadmap doc a project actually resolves to — shared by the roadmap API
 * (operations.ts's getProjectRoadmap) and Steward's own grounding
 * (prepareStewardCall), so "what Steward tells you the roadmap is" and "what
 * the Roadmap tab shows" can never drift apart.
 *
 * `project.roadmapPath` (set via the Roadmap tab's "select a file" affordance,
 * by the operator or by Steward's own confirmed set_roadmap_path action) is
 * tried EXCLUSIVELY when present — not as a first-choice-then-fall-back, so an
 * explicit override that's gone missing reads as "not found" for the file the
 * operator actually chose, not a silent, confusing fall-back elsewhere. With
 * no override, the default ROADMAP_PATHS candidates are tried in order.
 */
export function resolveRoadmapDoc(
  workspaceId: string,
  project: Project,
  opts: { maxChars?: number } = {},
): Promise<ProjectDoc | null> {
  return project.roadmapPath
    ? readProjectDoc(workspaceId, project, project.roadmapPath, opts)
    : readProjectDocFromCandidates(workspaceId, project, ROADMAP_PATHS, opts);
}

/** Top-level file listing of a project's bound repo (best-effort — [] on any
 *  read failure, same as the GitHub branch always behaved; the local branch is
 *  now equally best-effort rather than throwing). */
export async function listProjectRoot(workspaceId: string, project: Project): Promise<string[]> {
  if (project.repoPath) {
    const root = await readdir(project.repoPath).catch(() => [] as string[]);
    return root.slice(0, 60);
  }
  if (project.repo) {
    return githubService.listRepoRoot(workspaceId, project.repo);
  }
  return [];
}

/** sha256 hex digest — the optimistic-concurrency baseline hash for a doc
 *  edit (so a commit refuses if the file changed since it was read). */
export function contentHash(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}
