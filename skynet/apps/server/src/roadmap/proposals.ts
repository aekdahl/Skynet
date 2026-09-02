// ─── Roadmap proposal governance (Phase 25 — TASK 28) ───────────────────────
// Pure rules for the concurrency/ownership problem a shared, machine-writable
// ROADMAP.md creates once more than one agent can propose edits to it. No
// store/repo I/O here — Operations.ts (roadmap proposal methods) is the thin
// I/O shell around these; see that file for the store-backed entry points.
//
// Rule 1 — one open proposal per section: `findOpenProposalForSection` +
//          `joinProposal` (a second agent's compatible proposal merges into
//          the first instead of creating a second row).
// Rule 2 — deletions/date-moves always need a human: `diffRequiresHumanApproval`,
//          checked by Operations.applyRoadmapProposal BEFORE the autonomy
//          detent is even read — see that function's own comment for why.
// Rule 3 — the repo wins: `sectionRawText` + `proposalIsStale` let a re-parse
//          detect a human's direct edit already changed what a proposal
//          targeted, so it can be marked superseded instead of applied.
// Rule 4 — contradictory proposals held: `proposalsConflict` decides when a
//          join attempt (Rule 1) must instead fork into two `held_conflict`
//          proposals; `lockedSectionIds` + `taskBlockedByRoadmapLock` are the
//          "lightweight lock" the orchestrator's auto-pick checks.

import type { RoadmapAstNode, RoadmapChecklistItemNode, RoadmapDoc, RoadmapProposal, RoadmapProposalDiff } from "@skynet/shared";
import { hashLineText } from "./identity.js";

// ─── Rule 1 — one open proposal per section ─────────────────────────────────

/** The section's current open proposal, if any — Rule 1's whole "is there
 *  already one?" check. `held_conflict`/`approved`/`rejected`/`superseded`
 *  proposals don't count: a resolved (or locked) proposal isn't "open" for a
 *  new one to join. */
export function findOpenProposalForSection(proposals: RoadmapProposal[], section: string): RoadmapProposal | undefined {
  return proposals.find((p) => p.section === section && p.state === "open");
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

/**
 * Merge a second agent's compatible proposal into the section's existing
 * open one (Rule 1's "joins/amends it" outcome) — diff/impact/boundaries are
 * unioned, `reasoning` gets an attributed addendum, but `id`/`agentId`/
 * `createdAt`/`state` are all untouched: this stays the SAME proposal row,
 * just amended, not a new one. Callers must have already ruled out
 * `proposalsConflict` (an incompatible join is Rule 4's job, not this one's).
 */
export function joinProposal(
  existing: RoadmapProposal,
  incoming: { agentId: string; headline: string; diff: RoadmapProposalDiff; reasoning: string; respectedBoundaries?: string[] },
): RoadmapProposal {
  return {
    ...existing,
    diff: {
      added: dedupe([...existing.diff.added, ...incoming.diff.added]),
      removed: dedupe([...existing.diff.removed, ...incoming.diff.removed]),
      context: existing.diff.context,
    },
    reasoning: `${existing.reasoning}\n\n— amended by ${incoming.agentId}: ${incoming.reasoning}`,
    respectedBoundaries: dedupe([...existing.respectedBoundaries, ...(incoming.respectedBoundaries ?? [])]),
  };
}

// ─── Rule 2 — deletions and date-moves always need a human ─────────────────

// ISO date (the convention every Timestamp-adjacent field in this codebase
// already implies, and the only unambiguous pattern ROADMAP.md prose could
// realistically use for a promised date). Deliberately broad: ANY line
// touching a recognizable date is treated as sensitive — a false positive
// just costs a human a confirm click; a false negative would silently let a
// date-move slip past the gate this rule exists to guarantee.
const DATE_PATTERN = /\b\d{4}-\d{2}-\d{2}\b/;

/** True if any line this diff adds OR removes carries a date — the
 *  unconditional half of Rule 2. Pure text heuristic (RoadmapLine.promisedDate
 *  isn't populated by any parser yet — see roadmap-doc.ts's own doc comment),
 *  deliberately over- rather than under-inclusive. */
export function touchesPromisedDate(diff: RoadmapProposalDiff): boolean {
  return [...diff.added, ...diff.removed].some((line) => DATE_PATTERN.test(line));
}

/**
 * Rule 2, in full: true when this diff removes any line at all, or touches
 * something that looks like a promised date. MUST be checked before any
 * autonomy-detent read — see Operations.applyRoadmapProposal, which calls
 * this literally first, so there is no code path (no detent, no approval
 * level, no override) that can reach the auto-apply branch for a diff this
 * returns true for.
 */
export function diffRequiresHumanApproval(diff: RoadmapProposalDiff): boolean {
  return diff.removed.length > 0 || touchesPromisedDate(diff);
}

// ─── Rule 3 — the repo wins ──────────────────────────────────────────────────

const PREAMBLE_SECTION_ID = hashLineText("");

/**
 * Reconstructs one section's exact raw text (heading line included, for a
 * non-preamble section) straight from the ast — the same `##`/`#`-level
 * boundary and `hashLineText(heading text)` id scheme `sections.ts`'s
 * `buildSections` uses, so a `RoadmapSection.id` from either always means the
 * same span. Unlike `buildSections` (which only collects checklistItem line
 * ids), this concatenates EVERY node's `raw` in range — the full text a
 * proposal's `diff.context` was drafted against, not just its checklist
 * items. Returns "" for a section id that no longer exists in `ast` at all
 * (a heading itself got removed) — never throws.
 */
export function sectionRawText(ast: RoadmapAstNode[], sectionId: string): string {
  let inSection = sectionId === PREAMBLE_SECTION_ID;
  let found = inSection;
  let buf = "";
  for (const node of ast) {
    if (node.type === "heading" && node.level <= 2) {
      if (inSection) break; // reached the next section's heading — stop
      const isTarget = hashLineText(node.text) === sectionId;
      inSection = isTarget;
      if (isTarget) found = true;
    }
    if (inSection) buf += node.raw;
  }
  return found ? buf : "";
}

/**
 * True when the section a proposal targets no longer matches the baseline it
 * was drafted against — a human's direct commit already changed it. This is
 * Rule 3 in full: any caller re-parsing the repo (TASK 27's push-webhook
 * handler, via Operations.syncProjectRoadmap) diffs every OPEN proposal
 * against the fresh doc with this, and marks a match `superseded` instead of
 * ever applying it.
 */
export function proposalIsStale(proposal: RoadmapProposal, freshDoc: RoadmapDoc): boolean {
  return sectionRawText(freshDoc.ast, proposal.section) !== proposal.diff.context;
}

/** Splices `diff` onto `fullRaw` (a whole roadmap file's current content) —
 *  the one place a proposal's diff actually becomes new file text, shared by
 *  both the explicit-approve and eligible-auto-apply paths in Operations.
 *  Requires `diff.context` to appear verbatim in `fullRaw` — a caller must
 *  have already ruled out `proposalIsStale` (this throws rather than silently
 *  applying against content that's moved, the same "never overwrite a
 *  changed baseline" contract local-repo-write.ts's own baseline check
 *  enforces for a Steward edit). */
export class RoadmapProposalStaleError extends Error {
  constructor() {
    super("This proposal's target section no longer matches the repo — it needs to be re-drafted or superseded.");
    this.name = "RoadmapProposalStaleError";
  }
}

export function applyRoadmapProposalDiff(fullRaw: string, diff: RoadmapProposalDiff): string {
  const idx = fullRaw.indexOf(diff.context);
  if (idx === -1) throw new RoadmapProposalStaleError();
  const removedSet = new Set(diff.removed);
  let section = diff.context
    .split("\n")
    .filter((line) => !removedSet.has(line))
    .join("\n");
  if (diff.added.length > 0) {
    const trailingNewline = section.endsWith("\n");
    const base = trailingNewline ? section.slice(0, -1) : section;
    section = `${base}\n${diff.added.join("\n")}${trailingNewline ? "\n" : ""}`;
  }
  return fullRaw.slice(0, idx) + section + fullRaw.slice(idx + diff.context.length);
}

// ─── Rule 4 — contradictory proposals held ──────────────────────────────────

/**
 * True when two open proposals in the SAME section can't be reconciled by a
 * plain Rule-1 join: they both touch (remove) at least one common line, but
 * don't agree on the replacement — a real content collision, not just two
 * agents independently proposing the identical fix (which would produce
 * identical `added`, not a conflict). Different `diff.context` on its own
 * (one agent drafted against a slightly staler baseline) is NOT by itself a
 * conflict — only overlapping `removed` lines with differing `added` is,
 * because that's the case a blind merge would silently pick a winner for.
 */
export function proposalsConflict(a: RoadmapProposal, b: RoadmapProposal): boolean {
  if (a.id === b.id || a.section !== b.section) return false;
  const overlap = a.diff.removed.some((line) => b.diff.removed.includes(line));
  if (!overlap) return false;
  const sameResolution =
    a.diff.added.length === b.diff.added.length && [...a.diff.added].sort().every((line, i) => [...b.diff.added].sort()[i] === line);
  return !sameResolution;
}

/** The section ids currently locked by a held_conflict proposal — Rule 4's
 *  "lightweight lock", derived on read from whatever proposals are already in
 *  that state rather than a separate lock table to keep in sync. */
export function lockedSectionIds(heldConflictProposals: RoadmapProposal[]): Set<string> {
  return new Set(heldConflictProposals.map((p) => p.section));
}

/** True if `taskId` is linked (via a roadmap line's `taskIds`) to a section
 *  currently locked — what the orchestrator's auto-pick filter calls before
 *  starting a task, so no agent can pick up work tied to a section a human
 *  hasn't finished resolving yet. A task with no roadmap linkage at all (the
 *  overwhelming common case) is never blocked by this. */
export function taskBlockedByRoadmapLock(doc: RoadmapDoc | undefined, locked: Set<string>, taskId: string): boolean {
  if (!doc || locked.size === 0) return false;
  const linesById = new Map<string, RoadmapChecklistItemNode>();
  for (const node of doc.ast) if (node.type === "checklistItem") linesById.set(node.id, node);
  for (const section of doc.sections) {
    if (!locked.has(section.id)) continue;
    for (const lineId of section.lineIds) {
      if (linesById.get(lineId)?.taskIds.includes(taskId)) return true;
    }
  }
  return false;
}
