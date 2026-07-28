// ─── Steward — the shared assistant brain ───────────────────────────────────
// "Steward" is the operator's repo-aware, project-managing conversational agent.
// It is the SAME brain whether reached in-app (the project page's "Ask about this
// project") or over Telegram: one grounding + prompt + action model + parser +
// validator lives here, so both surfaces get identical repo access, tools, and
// confirm-first action proposals. Each surface keeps only its own transport
// (web streaming + a confirm UI; Telegram messaging + a text-confirm loop) and
// its own execution of a confirmed action.
//
// Repo access, picked by how the project is bound to code (same for both surfaces):
//   • local `repoPath` → Steward READS the working tree directly via a bounded,
//     read-only Claude tool-loop (Read/LS/Glob/Grep), so it can open any file.
//   • connected GitHub `repo` (no local clone) → prefetch the key docs + top-level
//     tree via the GitHub API and answer tool-lessly.
// Either way the answer stays grounded — the model is told never to invent repo
// content or project state.

import type { Project, Task, TaskRun } from "@skynet/shared";
import { ProjectStatus, TaskState } from "@skynet/shared";
import {
  oneShotRepoAssistant,
  oneShotRepoAssistantStream,
  oneShotText,
  oneShotTextStream,
} from "@skynet/runner-sdk/claude";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { githubService } from "../github/index.js";
import { secretService } from "../secrets/index.js";

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

/** The narrow data access Steward needs to ground an answer — satisfied by both
 *  the full Store and Operations, so either surface (web or Telegram) can call it. */
export interface StewardData {
  listTasks(workspaceId: string): Promise<Task[]>;
  listRuns(workspaceId: string): Promise<TaskRun[]>;
}

/** Pick the single project a message is about — a case-insensitive match of a
 *  project's name in the text — but only when it has a LOCAL checkout, since that's
 *  what the repo tool-loop reads. Returns null when zero or MORE THAN ONE match
 *  (ambiguous → fall back to workspace-wide grounding). Pure. */
export function resolveFocusedProject<P extends { name: string; repoPath?: string | null }>(
  text: string,
  projects: P[],
): P | null {
  const hay = (text ?? "").toLowerCase();
  const hits = projects.filter(
    (p) => !!p.repoPath && p.name.trim().length > 0 && hay.includes(p.name.trim().toLowerCase()),
  );
  return hits.length === 1 ? hits[0]! : null;
}

const STAGES: Task["state"][] = ["backlog", "triage", "todo", "ongoing", "review", "done"];
// Docs worth prefetching for a GitHub-only project, in priority order.
const KEY_DOCS = ["README.md", "ROADMAP.md", "docs/ROADMAP.md", "AGENTS.md", "CLAUDE.md"];
const MAX_DOC_CHARS = 8000;
const MAX_HISTORY = 8;

const SYSTEM =
  "You are Steward, the repo-aware project assistant for a Skynet workspace — you help the operator understand the CURRENT STATUS and CONTENT of one project, and you can perform project & task actions on request. " +
  "Answer conversationally and concisely. Ground every answer in the PROJECT STATUS below, and when the question is about the code or docs, in the repository content (open files such as ROADMAP.md / README.md as needed). " +
  "If a file or fact isn't available to you, say so plainly — never invent repo content or project state.\n" +
  'ACTIONS: ONLY when the operator is clearly asking you to CHANGE something, append as the FINAL line a JSON object exactly {"proposeAction": <one action object>} and nothing after it — the operator confirms before it runs. Never include it for questions, summaries, or chat, and never more than one. ' +
  "Use the task ids from PROJECT STATUS (each task is listed as `[id] text`); if a request references a task that isn't listed, ask instead of guessing. Valid action objects:\n" +
  '  {"kind":"add_task","text":"<title>","description":"<optional — the full brief the agent gets>"}\n' +
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
 * surface (which grounds workspace-wide across projects). Best-effort: any read
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

/** A validated, project-scoped action Steward proposes (confirm-first). `summary`
 *  is the human confirm-chip label, built at validation time so the UI needs no
 *  per-kind label logic. Mirror kept in sync with the web client's copy. */
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
      if (!text) return null;
      const description = str(o.description);
      return {
        kind,
        text,
        ...(description ? { description } : {}),
        summary: `Create task: “${clip(text)}”${description ? " (with description)" : ""}`,
      };
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

/** Find the last balanced top-level `{…}` object in `s` by matching braces from
 *  the end — so a NESTED tail like {"proposeAction":{…}} is captured whole. */
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

/**
 * PURE: split an assistant answer into its human `reply` and an OPTIONAL validated
 * action. The model appends a final-line `{"proposeAction": <action>}` only when
 * the operator clearly asked to change something; we strip it from the shown reply
 * and validate it against the project context.
 */
export function splitProposedAction(
  text: string,
  ctx: ProjectActionContext,
): { reply: string; action: AssistantAction | null } {
  const trimmed = (text ?? "").trim();
  const body = trimmed.replace(/\n?```\s*$/, "").trimEnd();
  const found = lastTopLevelObject(body);
  if (!found) return { reply: trimmed, action: null };
  try {
    const obj = JSON.parse(found.json) as Record<string, unknown>;
    if (obj && typeof obj === "object" && "proposeAction" in obj) {
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

/** The prepared model call for a project question — the prompt (grounded in
 *  status + repo docs), whether it runs against a local checkout, and the key.
 *  Shared by the accumulating and streaming answer paths so they ask identically. */
export type StewardCall = { repo: boolean; prompt: string; cwd?: string; apiKey?: string; actionCtx: ProjectActionContext };

/** Ground a project question into a prepared Steward call — the SINGLE place both
 *  surfaces build the prompt + pick the repo tool-loop vs prefetch path, so they
 *  get identical repo access. */
export async function prepareStewardCall(
  store: StewardData,
  opts: { workspaceId: string; project: Project; question: string; history?: ChatTurn[] },
): Promise<StewardCall> {
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
  const apiKey = (await secretService.resolve(workspaceId, "claude")) ?? undefined;

  // Local checkout → read the working tree directly (Read/Grep/Glob).
  if (project.repoPath) {
    return { repo: true, prompt: buildPrompt(context, "", history, question), cwd: project.repoPath, apiKey, actionCtx };
  }
  // GitHub-connected but not cloned → prefetch key docs + the top-level tree.
  let docs = project.repo ? await prefetchProjectDocs(workspaceId, project) : "";
  if (project.repo && !docs) {
    docs = "\n\n(Repo is connected but no README/ROADMAP was found and files aren't cloned locally — answer from project status.)";
  }
  return { repo: false, prompt: buildPrompt(context, docs, history, question), apiKey, actionCtx };
}

/**
 * Ask Steward about one project. Runs the grounded call to completion — the repo
 * tool-loop for a local checkout, else the tool-less prefetch answer — then splits
 * out any confirm-first proposed action. The shared brain both surfaces call.
 */
export async function askSteward(
  store: StewardData,
  opts: { workspaceId: string; project: Project; question: string; history?: ChatTurn[] },
): Promise<{ reply: string; action: AssistantAction | null }> {
  const c = await prepareStewardCall(store, opts);
  const answer = c.repo
    ? await oneShotRepoAssistant({ prompt: c.prompt, cwd: c.cwd!, apiKey: c.apiKey })
    : await oneShotText({ prompt: c.prompt, apiKey: c.apiKey });
  return splitProposedAction(answer, c.actionCtx);
}

/** Streaming form of {@link askSteward} — yields the answer as text deltas so the
 *  web "Ask about this project" panel renders it live. Display-only: proposed
 *  actions come from the accumulating {@link askSteward}. */
export async function* askStewardStream(
  store: StewardData,
  opts: { workspaceId: string; project: Project; question: string; history?: ChatTurn[] },
): AsyncGenerator<string> {
  const c = await prepareStewardCall(store, opts);
  if (c.repo) yield* oneShotRepoAssistantStream({ prompt: c.prompt, cwd: c.cwd!, apiKey: c.apiKey });
  else yield* oneShotTextStream({ prompt: c.prompt, apiKey: c.apiKey });
}
