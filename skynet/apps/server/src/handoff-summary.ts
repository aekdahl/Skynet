// ─── Reassignment handoff summary (structured output) ───────────────────────
// Kanban redesign, stage 1: when a run is REASSIGNED to a different agent
// (the prior one is stuck, crashed, or the operator just wants a change), the
// new agent used to get only a static "your work so far is already in the
// working directory" line — no idea WHAT was tried or WHY it's being handed
// off. This drafts a real summary of the prior agent's log, grounded on the
// log itself — same stateless one-shot consult discipline as
// diff-walkthrough.ts / merge-brief.ts: a structured field, never prose
// classification, and a failure/empty-log/no-consult-support all just mean no
// summary — the caller (Orchestrator.relaunchEscalated) already has a safe
// static fallback, so a failure here never blocks the reassign.

import { extractJsonObject } from "./review-verdict.js";

export const HANDOFF_SUMMARY_SYSTEM =
  "You are an AI coding agent whose work on a task is being handed off to a DIFFERENT agent — because " +
  "you got stuck, crashed, or the operator wants a change. Write that agent a short, concrete briefing " +
  "grounded ONLY in the log below: what you actually tried, what state you left things in, and — if it's " +
  "visible in the log — why the handoff is happening. Never invent something the log doesn't show.";

export const HANDOFF_SUMMARY_INSTRUCTION =
  'Respond with ONLY a JSON object and nothing else: {"summary":"<2-5 plain-English sentences: what was ' +
  'tried, current state, and why you\'re being handed off if visible>"}. Be concrete (name the approach, ' +
  "not just \"made progress\") — the next agent should be able to pick up without re-reading your whole log.";

/**
 * Read the model's structured summary. Returns null for an unreadable reply
 * or an empty/missing summary field — the caller falls back to a static
 * line, same safe-default discipline as parseDiffWalkthrough.
 */
export function parseHandoffSummary(reply: string): string | null {
  const obj = extractJsonObject(reply);
  const summary = obj && typeof obj.summary === "string" ? obj.summary.trim().slice(0, 1000) : "";
  return summary || null;
}
