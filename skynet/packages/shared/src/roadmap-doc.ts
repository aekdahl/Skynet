// ─── Roadmap document model (Phase 24 — Fleet Governance Rollout turn 4) ────
// Parses a project's ROADMAP.md into a stable, diffable structure other tasks
// (an editor UI, a Steward-driven line update, a "what shipped this week"
// digest) build on. This module is SCHEMA ONLY — see apps/server/src/roadmap/
// for the parser, line-identity reconciliation, and state-block serializer.
//
// Line identity is the whole point: `RoadmapLine.id` is a content hash by
// default (stable across a re-parse as long as the line's text doesn't
// change), falling back to a `<!--#id-->` trailing anchor comment ONLY when a
// re-parse finds the line reworded (changed hash, but clearly the same line)
// — introduced lazily, never stamped onto every line up front, so a fresh
// ROADMAP.md with no prior sync history round-trips with zero anchors added.

import { z } from "zod";
import { Timestamp } from "./contracts.js";

// ─── shared small pieces ─────────────────────────────────────────────────
export const RoadmapLink = z.object({ text: z.string(), url: z.string() });
export type RoadmapLink = z.infer<typeof RoadmapLink>;

// Derived directly from the checkbox marker actually written in the file
// (`[ ]`/`[x]`/`[~]` — all three are in real use in ROADMAP.md today, unlike
// the plain 2-state checklist tasks/checklist.ts already parses for repo
// TODO-file sync). Nothing here infers "blocked" or similar — there's no
// markdown convention for it, so it isn't fabricated.
export const RoadmapLineState = z.enum(["done", "in_progress", "todo"]);
export type RoadmapLineState = z.infer<typeof RoadmapLineState>;

export const RoadmapLineForecast = z.object({
  etaAt: Timestamp.nullable(),
  confidence: z.enum(["low", "medium", "high"]).nullable(),
  basis: z.string().nullable(),
});
export type RoadmapLineForecast = z.infer<typeof RoadmapLineForecast>;

/**
 * One roadmap checklist entry (`- [x] **Title.** description …`). Everything
 * beyond `id`/`text`/`checked`/`state`/`links` is a forward-declared field for
 * a LATER task — nothing in Phase 24 populates `author`/`authorRef`/`addedAt`
 * (would need git-blame attribution), `taskIds`/`questionIds` (would need a
 * linking UI/action), `claimedByHuman`, `promisedDate`, `forecast`, or
 * `acceptanceCriteria` (no structural marker for this exists in ROADMAP.md's
 * current prose convention). They default to null/[]/false rather than being
 * omitted, so the shape other tasks build against is stable from day one; see
 * apps/server/src/roadmap/identity.ts's own doc comment for what IS wired.
 */
export const RoadmapLine = z.object({
  id: z.string(),
  text: z.string(),
  checked: z.boolean(),
  acceptanceCriteria: z.string().nullable().default(null),
  author: z.string().nullable().default(null),
  authorRef: z.string().nullable().default(null),
  addedAt: Timestamp.nullable().default(null),
  claimedByHuman: z.boolean().default(false),
  taskIds: z.array(z.string()).default([]),
  state: RoadmapLineState,
  promisedDate: Timestamp.nullable().default(null),
  forecast: RoadmapLineForecast.nullable().default(null),
  questionIds: z.array(z.string()).default([]),
  // Phase 26 (TASK 29) — the commit that git-blame currently attributes this
  // line's text to, filled in at READ time only (apps/server/src/roadmap/
  // enrich.ts), never persisted onto the parsed doc: like author/authorRef/
  // addedAt above, a reparse resets this to null (identity.ts's
  // assignLineIdentity only ever carries `id` forward). "Revert the commit"
  // reverts THIS sha.
  blameSha: z.string().nullable().default(null),
});
export type RoadmapLine = z.infer<typeof RoadmapLine>;

// ─── AST ─────────────────────────────────────────────────────────────────
// Every node carries `raw` — the EXACT original source span it came from.
// Serialization is just `ast.map(n => n.raw).join("")`: byte-identical by
// construction, not by careful reconstruction, so it holds even for markdown
// shapes this parser doesn't deeply model (a code fence or blockquote both
// fall into "other" and round-trip untouched).

export const RoadmapHeadingNode = z.object({
  type: z.literal("heading"),
  level: z.number().int().min(1).max(6),
  text: z.string(),
  raw: z.string(),
});
export type RoadmapHeadingNode = z.infer<typeof RoadmapHeadingNode>;

// A roadmap entry — extends RoadmapLine with the markdown-specific span
// metadata, so `ast.filter(n => n.type === "checklistItem")` IS the doc's
// RoadmapLine[] with no separate collection to keep in sync.
export const RoadmapChecklistItemNode = RoadmapLine.extend({
  type: z.literal("checklistItem"),
  indent: z.number().int().min(0),
  marker: z.enum([" ", "x", "~"]),
  links: z.array(RoadmapLink),
  raw: z.string(),
});
export type RoadmapChecklistItemNode = z.infer<typeof RoadmapChecklistItemNode>;

// A bullet WITHOUT a checkbox — e.g. a sub-bullet elaborating on a design
// under a heading. Not a RoadmapLine (nothing to track state/identity for).
export const RoadmapListItemNode = z.object({
  type: z.literal("listItem"),
  indent: z.number().int().min(0),
  text: z.string(),
  links: z.array(RoadmapLink),
  raw: z.string(),
});
export type RoadmapListItemNode = z.infer<typeof RoadmapListItemNode>;

export const RoadmapTableNode = z.object({
  type: z.literal("table"),
  rows: z.array(z.array(z.string())),
  raw: z.string(),
});
export type RoadmapTableNode = z.infer<typeof RoadmapTableNode>;

export const RoadmapParagraphNode = z.object({
  type: z.literal("paragraph"),
  text: z.string(),
  links: z.array(RoadmapLink),
  raw: z.string(),
});
export type RoadmapParagraphNode = z.infer<typeof RoadmapParagraphNode>;

export const RoadmapHrNode = z.object({ type: z.literal("hr"), raw: z.string() });
export type RoadmapHrNode = z.infer<typeof RoadmapHrNode>;

export const RoadmapBlankNode = z.object({ type: z.literal("blank"), raw: z.string() });
export type RoadmapBlankNode = z.infer<typeof RoadmapBlankNode>;

// Catch-all passthrough — a code fence, a blockquote, or anything else this
// parser doesn't structurally model. `raw` is preserved verbatim either way.
export const RoadmapOtherNode = z.object({ type: z.literal("other"), raw: z.string() });
export type RoadmapOtherNode = z.infer<typeof RoadmapOtherNode>;

export const RoadmapAstNode = z.discriminatedUnion("type", [
  RoadmapHeadingNode,
  RoadmapChecklistItemNode,
  RoadmapListItemNode,
  RoadmapTableNode,
  RoadmapParagraphNode,
  RoadmapHrNode,
  RoadmapBlankNode,
  RoadmapOtherNode,
]);
export type RoadmapAstNode = z.infer<typeof RoadmapAstNode>;

// ─── sections ────────────────────────────────────────────────────────────
// A coarse, stable-id'd grouping by level-2 (`##`) heading — ROADMAP.md's own
// dominant structural marker (each `##` is a version/phase group; a `###`
// beneath it stays part of the same section rather than splitting further).
// Content before the first `##` (the H1 + intro prose) is the one section
// with `heading: null`. Section `id` is a content hash of the heading text,
// so it's stable across re-parses the same way a line id is.
export const RoadmapSection = z.object({
  id: z.string(),
  heading: z.string().nullable(),
  level: z.number().int().min(0).max(6),
  lineIds: z.array(z.string()),
});
export type RoadmapSection = z.infer<typeof RoadmapSection>;

// ─── doc ─────────────────────────────────────────────────────────────────
export const RoadmapSyncState = z.enum(["in_sync", "repo_ahead", "unparseable"]);
export type RoadmapSyncState = z.infer<typeof RoadmapSyncState>;

export const RoadmapDoc = z.object({
  workspaceId: z.string(),
  projectId: z.string(),
  path: z.string(),
  // The repo commit this parse reflects. Null when unknown (e.g. a GitHub
  // Contents-API read outside a webhook, which returns a blob sha, not a
  // commit sha — see resolveRoadmapDoc; conflating the two would be worse
  // than leaving this honestly null).
  commitSha: z.string().nullable(),
  syncedAt: Timestamp,
  syncState: RoadmapSyncState,
  raw: z.string(),
  ast: z.array(RoadmapAstNode),
  sections: z.array(RoadmapSection),
});
export type RoadmapDoc = z.infer<typeof RoadmapDoc>;

// ─── state block ─────────────────────────────────────────────────────────
// A machine-generated snapshot other tooling (or an operator) can diff
// against — "as of commit X, here's what state every tracked line was in."
// Always regenerated wholesale (see apps/server/src/roadmap/state-block.ts);
// never hand-edited or merged into.
export const RoadmapStateBlockEntry = z.object({
  lineId: z.string(),
  state: RoadmapLineState,
  taskIds: z.array(z.string()),
});
export type RoadmapStateBlockEntry = z.infer<typeof RoadmapStateBlockEntry>;

export const RoadmapStateBlock = z.object({
  generatedAt: Timestamp,
  commitSha: z.string().nullable(),
  entries: z.array(RoadmapStateBlockEntry),
});
export type RoadmapStateBlock = z.infer<typeof RoadmapStateBlock>;

// ─── line claims (Phase 26 — TASK 29) ───────────────────────────────────────
// "KEEP · CLAIM AS MINE" on an agent-added line — an operator explicitly
// taking display ownership of a line git-blame otherwise attributes to an
// agent/Skynet identity. Deliberately NOT stored on RoadmapLine/RoadmapDoc
// itself: a reparse resets those fields to null (identity.ts's
// assignLineIdentity only ever carries `id` forward — see RoadmapLine's own
// doc comment), so a claim needs its own persistence, keyed by the STABLE
// line id, overlaid onto the freshly-parsed+blamed doc at read time
// (apps/server/src/operations.ts's getProjectRoadmapDoc). This does NOT
// rewrite git history or blame — it's a display-layer override only, exactly
// like git blame itself can't represent "reassigned ownership" without an
// actual commit.
export const RoadmapLineClaim = z.object({
  id: z.string(),
  workspaceId: z.string(),
  projectId: z.string(),
  lineId: z.string(),
  operatorId: z.string(),
  claimedAt: Timestamp,
});
export type RoadmapLineClaim = z.infer<typeof RoadmapLineClaim>;

// ─── workspace roll-up (Phase 29 — TASK 32) ─────────────────────────────────
// "Six repos, one quarter" — an aggregate over every project's ROADMAP.md the
// CALLER already has access to (no new access-control surface: scoped by the
// same principal.projectIds allowlist mcp/project-scope.ts already enforces
// everywhere else; an unrestricted principal — every human/workspace token
// today — sees every project, unchanged). apps/server/src/roadmap/rollup.ts
// derives this from a RoadmapDoc + Project; this file is schema only.

// A repo's per-line risk verdict, derived from RoadmapLine.forecast — which
// TASK 31 is what actually populates (until then every real doc's lines carry
// `forecast: null`, so this always reads "unknown"; the shape is stable from
// day one so TASK 31 lighting it up needs no rollup-side change). Never
// fabricated from an unrelated signal — see `atRiskReason` below for the one
// real signal available TODAY (TASK 19's credential breaker).
export const RoadmapDriftVerdict = z.enum(["on_track", "at_risk", "unknown"]);
export type RoadmapDriftVerdict = z.infer<typeof RoadmapDriftVerdict>;

// One repo's row in the workspace roll-up table (REPO / FILE / LINES / WITH
// TASKS / WITH CRITERIA / DRIFT / PROPOSALS).
export const RoadmapRollupRow = z.object({
  projectId: z.string(),
  projectName: z.string(),
  repo: z.string().nullable(), // "owner/name" (GitHub-bound) or null (local repoPath only)
  // Non-null only for a project WITH a resolved roadmap file — the dashed
  // "no roadmap" row (see RoadmapWorkspaceRollup.noRoadmapProjects) never
  // gets a RoadmapRollupRow at all, so this field is never null here.
  path: z.string(),
  syncState: RoadmapSyncState,
  lineCount: z.number().int().nonnegative(),
  withTasksCount: z.number().int().nonnegative(),
  withCriteriaCount: z.number().int().nonnegative(),
  doneCount: z.number().int().nonnegative(),
  drift: RoadmapDriftVerdict,
  proposalCount: z.number().int().nonnegative(), // open + held_conflict, this project
  // The one real, non-fabricated "why might this miss" line available before
  // TASK 31 ships real per-line forecasts — the project's own credential
  // breaker state (TASK 19), when one of its enabled runner keys is paused.
  // Null = nothing to report (not necessarily "healthy" — just nothing this
  // rollup can currently see).
  atRiskReason: z.string().nullable(),
});
export type RoadmapRollupRow = z.infer<typeof RoadmapRollupRow>;

// One repo's contribution to a cross-repo milestone group — SECTION-scoped
// (only the lines under that one `##` heading), unlike RoadmapRollupRow which
// is whole-doc. A project with a 40-line roadmap spanning six milestones
// contributes a different, much smaller bar to each one.
export const RoadmapMilestoneRepoBar = z.object({
  projectId: z.string(),
  projectName: z.string(),
  repo: z.string().nullable(),
  lineCount: z.number().int().nonnegative(),
  doneCount: z.number().int().nonnegative(),
  drift: RoadmapDriftVerdict,
  atRiskReason: z.string().nullable(),
});
export type RoadmapMilestoneRepoBar = z.infer<typeof RoadmapMilestoneRepoBar>;

// A milestone NAME matched by plain string equality across repos' own `##`
// section headings — not a new stored cross-repo entity (per the confirmed
// decision). Only a heading shared by 2+ projects becomes a group — that's
// the whole point of "cross-repo"; a repo's own unique section heading is
// still counted in its RoadmapRollupRow, just never grouped here.
export const RoadmapMilestoneGroup = z.object({
  name: z.string(),
  repos: z.array(RoadmapMilestoneRepoBar),
  // The single repo (if any) this milestone is most likely to miss — the
  // first `drift: "at_risk"` bar, else the first bar carrying a real
  // `atRiskReason` (a tripped breaker), else null (nothing to flag).
  mostAtRiskProjectId: z.string().nullable(),
});
export type RoadmapMilestoneGroup = z.infer<typeof RoadmapMilestoneGroup>;

// A project with no resolved roadmap file (no `roadmapPath` override AND
// neither default candidate exists) — rendered as the roll-up's dashed final
// row instead of a normal RoadmapRollupRow, since there's nothing to count.
export const RoadmaplessProject = z.object({
  projectId: z.string(),
  projectName: z.string(),
});
export type RoadmaplessProject = z.infer<typeof RoadmaplessProject>;

export const RoadmapWorkspaceRollup = z.object({
  // Every caller-accessible project WITH a resolved roadmap file — one row
  // per repo. The repo table renders this directly.
  rows: z.array(RoadmapRollupRow),
  // Cross-repo groupings over the SAME rows above (a row can appear under
  // more than one milestone name only if its doc genuinely has two `##`
  // headings matching two different groups elsewhere — ordinary, not deduped
  // against). The milestone card renders this.
  milestones: z.array(RoadmapMilestoneGroup),
  noRoadmapProjects: z.array(RoadmaplessProject),
});
export type RoadmapWorkspaceRollup = z.infer<typeof RoadmapWorkspaceRollup>;
