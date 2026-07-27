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
import { ProjectStatus, TaskState } from "@skynet/shared";
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
  "You are the project assistant for a Skynet workspace — you help the operator understand the CURRENT STATUS and CONTENT of one project, and you can perform project & task actions on request. " +
  "Answer conversationally and concisely. Ground every answer in the PROJECT STATUS below, and when the question is about the code or docs, in the repository content (open files such as ROADMAP.md / README.md as needed). " +
  "If a file or fact isn't available to you, say so plainly — never invent repo content or project state.\n" +
  'ACTIONS: ONLY when the operator is clearly asking you to CHANGE something, append as the FINAL line a JSON object exactly {"proposeAction": <one action object>} and nothing after it — the operator confirms before it runs. Never include it for questions, summaries, or chat, and never more than one. ' +
  "Use the task ids from PROJECT STATUS (each task is listed as `[id] text`); if a request references a task that isn't listed, ask instead of guessing. Valid action objects:\n" +
  '  {"kind":"add_task","text":"<title>"}\n' +
  '  {"kind":"move_task","taskId":"<id>","to":"backlog|triage|todo|ongoing|review|done"}\n' +
  '  {"kind":"rename_task","taskId":"<id>","text":"<new title>"}\n' +
  '  {"kind":"set_task_desc","taskId":"<id>","description":"<text>"}\n' +
  '  {"kind":"remove_task","taskId":"<id>"}\n' +
  '  {"kind":"reorder_task","taskId":"<id>","direction":"up|down"}\n' +
  '  {"kind":"rename_project","name":"<new name>"}\n' +
  '  {"kind":"set_goal","goal":"<goal>"}\n' +
  '  {"kind":"set_autonomy","autonomy":true|false}\n' +
  '  {"kind":"set_status","status":"active|paused|done"}';

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

/** A validated, project-scoped action the assistant proposes (confirm-first).
 *  `summary` is the human confirm-chip label, built at validation time so the UI
 *  needs no per-kind label logic. Mirror kept in sync with the web client's copy. */
export type ProjectActionKind =
  | "add_task"
  | "move_task"
  | "rename_task"
  | "set_task_desc"
  | "remove_task"
  | "reorder_task"
  | "rename_project"
  | "set_goal"
  | "set_autonomy"
  | "set_status";

export interface AssistantAction {
  kind: ProjectActionKind;
  summary: string;
  taskId?: string;
  text?: string;
  description?: string;
  to?: Task["state"];
  direction?: "up" | "down";
  name?: string;
  goal?: string;
  autonomy?: boolean;
  status?: Project["status"];
}

/** The grounding the action validator resolves ids against (this project only). */
export interface ProjectActionContext {
  project: { id: string; name: string };
  tasks: { id: string; text: string; state: Task["state"] }[];
}

const clip = (s: string): string => (s.length > 60 ? s.slice(0, 57) + "…" : s);

/**
 * PURE: validate a CANDIDATE action against the whitelist AND this project's
 * grounding. Every task-referencing action's `taskId` MUST resolve to a task in
 * the context — so a misparse or an injected instruction can never touch a task
 * outside this project. Enum-valued fields (`to`, `status`) are checked against
 * the contract. Returns the normalized {@link AssistantAction} (with a display
 * summary) or `null` when the action is unknown or fails validation.
 */
export function validateProjectAction(obj: unknown, ctx: ProjectActionContext): AssistantAction | null {
  if (!obj || typeof obj !== "object") return null;
  const o = obj as Record<string, unknown>;
  const kind = typeof o.kind === "string" ? o.kind : "";
  const str = (v: unknown): string => (typeof v === "string" && v.trim() ? v.trim() : "");
  const task = (id: unknown) => ctx.tasks.find((t) => t.id === id);

  switch (kind) {
    case "add_task": {
      const text = str(o.text);
      return text ? { kind, text, summary: `Create task: “${clip(text)}”` } : null;
    }
    case "move_task": {
      const t = task(o.taskId);
      const to = str(o.to) as Task["state"];
      if (!t || !TaskState.options.includes(to)) return null;
      return { kind, taskId: t.id, to, summary: `Move “${clip(t.text)}” → ${to}` };
    }
    case "rename_task": {
      const t = task(o.taskId);
      const text = str(o.text);
      if (!t || !text) return null;
      return { kind, taskId: t.id, text, summary: `Rename “${clip(t.text)}” → “${clip(text)}”` };
    }
    case "set_task_desc": {
      const t = task(o.taskId);
      const description = str(o.description);
      if (!t || !description) return null;
      return { kind, taskId: t.id, description, summary: `Set description on “${clip(t.text)}”` };
    }
    case "remove_task": {
      const t = task(o.taskId);
      return t ? { kind, taskId: t.id, summary: `Delete task “${clip(t.text)}”` } : null;
    }
    case "reorder_task": {
      const t = task(o.taskId);
      const direction = o.direction === "up" || o.direction === "down" ? o.direction : null;
      if (!t || !direction) return null;
      return { kind, taskId: t.id, direction, summary: `Move “${clip(t.text)}” ${direction} in its column` };
    }
    case "rename_project": {
      const name = str(o.name);
      return name ? { kind, name, summary: `Rename project → “${clip(name)}”` } : null;
    }
    case "set_goal": {
      const goal = str(o.goal);
      return goal ? { kind, goal, summary: `Set project goal → “${clip(goal)}”` } : null;
    }
    case "set_autonomy": {
      if (typeof o.autonomy !== "boolean") return null;
      return { kind, autonomy: o.autonomy, summary: `Turn autonomy ${o.autonomy ? "on" : "off"}` };
    }
    case "set_status": {
      const status = str(o.status) as Project["status"];
      if (!ProjectStatus.options.includes(status)) return null;
      return { kind, status, summary: `Set project status → ${status}` };
    }
    default:
      return null;
  }
}

/**
 * PURE: split an assistant answer into its human `reply` and an OPTIONAL validated
 * action. The model appends a final-line `{"proposeAction": <action>}` only when
 * the operator clearly asked to change something; we strip it from the shown reply
 * and validate it against the project context. Degrades safely — no valid tail (or
 * an action that fails validation) → the whole text is the reply, `action` is null.
 */
/** Find the last balanced top-level `{…}` object in `s` by matching braces from
 *  the end — so a NESTED tail like {"proposeAction":{…}} is captured whole (a
 *  naive lastIndexOf("{") would grab the inner object). Returns the substring and
 *  its start index, or null. Good enough for our tails (no brace-in-string edge). */
function lastTopLevelObject(s: string): { json: string; start: number } | null {
  const end = s.lastIndexOf("}");
  if (end === -1) return null;
  let depth = 0;
  for (let i = end; i >= 0; i--) {
    if (s[i] === "}") depth++;
    else if (s[i] === "{") {
      depth--;
      if (depth === 0) return { json: s.slice(i, end + 1), start: i };
    }
  }
  return null;
}

export function splitProposedAction(
  text: string,
  ctx: ProjectActionContext,
): { reply: string; action: AssistantAction | null } {
  const trimmed = (text ?? "").trim();
  // Tolerate a trailing code fence around the JSON tail.
  const body = trimmed.replace(/\n?```\s*$/, "").trimEnd();
  const found = lastTopLevelObject(body);
  if (!found) return { reply: trimmed, action: null };
  try {
    const obj = JSON.parse(found.json) as Record<string, unknown>;
    if (obj && typeof obj === "object" && "proposeAction" in obj) {
      // A recognized proposeAction block is ALWAYS stripped from the shown reply —
      // even when it fails validation (unknown task id, injected instruction), so
      // raw JSON never leaks to the operator. The chip appears only if it validates.
      const action = validateProjectAction(obj.proposeAction, ctx);
      const stripped = body.slice(0, found.start).replace(/```[a-zA-Z]*\s*$/, "").trim();
      const reply = stripped
        ? stripped
        : action
          ? `Want me to ${action.summary[0]!.toLowerCase()}${action.summary.slice(1)}?`
          : "Hmm — I couldn't map that to something on this board.";
      return { reply, action };
    }
  } catch {
    /* not a JSON tail — the whole answer is the reply */
  }
  return { reply: trimmed, action: null };
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
        ? `  ${s} (${items.length}): ${items.slice(0, 20).map((t) => `[${t.id}] ${t.text}`).join(" · ")}`
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
): Promise<{ reply: string; action: AssistantAction | null }> {
  const { workspaceId, project, question } = opts;
  const history = opts.history ?? [];

  const [allTasks, allRuns] = await Promise.all([
    store.listTasks(workspaceId),
    store.listRuns(workspaceId),
  ]);
  const projectTasks = allTasks.filter((t) => t.projectId === project.id);
  const context = statusContext(
    project,
    projectTasks,
    allRuns.filter((r) => r.projectId === project.id),
  );
  const actionCtx: ProjectActionContext = {
    project: { id: project.id, name: project.name },
    tasks: projectTasks.map((t) => ({ id: t.id, text: t.text, state: t.state })),
  };
  const apiKey = await secretService.resolve(workspaceId, "claude");

  // Local checkout → read the working tree directly (Read/Grep/Glob), so the
  // assistant can open any source file, not just the prefetched docs.
  if (project.repoPath) {
    const answer = await oneShotRepoAssistant({
      prompt: buildPrompt(context, "", history, question),
      cwd: project.repoPath,
      apiKey,
    });
    return splitProposedAction(answer, actionCtx);
  }

  // GitHub-connected but not cloned → prefetch key docs + the top-level tree.
  let docs = project.repo ? await prefetchProjectDocs(workspaceId, project) : "";
  if (project.repo && !docs) {
    docs = "\n\n(Repo is connected but no README/ROADMAP was found and files aren't cloned locally — answer from project status.)";
  }
  const answer = await oneShotText({ prompt: buildPrompt(context, docs, history, question), apiKey });
  return splitProposedAction(answer, actionCtx);
}
