// ─── Backlog replenishment: a dry board proposes its own next steps ─────────
// The project driver (drive.ts) can tell when a project has run out of
// startable work. For a project bound to a source that's answerable by
// re-pulling issues. For everything else the board just… stops, and the project
// waits for a human to notice and think of the next thing.
//
// This is that thinking, grounded in what the project already knows: its goal,
// its roadmap doc, the context an operator pasted in, and — importantly — what
// has already been DONE, so it proposes next steps rather than re-proposing
// finished ones.
//
// Same discipline as decompose.ts / crystallize.ts: the model emits a
// zod-validated JSON object read as FIELDS, never prose classified after the
// fact. An unreadable reply gets ONE retry with the parse error appended, then
// yields nothing — replenishment is advisory, so "no suggestions this time" is
// a perfectly good outcome and far better than a half-parsed guess.
//
// ── Why this can't run away ────────────────────────────────────────────────
// Proposed tasks land in `backlog` with `autoPick: false`. Auto-pick only ever
// starts tasks flagged `autoPick`, so nothing here can start itself: a human
// (or an explicit queue_tasks) has to pick it up. Without that property this
// would be a perpetual work generator — invent tasks, run them, empty the
// board, invent more — which is exactly the failure mode a cost-conscious
// operator would never forgive.

import { z } from "zod";
import { extractJsonObject } from "../review-verdict.js";

const MAX_PROPOSED = 5;

const Proposed = z.object({
  tasks: z
    .array(
      z.object({
        text: z.string().min(1).max(200),
        description: z.string().max(2000).optional(),
        /** Why this is the next thing — shown to the operator, not stored. */
        rationale: z.string().max(400).optional(),
      }),
    )
    .max(MAX_PROPOSED)
    .default([]),
});

export interface ProposedTask {
  text: string;
  description?: string;
  rationale?: string;
}

export interface ReplenishGrounding {
  projectName: string;
  goal: string;
  /** The project's roadmap doc, already clipped by the caller. */
  roadmap?: string | null;
  /** Condensed operator-supplied context (meeting notes, emails, docs). */
  contextSummary?: string | null;
  doneTitles: string[];
  openTitles: string[];
}

const clipList = (xs: string[], n: number) =>
  xs.slice(0, n).map((t) => `- ${t}`).join("\n") + (xs.length > n ? `\n- …and ${xs.length - n} more` : "");

/** PURE: the prompt. Separated so a test can assert what the model is told —
 *  particularly that it's shown the finished work, which is the difference
 *  between "next steps" and "the same list again". */
export function buildReplenishPrompt(g: ReplenishGrounding): string {
  return [
    `You are proposing the NEXT concrete steps for a software project that has run out of startable work.`,
    ``,
    `PROJECT: ${g.projectName}`,
    `GOAL: ${g.goal || "(none stated)"}`,
    g.roadmap ? `\nROADMAP DOC:\n${g.roadmap}` : "",
    g.contextSummary ? `\nCONTEXT the operator supplied:\n${g.contextSummary}` : "",
    g.doneTitles.length ? `\nALREADY DONE (do NOT propose these again, and do not propose trivial follow-ups to them):\n${clipList(g.doneTitles, 40)}` : "",
    g.openTitles.length ? `\nALREADY ON THE BOARD (do NOT duplicate):\n${clipList(g.openTitles, 40)}` : "",
    ``,
    `Propose at most ${MAX_PROPOSED} tasks that genuinely move this project toward its goal. Rules:`,
    `- Ground every task in the goal, roadmap or context above. If none of them say what comes next, propose NOTHING — an empty list is the correct answer when the project's direction isn't written down anywhere. Never invent a plausible-sounding roadmap of your own.`,
    `- Each task must be a concrete piece of work someone could start, not a theme ("Improve performance") or a process step ("Plan the next sprint").`,
    `- Prefer the smallest set that unblocks real progress. Three good tasks beat five padded ones.`,
    `- Do not propose testing, documentation or cleanup as separate tasks unless the project's own materials call for them.`,
    ``,
    `Reply with ONLY this JSON — no other text, no code fence:`,
    `{"tasks":[{"text":"<title>","description":"<what and why, 1-3 sentences>","rationale":"<why this is next>"}]}`,
    `An empty list is valid: {"tasks":[]}`,
  ]
    .filter(Boolean)
    .join("\n");
}

/** PURE: read the model's reply. Null = unreadable (caller retries once). */
export function parseProposedTasks(reply: string): ProposedTask[] | null {
  const obj = extractJsonObject(reply);
  if (!obj) return null;
  const parsed = Proposed.safeParse(obj);
  if (!parsed.success) return null;
  return parsed.data.tasks.map((t) => ({
    text: t.text.trim(),
    ...(t.description?.trim() ? { description: t.description.trim() } : {}),
    ...(t.rationale?.trim() ? { rationale: t.rationale.trim() } : {}),
  }));
}
