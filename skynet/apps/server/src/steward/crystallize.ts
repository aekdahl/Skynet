// ─── Crystallize: Steward conversation → draft SolutionBrief (S5) ───────────
// "Make it durable" — one LLM call turns a solutioning conversation into a
// structured planning doc. Same discipline as the diff walkthrough / merge
// brief / auto-review verdict: the model emits a zod-validated JSON object we
// read as FIELDS, never prose we classify with regex/keywords. Unlike those
// (which degrade gracefully to "no brief" on an unreadable reply — they're
// advisory, the review/merge proceeds regardless), crystallize's entire job
// IS to produce a brief, so an unreadable reply gets exactly ONE retry with
// the validation error appended, then a real error — never a half-parsed
// brief silently created from a partial/malformed model reply.
import { z } from "zod";
import { extractJsonObject } from "../review-verdict.js";
import type { ChatTurn } from "./assistant.js";

const MAX_ARRAY_ENTRIES = 8;

export const DraftBriefOption = z.object({
  name: z.string().min(1).max(200),
  verdict: z.string().min(1).max(200),
  why: z.string().min(1).max(500),
});

/** What the model must emit — a subset of SolutionBrief's fields; id/workspace/
 *  project/status/timestamps/approval are all system-assigned, never asked of
 *  the model (createBrief fills them, same boundary as every other entity). */
export const DraftBrief = z.object({
  title: z.string().min(1).max(200),
  problem: z.string().min(1).max(4000),
  approach: z.string().min(1).max(4000),
  optionsConsidered: z.array(DraftBriefOption).max(MAX_ARRAY_ENTRIES).default([]),
  risks: z.array(z.string().min(1).max(300)).max(MAX_ARRAY_ENTRIES).default([]),
  acceptanceCriteria: z.array(z.string().min(1).max(300)).max(MAX_ARRAY_ENTRIES).default([]),
  openQuestions: z.array(z.string().min(1).max(300)).max(MAX_ARRAY_ENTRIES).default([]),
});
export type DraftBrief = z.infer<typeof DraftBrief>;

export const CRYSTALLIZE_SYSTEM =
  "You are Steward, drafting a SOLUTION BRIEF from a conversation between an operator and an assistant about a " +
  "piece of work. Read the conversation and distill it into a structured planning doc: the problem being solved, " +
  "the chosen approach, options that were weighed (including ones rejected or deferred, with why), risks, " +
  "acceptance criteria, and open questions still unresolved. Ground every field in what was ACTUALLY discussed — " +
  "never invent a risk, option, or criterion the conversation didn't raise. If the conversation didn't cover a " +
  "field (e.g. no alternatives were compared), leave that array empty rather than inventing content.";

export const CRYSTALLIZE_INSTRUCTION =
  'Respond with ONLY a JSON object and nothing else: {"title":"<short, specific — like a commit subject>",' +
  '"problem":"<1-3 sentences: what is wrong or needed, and why now>","approach":"<1-3 sentences: the chosen plan>",' +
  '"optionsConsidered":[{"name":"<option>","verdict":"<chosen|rejected — brief reason|deferred>","why":"<one short line>"}],' +
  '"risks":["<one short line per concrete risk actually discussed>"],' +
  '"acceptanceCriteria":["<one short line per way to know it is done, if discussed>"],' +
  '"openQuestions":["<one short line per thing still unresolved, if any>"]}. ' +
  `Every array may be empty if the conversation didn't cover it. At most ${MAX_ARRAY_ENTRIES} entries per array.`;

/** History is capped defensively — a long-running solutioning thread shouldn't
 *  produce an unbounded prompt. Generous relative to a quick Q&A (Steward's own
 *  chat prompt keeps only the last 8 turns) because the whole point here is to
 *  capture a real planning discussion, not a one-off question. */
export const CRYSTALLIZE_MAX_HISTORY = 60;

function formatConversation(history: ChatTurn[]): string {
  return history
    .slice(-CRYSTALLIZE_MAX_HISTORY)
    .map((t) => `${t.role === "user" ? "Operator" : "Assistant"}: ${t.content}`)
    .join("\n");
}

export function buildCrystallizePrompt(projectName: string, history: ChatTurn[], retryError?: string): string {
  return [
    CRYSTALLIZE_SYSTEM,
    "",
    `Project: ${projectName}`,
    "",
    "=== CONVERSATION ===",
    formatConversation(history),
    "",
    CRYSTALLIZE_INSTRUCTION,
    retryError
      ? `\nYour previous reply could not be read as valid JSON matching that exact shape: ${retryError}. Try again, following the shape EXACTLY — respond with ONLY the JSON object.`
      : "",
  ]
    .filter((s) => s !== "")
    .join("\n");
}

type ParseResult = { ok: true; data: DraftBrief } | { ok: false; error: string };

/** Read the model's structured draft. Unlike parseMergeBrief/parseReviewVerdict
 *  (which degrade a bad reply to null/flag because their callers proceed
 *  regardless), this reports WHY parsing failed — draftBriefFromConversation
 *  feeds that reason back into a retry prompt. */
export function parseDraftBrief(reply: string): ParseResult {
  const obj = extractJsonObject(reply);
  if (!obj) return { ok: false, error: "the reply was not a readable JSON object" };
  const parsed = DraftBrief.safeParse(obj);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    return { ok: false, error: detail };
  }
  return { ok: true, data: parsed.data };
}

/** A validated model reply couldn't be produced even after a retry. Mapped to
 *  a 4xx at the HTTP boundary (api.ts) — never results in a brief. */
export class CrystallizeParseError extends Error {
  constructor(detail: string) {
    super(`Could not draft a solution brief from this conversation — the model's reply couldn't be read even after a retry: ${detail}`);
    this.name = "CrystallizeParseError";
  }
}

/**
 * One LLM call, validated; on a bad reply, exactly ONE retry with the
 * validation error appended to the prompt so the model can self-correct; a
 * second bad reply throws CrystallizeParseError. `ask` is the model call
 * itself (injected by the caller — see Operations.crystallizeBrief — so this
 * function, and therefore the whole retry contract, is testable with a stub
 * that returns canned replies, no real LLM call needed).
 */
export async function draftBriefFromConversation(
  ask: (prompt: string) => Promise<string>,
  projectName: string,
  history: ChatTurn[],
): Promise<DraftBrief> {
  const first = parseDraftBrief(await ask(buildCrystallizePrompt(projectName, history)));
  if (first.ok) return first.data;
  const second = parseDraftBrief(await ask(buildCrystallizePrompt(projectName, history, first.error)));
  if (second.ok) return second.data;
  throw new CrystallizeParseError(second.error);
}

/** A capped, joined excerpt of the source conversation — for SolutionBrief.
 *  sourceConversation (createBrief truncates further to its own 500-char cap;
 *  this just keeps the join itself bounded before that). */
export function summarizeConversation(history: ChatTurn[]): string {
  return formatConversation(history);
}
