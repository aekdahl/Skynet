// ─── Project primer auto-draft (S2) ──────────────────────────────────────
// Draft `Project.primer` from the project's bound repo: a deterministic,
// bounded digest (file tree, manifests, README head — never an open-ended
// agent tool-loop) fed into ONE stateless consult call. The operator reviews
// and edits the draft before it's ever saved — this module never writes
// `Project.primer` itself, it only returns text (see Operations.draftProjectPrimer).

import { readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Project } from "@skynet/shared";
import { oneShotText } from "@skynet/runner-sdk/claude";
import { secretService } from "./secrets/index.js";
import { readProjectDoc, listProjectRoot } from "./steward/docs.js";

const TREE_DEPTH = 3;
const MAX_TREE_ENTRIES = 400;
const TREE_CHAR_CAP = 3_000;
const README_HEAD_CHARS = 2_000;
const MANIFEST_CHARS = 1_500;
const DIGEST_CHAR_CAP = 8_000;
const MAX_DRAFT_CHARS = 12_000;

// Common single-file manifests, tried at repo root only (both local + GitHub,
// via readProjectDoc) — enough to name the stack without an unbounded search.
const MANIFEST_CANDIDATES = ["package.json", "pnpm-workspace.yaml", "pyproject.toml", "requirements.txt", "Cargo.toml", "go.mod", "Gemfile", "composer.json"];

const IGNORED_DIRS = new Set(["node_modules", ".git", "dist", "build", ".next", "out", "coverage", "target", "vendor", ".venv", "__pycache__", ".turbo", ".cache"]);

/** Recursive local file tree, depth-bounded (both in directory levels and
 *  total entry count) — deterministic, no agent tool-loop involved. */
async function walkLocalTree(root: string, maxDepth: number): Promise<string[]> {
  const lines: string[] = [];
  async function walk(dir: string, rel: string, level: number): Promise<void> {
    if (lines.length >= MAX_TREE_ENTRIES) return;
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    const visible = entries.filter((e) => !(e.isDirectory() && IGNORED_DIRS.has(e.name))).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of visible) {
      if (lines.length >= MAX_TREE_ENTRIES) return;
      const entryRel = rel ? `${rel}/${entry.name}` : entry.name;
      lines.push(entry.isDirectory() ? `${entryRel}/` : entryRel);
      if (entry.isDirectory() && level < maxDepth) await walk(join(dir, entry.name), entryRel, level + 1);
    }
  }
  await walk(root, "", 0);
  return lines;
}

interface RepoDigest {
  treeText: string;
  manifests: Array<{ path: string; content: string }>;
  readme: string | null;
}

/** Gathers the bounded, deterministic repo digest the draft is grounded on. A
 *  local `repoPath` gets the fuller depth-N tree; a GitHub-only `repo` gets
 *  the top-level listing only (`listProjectRoot` has no recursive fetch) —
 *  a shallower digest, not a failure. */
async function buildRepoDigest(ws: string, project: Project): Promise<RepoDigest> {
  const manifests: Array<{ path: string; content: string }> = [];
  for (const path of MANIFEST_CANDIDATES) {
    const doc = await readProjectDoc(ws, project, path, { maxChars: MANIFEST_CHARS }).catch(() => null);
    if (doc) manifests.push({ path, content: doc.content });
  }
  const readmeDoc = await readProjectDoc(ws, project, "README.md", { maxChars: README_HEAD_CHARS }).catch(() => null);
  const treeLines = project.repoPath ? await walkLocalTree(project.repoPath, TREE_DEPTH) : await listProjectRoot(ws, project);
  let treeText = treeLines.join("\n");
  if (treeText.length > TREE_CHAR_CAP) treeText = `${treeText.slice(0, TREE_CHAR_CAP)}\n… (truncated)`;
  return { treeText, manifests, readme: readmeDoc?.content ?? null };
}

function digestToText(digest: RepoDigest): string {
  const parts: string[] = [];
  if (digest.manifests.length) parts.push(digest.manifests.map((m) => `--- ${m.path} ---\n${m.content}`).join("\n\n"));
  if (digest.readme) parts.push(`--- README.md (head) ---\n${digest.readme}`);
  if (digest.treeText) parts.push(`--- file tree (depth ${TREE_DEPTH}) ---\n${digest.treeText}`);
  return parts.join("\n\n").slice(0, DIGEST_CHAR_CAP);
}

function buildPrompt(project: Project, digest: string): string {
  return [
    `You are drafting a "project primer" — a markdown briefing every coding agent working on "${project.name}" reads before starting a task.`,
    project.goal.trim() ? `The project's stated goal: ${project.goal.trim()}` : "",
    "Write it as a well-organized markdown document covering (skip a section the repo digest below doesn't support):",
    "- What this project is / does (a short elaboration of the goal)",
    "- Tech stack (languages, frameworks, key libraries)",
    "- Repo layout (what lives where)",
    "- Conventions (naming, structure, patterns you can actually infer)",
    "- Build / test / dev commands (from manifest scripts or equivalent)",
    "- Anything else an agent should know before making a change",
    "",
    "Ground every claim in what's ACTUALLY in the digest below — never invent a stack, command, or convention the digest doesn't support. Be concrete and concise, not generic boilerplate.",
    "",
    "=== REPO DIGEST ===",
    digest,
    "=== END REPO DIGEST ===",
    "",
    "Respond with ONLY the markdown primer document — no preamble, no commentary, no code-fence wrapper.",
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Draft a primer for a project from its bound repo. Never touches
 * `Project.primer` — returns the draft text for the operator to review, edit,
 * and explicitly save (the edit/save IS the approval). Throws with a clear
 * message on any failure (no bound repo, nothing readable, consult error) —
 * the caller (Operations.draftProjectPrimer) surfaces it as-is; there is no
 * silent fallback that could be mistaken for a real draft.
 */
export async function draftPrimer(ws: string, project: Project): Promise<string> {
  if (!project.repoPath && !project.repo) {
    throw new Error("This project has no bound repository to draft a primer from — connect a local folder or GitHub repo first.");
  }
  const digest = digestToText(await buildRepoDigest(ws, project));
  if (!digest.trim()) {
    throw new Error("Couldn't read anything from this project's repo to draft a primer from.");
  }
  const apiKey = (await secretService.resolve(ws, "claude")) ?? undefined;
  let reply: string;
  try {
    reply = await oneShotText({ prompt: buildPrompt(project, digest), apiKey });
  } catch (err) {
    throw new Error(`Couldn't draft a primer: ${(err as Error).message}`);
  }
  const draft = reply.trim();
  if (!draft) throw new Error("The model returned an empty draft — try again.");
  return draft.slice(0, MAX_DRAFT_CHARS);
}
