// ─── Project context condensation ───────────────────────────────────────────
// Raw ProjectContextEntry rows (pasted notes, extracted upload text — see
// steward/extract.ts) are the source of truth, kept verbatim. This module
// turns the accumulated set into ONE short primer (Project.contextSummary)
// that's actually cheap enough to ride every agent prompt — the "S2" primer
// slot agent-context.ts already reserved (buildAgentContext's `primer` param).
//
// One LLM call, PURE apart from the injected `ask` (mirrors crystallize.ts's
// draftBriefFromConversation — testable with a stub, no real model call
// needed). Unlike crystallize, the output is plain text, not a validated JSON
// shape: a primer is prose by nature, and there's no structured field set to
// enforce here — a short, unreadable/empty reply just means "no summary yet"
// rather than a parse failure to retry.

import type { ProjectContextEntry } from "@skynet/shared";

/** How much of the accumulated raw entries the condensation prompt reads —
 *  generous (a real backlog of notes should mostly fit), but bounded so a
 *  large history of uploads can't produce an unbounded prompt. Oldest entries
 *  drop first when over budget (the newest context is the most likely to
 *  still be relevant to "what we're aiming at"). */
export const MAX_CONTEXT_INPUT_CHARS = 60_000;

/** The condensed primer's own cap — sized to agent-context.ts's
 *  PRIMER_CHAR_CAP (2,000) with room for the model to run slightly over
 *  before this defensive trim. */
export const MAX_SUMMARY_CHARS = 2_400;

const SYSTEM =
  "You are condensing raw project context — meeting notes, emails, pasted or uploaded documents — into a SHORT primer " +
  "that will ride every task an autonomous coding agent works on for this project. The agent has never seen the raw " +
  "notes and has limited space: write a dense, factual digest of what the project is actually trying to achieve — " +
  "goals, key decisions, constraints, stakeholders/context that shapes scope, and anything explicitly agreed or ruled " +
  "out. Skip pleasantries, scheduling logistics, and anything not relevant to what gets built. Never invent — only " +
  "include what the notes actually say. Plain prose or tight bullet points, no headers, no meta-commentary about " +
  "the notes themselves (e.g. don't say \"the notes discuss...\" — just state the facts). Keep it under ~350 words.";

function formatEntries(entries: ProjectContextEntry[]): string {
  // Newest first in the prompt (most likely still relevant), but budget from
  // the front so the model reads a truncated OLDEST entry last, never a
  // truncated newest one.
  const ordered = [...entries].sort((a, b) => b.createdAt - a.createdAt);
  let budget = MAX_CONTEXT_INPUT_CHARS;
  const included: string[] = [];
  for (const e of ordered) {
    const date = new Date(e.createdAt).toISOString().slice(0, 10);
    const block = `--- ${e.label} (${date}) ---\n${e.content.trim()}`;
    if (block.length > budget) {
      if (included.length === 0) included.push(block.slice(0, budget));
      break;
    }
    included.push(block);
    budget -= block.length;
  }
  return included.join("\n\n");
}

export function buildCondensePrompt(projectName: string, entries: ProjectContextEntry[]): string {
  return [SYSTEM, "", `Project: ${projectName}`, "", "=== RAW CONTEXT (newest first) ===", formatEntries(entries)].join("\n");
}

/** Condense `entries` into a primer string, or null when there's nothing to
 *  condense (empty list, or a degenerate/empty model reply — never overwrite
 *  an existing summary with blank). `ask` is the model call itself, injected
 *  by the caller (see Operations.refreshProjectContext) so this stays testable
 *  with a stub — no real LLM call needed.
 *
 *  Deliberately does NOT try to detect an unusable reply (e.g. an auth/network
 *  failure that degraded to error text instead of throwing — see runner-sdk's
 *  streamQueryText) by sniffing its content: classifying free text by keyword/
 *  shape is exactly the anti-pattern that bit the auto-review APPROVE/FLAG
 *  parser. The one check that IS safe (a structural fact, not text
 *  classification) — whether a usable key resolves at all — is the caller's
 *  job, made BEFORE calling this, so a doomed call is never attempted in the
 *  first place (see Operations.refreshProjectContext). */
export async function condenseProjectContext(
  ask: (prompt: string) => Promise<string>,
  projectName: string,
  entries: ProjectContextEntry[],
): Promise<string | null> {
  if (entries.length === 0) return null;
  const reply = (await ask(buildCondensePrompt(projectName, entries))).trim();
  if (!reply) return null;
  return reply.length > MAX_SUMMARY_CHARS ? `${reply.slice(0, MAX_SUMMARY_CHARS)}\n… (truncated)` : reply;
}
