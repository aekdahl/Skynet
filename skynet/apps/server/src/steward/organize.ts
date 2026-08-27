// ─── Organize board: Steward reorders a column by inferred priority ─────────
// Advisory, best-effort — same family as the diff walkthrough / merge brief /
// auto-review verdict (never the sole source of truth for a mutation the
// operator can trivially redo by hand). One LLM call reads each task's title
// + description in a column and returns a priority order; an unreadable reply
// gets ONE retry with the parse error appended (crystallize.ts's pattern), and
// a still-bad second reply degrades to "leave this column's order unchanged"
// rather than throwing — sorting a kanban column is never worth a hard error.

import { extractJsonObject } from "../review-verdict.js";

export interface OrganizeTaskInput {
  id: string;
  text: string;
  description: string | null;
}

export const ORGANIZE_SYSTEM =
  "You are Steward, prioritizing a column of tasks on a kanban board for a software project. Read each task's " +
  "title and description and order them from HIGHEST to LOWEST priority — what should be tackled first. Weigh " +
  "what's actually written: blockers/foundational work before what depends on it, bugs and regressions before " +
  "nice-to-haves, small well-scoped items before vague or sprawling ones (a vague item benefits from being sized " +
  "up before it blocks something else waiting on it). You have no context beyond each task's own title and " +
  "description — infer priority from that alone, never invent facts about the project.";

function formatTasks(tasks: OrganizeTaskInput[]): string {
  return tasks.map((t) => `- id: ${t.id}\n  title: ${t.text}${t.description ? `\n  description: ${t.description}` : ""}`).join("\n");
}

export function buildOrganizePrompt(projectName: string, projectGoal: string, tasks: OrganizeTaskInput[], retryError?: string): string {
  return [
    ORGANIZE_SYSTEM,
    "",
    `Project: ${projectName}`,
    projectGoal ? `Goal: ${projectGoal}` : "",
    "",
    "=== TASKS (unordered) ===",
    formatTasks(tasks),
    "",
    `Respond with ONLY a JSON object and nothing else: {"order":["<task id>", ...]} — every id from the list ` +
      "above, exactly once, ordered highest to lowest priority.",
    retryError
      ? `\nYour previous reply could not be read as valid JSON matching that exact shape: ${retryError}. Try again, following the shape EXACTLY — respond with ONLY the JSON object.`
      : "",
  ]
    .filter((s) => s !== "")
    .join("\n");
}

type ParseResult = { ok: true; order: string[] } | { ok: false; error: string };

/** Reads `{"order": [...]}`, tolerant of a model dropping/duplicating/inventing
 *  an id — never loses a task over a sloppy reply: known ids are deduped
 *  in the model's order, then any task the model omitted is appended at the
 *  end in its original relative order (never silently dropped from the
 *  column), and any id that isn't a real task in this batch is discarded. */
function parseOrder(reply: string, validIds: string[]): ParseResult {
  const obj = extractJsonObject(reply);
  if (!obj || !Array.isArray((obj as Record<string, unknown>).order)) {
    return { ok: false, error: "expected a JSON object with an \"order\" array" };
  }
  const raw = (obj as { order: unknown[] }).order.filter((v): v is string => typeof v === "string");
  const valid = new Set(validIds);
  const seen = new Set<string>();
  const order: string[] = [];
  for (const id of raw) {
    if (valid.has(id) && !seen.has(id)) {
      seen.add(id);
      order.push(id);
    }
  }
  for (const id of validIds) if (!seen.has(id)) order.push(id);
  return { ok: true, order };
}

/** Priority-order one column's tasks via one LLM call (one retry on an
 *  unreadable reply). Falls back to the tasks' ORIGINAL order — never
 *  throws — on a persistently bad reply or an ask failure; a caller can
 *  always tell "nothing changed" apart from "a real new order" by comparing
 *  the returned array to `tasks.map(t => t.id)`. */
export async function prioritizeColumn(
  ask: (prompt: string) => Promise<string>,
  projectName: string,
  projectGoal: string,
  tasks: OrganizeTaskInput[],
): Promise<string[]> {
  const original = tasks.map((t) => t.id);
  if (tasks.length < 2) return original; // nothing to order
  try {
    const first = await ask(buildOrganizePrompt(projectName, projectGoal, tasks));
    const firstParsed = parseOrder(first, original);
    if (firstParsed.ok) return firstParsed.order;
    const second = await ask(buildOrganizePrompt(projectName, projectGoal, tasks, firstParsed.error));
    const secondParsed = parseOrder(second, original);
    return secondParsed.ok ? secondParsed.order : original;
  } catch {
    return original; // ask() itself failed (no key, network, etc.) — leave it alone
  }
}
