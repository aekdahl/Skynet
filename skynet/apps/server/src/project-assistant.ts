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
  "You are the project assistant for a Skynet workspace — you help the operator understand the CURRENT STATUS and CONTENT of one project. " +
  "Answer conversationally and concisely. Ground every answer in the PROJECT STATUS below, and when the question is about the code or docs, in the repository content (open files such as ROADMAP.md / README.md as needed). " +
  "If a file or fact isn't available to you, say so plainly — never invent repo content or project state.";

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
): Promise<string> {
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

  // Local checkout → read the working tree directly.
  if (project.repoPath) {
    return oneShotRepoAssistant({
      prompt: buildPrompt(context, "", history, question),
      cwd: project.repoPath,
      apiKey,
    });
  }

  // GitHub-connected but not cloned → prefetch key docs + the top-level tree.
  let docs = "";
  if (project.repo) {
    const root = await githubService.listRepoRoot(workspaceId, project.repo).catch(() => [] as string[]);
    if (root.length) docs += `\n\nTop-level files: ${root.join(", ")}`;
    for (const path of KEY_DOCS) {
      const content = await githubService.readRepoFile(workspaceId, project.repo, path).catch(() => null);
      if (content) docs += `\n\n=== ${path} ===\n${content.slice(0, MAX_DOC_CHARS)}`;
    }
    if (!docs) {
      docs = "\n\n(Repo is connected but no README/ROADMAP was found and files aren't cloned locally — answer from project status.)";
    }
  }
  return oneShotText({ prompt: buildPrompt(context, docs, history, question), apiKey });
}
