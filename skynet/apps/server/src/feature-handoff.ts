// ─── Agent-to-agent handoff on feature completion (v2) ──────────────────────
// When a Feature/Milestone ships, up to three configured role-agents each draft
// a small, scoped artifact from the same shipped-work context: change-manager
// writes a CHANGELOG.md entry, docs-writer updates README.md, release-comms
// drafts an announcement. Each is a single stateless `consult` call (no
// worktree, no tool access) — this file is the pure prompt-building + reply
// handling for all three, kept out of orchestrator.ts the same way
// review-verdict.ts/bakeoff-verdict.ts keep their own consult contracts
// separate from the dispatch code that calls them.
//
// Deliberately NOT a structured-JSON-verdict contract like review-verdict.ts's
// approve/flag or bakeoff-verdict.ts's pick-a-winner: those parse a DECISION
// out of the reply (where an unreadable answer must default to the safe
// choice), but this is pure content generation — the reply string more or
// less already differently IS the artifact. Each parser below only does the
// minimum defensive cleanup (strip an accidental code fence, reject an
// empty/degenerate reply) rather than classify the prose.

import type { HandoffRole } from "@skynet/shared";

/** Fixed target file per file-writing role; `null` for release-comms, which
 *  produces prose with no file behind it. Scoped deliberately narrow for v1:
 *  one well-known root file per role rather than open-ended doc discovery
 *  (which file counts as "the" user-facing doc varies too much project to
 *  project to pick reliably) — broader targeting is a natural follow-up once
 *  this lands and the pattern proves out. */
export const HANDOFF_TARGET_FILE: Record<HandoffRole, string | null> = {
  "change-manager": "CHANGELOG.md",
  "docs-writer": "README.md",
  "release-comms": null,
};

/** Shared shipped-work context every role's prompt is built from. */
export interface HandoffContext {
  sourceKind: "feature" | "milestone";
  sourceName: string;
  description: string | null;
  /** Task text for every task rolled up under the shipped feature/milestone —
   *  the "task descriptions" ROADMAP.md calls out as docs-writer's input.
   *  Capped by the caller before this is built (see MAX_TASK_LINES). */
  taskTexts: string[];
}

export const MAX_TASK_LINES = 25;

function contextBlock(ctx: HandoffContext): string {
  const lines = [
    `${ctx.sourceKind === "feature" ? "Feature" : "Milestone"} shipped: "${ctx.sourceName}"`,
    ctx.description ? `Description: ${ctx.description}` : null,
    ctx.taskTexts.length > 0
      ? `What actually shipped (task list):\n${ctx.taskTexts
          .slice(0, MAX_TASK_LINES)
          .map((t) => `- ${t}`)
          .join("\n")}`
      : null,
  ].filter((l): l is string => !!l);
  return lines.join("\n");
}

/** Strip a single accidental ```lang / ``` fence wrapping the whole reply —
 *  models wrap output in one even when told not to. Only strips a fence that
 *  wraps the ENTIRE reply (first and last non-blank lines), never one that's
 *  genuinely part of the content. */
function stripOuterFence(reply: string): string {
  const trimmed = reply.trim();
  const lines = trimmed.split("\n");
  if (lines.length >= 2 && /^```/.test(lines[0]!.trim()) && lines[lines.length - 1]!.trim() === "```") {
    return lines.slice(1, -1).join("\n").trim();
  }
  return trimmed;
}

// ─── change-manager ──────────────────────────────────────────────────────────

export function changeManagerQuestion(ctx: HandoffContext): string {
  return [
    "Write a single new CHANGELOG.md entry for the work described below — the kind of one-paragraph-or-bullet-list entry a real changelog carries for one shipped feature.",
    "Reply with ONLY the new entry's markdown (a heading line if you want one, then bullets or prose) — no commentary before or after, no code fence.",
    "",
    contextBlock(ctx),
  ].join("\n");
}

/** Non-empty, plausible-length cleanup only — see file header for why this
 *  isn't a structured-verdict parse. Returns null (skip, no HITL raised this
 *  time) on a degenerate reply rather than raising a HITL with junk content. */
export function parseChangeManagerReply(reply: string): string | null {
  const entry = stripOuterFence(reply);
  if (entry.length < 10 || entry.length > 4000) return null;
  return entry;
}

/** Splice a new entry into CHANGELOG.md content — deterministic, not
 *  LLM-controlled placement. Inserted right after the file's first heading
 *  line (`# ...`/`## ...`) and the blank line that usually follows it, so a
 *  "## Unreleased" or version-header convention is respected without this
 *  code needing to understand it; falls back to prepending at the very top
 *  when no heading is found. `current === null` (file doesn't exist yet)
 *  scaffolds a minimal `# Changelog` header above the new entry. */
export function spliceChangelogEntry(current: string | null, entry: string): string {
  if (current === null || current.trim().length === 0) {
    return `# Changelog\n\n${entry}\n`;
  }
  const lines = current.split("\n");
  const headingIdx = lines.findIndex((l) => /^#{1,2}\s/.test(l));
  if (headingIdx === -1) {
    return `${entry}\n\n${current}`;
  }
  let insertAt = headingIdx + 1;
  if (lines[insertAt] === "") insertAt++;
  return [...lines.slice(0, insertAt), entry, "", ...lines.slice(insertAt)].join("\n");
}

// ─── docs-writer ─────────────────────────────────────────────────────────────

export function docsWriterQuestion(ctx: HandoffContext, currentReadme: string | null): string {
  return [
    "Update README.md to reflect the shipped work described below — the kind of small, user-facing edit a docs writer would make right after a feature ships (a new bullet under an existing section, an updated feature list entry, etc.). Keep everything else in the file exactly as it is; make the smallest edit that's actually accurate.",
    "Reply with ONLY the ENTIRE updated file content, start to finish — no commentary before or after, no code fence.",
    "",
    contextBlock(ctx),
    "",
    currentReadme !== null ? `=== Current README.md ===\n${currentReadme}` : "(README.md doesn't exist yet — write a minimal one.)",
  ].join("\n");
}

/** Same non-classifying cleanup as parseChangeManagerReply, plus a sanity
 *  floor against a truncated/runaway reply: rejects a reply wildly shorter or
 *  longer than the baseline it was asked to lightly edit (baseline === null,
 *  i.e. no existing file, skips this check — there's nothing to compare
 *  against). This is a floor, not a diff-quality check; the human approval
 *  gate is still the real review. */
export function parseDocsWriterReply(reply: string, baseline: string | null): string | null {
  const content = stripOuterFence(reply);
  if (content.length < 20) return null;
  if (baseline !== null && baseline.length > 0) {
    const ratio = content.length / baseline.length;
    if (ratio < 0.3 || ratio > 3) return null;
  }
  return content;
}

// ─── release-comms ───────────────────────────────────────────────────────────

export function releaseCommsQuestion(ctx: HandoffContext): string {
  return [
    "Draft a short release-announcement blurb (2-4 sentences, plain prose — think a changelog tweet or a Slack #announcements post) for the shipped work described below. Lead with the user-facing benefit, not the implementation.",
    "Reply with ONLY the announcement text — no commentary before or after, no code fence, no hashtags.",
    "",
    contextBlock(ctx),
  ].join("\n");
}

export function parseReleaseCommsReply(reply: string): string | null {
  const text = stripOuterFence(reply);
  if (text.length < 10 || text.length > 2000) return null;
  return text;
}
