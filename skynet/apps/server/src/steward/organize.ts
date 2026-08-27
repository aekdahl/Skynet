// ─── Organize board: Steward reorders a column by inferred priority, and ────
// ─── suggests any-agent eligibility for unassigned backlog tasks ───────────
// Advisory, best-effort — same family as the diff walkthrough / merge brief /
// auto-review verdict (never the sole source of truth for a mutation the
// operator can trivially redo by hand). One LLM call reads each task's title
// + description in a column and returns a priority order; an unreadable reply
// gets ONE retry with the parse error appended (crystallize.ts's pattern), and
// a still-bad second reply degrades to "leave this column's order unchanged"
// rather than throwing — sorting a kanban column is never worth a hard error.
// A second, independent consult (suggestAnyAgentEligible, below) applies the
// same tolerant-parse/one-retry/degrade-quietly discipline to a different
// question: which currently-unassigned backlog tasks look ready for any
// available agent, so Operations.organizeBoard can clear that one blocker
// for them instead of leaving every unassigned task stuck until a human
// routes it by hand.

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

// ─── Any-agent eligibility: unstick unassigned backlog tasks ────────────────
// An `unassigned` backlog task never leaves backlog on its own — the
// eligibility choice (who may work it) is the operator's, and both the
// manual "leave backlog" move and the autonomy triage sweep refuse it until
// that's set. A task genuinely can't tell Steward's board tidy apart from
// any other visit, so it's a natural moment to also clear that ONE blocker
// for tasks that don't actually need a human's judgment call: self-contained,
// well-scoped items where which agent picks it up wouldn't matter.

export const ANY_AGENT_SYSTEM =
  "You are Steward, deciding which UNASSIGNED backlog tasks on a kanban board are ready for ANY available agent " +
  "to pick up autonomously, instead of waiting for an operator to route them by hand. A task belongs on the list " +
  "when it's self-contained and well enough scoped that WHICH agent picks it up wouldn't matter — no task-specific " +
  "expertise, prior context, credentials, or judgment call implied by its title or description. Leave a task OFF " +
  "the list when it's too vague or large to safely hand to whichever agent happens to be free, hints at needing a " +
  "specific area of the codebase or a deliberate routing decision, or you're simply unsure — an operator can " +
  "always assign it by hand later; wrongly declaring a task fine for anyone is the costlier mistake, so default " +
  "to leaving it off when in doubt.";

export function buildAnyAgentPrompt(projectName: string, projectGoal: string, tasks: OrganizeTaskInput[], retryError?: string): string {
  return [
    ANY_AGENT_SYSTEM,
    "",
    `Project: ${projectName}`,
    projectGoal ? `Goal: ${projectGoal}` : "",
    "",
    "=== UNASSIGNED BACKLOG TASKS ===",
    formatTasks(tasks),
    "",
    `Respond with ONLY a JSON object and nothing else: {"anyAgent":["<task id>", ...]} — the ids (from the list ` +
      "above) that are ready for any available agent; omit an id to leave it for an operator to assign by hand. " +
      `An empty array ({"anyAgent":[]}) is a valid answer when none qualify.`,
    retryError
      ? `\nYour previous reply could not be read as valid JSON matching that exact shape: ${retryError}. Try again, following the shape EXACTLY — respond with ONLY the JSON object.`
      : "",
  ]
    .filter((s) => s !== "")
    .join("\n");
}

type AnyAgentParseResult = { ok: true; ids: string[] } | { ok: false; error: string };

/** Reads `{"anyAgent": [...]}`, tolerant like parseOrder: an unknown id is
 *  dropped, a duplicate deduped. A reply that parses as JSON but carries no
 *  `anyAgent` key at all (e.g. one shaped for a DIFFERENT consult) reads as
 *  "nothing suggested" — valid and empty, not a parse failure — so a
 *  genuinely quiet or off-shape answer never burns a wasted retry; only
 *  actually-unparseable text does. */
function parseAnyAgent(reply: string, validIds: string[]): AnyAgentParseResult {
  const obj = extractJsonObject(reply);
  if (!obj) return { ok: false, error: "expected a JSON object" };
  const raw = (obj as Record<string, unknown>).anyAgent;
  if (raw === undefined) return { ok: true, ids: [] };
  if (!Array.isArray(raw)) return { ok: false, error: "expected \"anyAgent\" to be an array" };
  const valid = new Set(validIds);
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const v of raw) {
    if (typeof v === "string" && valid.has(v) && !seen.has(v)) {
      seen.add(v);
      ids.push(v);
    }
  }
  return { ok: true, ids };
}

/** Ask which currently-unassigned backlog tasks are ready for any available
 *  agent — one LLM call (one retry on an unreadable reply), degrading to
 *  "none" (never throws, never guesses) on a persistently bad reply or an
 *  ask failure. Purely advisory: the caller decides what to actually do with
 *  the suggested ids (see Operations.organizeBoard). */
export async function suggestAnyAgentEligible(
  ask: (prompt: string) => Promise<string>,
  projectName: string,
  projectGoal: string,
  tasks: OrganizeTaskInput[],
): Promise<string[]> {
  if (tasks.length === 0) return [];
  const validIds = tasks.map((t) => t.id);
  try {
    const first = await ask(buildAnyAgentPrompt(projectName, projectGoal, tasks));
    const firstParsed = parseAnyAgent(first, validIds);
    if (firstParsed.ok) return firstParsed.ids;
    const second = await ask(buildAnyAgentPrompt(projectName, projectGoal, tasks, firstParsed.error));
    const secondParsed = parseAnyAgent(second, validIds);
    return secondParsed.ok ? secondParsed.ids : [];
  } catch {
    return []; // ask() itself failed (no key, network, etc.) — suggest nothing
  }
}
