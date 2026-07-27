// ─── Project assistant ─────────────────────────────────────────────────────
// A repo-aware chat assistant for the project detail page. Uses the same
// general-purpose LLM as the rest of Skynet (runner-sdk `oneShot*` → Claude),
// grounded in the project's live status (board + runs) and its repository
// content, so the operator can ask "what's the status?" or "summarize
// ROADMAP.md" and get a real answer.
//
// Two grounding paths, picked by how the project is bound to code:
//   • local `repoPath` → the model READS the working tree directly (Read/Grep/
//     Glob), so it can open any file on demand.
//   • connected GitHub `repo` (no local clone) → we prefetch the key docs +
//     top-level tree via the GitHub API and hand them to a tool-less answer.
// Either way the answer stays grounded — the model is told never to invent repo
// content or project state.

import type { Project, Task, TaskRun } from "@skynet/shared";
import { oneShotRepoAssistant, oneShotText } from "@skynet/runner-sdk/claude";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { githubService } from "./github/index.js";
import { secretService } from "./secrets/index.js";
import type { Store } from "./store/store.js";

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

const STAGES: Task["state"][] = ["backlog", "triage", "todo", "ongoing", "review", "done"];
// Docs worth prefetching for a GitHub-only project, in priority order.
const KEY_DOCS = ["README.md", "ROADMAP.md", "docs/ROADMAP.md", "AGENTS.md", "CLAUDE.md"];
const MAX_DOC_CHARS = 8000;
const MAX_HISTORY = 8;

const SYSTEM =
  "You are the project assistant for a Skynet workspace — you help the operator understand the CURRENT STATUS and CONTENT of one project, and you can propose creating a work item (task) for it. " +
  "Answer conversationally and concisely. Ground every answer in the PROJECT STATUS below, and when the question is about the code or docs, in the repository content (open files such as ROADMAP.md / README.md as needed). " +
  "If a file or fact isn't available to you, say so plainly — never invent repo content or project state. " +
  'TASK CREATION: ONLY when the operator is clearly asking to create/add a task or work item for this project, append as the FINAL line a JSON object exactly like {"proposeTask":"<concise task title>"} and nothing after it. Never include it for questions, summaries, or chat. The operator confirms before it is created.';

/**
 * Prefetch a bounded snapshot of a project's repo — the top-level file list plus
 * the key docs (README / ROADMAP / AGENTS / CLAUDE) — as plain text for grounding.
 * Works for either binding: a local checkout is read from disk, a GitHub-only
 * project is read via the API. Used by the GitHub branch below AND by the Telegram
 * assistant (which has no working tree to tool-loop over). Best-effort: any read
 * that fails is simply omitted. Never throws.
 */
export async function prefetchProjectDocs(
  workspaceId: string,
  project: Project,
  perDocChars: number = MAX_DOC_CHARS,
): Promise<string> {
  let docs = "";
  if (project.repoPath) {
    // Local checkout — read the top-level listing + key docs straight off disk.
    const root = await readdir(project.repoPath).catch(() => [] as string[]);
    if (root.length) docs += `\n\nTop-level files: ${root.slice(0, 60).join(", ")}`;
    for (const rel of KEY_DOCS) {
      // KEY_DOCS are fixed constants (no user input), so this join can't escape the repo.
      const content = await readFile(join(project.repoPath, rel), "utf8").catch(() => null);
      if (content) docs += `\n\n=== ${rel} ===\n${content.slice(0, perDocChars)}`;
    }
  } else if (project.repo) {
    const root = await githubService.listRepoRoot(workspaceId, project.repo).catch(() => [] as string[]);
    if (root.length) docs += `\n\nTop-level files: ${root.join(", ")}`;
    for (const rel of KEY_DOCS) {
      const content = await githubService.readRepoFile(workspaceId, project.repo, rel).catch(() => null);
      if (content) docs += `\n\n=== ${rel} ===\n${content.slice(0, perDocChars)}`;
    }
  }
  return docs;
}

/**
 * PURE: split an assistant answer into its human `reply` and an OPTIONAL proposed
 * task title. The model appends a final-line `{"proposeTask":"…"}` only when the
 * operator clearly asked to create a task; we strip it from the shown reply and
 * surface it as a confirm chip. Degrades safely — no valid JSON tail → the whole
 * text is the reply and `proposeTask` is null.
 */
export function splitProposedTask(text: string): { reply: string; proposeTask: string | null } {
  const trimmed = (text ?? "").trim();
  // Tolerate a trailing code fence around the JSON tail.
  const body = trimmed.replace(/\n?```\s*$/, "").trimEnd();
  const start = body.lastIndexOf("{");
  if (start === -1) return { reply: trimmed, proposeTask: null };
  try {
    const obj = JSON.parse(body.slice(start)) as { proposeTask?: unknown };
    if (obj && typeof obj.proposeTask === "string" && obj.proposeTask.trim()) {
      const reply = body.slice(0, start).replace(/```[a-zA-Z]*\s*$/, "").trim();
      return { reply: reply || "Want me to add this as a task?", proposeTask: obj.proposeTask.trim() };
    }
  } catch {
    /* not a JSON tail — the whole answer is the reply */
  }
  return { reply: trimmed, proposeTask: null };
}

function statusContext(project: Project, tasks: Task[], runs: TaskRun[]): string {
  const lines: string[] = [
    `PROJECT: ${project.name}`,
    `GOAL: ${project.goal?.trim() || "(none set yet)"}`,
    `REPO: ${project.repo ?? project.repoPath ?? "(not connected)"}`,
    `AUTONOMY: ${project.autonomy ? "on (agents may self-advance tasks)" : "off (human-driven)"}`,
    "BOARD (tasks by stage):",
  ];
  for (const s of STAGES) {
    const items = tasks.filter((t) => t.state === s);
    lines.push(
      items.length
        ? `  ${s} (${items.length}): ${items.slice(0, 10).map((t) => t.text).join(" · ")}`
        : `  ${s}: 0`,
    );
  }
  const active = runs.filter((r) => r.status !== "done" && !r.archived);
  if (active.length) {
    lines.push("ACTIVE RUNS:");
    for (const r of active.slice(0, 10)) {
      lines.push(`  ${r.name} — ${r.status} · ${Math.round(r.progress * 100)}% · ${r.branch}`);
    }
  }
  return lines.join("\n");
}

function buildPrompt(context: string, docs: string, history: ChatTurn[], question: string): string {
  const convo = history
    .slice(-MAX_HISTORY)
    .map((t) => `${t.role === "user" ? "Operator" : "Assistant"}: ${t.content}`)
    .join("\n");
  return [
    SYSTEM,
    "",
    "=== PROJECT STATUS ===",
    context,
    docs ? `\n=== REPO CONTENT ===${docs}` : "",
    convo ? `\n=== CONVERSATION SO FAR ===\n${convo}` : "",
    "",
    `Operator asks: ${question}`,
  ]
    .filter((s) => s !== "")
    .join("\n");
}

export async function answerProjectQuestion(
  store: Store,
  opts: { workspaceId: string; project: Project; question: string; history?: ChatTurn[] },
): Promise<{ reply: string; proposeTask: string | null }> {
  const { workspaceId, project, question } = opts;
  const history = opts.history ?? [];

  const [allTasks, allRuns] = await Promise.all([
    store.listTasks(workspaceId),
    store.listRuns(workspaceId),
  ]);
  const context = statusContext(
    project,
    allTasks.filter((t) => t.projectId === project.id),
    allRuns.filter((r) => r.projectId === project.id),
  );
  const apiKey = await secretService.resolve(workspaceId, "claude");

  // Local checkout → read the working tree directly (Read/Grep/Glob), so the
  // assistant can open any source file, not just the prefetched docs.
  if (project.repoPath) {
    const answer = await oneShotRepoAssistant({
      prompt: buildPrompt(context, "", history, question),
      cwd: project.repoPath,
      apiKey,
    });
    return splitProposedTask(answer);
  }

  // GitHub-connected but not cloned → prefetch key docs + the top-level tree.
  let docs = project.repo ? await prefetchProjectDocs(workspaceId, project) : "";
  if (project.repo && !docs) {
    docs = "\n\n(Repo is connected but no README/ROADMAP was found and files aren't cloned locally — answer from project status.)";
  }
  const answer = await oneShotText({ prompt: buildPrompt(context, docs, history, question), apiKey });
  return splitProposedTask(answer);
}
