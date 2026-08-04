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

import type { Agent, Feature, HitlItem, Milestone, Project, Task, TaskAssignment, TaskRun } from "@skynet/shared";
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
import { settingsContext } from "../settings/env-settings.js";
import type { Store } from "../store/store.js";

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

const STAGES: Task["state"][] = ["backlog", "triage", "todo", "ongoing", "review", "done"];
// Docs worth prefetching for a GitHub-only project, in priority order.
const KEY_DOCS = ["README.md", "ROADMAP.md", "docs/ROADMAP.md", "AGENTS.md", "CLAUDE.md"];
const MAX_DOC_CHARS = 8000;
const MAX_HISTORY = 8;
/** Steward's per-input action budget ("loops"). It can propose up to this many
 *  changes from one message; asked for more, it proposes the first N and reports
 *  that it ran out so the operator can ask it to continue. */
export const MAX_STEWARD_ACTIONS = 10;

const SYSTEM =
  "You are Steward, the repo-aware project assistant for a Skynet workspace — you help the operator understand the CURRENT STATUS and CONTENT of one project, and you can perform project & task actions on request. " +
  "Answer conversationally and concisely. Ground every answer in the PROJECT STATUS below, and when the question is about the code or docs, in the repository content (open files such as ROADMAP.md / README.md as needed). " +
  "For questions about how this workspace is configured — approvals, autonomy, the runner sandbox, integration, Telegram, MCP, backends, vendor CLIs — ground the answer in the WORKSPACE SETTINGS section (the LIVE runtime config), NOT the committed repo docs, which may be out of date. Secret values there are shown only as set/not-set — never claim to know a secret's value. " +
  "If a file or fact isn't available to you, say so plainly — never invent repo content, project state, or settings.\n" +
  `ACTIONS: ONLY when the operator is clearly asking you to CHANGE something, append as the FINAL line a JSON object exactly {"proposeActions": [<action>, …]} — a LIST of 1 to ${MAX_STEWARD_ACTIONS} action objects, in the order they should apply — and NOTHING after it. The operator confirms before anything runs. Include it ONLY for change requests, never for questions, summaries, or chat. If the operator asks for MORE than ${MAX_STEWARD_ACTIONS} changes at once, propose the first ${MAX_STEWARD_ACTIONS} and say in your reply that there are more so they can ask you to continue. ` +
  "Use the task ids from PROJECT STATUS (each task is listed as `[id] text`); if a request references a task that isn't listed, ask instead of guessing. Valid action objects:\n" +
  '  {"kind":"add_task","text":"<title>","description":"<optional — the full brief the agent gets>"}\n' +
  '  {"kind":"move_task","taskId":"<id>","to":"backlog|triage|todo|ongoing|review|done"}\n' +
  '  {"kind":"rename_task","taskId":"<id>","text":"<new title>"}\n' +
  '  {"kind":"set_task_desc","taskId":"<id>","description":"<text>"}\n' +
  '  {"kind":"remove_task","taskId":"<id>"}\n' +
  '  {"kind":"archive_task","taskId":"<id>"}\n' +
  '  {"kind":"reorder_task","taskId":"<id>","direction":"up|down"}\n' +
  '  {"kind":"rename_project","name":"<new name>"}\n' +
  '  {"kind":"set_goal","goal":"<goal>"}\n' +
  '  {"kind":"set_autonomy","autonomy":true|false}\n' +
  '  {"kind":"set_status","status":"active|paused|done"}\n' +
  '  {"kind":"set_schedule","taskId":"<id>","estimatedDurationMs":<ms or null>,"plannedStartAt":<epoch ms or null>}\n' +
  '  {"kind":"set_assignment","taskId":"<id>","mode":"any|agents|unassigned","agentIds":["<agent id>", …]}\n' +
  '  {"kind":"add_feature","name":"<feature name>","description":"<optional>","milestoneId":"<optional milestone id>"}\n' +
  '  {"kind":"add_milestone","name":"<milestone name>","description":"<optional>","targetAt":<optional epoch ms>}\n' +
  '  {"kind":"set_task_feature","taskId":"<id>","featureId":"<feature id, or null to unlink>"}\n' +
  '  {"kind":"set_feature_milestone","featureId":"<feature id>","milestoneId":"<milestone id, or null to detach>"}\n' +
  "Notes on the roadmap actions (features + milestones): a FEATURE groups tasks; a MILESTONE is a dated release/checkpoint that features roll up into — that's the roadmap. " +
  "Use the feature ids from the FEATURES list and milestone ids from the MILESTONES list in PROJECT STATUS; if the operator names one that isn't listed, propose add_feature/add_milestone to create it (you can create it and link in the same batch), and never invent an id. " +
  "For `targetAt` prefer an epoch-ms timestamp for the date the operator gives.\n" +
  "Notes on set_schedule: either or both fields may be present. `estimatedDurationMs` = how long you think the task takes; " +
  "`plannedStartAt` = when it should start (epoch ms). Pass `null` for a field to clear it (e.g. unschedule). " +
  "For durations, prefer minutes-to-milliseconds math (30m = 1_800_000).\n" +
  "Notes on set_assignment: this sets a task's agent ELIGIBILITY — WHO may pick it up, not who ran it. " +
  "`any` = any idle fleet agent may take it (omit agentIds); `agents` = only the listed agentIds (≥1) may take it, whichever is idle first; " +
  "`unassigned` clears the choice (only valid while the task is still in backlog). Every id in `agentIds` MUST be an agent from the AGENTS list " +
  "in PROJECT STATUS — map the operator's wording (name or id) to those ids, and if they name an agent that isn't listed, ask instead of guessing.\n" +
  "Notes on archive_task vs remove_task: PREFER archive_task when the operator says 'archive', 'hide', 'shelve', 'set aside', " +
  "or wants the task out of the way but recoverable (soft-hide — stays in the store, hidden from the board). " +
  "Only use remove_task for an unambiguous 'delete' / 'remove for good' — that's a hard delete.\n" +
  "Grouping: features are named capabilities (see FEATURES list below, `[fid]`); milestones are planned releases (see MILESTONES, `[mid]`, with target dates). " +
  "Use the ids from PROJECT STATUS — reject the action rather than guess if the referenced feature/milestone isn't listed. " +
  "set_task_feature / set_feature_milestone / set_task_milestone accept `null` for milestoneId/featureId to clear the linkage. " +
  "create_milestone's `targetAt` is epoch ms (Date.parse('2026-06-01') style) or null for no committed date. " +
  "mark_milestone_shipped is a shortcut for setting status='shipped' — use it when the operator says 'we shipped v1' or similar.";

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
  | "archive_task"
  | "reorder_task"
  | "rename_project"
  | "set_goal"
  | "set_autonomy"
  | "set_status"
  | "set_schedule"
  | "set_assignment"
  | "add_feature"
  | "add_milestone"
  | "set_task_feature"
  | "set_feature_milestone";

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
  // Scheduling. Either / both may be set. `null` clears the field on the task
  // (so an operator can undo a scheduled start or drop an estimate).
  estimatedDurationMs?: number | null;
  plannedStartAt?: number | null;
  // Agent eligibility (set_assignment). `mode` picks WHO may take the task;
  // `agentIds` is the pool for `agents` mode (empty otherwise).
  mode?: TaskAssignment["mode"];
  agentIds?: string[];
  // Roadmap linkage. `featureId` links a task to a feature (set_task_feature)
  // or is the target of set_feature_milestone; `milestoneId` links a feature (or
  // feature-at-creation) to a milestone; `targetAt` is a milestone's date. `null`
  // clears the respective link.
  featureId?: string | null;
  milestoneId?: string | null;
  targetAt?: number | null;
}

/** The grounding the action validator resolves ids against (this project only).
 *  `agents` is the workspace fleet — set_assignment pins only to ids in it, so a
 *  misparse can't invent an agent (mirrors the server's fleet check). */
export interface ProjectActionContext {
  project: { id: string; name: string };
  tasks: { id: string; text: string; state: Task["state"] }[];
  agents?: { id: string; name: string }[];
  // The project's features + milestones, so the roadmap actions resolve their
  // ids against real records (a misparse can't invent one, mirroring `tasks`).
  features?: { id: string; name: string }[];
  milestones?: { id: string; name: string }[];
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
  const feature = (id: unknown) => ctx.features.find((f) => f.id === id);
  const milestone = (id: unknown) => ctx.milestones.find((m) => m.id === id);

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
    case "archive_task": {
      // Soft-hide (recoverable) — distinct from remove_task's hard delete. The
      // grounding filters archived tasks out, so once archived Steward can't
      // reference the task to unarchive it; unarchive stays a UI-only action.
      const t = task(o.taskId);
      return t ? { kind, taskId: t.id, summary: `Archive task “${clip(t.text)}” (hide, recoverable)` } : null;
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
    case "set_schedule": {
      // Either field may be present. Both explicitly null = clear both.
      // A number is required to be positive (durations) or a valid timestamp;
      // an unknown taskId is refused. At least ONE of the two fields must be
      // supplied — otherwise the action is a no-op we should reject.
      const t = task(o.taskId);
      if (!t) return null;
      const hasDur = "estimatedDurationMs" in o;
      const hasStart = "plannedStartAt" in o;
      if (!hasDur && !hasStart) return null;
      let dur: number | null | undefined;
      if (hasDur) {
        if (o.estimatedDurationMs === null) dur = null;
        else if (typeof o.estimatedDurationMs === "number" && o.estimatedDurationMs > 0)
          dur = Math.min(Math.round(o.estimatedDurationMs), 24 * 60 * 60 * 1000);
        else return null;
      }
      let start: number | null | undefined;
      if (hasStart) {
        if (o.plannedStartAt === null) start = null;
        else if (typeof o.plannedStartAt === "number" && Number.isFinite(o.plannedStartAt))
          start = Math.round(o.plannedStartAt);
        else return null;
      }
      const parts: string[] = [];
      if (dur === null) parts.push("clear estimate");
      else if (dur != null) parts.push(`~${Math.round(dur / 60000)}m`);
      if (start === null) parts.push("clear start");
      else if (start != null) parts.push(`start ${new Date(start).toISOString().slice(0, 16).replace("T", " ")}`);
      return {
        kind,
        taskId: t.id,
        ...(dur !== undefined ? { estimatedDurationMs: dur } : {}),
        ...(start !== undefined ? { plannedStartAt: start } : {}),
        summary: `Schedule “${clip(t.text)}” — ${parts.join(", ") || "no change"}`,
      };
    }
    case "set_assignment": {
      // Agent eligibility (WHO may take the task). `any`/`unassigned` carry no
      // agentIds; `agents` needs ≥1, and each MUST be a real fleet agent from the
      // grounding — so a misparse or injected instruction can't invent an agent.
      // (The server re-checks the fleet; validating here keeps the confirm chip
      // honest.) The leaving-backlog gate for `unassigned` is enforced server-side.
      const t = task(o.taskId);
      const mode = str(o.mode) as TaskAssignment["mode"];
      if (!t || (mode !== "any" && mode !== "agents" && mode !== "unassigned")) return null;
      if (mode === "agents") {
        const fleet = ctx.agents ?? [];
        const raw = Array.isArray(o.agentIds) ? o.agentIds.filter((x): x is string => typeof x === "string") : [];
        const ids = [...new Set(raw)].filter((id) => fleet.some((a) => a.id === id));
        if (ids.length === 0) return null; // no known agents named → refuse rather than guess
        const names = ids.map((id) => fleet.find((a) => a.id === id)!.name);
        return {
          kind,
          taskId: t.id,
          mode,
          agentIds: ids,
          summary: `Assign “${clip(t.text)}” → ${names.join(", ")}`,
        };
      }
      return {
        kind,
        taskId: t.id,
        mode,
        agentIds: [],
        summary: mode === "any"
          ? `Make “${clip(t.text)}” open to any agent`
          : `Clear agent eligibility on “${clip(t.text)}”`,
      };
    }
    case "add_feature": {
      // Create a feature (a task grouping). Optionally slot it under a milestone
      // — if `milestoneId` is given it must resolve to a real one.
      const name = str(o.name);
      if (!name) return null;
      const description = str(o.description);
      let milestoneId: string | undefined;
      if (o.milestoneId != null) {
        const m = (ctx.milestones ?? []).find((x) => x.id === o.milestoneId);
        if (!m) return null; // named a milestone we don't have → refuse, don't guess
        milestoneId = m.id;
      }
      const mName = milestoneId ? (ctx.milestones ?? []).find((x) => x.id === milestoneId)!.name : null;
      return {
        kind,
        name,
        ...(description ? { description } : {}),
        ...(milestoneId ? { milestoneId } : {}),
        summary: `Create feature: “${clip(name)}”${mName ? ` under milestone “${clip(mName)}”` : ""}`,
      };
    }
    case "add_milestone": {
      const name = str(o.name);
      if (!name) return null;
      const description = str(o.description);
      let targetAt: number | undefined;
      if (o.targetAt != null) {
        if (typeof o.targetAt !== "number" || !Number.isFinite(o.targetAt)) return null;
        targetAt = Math.round(o.targetAt);
      }
      return {
        kind,
        name,
        ...(description ? { description } : {}),
        ...(targetAt != null ? { targetAt } : {}),
        summary: `Create milestone: “${clip(name)}”${targetAt != null ? ` (target ${new Date(targetAt).toISOString().slice(0, 10)})` : ""}`,
      };
    }
    case "set_task_feature": {
      // Link a task to a feature (or `null` to unlink). Both ids validated.
      const t = task(o.taskId);
      if (!t) return null;
      if (o.featureId === null) return { kind, taskId: t.id, featureId: null, summary: `Unlink “${clip(t.text)}” from its feature` };
      const f = (ctx.features ?? []).find((x) => x.id === o.featureId);
      if (!f) return null;
      return { kind, taskId: t.id, featureId: f.id, summary: `Put “${clip(t.text)}” under feature “${clip(f.name)}”` };
    }
    case "set_feature_milestone": {
      // Roll a feature up into a milestone (or `null` to detach).
      const f = (ctx.features ?? []).find((x) => x.id === o.featureId);
      if (!f) return null;
      if (o.milestoneId === null) return { kind, featureId: f.id, milestoneId: null, summary: `Detach feature “${clip(f.name)}” from its milestone` };
      const m = (ctx.milestones ?? []).find((x) => x.id === o.milestoneId);
      if (!m) return null;
      return { kind, featureId: f.id, milestoneId: m.id, summary: `Roll feature “${clip(f.name)}” into milestone “${clip(m.name)}”` };
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
 * PURE: split an assistant answer into its human `reply` and a validated LIST of
 * confirm-first actions (0..N). The model appends a final-line
 * `{"proposeActions": [<action>, …]}` only when the operator asked to change
 * something; we strip it from the shown reply and validate each action against the
 * project context. The list is capped at {@link MAX_STEWARD_ACTIONS} — when the
 * model proposed MORE than that, the reply is annotated so the operator knows to
 * ask it to continue ("ran out of loops"). A legacy single `proposeAction` object
 * is still accepted (treated as a one-item list).
 */
export function splitProposedAction(
  text: string,
  ctx: ProjectActionContext,
): { reply: string; actions: AssistantAction[] } {
  const trimmed = (text ?? "").trim();
  const body = trimmed.replace(/\n?```\s*$/, "").trimEnd();
  const found = lastTopLevelObject(body);
  if (!found) return { reply: trimmed, actions: [] };
  try {
    const obj = JSON.parse(found.json) as Record<string, unknown>;
    // Prefer a `proposeActions` list; fall back to a single `proposeAction`.
    const rawList = Array.isArray(obj?.proposeActions)
      ? (obj.proposeActions as unknown[])
      : obj && typeof obj === "object" && "proposeAction" in obj
        ? [obj.proposeAction]
        : null;
    if (rawList) {
      const validated = rawList
        .map((a) => validateProjectAction(a, ctx))
        .filter((a): a is AssistantAction => a !== null);
      const actions = validated.slice(0, MAX_STEWARD_ACTIONS);
      // "Ran out of loops": the model asked for more changes than the budget.
      const overflow = rawList.length > MAX_STEWARD_ACTIONS;
      const stripped = body.slice(0, found.start).replace(/```[a-zA-Z]*\s*$/, "").trim();
      let reply = stripped
        ? stripped
        : actions.length === 1
          ? `Want me to ${actions[0]!.summary[0]!.toLowerCase()}${actions[0]!.summary.slice(1)}?`
          : actions.length > 1
            ? `Want me to make these ${actions.length} changes?`
            : "Hmm — I couldn't map that to something on this board.";
      if (overflow) {
        reply += `\n\n(That's the first ${MAX_STEWARD_ACTIONS} — I ran out of action slots for one go. Ask me to continue for the rest.)`;
      }
      return { reply, actions };
    }
  } catch {
    /* not a JSON tail — the whole answer is the reply */
  }
  return { reply: trimmed, actions: [] };
}

export function statusContext(
  project: Project,
  tasks: Task[],
  runs: TaskRun[],
  agents: Agent[] = [],
  features: Feature[] = [],
  milestones: Milestone[] = [],
): string {
  const agentName = (id: string): string => agents.find((a) => a.id === id)?.name ?? id;
  // Compact "who may take this" tag so Steward can report + change eligibility.
  const eligibility = (t: Task): string => {
    const m = t.assignment?.mode ?? "unassigned";
    if (m === "any") return " → any agent";
    if (m === "agents") return ` → ${t.assignment.agentIds.map(agentName).join(", ")}`;
    return "";
  };
  // Which feature (if any) a task is already under — so Steward knows what to
  // link/relink and doesn't re-propose an existing grouping.
  const featureTag = (t: Task): string => {
    const f = t.featureId ? features.find((x) => x.id === t.featureId) : undefined;
    return f ? ` ⟨feat ${f.id}⟩` : "";
  };
  const lines: string[] = [
    `PROJECT: ${project.name}`,
    `GOAL: ${project.goal?.trim() || "(none set yet)"}`,
    `REPO: ${project.repo ?? project.repoPath ?? "(not connected)"}`,
    `AUTONOMY: ${project.autonomy ? "on (agents may self-advance tasks)" : "off (human-driven)"}`,
  ];
  // Project-scoped agent guidance (rides every task prompt). Steward sees it
  // too so it can answer "what are the project rules?" and honor them itself.
  // A run of dashes bounds the block so Steward doesn't confuse it with task text.
  if (project.instructions?.trim()) {
    lines.push(
      "INSTRUCTIONS (rules for every agent on this project):",
      "---",
      project.instructions.trim(),
      "---",
    );
  }
  lines.push("BOARD (tasks by stage — `→` shows current agent eligibility):");
  for (const s of STAGES) {
    // Archived tasks are OFF the board — excluded from the stage grouping, listed
    // separately below so they stay readable without cluttering the live board.
    const items = tasks.filter((t) => t.state === s && !t.archived);
    lines.push(
      items.length
        ? `  ${s} (${items.length}): ${items.slice(0, 20).map((t) => `[${t.id}] ${t.text}${eligibility(t)}${featureTag(t)}`).join(" · ")}`
        : `  ${s}: 0`,
    );
  }
  // ROADMAP: features group tasks; milestones are dated buckets features roll up
  // into. Listed with ids so Steward can link (set_task_feature) + roll up
  // (set_feature_milestone) against real records.
  const liveFeatures = features.filter((f) => !f.archived);
  if (liveFeatures.length) {
    const mName = (id: string | null) => (id ? milestones.find((m) => m.id === id)?.name ?? id : null);
    lines.push(
      `FEATURES (task groupings): ${liveFeatures
        .slice(0, 30)
        .map((f) => `[${f.id}] ${f.name} (${f.status})${f.milestoneId ? ` → milestone “${mName(f.milestoneId)}”` : ""}`)
        .join(" · ")}`,
    );
  }
  const liveMilestones = milestones.filter((m) => !m.archived);
  if (liveMilestones.length) {
    lines.push(
      `MILESTONES (roadmap): ${liveMilestones
        .slice(0, 30)
        .map((m) => `[${m.id}] ${m.name} (${m.status}${m.targetAt != null ? `, target ${new Date(m.targetAt).toISOString().slice(0, 10)}` : ""})`)
        .join(" · ")}`,
    );
  }
  if (agents.length) {
    lines.push(
      `AGENTS (workspace fleet — set_assignment may only pin to these ids): ${agents
        .slice(0, 30)
        .map((a) => `[${a.id}] ${a.name} (${a.status})`)
        .join(" · ")}`,
    );
  }
  const archived = tasks.filter((t) => t.archived);
  if (archived.length) {
    lines.push(
      `ARCHIVED (off the board, still available): ${archived
        .slice(0, 20)
        .map((t) => `[${t.id}] ${t.text} (${t.state})`)
        .join(" · ")}`,
    );
  }
  // Grouping: features (task grouping) + milestones (roadmap). Only non-archived
  // rows so Steward doesn't reference deleted-in-spirit entries. Task-count per
  // feature comes from the tasks passed in; milestone dates render as ISO YYYY-MM-DD.
  const liveFeatures = features.filter((f) => !f.archived);
  if (liveFeatures.length) {
    const tasksByFeat = new Map<string, number>();
    for (const t of tasks) if (t.featureId) tasksByFeat.set(t.featureId, (tasksByFeat.get(t.featureId) ?? 0) + 1);
    lines.push("FEATURES:");
    for (const f of liveFeatures.slice(0, 30)) {
      const count = tasksByFeat.get(f.id) ?? 0;
      const ms = f.milestoneId ? milestones.find((m) => m.id === f.milestoneId) : undefined;
      lines.push(`  [${f.id}] ${f.name}${f.status !== "active" ? ` (${f.status})` : ""} · ${count} task${count === 1 ? "" : "s"}${ms ? ` · milestone [${ms.id}] ${ms.name}` : ""}`);
    }
  }
  const liveMilestones = milestones.filter((m) => !m.archived);
  if (liveMilestones.length) {
    lines.push("MILESTONES:");
    for (const m of liveMilestones.slice(0, 30)) {
      const when = m.targetAt != null ? ` · target ${new Date(m.targetAt).toISOString().slice(0, 10)}` : "";
      const status = m.status !== "planned" ? ` (${m.status})` : "";
      lines.push(`  [${m.id}] ${m.name}${status}${when}`);
    }
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

function buildPrompt(context: string, docs: string, settings: string, history: ChatTurn[], question: string): string {
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
    settings ? `\n=== WORKSPACE SETTINGS (live) ===\n${settings}` : "",
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
  store: Store,
  opts: { workspaceId: string; project: Project; question: string; history?: ChatTurn[] },
): Promise<StewardCall> {
  const { workspaceId, project, question } = opts;
  const history = opts.history ?? [];

  const [allTasks, allRuns, agents, allFeatures, allMilestones] = await Promise.all([
    store.listTasks(workspaceId),
    store.listRuns(workspaceId),
    store.listAgents(workspaceId),
    store.listFeatures(workspaceId),
    store.listMilestones(workspaceId),
  ]);
  const projectTasks = allTasks.filter((t) => t.projectId === project.id);
  const features = allFeatures.filter((f) => f.projectId === project.id && !f.archived);
  const milestones = allMilestones.filter((m) => m.projectId === project.id && !m.archived);
  const context = statusContext(
    project,
    projectTasks,
    allRuns.filter((r) => r.projectId === project.id),
    agents,
    features,
    milestones,
  );
  const actionCtx: ProjectActionContext = {
    project: { id: project.id, name: project.name },
    tasks: projectTasks.map((t) => ({ id: t.id, text: t.text, state: t.state })),
    // Fleet is workspace-wide (agents aren't project-scoped) — it's the pool
    // set_assignment validates agentIds against.
    agents: agents.map((a) => ({ id: a.id, name: a.name })),
    features: features.map((f) => ({ id: f.id, name: f.name })),
    milestones: milestones.map((m) => ({ id: m.id, name: m.name })),
  };
  const apiKey = (await secretService.resolve(workspaceId, "claude")) ?? undefined;
  // Live, secret-safe settings snapshot so settings questions ground in real
  // runtime config, not just the committed repo docs.
  const settings = await settingsContext();

  // Local checkout → read the working tree directly (Read/Grep/Glob).
  if (project.repoPath) {
    return { repo: true, prompt: buildPrompt(context, "", settings, history, question), cwd: project.repoPath, apiKey, actionCtx };
  }
  // GitHub-connected but not cloned → prefetch key docs + the top-level tree.
  let docs = project.repo ? await prefetchProjectDocs(workspaceId, project) : "";
  if (project.repo && !docs) {
    docs = "\n\n(Repo is connected but no README/ROADMAP was found and files aren't cloned locally — answer from project status.)";
  }
  return { repo: false, prompt: buildPrompt(context, docs, settings, history, question), apiKey, actionCtx };
}

/**
 * Ask Steward about one project. Runs the grounded call to completion — the repo
 * tool-loop for a local checkout, else the tool-less prefetch answer — then splits
 * out any confirm-first proposed action. The shared brain both surfaces call.
 */
export async function askSteward(
  store: Store,
  opts: { workspaceId: string; project: Project; question: string; history?: ChatTurn[] },
): Promise<{ reply: string; actions: AssistantAction[] }> {
  const c = await prepareStewardCall(store, opts);
  const answer = c.repo
    ? await oneShotRepoAssistant({ prompt: c.prompt, cwd: c.cwd!, apiKey: c.apiKey })
    : await oneShotText({ prompt: c.prompt, apiKey: c.apiKey });
  return splitProposedAction(answer, c.actionCtx);
}

// ─── Workspace-wide Steward (the global dock, no single project in focus) ────
// From the workspace dock Steward can still ACT on a project — it just has to
// know WHICH one. resolveFocusProject reads the conversation to pick that project
// (so "…in Takeoff?" then "can you do anything with it?" focuses Takeoff and acts);
// only when no single project can be resolved do we fall back to the answer-only
// cross-project snapshot below.

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * PURE: resolve which project the operator is referring to, so the workspace dock
 * can FOCUS + act on it even with no project page open. Scans the current
 * `question` first, then `history` newest→oldest; the first message that names a
 * project decides — a single unambiguous match wins, and a message naming 2+
 * distinct projects yields `null` (we never guess). A project matches on its exact
 * id token or its name as a whole-word, case-insensitive phrase (so "API" doesn't
 * match inside "capability"). Returns the project id, or `null` when none is
 * clearly referenced (the caller then answers workspace-wide).
 */
export function resolveFocusProject(
  projects: { id: string; name: string }[],
  question: string,
  history: ChatTurn[] = [],
): string | null {
  if (projects.length === 0) return null;
  const mentions = (text: string): Set<string> => {
    const hits = new Set<string>();
    const lower = (text ?? "").toLowerCase();
    if (!lower.trim()) return hits;
    for (const p of projects) {
      const id = p.id.toLowerCase();
      const name = p.name.trim().toLowerCase();
      if (id && new RegExp(`(^|\\W)${escapeRe(id)}(\\W|$)`).test(lower)) hits.add(p.id);
      else if (name && new RegExp(`(^|\\W)${escapeRe(name)}(\\W|$)`).test(lower)) hits.add(p.id);
    }
    return hits;
  };
  const texts = [question, ...[...history].reverse().map((t) => t.content)];
  for (const text of texts) {
    const hits = mentions(text);
    if (hits.size === 1) return [...hits][0]!;
    if (hits.size > 1) return null; // named several — ambiguous, don't guess
  }
  return null;
}

const WORKSPACE_SYSTEM =
  "You are Steward, the operator's assistant for a Skynet workspace. Answer conversationally and concisely about the CURRENT STATUS across the whole workspace — projects, their task boards, active runs, and open approvals — grounded ONLY in the WORKSPACE STATUS below. " +
  "For questions about how the workspace is configured — approvals, autonomy, the runner sandbox, integration, Telegram, MCP, backends, vendor CLIs — ground the answer in the WORKSPACE SETTINGS section (the LIVE runtime config), not from memory. Secret values there are shown only as set/not-set — never claim to know a secret's value. " +
  "If a fact isn't shown, say so plainly; never invent state or settings. You CAN change things on a specific project (add/move a task, edit settings) — just tell the operator to name the project they mean and you'll take care of it right here (you always confirm before anything runs). Do NOT emit any JSON.";

function workspaceStatusContext(projects: Project[], tasks: Task[], runs: TaskRun[], gates: HitlItem[]): string {
  const openGates = gates.filter((g) => !g.resolvedAt).length;
  const activeRuns = runs.filter((r) => r.status !== "done" && !r.archived);
  const lines: string[] = [
    `WORKSPACE: ${projects.length} project(s), ${activeRuns.length} active run(s), ${openGates} open approval(s).`,
    "PROJECTS:",
  ];
  for (const p of projects.slice(0, 30)) {
    const pt = tasks.filter((t) => t.projectId === p.id && !t.archived);
    const byStage = STAGES.map((s) => `${s} ${pt.filter((t) => t.state === s).length}`).join(" · ");
    const pr = activeRuns.filter((r) => r.projectId === p.id).length;
    lines.push(`  [${p.id}] ${p.name} — status ${p.status}, autonomy ${p.autonomy ? "on" : "off"}, ${pr} active run(s) · ${byStage}`);
  }
  if (activeRuns.length) {
    lines.push("ACTIVE RUNS:");
    for (const r of activeRuns.slice(0, 12)) {
      lines.push(`  ${r.name} — ${r.status} · ${Math.round(r.progress * 100)}%`);
    }
  }
  return lines.join("\n");
}

/** Ask Steward workspace-wide (the global dock with no project focused). Grounds
 *  on a cross-project status snapshot; answer-only (no proposed actions). */
/** Build the workspace-wide prompt (+ resolve the key). Shared by the
 *  accumulating and streaming answer paths so they ground identically. */
async function buildWorkspaceCall(
  store: Store,
  opts: { workspaceId: string; question: string; history?: ChatTurn[] },
): Promise<{ prompt: string; apiKey?: string }> {
  const { workspaceId, question } = opts;
  const [projects, tasks, runs, gates] = await Promise.all([
    store.listProjects(workspaceId),
    store.listTasks(workspaceId),
    store.listRuns(workspaceId),
    store.listQueue(workspaceId),
  ]);
  const context = workspaceStatusContext(projects, tasks, runs, gates);
  const settings = await settingsContext();
  const convo = (opts.history ?? [])
    .slice(-MAX_HISTORY)
    .map((t) => `${t.role === "user" ? "Operator" : "Assistant"}: ${t.content}`)
    .join("\n");
  const prompt = [
    WORKSPACE_SYSTEM,
    "",
    "=== WORKSPACE STATUS ===",
    context,
    settings ? `\n=== WORKSPACE SETTINGS (live) ===\n${settings}` : "",
    convo ? `\n=== CONVERSATION SO FAR ===\n${convo}` : "",
    "",
    `Operator asks: ${question}`,
  ]
    .filter((s) => s !== "")
    .join("\n");
  const apiKey = (await secretService.resolve(workspaceId, "claude")) ?? undefined;
  return { prompt, apiKey };
}

export async function askStewardWorkspace(
  store: Store,
  opts: { workspaceId: string; question: string; history?: ChatTurn[] },
): Promise<{ reply: string; actions: AssistantAction[] }> {
  const { prompt, apiKey } = await buildWorkspaceCall(store, opts);
  const reply = await oneShotText({ prompt, apiKey });
  return { reply, actions: [] };
}

/** Streaming form of {@link askStewardWorkspace} — yields text deltas, then
 *  RETURNS the full reply. Workspace mode never proposes an action. */
export async function* askStewardWorkspaceStream(
  store: Store,
  opts: { workspaceId: string; question: string; history?: ChatTurn[] },
): AsyncGenerator<string, { reply: string; actions: AssistantAction[] }> {
  const { prompt, apiKey } = await buildWorkspaceCall(store, opts);
  let full = "";
  for await (const delta of oneShotTextStream({ prompt, apiKey })) {
    full += delta;
    yield delta;
  }
  return { reply: full, actions: [] };
}

/** Streaming form of {@link askSteward} — yields the answer as text deltas so the
 *  dock renders it live, then RETURNS the clean reply + any confirm-first proposed
 *  action. The action is parsed from the FULL accumulated text, so the trailing
 *  action JSON is never the shown reply (the caller reconciles to `reply`). */
export async function* askStewardStream(
  store: Store,
  opts: { workspaceId: string; project: Project; question: string; history?: ChatTurn[] },
): AsyncGenerator<string, { reply: string; actions: AssistantAction[] }> {
  const c = await prepareStewardCall(store, opts);
  let full = "";
  const gen = c.repo
    ? oneShotRepoAssistantStream({ prompt: c.prompt, cwd: c.cwd!, apiKey: c.apiKey })
    : oneShotTextStream({ prompt: c.prompt, apiKey: c.apiKey });
  for await (const delta of gen) {
    full += delta;
    yield delta;
  }
  return splitProposedAction(full, c.actionCtx);
}
