// ─── Roadmap proposal governance (Phase 25 — TASK 28) ───────────────────────
// An agent's proposed edit to a project's roadmap doc (packages/shared/src/
// roadmap-doc.ts). Distinct from the kanban `Proposal` (contracts.ts —
// draft_task/suggested_subtask/... rule-engine suggestions): this is scoped
// specifically to roadmap-document governance — one open proposal per
// section, contradictory proposals held for a human, a human-repo edit always
// wins, and every applied change carries real commit attribution. See
// apps/server/src/roadmap/proposals.ts for the concurrency rules themselves;
// this file is schema only.

import { z } from "zod";
import { Timestamp } from "./contracts.js";

export const RoadmapProposalState = z.enum(["open", "held_conflict", "approved", "rejected", "superseded"]);
export type RoadmapProposalState = z.infer<typeof RoadmapProposalState>;

/**
 * A proposed edit to one roadmap SECTION, expressed against a fixed baseline
 * rather than a line-range patch: `context` is the section's exact raw text
 * as it read when this proposal was drafted (both the apply step and Rule
 * 3's "did a human already change this?" supersede check key off it —
 * apps/server/src/roadmap/proposals.ts's `sectionRawText`), `removed` is the
 * exact original lines to drop from it, `added` is the new lines to append.
 * Baseline-keyed rather than a synthesized unified diff so two independent
 * proposals against the SAME baseline are trivially comparable (Rule 1/4)
 * without a diff/patch library.
 */
export const RoadmapProposalDiff = z.object({
  added: z.array(z.string()),
  removed: z.array(z.string()),
  context: z.string(),
});
export type RoadmapProposalDiff = z.infer<typeof RoadmapProposalDiff>;

export const RoadmapProposalImpact = z.object({
  tasksCreated: z.array(z.string()).default([]),
  questionsResolved: z.array(z.string()).default([]),
  dependencies: z.array(z.string()).default([]),
});
export type RoadmapProposalImpact = z.infer<typeof RoadmapProposalImpact>;

export const RoadmapProposal = z.object({
  id: z.string(),
  workspaceId: z.string(),
  projectId: z.string(),
  // The agent that opened the proposal. A second agent that joins/amends it
  // (Rule 1) is noted in `reasoning`, not a second id here — this stays the
  // ORIGINAL proposer for the life of the proposal.
  agentId: z.string(),
  // RoadmapSection.id — which `##` (or the preamble) this targets.
  section: z.string(),
  headline: z.string(),
  diff: RoadmapProposalDiff,
  reasoning: z.string(),
  impact: RoadmapProposalImpact,
  // What the agent checked before proposing (e.g. "did not touch another
  // agent's in-flight task", "left the state block alone") — self-reported,
  // shown to the human approver as context, never independently verified.
  respectedBoundaries: z.array(z.string()).default([]),
  state: RoadmapProposalState,
  // Other RoadmapProposal ids this one is in `held_conflict` with (Rule 4) —
  // populated on BOTH sides of a conflicting pair, so either can be opened
  // straight to the other from the UI.
  conflictsWith: z.array(z.string()).default([]),
  createdAt: Timestamp,
  // Milliseconds since createdAt as of the last time this proposal was
  // touched (join, conflict check, or read) — informational, for a "this has
  // been sitting for 3 days" cue; never itself gates a rule.
  idleMs: z.number().int().nonnegative().default(0),
  // Agent ids that tried to touch this section while it (or their own
  // incoming proposal) was locked by a held_conflict and were turned away —
  // Rule 4's queue, so a human resolving the conflict can see who's waiting.
  blockedAgents: z.array(z.string()).default([]),
});
export type RoadmapProposal = z.infer<typeof RoadmapProposal>;

/** What an agent submits to open (or join) a section's proposal. */
export const ProposeRoadmapChangeRequest = z.object({
  agentId: z.string(),
  section: z.string(),
  headline: z.string(),
  diff: RoadmapProposalDiff,
  reasoning: z.string(),
  impact: RoadmapProposalImpact.optional(),
  respectedBoundaries: z.array(z.string()).optional(),
});
export type ProposeRoadmapChangeRequest = z.infer<typeof ProposeRoadmapChangeRequest>;
