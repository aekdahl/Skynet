// ─── Orchestrator ─────────────────────────────────────────────────────────
// TaskRun lifecycle (Backend Brief §04): provision a runner, start an agent on a
// task, route HITL gates, deliver decisions, fork, complete. Phase 0 uses the
// mock runner; real providers drop in behind the same runner-sdk interface.

import type { TaskRun, Checkpoint, HitlItem, Project, Resolution, Agent, Task, TaskAssignment, TaskSource, ProviderId, ProviderInfo, MergeBriefing, MergeBrief, FeatureBrief, Risk, Feature, FeatureStatus, Milestone, SolutionBrief, DiffWalkthrough, PullRequest, PrChecksStatus } from "@skynet/shared";
import { WorkspaceSettings, computeDailySpend, costBandFor, dayWindow, pacedAvailableUsd, resolveTaskBrief } from "@skynet/shared";
import {
  isCreditExhaustionError,
  type HitlRaise,
  type RunnerEvents,
  type RunnerHandle,
  type RunnerProvider,
  type UntrustedRead,
} from "@skynet/runner-sdk";
// Cheap, tool-less one-shot for the clarification draft. Explicit mid-tier
// model: this is a short, high-frequency assistant call where the top tier
// buys nothing and costs several times more.
import { oneShotText } from "@skynet/runner-sdk/claude";
const CLARIFY_DRAFT_MODEL = "sonnet";
import { basename, join, resolve } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { blastRadiusFlags, classifyCommand } from "./command-safety.js";
import { decideAutoApproval } from "./approval-policy.js";
import { resolveActivePolicy } from "./command-policy.js";
import { resolveMergeTarget } from "./derive/merge-target.js";
import { parseReviewVerdict, extractJsonObject, REVIEW_OUTPUT_INSTRUCTION, parseReviewProposals, type ProposedTask } from "./review-verdict.js";
import { parseBreakerVerdict, BREAKER_OUTPUT_INSTRUCTION, type BreakerVerdictOut } from "./breaker-verdict.js";
import { parseInjectionVerdict, buildInjectionPrompt } from "./injection-firewall.js";
import { parseDiffWalkthrough, DIFF_WALKTHROUGH_INSTRUCTION, DIFF_WALKTHROUGH_SYSTEM } from "./diff-walkthrough.js";
import { parseMergeBrief, MERGE_BRIEF_INSTRUCTION, MERGE_BRIEF_SYSTEM } from "./merge-brief.js";
import { composeFeatureBrief, parseFeatureNarrative, FEATURE_BRIEF_INSTRUCTION, FEATURE_BRIEF_SYSTEM } from "./feature-brief.js";
import { decisionResumePrompt } from "./decision-resume.js";
import { buildAgentContext, withInstructions } from "./agent-context.js";
import { syncRepoNativeMemory } from "./repo-memory-sync.js";
import { buildSiblingDigest } from "./sibling-digest.js";
import { config, now } from "./config.js";
import { githubService } from "./github/index.js";
import type { Hub } from "./hub.js";
import { MergeEngine, FEATURE_BRANCH_PREFIX, type MergeRequest } from "./merge.js";
import { loadModuleMap, type ModuleMap } from "./modules-map.js";
import { providerUsableFromEnv } from "./provider-env.js";
import { secretService } from "./secrets/index.js";
import { previewService } from "./preview/index.js";
import { projectPreview, type ProjectPreviewManager } from "./preview/project-preview.js";
import { prepareWorktree } from "./preview/worktree.js";
import type { Store } from "./store/store.js";
import { WorktreeProvisioner, type DiffStat } from "./worktrees.js";

interface LiveAgent {
  handle: RunnerHandle;
  agentId: string | null;
  taskId: string | null;
  /** The agent's branch (used as its merge-queue source). */
  branch: string;
  /** Set when the agent runs in a real worktree; enables the commit→review→merge
   *  loop. The ref the branch was cut from, for diffing. */
  baseRef?: string;
  /** The git backend (worktrees + merge queue) this agent is integrating into,
   *  resolved from its project's repo. Unset in the Phase 0 / no-repo flow. */
  git?: GitContext;
  /** A private per-run tmp dir this orchestrator created for a chat-only run
   *  (no bound repo, no operator-configured SKYNET_RUNNER_CWD) — mutually
   *  exclusive with `git`. Removed on completion/failure/stop; never set for a
   *  git-backed run or one using the operator's own shared runnerCwd. */
  scratchCwd?: string;
  /** Set when a question this agent raised went unanswered and was auto-resolved
   *  by the no-operator-answer timeout. If it then finishes with no change, it's
   *  surfaced as needs-attention rather than a silent "done". */
  blockedUnanswered?: boolean;
}

/** The git integration backend bound to one repo: an isolated worktree per agent
 *  feeding a serialized merge queue. Resolved per project (its own local repo
 *  when git-backed, else the server-global integration repo) and cached by repo
 *  path so each repo keeps exactly one worktree provisioner + one merge queue. */
interface GitContext {
  repo: string;
  worktrees: WorktreeProvisioner;
  merge: MergeEngine;
}

export class NoCapacityError extends Error {
  constructor(message?: string) {
    super(message ?? "No idle runner available");
    this.name = "NoCapacityError";
  }
}

/** No runner can execute — the fleet is empty, or the executor has no API key.
 *  The route maps this to 409 so agent creation is refused rather than spawning
 *  an agent that can only fail. */
export class RunnerNotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunnerNotConfiguredError";
  }
}

/** A task can't be assigned because it's already handled (assigned or done). The
 *  route maps this to 409 so a double-assign is rejected, never double-spawned. */
export class TaskAlreadyAssignedError extends Error {
  constructor(message: string, readonly agent?: TaskRun) {
    super(message);
    this.name = "TaskAlreadyAssignedError";
  }
}

/**
 * requestReview()'s failure modes — each an honest, actionable reason a manual
 * "Request review" couldn't run, rather than a silent no-op or a fake success.
 * The single-agent-fleet case (no OTHER eligible agent can ever exist, since a
 * run can't review itself) is exactly why this can't be a hard block on
 * merging unreviewed work elsewhere — some projects genuinely have no way to
 * satisfy it.
 */
export class NoOpenReviewGateError extends Error {
  constructor() {
    super("This run has no open review gate right now — nothing for a review to attach to.");
    this.name = "NoOpenReviewGateError";
  }
}
export class AlreadyReviewedError extends Error {
  constructor(by: string, decision: string, reason: string) {
    super(`Already reviewed by ${by} — ${decision}: ${reason}`);
    this.name = "AlreadyReviewedError";
  }
}
export class NoReviewerAvailableError extends Error {
  constructor() {
    super("No other agent is free to review this right now — try again once one is idle, or review it yourself.");
    this.name = "NoReviewerAvailableError";
  }
}

/** requestRetriage()'s "nothing to re-triage" failure mode — the task isn't
 *  (or is no longer) sitting in `triage`. NoCapacityError covers the other
 *  failure mode (no idle agent right now) — same error every other manual
 *  on-demand action already uses for that. */
export class NoTriageTargetError extends Error {
  constructor() {
    super("This task isn't in triage right now — nothing to re-triage.");
    this.name = "NoTriageTargetError";
  }
}

/**
 * PURE: extract a trailing `{"estMinutes": N, "clarity": "clear"|"unclear"}`
 * JSON tag off the triage LLM's reply. Returns the body (with the tag stripped)
 * plus each parsed field. Tolerates a code fence around the tag; ignores
 * non-numeric / malformed / missing values individually — a bad `estMinutes`
 * doesn't strip a valid `clarity` and vice versa. A missing signal stays
 * missing (never fabricated). Exported for the unit tests.
 *
 * `clarity` drives auto-promote triage→todo: only "clear" tasks auto-advance
 * (and only when they also have an eligibility set). "unclear" and null both
 * park the task in triage for a human to promote.
 */
export interface TriageTag {
  body: string;
  estMinutes: number | null;
  clarity: "clear" | "unclear" | null;
  // Grouping picks: the id of a suitable existing feature / milestone, or null.
  // Raw here — assessTask validates them against the project's actual ids (the
  // model must pick from a supplied list; we never trust a fabricated id).
  featureId: string | null;
  milestoneId: string | null;
  // Structured triage card (v1.5): rough agent-effort size and a short risks
  // list, alongside the existing estimate/clarity/grouping signals. Same
  // "missing signal stays missing" rule as every other field here.
  effort: "small" | "medium" | "large" | null;
  risks: string[] | null;
  // What triage needs to know before this task is workable — only meaningful
  // alongside `clarity: "unclear"`. Same "missing signal stays missing" rule.
  questions: string[] | null;
}

export function splitEstMinutesTag(raw: string): TriageTag {
  const none: TriageTag = {
    body: (raw ?? "").trim(),
    estMinutes: null,
    clarity: null,
    featureId: null,
    milestoneId: null,
    effort: null,
    risks: null,
    questions: null,
  };
  const trimmed = (raw ?? "").trim();
  const noFence = trimmed.replace(/\n?```\s*$/, "").trimEnd();
  // Match the LAST balanced top-level {...} on the tail.
  const end = noFence.lastIndexOf("}");
  if (end === -1) return none;
  let depth = 0;
  let start = -1;
  for (let i = end; i >= 0; i--) {
    const c = noFence[i];
    if (c === "}") depth++;
    else if (c === "{") {
      depth--;
      if (depth === 0) { start = i; break; }
    }
  }
  if (start < 0) return none;
  try {
    const obj = JSON.parse(noFence.slice(start, end + 1)) as {
      estMinutes?: unknown;
      clarity?: unknown;
      featureId?: unknown;
      milestoneId?: unknown;
      effort?: unknown;
      risks?: unknown;
      questions?: unknown;
    };
    // Parse each field independently — a malformed one shouldn't drop the tag.
    const estMinutes =
      typeof obj.estMinutes === "number" && Number.isFinite(obj.estMinutes) && obj.estMinutes > 0
        ? Math.round(obj.estMinutes)
        : null;
    const clarity: "clear" | "unclear" | null =
      obj.clarity === "clear" || obj.clarity === "unclear" ? obj.clarity : null;
    const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
    const featureId = str(obj.featureId);
    const milestoneId = str(obj.milestoneId);
    const effort: "small" | "medium" | "large" | null =
      obj.effort === "small" || obj.effort === "medium" || obj.effort === "large" ? obj.effort : null;
    // Cap count + length so a garbage/runaway array can't bloat the task record —
    // a legitimate risks list is a handful of short lines, never a wall of text.
    const risks = Array.isArray(obj.risks)
      ? obj.risks.filter((r): r is string => typeof r === "string" && r.trim().length > 0).map((r) => r.trim().slice(0, 140)).slice(0, 5)
      : null;
    // Same cap/shape discipline as `risks` — a clarifying question is one
    // short line, and an unbounded list would bloat the task record.
    const questions = Array.isArray(obj.questions)
      ? obj.questions.filter((q): q is string => typeof q === "string" && q.trim().length > 0).map((q) => q.trim().slice(0, 200)).slice(0, 5)
      : null;
    // Only strip the tag from the body if AT LEAST ONE field parsed — if
    // none did the "JSON object" was probably a false positive in prose.
    if (
      estMinutes != null || clarity != null || featureId != null || milestoneId != null ||
      effort != null || (risks != null && risks.length > 0) || (questions != null && questions.length > 0)
    ) {
      const body = noFence.slice(0, start).replace(/```[a-zA-Z]*\s*$/, "").trim();
      return { body, estMinutes, clarity, featureId, milestoneId, effort, risks, questions };
    }
  } catch {
    /* not a JSON tail — whole reply is the body */
  }
  return none;
}

// Appended to every run brief. Scope creep — an agent finishing the ask and then
// wandering into unrequested adjacent work — is the #1 way a run burns its turn
// budget and stalls. Keep the agent inside the requested scope so it finishes.
const SCOPE_NOTE =
  "\n\n---\nScope discipline: do exactly what's asked above, then stop. Don't expand into adjacent or unrequested work — extra features, UI, refactors, or speculative follow-ups. When the requested change is complete, report and finish rather than inventing more scope. If you're genuinely blocked, or the task is too big for one focused session, escalate (AskUserQuestion with header \"ESCALATE\") instead of grinding through your turn budget.\n\nIf you spawned a subagent for research or exploration, wait for its result before concluding your own work — never finish a turn (including a no-changes-needed completion) while a subagent you launched is still running; its findings may change what \"done\" means here. If you decide to stop waiting on one, say why. And before reporting no changes are needed, check that against each concrete thing this task asked for — a plausible-looking comment or test elsewhere is a clue to verify, not proof by itself.";

// A deep-review reviewer (see Project.deepReview / runDeepReview) is a real but
// deliberately SHORT-LIVED agent run — read the brief, browse the live preview,
// answer with a verdict. A low turn budget keeps its cost bounded and its own
// runtime/idle caps as a backstop; this wall-clock timeout is belt-and-suspenders
// in case those never fire (e.g. a handle that never calls onCompleted/onFailed).
const DEEP_REVIEW_MAX_TURNS = 20;
const DEEP_REVIEW_TIMEOUT_MS = 6 * 60_000;

// The exact heading Operations.answerClarification stamps into a task's
// description above the operator's answer. Checking for OUR OWN literal
// marker — never classifying the model's free text — lets `assessTask` and
// the autonomy tick recognize "this task already went through one clarify
// round" deterministically, so a model that stays "unclear" even after being
// answered can't re-ask the same question forever (backlog → triage →
// backlog → ... with no way out). See the tickAutonomy triage step below.
export const CLARIFICATION_ANSWERED_MARKER = "**Clarifications** (asked at triage, answered by the operator):";

// The breaker (Project.breakerReview / runBreakerReview) runs strictly AFTER
// the deepReview reviewer above already approved — it's pure extra scrutiny on
// a change that's already been judged to work, so its own budget is tighter
// still: fewer turns, a shorter wall-clock backstop.
const BREAKER_MAX_TURNS = 12;
const BREAKER_TIMEOUT_MS = 4 * 60_000;

// S6's explore run (Orchestrator.exploreBrief) is read-only codebase grounding
// for a draft plan, not a live-app review — cheaper turn budget than deepReview
// (no browsing back and forth), shorter wall-clock backstop. No Agent exists
// yet at this point in a brief's life (it's pre-work, before any run/task), so
// there's no per-agent model to inherit — hardcoded to Claude's default model
// (matches DEFAULT_PROVIDERS' first "claude" entry in packages/shared/src/providers.ts).
const EXPLORE_MODEL = "opus-4.8";
const EXPLORE_MAX_TURNS = 14;
const EXPLORE_TIMEOUT_MS = 4 * 60_000;

// `withInstructions` now lives in agent-context.ts (alongside the fuller
// buildAgentContext it's superseded by for every real call site below) —
// re-exported here since tests/project-instructions.test.ts imports it from
// this module.
export { withInstructions };

/** Feature-scoped branch batching, step 2: true when a MergeRequest's SOURCE
 *  is a feature branch merging UP into the project's default integration
 *  branch (`featureId` unset — the destination isn't a feature branch — but
 *  `agentBranch` names one), as opposed to step 1 (a task merging INTO its
 *  feature branch, `featureId` set) or a normal per-run merge (neither).
 *  There's no single "owning run" for this step — the callback wiring and
 *  HITL raising both need to know not to treat `req.runId` as one. */
export function isFeatureUpMerge(req: MergeRequest): boolean {
  return !req.featureId && req.agentBranch.startsWith(FEATURE_BRANCH_PREFIX);
}

/** Which (if any) feature-batch size guardrail a batch trips, and by how much
 *  — pure, exported for direct unit tests (see buildFeatureMergeBriefing,
 *  which floors risk to "high" and appends this to the rationale when
 *  `tripped`). Never blocks anything itself; a caller decides what to do with
 *  the verdict. Checks EVERY threshold (not just the first) so the rationale
 *  names every one that's over, not just whichever happened to be checked first. */
export interface FeatureBatchSizeCheck {
  tripped: boolean;
  /** e.g. "14 tasks (2 over the 12-task limit)"; joined with "; " when more
   *  than one threshold trips. Null when nothing tripped. */
  reason: string | null;
}
export function checkFeatureBatchSize(
  batch: { taskCount: number; changedLines: number; filesChanged: number },
  thresholds: { maxTasks: number; maxChangedLines: number; maxFiles: number },
): FeatureBatchSizeCheck {
  const overs: string[] = [];
  if (batch.taskCount > thresholds.maxTasks) {
    overs.push(`${batch.taskCount} tasks (${batch.taskCount - thresholds.maxTasks} over the ${thresholds.maxTasks}-task limit)`);
  }
  if (batch.changedLines > thresholds.maxChangedLines) {
    overs.push(`${batch.changedLines} changed lines (${batch.changedLines - thresholds.maxChangedLines} over the ${thresholds.maxChangedLines}-line limit)`);
  }
  if (batch.filesChanged > thresholds.maxFiles) {
    overs.push(`${batch.filesChanged} files changed (${batch.filesChanged - thresholds.maxFiles} over the ${thresholds.maxFiles}-file limit)`);
  }
  return { tripped: overs.length > 0, reason: overs.length ? overs.join("; ") : null };
}

// ─── Self-replenishing backlog — scope taxonomy is the valve ────────────────
// The fleet may PROPOSE new work from what it discovers while reviewing a run
// (see review-verdict.ts's ProposedTask); it can never GRANT itself scope.
// Bounded so the loop can't run away by construction, not by judgment call:
//   • in-scope (a defect/gap in what THIS change just built) may auto-promote
//     into the SAME Feature's already-approved batch — but only while that
//     batch is still under the feature-size guardrail (Task 4) AND the
//     project is still under its daily budget (Task 2); either one tripping
//     degrades the proposal to a parked, human-promoted one instead, same as
//     new-scope. A Feature that's shipped/paused, or a proposal with no
//     Feature to place it under at all, degrades the same way.
//   • new-scope (anything outside what was actually asked) ALWAYS parks —
//     full stop, no setting relaxes this. Growth into new territory needs a
//     human; growth fixing what's already approved does not.
//   • MAX_PROPOSALS_PER_REVIEW caps the fastest possible rate from any single
//     review; the daily per-project cap (config.fleetProposalMaxPerProjectPerDay)
//     backstops the cumulative rate across a whole day of reviews; dedup
//     against the project's own open tasks stops the same discovery from
//     re-proposing itself review after review. The session circuit-breaker
//     (Task 3) is the last-resort behavioral backstop if a project is
//     technically under every one of these ceilings but visibly churning.

/** Case/whitespace-normalized task title for near-exact dedup — same
 *  discipline as the repo-file checklist import's own `.trim().toLowerCase()`
 *  dedup (operations.ts's `maybeAutoClone`-adjacent import path). Deliberately
 *  simple: exact-after-normalization only, never fuzzy/semantic matching — a
 *  near-miss that ISN'T a true duplicate must still get through (the brief's
 *  "when in doubt, create as parked" default), not be silently swallowed by
 *  an overzealous matcher. */
export function normalizeProposalTitle(text: string): string {
  return text.trim().toLowerCase().replace(/\s+/g, " ");
}

export interface ProposalPlacementContext {
  /** Already-normalized titles of the project's own OPEN tasks (not done, not
   *  archived) — the caller adds each newly-created title as it goes, so two
   *  identical proposals in the SAME review batch don't both land. */
  openTaskTitles: Set<string>;
  /** Status of the Feature the source task belongs to; null when the source
   *  task isn't under any Feature — there's nothing for "in-scope" to mean in
   *  that case, so it always degrades. */
  featureStatus: FeatureStatus | null;
  /** Non-archived task count already under that Feature (excluding the one
   *  about to be added) — same count `maybeWarnFeatureBatchSize` computes. */
  siblingCountInFeature: number;
  featureBatchMaxTasks: number;
  /** Orchestrator.underDailyBudget's answer for the project right now. */
  underBudget: boolean;
}

export type ProposalPlacement =
  | { action: "skip-duplicate" }
  | { action: "create-parked"; degradedReason: string | null }
  | { action: "create-active" };

/** The scope-taxonomy valve, as a pure decision — no I/O, so every branch is
 *  directly unit-testable. `degradedReason` on a parked in-scope proposal
 *  names exactly which gate it failed, so the operator sees why it didn't
 *  auto-promote instead of a bare "parked". */
export function resolveProposalPlacement(
  proposal: Pick<ProposedTask, "title" | "scope">,
  ctx: ProposalPlacementContext,
): ProposalPlacement {
  if (ctx.openTaskTitles.has(normalizeProposalTitle(proposal.title))) return { action: "skip-duplicate" };
  if (proposal.scope === "new-scope") return { action: "create-parked", degradedReason: null };
  // in-scope from here — every gate must pass, or it degrades like new-scope.
  if (!ctx.featureStatus) return { action: "create-parked", degradedReason: "no feature to place it under" };
  if (ctx.featureStatus !== "active") {
    return { action: "create-parked", degradedReason: `feature is ${ctx.featureStatus}, not active` };
  }
  if (ctx.siblingCountInFeature >= ctx.featureBatchMaxTasks) {
    return { action: "create-parked", degradedReason: `feature already at the ${ctx.featureBatchMaxTasks}-task batch guardrail` };
  }
  if (!ctx.underBudget) return { action: "create-parked", degradedReason: "project is over its daily budget" };
  return { action: "create-active" };
}

/** How many fleet-authored tasks (source.kind === "fleet") this project has
 *  already accepted since local midnight — counts BOTH auto-promoted and
 *  parked proposals (a flood of parked ones is still noise a human has to
 *  triage, so both count against the same daily ceiling). Mirrors
 *  computeDailySpend's own dayWindow so "today" means the same thing here as
 *  it does for the budget gate. */
export function countFleetProposalsToday(projectTasks: Task[], at: number): number {
  const { start, end } = dayWindow(at);
  return projectTasks.filter((t) => {
    if (t.source?.kind !== "fleet") return false;
    const createdAt = fleetTaskCreatedAt(t);
    return createdAt >= start && createdAt < end;
  }).length;
}

/** Task has no createdAt field — order (append-only, increases with age) is
 *  the closest existing proxy, but a fleet task's OWN `id` embeds ordering
 *  via Orchestrator's monotonic `this.seq`, which isn't recoverable here
 *  either. Fleet proposals are the only Task producer that needs a real
 *  creation timestamp, so it rides in `TaskSource.fleet` itself rather than
 *  adding a field every other Task producer would need to backfill. */
function fleetTaskCreatedAt(task: Task): number {
  return task.source?.kind === "fleet" ? task.source.proposedAt : 0;
}

// ─── Ready-to-merge briefing — pure, exported for direct unit tests ─────────
// The decision-aid on the ready-to-merge card is built from data already in
// hand (the diff stat + mapped modules) plus the AI reviewer's recorded
// verdict when present — no LLM call, no I/O. Kept as standalone functions
// (not private Orchestrator methods) specifically so the sensitive-file/risk
// logic — the evidence an operator actually needs to trust a merge
// recommendation — can be unit-tested directly, without spinning up a git
// worktree + GitHub push just to reach it.

/** Sensitive areas — a change touching these reads as higher-risk on the
 *  ready-to-merge card (matched against module ids AND file paths, case-insensitive). */
const SENSITIVE_AREA =
  /(auth|login|session|token|secret|credential|password|payment|billing|charge|invoice|migration|schema|infra|deploy|terraform|k8s|kubernetes|security|permission|rbac)/i;

/** The actual file paths (plus any matching module ids, folded in as synthetic
 *  "module: …" entries when no individual file name matches) that tripped the
 *  sensitive-area heuristic — the evidence behind "includes a sensitive area",
 *  not just the boolean fact of it. */
export function mergeSensitiveFiles(files: string[], modules: string[]): string[] {
  const hits = files.filter((f) => SENSITIVE_AREA.test(f));
  if (!hits.length) for (const m of modules) if (SENSITIVE_AREA.test(m)) hits.push(`module: ${m}`);
  return hits;
}

/** Does the diff touch anything that reads as a test file? */
export function mergeTouchesTests(files: string[]): boolean {
  return files.some((f) => /(\.test\.|\.spec\.|\/tests?\/|__tests__)/i.test(f));
}

// A fixed, narrow policy list — distinct from SENSITIVE_AREA's broad word-match
// heuristic above — for the handful of path shapes where a bad LLM instinct
// plus a green light does the most damage: CI/deploy config, schema
// migrations, auth code, and dependency manifests. Surfaced on BOTH the
// diff-review gate (raiseDiffReview) and the ready-to-merge briefing so a
// reviewer sees it at every stage, not just one. Display-only here — this
// mirrors, not replaces, the merge-guardrails path-policy that decides what
// actually blocks an auto-merge.
const REQUIRES_HUMAN_PATTERNS: { label: string; re: RegExp }[] = [
  { label: "migrations/**", re: /(^|\/)migrations\// },
  { label: ".github/workflows/**", re: /^\.github\/workflows\// },
  { label: "auth/**", re: /(^|\/)auth\// },
];
const DEPENDENCY_MANIFESTS = new Set([
  "package.json", "package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml",
  "go.mod", "go.sum", "Cargo.toml", "Cargo.lock", "requirements.txt", "Pipfile", "Pipfile.lock",
  "pyproject.toml", "poetry.lock", "composer.json", "composer.lock", "Gemfile", "Gemfile.lock",
]);

/** The specific glob/category labels a diff's file list trips against the
 *  fixed "always needs a human" policy list — the evidence behind the
 *  "requires human" marker, not just its boolean fact. Empty = none matched. */
export function mergeRequiresHumanGlobs(files: string[]): string[] {
  const matched = new Set<string>();
  for (const f of files) {
    for (const { label, re } of REQUIRES_HUMAN_PATTERNS) if (re.test(f)) matched.add(label);
    if (DEPENDENCY_MANIFESTS.has(f.split("/").pop() ?? f)) matched.add("dependency manifest");
  }
  return [...matched];
}

/** Risk for the ready-to-merge card: a sensitive area → high; an otherwise
 *  broad change → medium; else low. */
export function mergeRisk(stat: { add: number; del: number; files: string[] }, sensitive: boolean): Risk {
  const big = stat.files.length > 15 || stat.del > 400 || stat.add + stat.del > 800;
  return sensitive ? "high" : big ? "medium" : "low";
}

const mergeImpact = (modules: string[], filesLen: number, sensitive: boolean, touchesTests: boolean): string =>
  [
    modules.length
      ? `Touches ${modules.slice(0, 6).join(", ")}${modules.length > 6 ? ` +${modules.length - 6} more` : ""}`
      : `${filesLen} file(s), no mapped module`,
    sensitive ? "includes a sensitive area (auth/data/infra)" : null,
    touchesTests ? "changes tests" : "no test changes",
  ]
    .filter(Boolean)
    .join(" · ");

/** Build the ready-to-merge decision-aid for a single run's PR. `verdict` is
 *  the task's recorded AI review (task.reviewVerdict), when one ran. */
export function computeMergeBriefing(input: {
  runName: string;
  authoredBy: string | null;
  verdict: { by: string; reason: string; decision: "approve" | "flag" } | null;
  stat: { add: number; del: number; files: string[] };
  modules: string[];
}): MergeBriefing {
  const { runName, authoredBy, verdict, stat, modules } = input;
  const files = stat.files;
  const sensitiveFiles = mergeSensitiveFiles(files, modules);
  const sensitive = sensitiveFiles.length > 0;
  const touchesTests = mergeTouchesTests(files);
  const requiresHumanGlobs = mergeRequiresHumanGlobs(files);
  const requiresHuman = requiresHumanGlobs.length > 0;
  return {
    summary: `${runName} — ${stat.add}+/${stat.del}− across ${files.length} file(s)`,
    impact: mergeImpact(modules, files.length, sensitive, touchesTests),
    risk: requiresHuman ? "high" : mergeRisk(stat, sensitive),
    recommendation: verdict?.decision === "flag" ? "rework" : "merge",
    rationale: verdict ? `${verdict.by}: ${verdict.reason}` : "No AI review recorded — merge at your discretion.",
    by: verdict?.by ?? "heuristic",
    add: stat.add,
    del: stat.del,
    filesChanged: files.length,
    modules,
    sensitiveFiles,
    testsChanged: touchesTests,
    authoredBy,
    reviewedBy: verdict?.by ?? null,
    reviewDecision: verdict?.decision ?? null,
    featureBrief: null, // single-run PR — never drafted for these (see feature-brief.ts)
    requiresHuman,
    requiresHumanGlobs,
  };
}

/** Build the ready-to-merge decision-aid for a feature-scoped batch PR (several
 *  tasks sharing one PR). `flaggedCount` → any flagged sibling forces "rework"
 *  so a batch never hides one task's flagged concern behind its siblings'
 *  clean ones; `anyReviewed` keeps `reviewDecision` honestly null when nothing
 *  in the batch was ever reviewed, rather than implying a blanket approval. */
export function computeFeatureMergeBriefing(input: {
  featureName: string;
  taskNames: string[];
  stat: { add: number; del: number; files: string[] };
  modules: string[];
  flaggedCount: number;
  anyReviewed: boolean;
}): MergeBriefing {
  const { featureName, taskNames, stat, modules, flaggedCount, anyReviewed } = input;
  const files = stat.files;
  const sensitiveFiles = mergeSensitiveFiles(files, modules);
  const sensitive = sensitiveFiles.length > 0;
  const touchesTests = mergeTouchesTests(files);
  const requiresHumanGlobs = mergeRequiresHumanGlobs(files);
  const requiresHuman = requiresHumanGlobs.length > 0;
  return {
    summary: `${featureName} — ${stat.add}+/${stat.del}− across ${files.length} file(s), ${taskNames.length} task(s): ${taskNames.slice(0, 4).join(", ")}${taskNames.length > 4 ? ` +${taskNames.length - 4} more` : ""}`,
    impact: mergeImpact(modules, files.length, sensitive, touchesTests),
    risk: requiresHuman ? "high" : mergeRisk(stat, sensitive),
    recommendation: flaggedCount > 0 ? "rework" : "merge",
    rationale:
      flaggedCount > 0
        ? `${flaggedCount} of ${taskNames.length} task(s) were flagged on review — check before merging.`
        : "No flagged tasks in this batch.",
    by: "heuristic",
    add: stat.add,
    del: stat.del,
    filesChanged: files.length,
    modules,
    sensitiveFiles,
    testsChanged: touchesTests,
    // A batch spans several tasks (each possibly a different author/reviewer
    // pair) — no single "authored by"/"reviewed by" applies (per-task review
    // decisions already surface via `rationale`'s flagged count).
    authoredBy: null,
    reviewedBy: null,
    reviewDecision: flaggedCount > 0 ? "flag" : anyReviewed ? "approve" : null,
    featureBrief: null, // filled in by openPrForFeature (draftFeatureBrief) after this heuristic returns
    requiresHuman,
    requiresHumanGlobs,
  };
}

/** Why a run got halted and handed to a human — see `escalate()`/`raiseEscalationCard()`.
 *  "agent" is agent-driven (the run itself called AskUserQuestion with header
 *  "ESCALATE") and is set directly in `raise()`, never via `escalate()`. */
type EscalationSource = "timeout" | "failures" | "conflict" | "turns" | "stalled" | "billing" | "agent" | "stuck-review" | "paused";

export class Orchestrator {
  private live = new Map<string, LiveAgent>();
  // Global kill switch. When paused, the autonomy loop is a no-op (no new work is
  // triaged, picked, or auto-reviewed) — set by the Telegram /stop kill switch and
  // cleared by /resume. The janitorial loops (reaper/GC) are deliberately NOT
  // gated by this: "stop all processing" means halt live runs + pause autonomy,
  // not freeze orphan cleanup.
  private paused = false;
  private chatWaiters = new Map<string, (reply: string) => void>();
  // Pending no-operator-answer timers for open `question` HITLs, keyed by item id.
  private questionTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private seq = 0;
  // Serializes runner acquisition (find-idle → mark-busy). The find and the busy
  // write are separated by an `await`, so without this two concurrent acquires
  // could both observe the SAME idle runner and hand it to two agents (TOCTOU
  // double-booking). Every acquire chains onto this promise so the read-check-
  // write runs atomically; a busy-marked runner is persisted before the next
  // acquire's find() reads, so it can never be re-selected. Mirrors the Hub's
  // per-hitl-id resolve mutex.
  private acquireLock: Promise<unknown> = Promise.resolve();
  // One lazily-loaded provider backend per provider id (real backends are heavy).
  private providers = new Map<string, Promise<RunnerProvider>>();
  // One module map per repo path, resolved from a project's OWN repo when it's
  // git-backed (its `.skynet/modules.json`), else the server-global integration
  // repo. Cached so the map file is read at most once per repo, not per diff —
  // and so a project bound to its own repo never silently uses the fallback of
  // some other repo's catalog. See moduleMapFor().
  private moduleMaps = new Map<string, ModuleMap>();
  // One git backend per repo path (worktrees + serialized merge queue), built on
  // demand. Keyed by repo so a project's local repo and the global integration
  // repo each get their own queue.
  private gitCtx = new Map<string, GitContext>();
  // Runs parked at a diff review, keyed by runId. The live entry is dropped when
  // a review is raised (compute is freed while a human reviews), so this holds
  // the little that a `modify` needs to resume the run for a revision in its
  // still-present worktree (see reviseAfterReview / deliver()). Cleared on merge.
  private reviews = new Map<string, { git: GitContext; baseRef: string; taskId: string | null }>();
  // Runs HALTED on an escalation (agent gave up, too long, or too many failures),
  // keyed by runId. Holds the worktree/git context a resume/reassign needs even
  // after the live handle is torn down. Presence = "already escalated" (so a
  // guard doesn't re-raise). Cleared when the escalation is resolved or the run
  // completes. See escalate() / deliverEscalation() / relaunchEscalated().
  // `agentId` is the runner this run escalated FROM — captured so a later
  // Reassign can explicitly exclude it (see relaunchEscalated): now that
  // every escalation frees its runner immediately at raise time (rather than
  // holding it busy until reassign's own acquire-then-free), that runner is
  // idle again by the time reassign runs and would otherwise just get
  // re-picked as its own "replacement".
  private escalations = new Map<string, { git?: GitContext; baseRef?: string; taskId: string | null; source: EscalationSource; agentId?: string | null }>();
  // Per-run failure counter (onFailed): past config.runMaxFailures the run is
  // escalated instead of parked in `review`. Cleared on success/resolution.
  private failCounts = new Map<string, number>();
  // Session circuit-breaker: consecutive BAD autonomy outcomes (a flagged
  // auto-review verdict, or a failed run) for the SAME project, with no good
  // outcome in between. Keyed by projectId. In-memory: a restart resets it to
  // 0, which fails OPEN (one more attempt is allowed before the breaker can
  // trip again) — an accepted trade-off, not a safety gap: this breaker is a
  // BEHAVIORAL stop (don't keep grinding through tasks on a project that's
  // clearly stuck), layered on top of the per-run/per-key breakers above and
  // whatever spend budget the operator has configured, not the only guard.
  // Cleared on any good outcome, or when the operator re-enables the
  // project's `autonomy` toggle (see resetAutonomyStreak, called from
  // operations.ts#updateProject).
  private autonomyStreaks = new Map<string, { count: number; entries: string[] }>();
  // Key-health circuit breaker: credentials (`${ws}:${credentialId ?? provider}`)
  // known to be out of credits/quota. `providerUsable` refuses a depleted key so
  // NO new run is assigned to it (and auto-provision skips it) — stopping the
  // cascade of per-run billing failures. Cleared when a run on the key succeeds,
  // or when its escalation is resumed (operator topped up). In-memory: a restart
  // re-learns it on the next failed call, which is correct (the key may be fixed).
  private depletedKeys = new Map<string, { reason: string; at: number }>();
  // Runs already told "main moved" — so the periodic freshness sweep nudges once,
  // not every tick. Cleared if the branch catches back up (e.g. after a resync).
  private baseMovedFlagged = new Set<string>();
  // Projects currently paused by their daily budget — so the "autonomy paused
  // for today" line logs once per PAUSE, not once per tick. Cleared (re-armed,
  // silently) once spend drops back under budget — which happens on its own at
  // local midnight, since the spend window is always recomputed from `now()`.
  private budgetPausedFlagged = new Set<string>();

  // `providerOverride` is a test seam — inject a runner provider directly instead
  // of resolving the runner's own provider. Production always passes (store, hub) only.
  constructor(
    private store: Store,
    private hub: Hub,
    private providerOverride?: RunnerProvider,
    // Test seam mirroring providerOverride: an injected preview manager
    // short-circuits `runDeepReview`'s use of the real `projectPreview`
    // singleton, so a deep-review test can point at an isolated worktrees dir
    // instead of the process-wide default.
    private previewOverride?: Pick<ProjectPreviewManager, "startRun" | "dirFor" | "stop">,
    // Test seam for exploreBrief's detached checkouts: `config.worktreesDir` is
    // a plain value read ONCE at module-import time (not a live env lookup),
    // so a test can't retarget it via process.env in beforeEach the way
    // previewOverride's injected manager sidesteps the same problem — this
    // does the equivalent for exploreBrief specifically.
    private exploreWorktreesDirOverride?: string,
  ) {}

  /** Build (or reuse) the git backend for a repo path + base branch. Cached so
   *  each (repo, base) keeps exactly one worktree provisioner and one serialized
   *  merge queue (§2). The base is part of the key: a project can point its runs
   *  at a feature branch instead of `main` (they cut from it, sync to it, and PR
   *  against it), so the same repo may back two contexts on different bases. */
  private gitContextForRepo(repo: string, baseBranch: string = config.baseBranch): GitContext {
    const key = `${repo}::${baseBranch}`;
    let ctx = this.gitCtx.get(key);
    if (!ctx) {
      const worktrees = new WorktreeProvisioner(repo, baseBranch, config.worktreesDir);
      const merge = new MergeEngine(
        repo,
        baseBranch,
        {
          // Feature-scoped branch batching step 2 (feature branch → project
          // integration branch, local-only projects) has no single owning run —
          // `isFeatureUpMerge` distinguishes it so completion/failure don't
          // corrupt an unrelated (already-done) run's state. Step 1 (a task
          // merging INTO its feature branch) is a normal per-run merge in every
          // other respect and needs no special-casing here.
          onMerged: (req) => (isFeatureUpMerge(req) ? this.completeFeatureMerged(req) : this.completeMerged(req.runId, req.agentBranch)),
          onConflict: (req, files, conflictDiff, targetBranch) => this.raiseMergeHitl(req, files, conflictDiff, targetBranch),
          onChecksFailed: async (req, out) => {
            if (isFeatureUpMerge(req)) {
              // No single owning run to bounce back to "review" (or raise a
              // verifier gate against) — the checks failure is logged against
              // the borrowed anchor run for visibility, but its status is left
              // alone (it already legitimately completed its own step 1). The
              // merge commit was already rolled back by MergeEngine, so the
              // project's integration branch is unaffected; this needs a
              // human to notice and investigate.
              await this.hub.runLog(req.runId, `feature branch ${req.agentBranch} failed checks merging into the project's integration branch: ${out.slice(0, 200)}`);
              return;
            }
            await this.raiseVerifierFailedHitl(req, out);
          },
          onMergeFailed: (req, reason) => this.raiseMergeFailedHitl(req, reason),
          onLog: (id, line) => void this.hub.runLog(id, line),
        },
        config.checkCmd,
        worktrees.root, // scratch integration worktrees live beside the agent worktrees
      );
      ctx = { repo, worktrees, merge };
      this.gitCtx.set(key, ctx);
    }
    return ctx;
  }

  /** The effective base branch for a project: its own `baseBranch` when set, else
   *  the server-global default (SKYNET_BASE_BRANCH || "main"). */
  private baseBranchFor(project?: Project | null): string {
    return project?.baseBranch ?? config.baseBranch;
  }

  /** Where `run`'s approved diff integrates first — see derive/merge-target.ts.
   *  Resolves the run's direct parent + that parent's fleet runner and defers
   *  the actual decision to the pure `resolveMergeTarget`. Currently always
   *  returns `baseBranchFor(project)` in practice (nothing provisions a
   *  manager-role agent yet), by design — see that module for why. */
  private async mergeTargetBranchFor(run: TaskRun, project?: Project | null): Promise<string> {
    const fallback = this.baseBranchFor(project);
    if (!run.parentId) return fallback;
    const parent = await this.store.getRun(run.parentId);
    const parentRunner = parent?.agentId ? await this.store.getAgent(parent.agentId) : undefined;
    return resolveMergeTarget(run, parent, parentRunner, fallback);
  }

  /** Resolve the git backend for a project: its own local repo when git-backed,
   *  else the server-global integration repo, else none (Phase 0 → runnerCwd).
   *  Built on the project's effective base branch. */
  private gitContextFor(project?: Project | null): GitContext | undefined {
    const repo = project?.gitBacked && project.repoPath ? project.repoPath : config.integrationRepo;
    return repo ? this.gitContextForRepo(repo, this.baseBranchFor(project)) : undefined;
  }

  /** Resolve (and cache) the module map for a project: its own repo when
   *  git-backed (reads `<repoPath>/.skynet/modules.json`), else the server-global
   *  integration repo. Cached per repo path so the map is read once, and so a
   *  project's own catalog is used rather than a static global one (#3). */
  private moduleMapFor(project?: Project | null): ModuleMap {
    const repo = project?.gitBacked && project.repoPath ? project.repoPath : config.integrationRepo;
    const key = repo ?? "";
    let map = this.moduleMaps.get(key);
    if (!map) {
      map = loadModuleMap(repo);
      this.moduleMaps.set(key, map);
    }
    return map;
  }

  /** Resolve the git backend for an existing agent (prefers the live entry, else
   *  looks it up via the agent's project). Used by post-completion cleanup. */
  private async gitContextForAgent(runId: string): Promise<GitContext | undefined> {
    const live = this.live.get(runId);
    if (live?.git) return live.git;
    const agent = await this.store.getRun(runId);
    const project = agent ? await this.store.getProject(agent.projectId) : null;
    return this.gitContextFor(project);
  }

  // Resolve the execution backend for an agent. The provider is the fleet
  // runner's own provider (runner.provider) — there is no global override and no
  // mock. Real backends load on demand (heavy) and are cached per id.
  private getProvider(id: string): Promise<RunnerProvider> {
    // Test seam: an injected provider short-circuits resolution.
    if (this.providerOverride) return Promise.resolve(this.providerOverride);
    let p = this.providers.get(id);
    if (!p) {
      p = (() => {
        switch (id) {
          case "claude":
            return import("@skynet/runner-sdk/claude").then((m) => new m.ClaudeRunnerProvider());
          case "codex":
            return import("@skynet/runner-sdk/codex").then((m) => new m.CodexRunnerProvider());
          case "gemini":
            return import("@skynet/runner-sdk/gemini").then((m) => new m.GeminiRunnerProvider());
          case "cursor":
            return import("@skynet/runner-sdk/cursor").then((m) => new m.CursorRunnerProvider());
          case "copilot":
            return import("@skynet/runner-sdk/copilot").then((m) => new m.CopilotRunnerProvider());
          case "hermes":
            return import("@skynet/runner-sdk/hermes").then((m) => new m.HermesRunnerProvider());
          case "opencode":
            return import("@skynet/runner-sdk/opencode").then((m) => new m.OpenCodeRunnerProvider());
          default:
            // An unresolvable provider is a loud error — there is no mock fallback.
            return Promise.reject(new Error(`Unknown runner provider "${id}" (expected claude|codex|gemini|cursor|copilot|hermes|opencode).`));
        }
      })();
      this.providers.set(id, p);
    }
    return p;
  }

  private slug(text: string): string {
    return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 32);
  }

  private events(): RunnerEvents {
    return {
      onLog: (runId, line, detail) => void this.hub.runLog(runId, line, detail),
      onLogDelta: (runId, delta) => void this.hub.runLogDelta(runId, delta),
      onProgress: (runId, progress, plan) => void this.hub.runProgress(runId, progress, plan),
      onUsage: (runId, usage) => void this.hub.runUsage(runId, usage),
      onHeartbeat: (runId) => void this.hub.runHeartbeat(runId),
      // "done" is the ORCHESTRATOR's decision, made in complete()/completeMerged
      // only AFTER a finished agent's diff has been committed → reviewed → merged
      // (or confirmed genuinely empty). A runner that flips itself to "done" on
      // finish() would mark the agent done while its edits are still uncommitted;
      // an observer polling that window sees a premature "done" with an empty diff
      // and the work looks silently dropped. Ignore a runner-emitted "done" here —
      // onCompleted drives the real terminal transition. Other statuses
      // (running/waiting/review) pass through unchanged.
      onStatus: (runId, status) => {
        if (status === "done") return;
        void this.hub.runStatus(runId, status);
      },
      onHitl: (runId, raise, untrustedReads) => void this.raise(runId, raise, untrustedReads),
      onCompleted: (runId, branch) => void this.complete(runId, branch),
      onFailed: (runId, reason) => void this.fail(runId, reason),
      onChatReply: (runId, text) => {
        const waiter = this.chatWaiters.get(runId);
        if (waiter) {
          waiter(text);
          this.chatWaiters.delete(runId);
        }
        void this.hub.runLog(runId, `↳ ${text}`);
      },
    };
  }

  private async raise(runId: string, raise: HitlRaise, untrustedReads?: UntrustedRead[]): Promise<void> {
    const agent = await this.store.getRun(runId);
    if (!agent) return;
    // A clarifying `question` gets an optional no-operator-answer deadline so a
    // headless/idle run doesn't hang forever waiting on a human (0 = disabled).
    const timeout = config.hitlQuestionTimeoutMs;
    const expiresAt = raise.kind === "question" && timeout > 0 ? now() + timeout : null;
    // Enrich a command-approval gate with the safety classifier's real severity +
    // reason, so the operator sees WHY it's risky (not just a flat "medium"). The
    // runner already decided to gate; this only adds honest, specific context.
    const rank = { low: 0, medium: 1, high: 2 } as const;
    let risk = raise.risk;
    const why = raise.why;
    let flags: string[] = [];
    const policy = await resolveActivePolicy(this.store, agent.workspaceId);
    if (raise.kind === "approval" && raise.command) {
      const verdict = classifyCommand(raise.command, policy);
      if (rank[verdict.risk] > rank[risk]) risk = verdict.risk;
      // Surface the classifier's real reasons as scannable chips (not buried in
      // prose) so the operator sees exactly WHY this needs approval.
      if (verdict.risk !== "low") flags = verdict.reasons.filter((r) => !/read-only|no-op/i.test(r));
    }
    // Prompt-injection / tool-poisoning firewall: classifyCommand above judges
    // the command by its OWN shape; this judges it by its CONTEXT — does it
    // look like it's following an instruction embedded in something the agent
    // read (a fetched page, a vendored file), rather than the operator's own
    // task? Only runs when there's something to check (a command gate with a
    // non-empty untrusted-read buffer) — most gates have neither, so this
    // stays a rare extra consult, not a tax on every approval. The outcome is
    // ALWAYS logged, even a benign one, so the firewall's activity is
    // auditable and not just its hits. A failed/unreadable consult fails open
    // (steered: false) — classifyCommand's own gate above still applies
    // regardless, so a failed check only loses the extra scrutiny.
    let steered = false;
    if (raise.kind === "approval" && raise.command && untrustedReads?.length) {
      try {
        const verdict = await this.checkInjectionSteering(agent, raise.command, untrustedReads);
        steered = verdict.steered;
        await this.hub.runLog(
          runId,
          steered
            ? `⚠ injection firewall: command looks steered by ${verdict.source ?? "untrusted content"} — ${verdict.reason}`
            : `injection firewall: checked ${untrustedReads.length} untrusted read(s), no steering detected — ${verdict.reason}`,
        );
        if (steered) {
          flags = [...flags, `prompt-injection-suspected${verdict.source ? `: ${verdict.source}` : ""}`];
          if (rank.medium > rank[risk]) risk = "medium";
        }
      } catch (err) {
        await this.hub.runLog(runId, `injection firewall check failed, failing open: ${(err as Error).message}`);
      }
    }
    // Context-aware blast-radius: classifyCommand judges the command string;
    // this judges WHERE it runs. An absolute path outside the agent's private
    // worktree means a mistake can't be confined to the disposable branch —
    // flag it and bump to high so auto-approval never quietly runs it.
    if (raise.kind === "approval" && raise.command) {
      const worktreePath = this.live.get(runId)?.git?.worktrees.pathFor(runId);
      const radiusFlags = blastRadiusFlags(raise.command, { worktreePath });
      if (radiusFlags.length) {
        flags = [...flags, ...radiusFlags];
        if (rank[risk] < rank.high) risk = "high";
      }
    }
    const item: HitlItem = {
      id: `q-${runId}-${++this.seq}`,
      workspaceId: agent.workspaceId,
      runId,
      kind: raise.kind,
      title: raise.title,
      why,
      risk,
      rationale: raise.rationale ?? null,
      raisedAt: now(),
      expiresAt,
      resolvedAt: null,
      resolution: null,
      command: raise.command ?? null,
      options: raise.options ?? null,
      recommended: raise.recommended ?? null,
      steps: raise.steps ?? null,
      diff: raise.diff ?? null,
      output: null,
      flags: raise.kind === "escalation" ? [...flags, "agent"] : flags,
      sourceBranchOverride: null,
    };
    // Auto-approve a reversible, in-sandbox command gate per the project's
    // approval policy (see approval-policy.ts), so the operator isn't asked to
    // confirm every command. Boundary ops (high-risk / deny) and non-command
    // gates fall through to a human. The gate is still recorded (audit trail
    // shows what was auto-approved and by which policy — nothing runs invisibly),
    // but we go through the SILENT hub path (`raiseAndAutoResolveHitl`) so no
    // `hitl.raised` event is published — Telegram/push subscribers only ping the
    // operator when a HUMAN is actually needed. `hitl.resolved` still fires.
    if (raise.kind === "approval" && !steered) {
      const project = await this.store.getProject(agent.projectId);
      const auto = decideAutoApproval({
        command: raise.command,
        level: project?.approvalLevel ?? "trusted",
        rules: project?.approvalRules ?? [],
        policy,
      });
      if (auto) {
        const resolution: Resolution = { action: "approve", optionIndex: null, guidance: null, targetBranch: null, memoryNote: null, resetWork: false, by: auto.by, at: now() };
        await this.hub.runLog(runId, `auto-approved (${auto.by}): ${item.command ?? item.title}`);
        await this.hub.raiseAndAutoResolveHitl(item, resolution);
        await this.deliver(item, resolution);
        return;
      }
    }
    // Agent-driven escalation: halt + free the runner exactly like a
    // system-driven escalation (escalate()) — a "blocked on a human" gate has
    // no reason to hold a compute slot idle for however long that takes.
    // Capture the worktree/git context so a later resume/reassign works
    // (relaunchEscalated re-acquires fresh compute in the same worktree,
    // same as the system-driven path already does) — this trades away the
    // narrower "resume the exact live session" optimization deliverEscalation
    // used to take for a live-handle `modify`, for consistent compute release.
    //
    // ONLY when `live.git` is set, though: a chat-only run (no bound repo —
    // see LiveAgent.scratchCwd) has no worktree for relaunchEscalated to
    // reacquire INTO, so freeing its runner here would make "Help & resume"
    // unrecoverable — deliverEscalation's live-handle-resume fallback stays
    // the real (only) path for that case, not dead code.
    if (raise.kind === "escalation") {
      const live = this.live.get(runId);
      if (live?.git) {
        await live.handle.stop().catch(() => undefined);
        await this.freeRunner(live.agentId);
        this.live.delete(runId);
      }
      this.escalations.set(runId, { git: live?.git, baseRef: live?.baseRef, taskId: live?.taskId ?? null, source: "agent", agentId: live?.agentId });
      await this.hub.runStatus(runId, "waiting"); // an escalation gate always blocks the run
      await this.hub.runLog(runId, `escalated by the agent${live?.git ? " — freed its runner" : ""} — ${raise.title}`);
    }
    await this.hub.raiseHitl(item);
    if (expiresAt != null) {
      this.questionTimers.set(item.id, setTimeout(() => void this.expireQuestion(item), timeout));
    }
  }

  /** No operator answered a `question` within its window: auto-resolve it as
   *  "no answer" through the normal resolve→deliver path so the audit records it,
   *  the Inbox clears, and the agent is told to conclude WITHOUT guessing. */
  private async expireQuestion(item: HitlItem): Promise<void> {
    this.questionTimers.delete(item.id);
    const current = await this.store.getHitl(item.id);
    if (!current || current.resolvedAt != null) return; // a human got there first
    const resolution: Resolution = {
      action: "reject",
      optionIndex: null,
      guidance: null,
      targetBranch: null,
      memoryNote: null,
      resetWork: false,
      by: "system:timeout",
      at: now(),
    };
    const resolved = await this.hub.resolveHitl(item.id, resolution);
    if (resolved && resolved.resolution?.at === resolution.at) {
      // Remember the agent concluded only because its question went unanswered,
      // so complete() can surface it as needs-attention instead of "done".
      const live = this.live.get(item.runId);
      if (live) live.blockedUnanswered = true;
      await this.hub.runLog(
        item.runId,
        `no operator answer within ${Math.round(config.hitlQuestionTimeoutMs / 1000)}s — asking the agent to conclude without guessing`,
      );
      await this.deliver(item, resolution);
    }
  }

  private async complete(runId: string, branch: string): Promise<void> {
    const live = this.live.get(runId);
    // The agent finished a turn → it's no longer failing/stuck; reset the guards.
    this.failCounts.delete(runId);
    this.escalations.delete(runId);
    // A successful turn proves the run's key works — clear any breaker on it.
    this.clearDepletedKey(await this.store.getRun(runId).catch(() => undefined));
    // Chat-only run (no bound repo — see LiveAgent.scratchCwd): mutually
    // exclusive with `git`, so this never races the diff/merge branches below.
    await this.releaseScratchCwd(live?.scratchCwd);

    // Real loop: the agent ran in an isolated worktree → commit its diff onto
    // its branch and raise a review. Approving it enqueues the branch onto the
    // merge queue (deliver → merge.enqueue → completeMerged).
    if (live?.git && live.baseRef !== undefined) {
      const wt = live.git.worktrees;
      const agent = await this.store.getRun(runId);
      const res = await wt
        .commitAll(runId, `Skynet agent ${runId}${agent ? `: ${agent.name}` : ""}`)
        .catch((err) => {
          void this.hub.runLog(runId, `commit failed: ${(err as Error).message}`);
          // A git error is NOT "nothing to integrate" — the agent may have real
          // edits we simply couldn't commit. Falling through to done would drop
          // them silently, so surface it for attention instead.
          return { committed: false, error: true } as const;
        });

      if (res.committed) {
        const stat = await wt.diffStat(runId, live.baseRef);
        // Fetched alongside the stat (not inside raiseDiffReview) since it's the
        // same worktree/baseRef this function already has in scope — raiseDiffReview
        // only needs the text, to draft the walkthrough and hand to the HITL.
        const patch = await wt.patch(runId, live.baseRef);
        await this.freeRunner(live.agentId); // compute is done; awaiting review
        await this.hub.runStatus(runId, "review");
        // The run produced a diff → its task enters the review column (a human or
        // an autonomous reviewer resolves the diff HITL, which merges → done).
        if (live.taskId) {
          const task = await this.store.getTask(live.taskId);
          if (task) await this.hub.upsertTask({ ...task, state: "review" });
        }
        await this.raiseDiffReview(runId, stat, patch);
        // Keep what a `modify` review resolution needs to resume this run for a
        // revision — its worktree survives (retire only happens on merge).
        this.reviews.set(runId, { git: live.git, baseRef: live.baseRef, taskId: live.taskId });
        this.live.delete(runId);
        return;
      }

      if ("error" in res && res.error) {
        // Couldn't commit a finished agent's worktree — needs-attention, never a
        // silent "done" that would lose the (possibly real) uncommitted work.
        await this.freeRunner(live.agentId);
        await this.hub.runStatus(runId, "review");
        await this.moveTaskToReview(live.taskId); // don't strand the card in Ongoing
        this.live.delete(runId);
        return;
      }

      // Nothing to integrate — retire the worktree and complete plainly.
      await this.hub.runLog(runId, "no changes to integrate");
      await wt.retire(runId).catch(() => undefined);
    } else if (live?.git) {
      await live.git.worktrees.retire(runId).catch(() => undefined);
    }

    // Reached here with no diff. If the agent only stopped because a question it
    // raised went unanswered, it did no real work — surface it as needs-attention
    // (never a silent "done"), leave its task open, and don't mark it completed.
    if (live?.blockedUnanswered) {
      await this.freeRunner(live.agentId);
      await this.hub.runStatus(runId, "review");
      await this.moveTaskToReview(live.taskId); // don't strand the card in Ongoing
      await this.hub.runLog(runId, "concluded without an answer to its question — needs attention (no change made)");
      this.live.delete(runId);
      return;
    }

    // A zero-diff completion against a task with explicit acceptance criteria (a
    // linked SolutionBrief's `acceptanceCriteria`) is exactly the shape of a
    // premature "nothing to do here" self-report — the agent decided the task
    // was already satisfied without producing any change to check that claim
    // against. Route to review instead of trusting it blindly; a genuinely
    // correct "already done" completion just costs one confirming look.
    if (live?.taskId) {
      const task = await this.store.getTask(live.taskId).catch(() => undefined);
      const brief = task ? await this.findTaskBrief(task, task.workspaceId) : undefined;
      if (brief && brief.acceptanceCriteria.some((c) => c.trim())) {
        await this.freeRunner(live.agentId);
        await this.hub.runStatus(runId, "review");
        await this.moveTaskToReview(live.taskId);
        await this.hub.runLog(
          runId,
          `concluded with no changes against ${brief.acceptanceCriteria.length} acceptance criterion/criteria — needs confirmation before closing`,
        );
        this.live.delete(runId);
        return;
      }
    }

    // Phase 0 / no-diff completion: free the runner, finish the task & agent.
    // The orchestrator sets "done" HERE (not the runner) — this is the only place
    // a genuinely change-free agent becomes terminal, so a runner's own "done" is
    // ignored (see events().onStatus) and can never precede real integration.
    await this.freeRunner(live?.agentId ?? null);
    if (live?.taskId) {
      const task = await this.store.getTask(live.taskId);
      if (task) await this.hub.upsertTask({ ...task, state: "done" });
    }
    await this.hub.runStatus(runId, "done");
    await this.hub.runCompleted(runId, branch);
    this.live.delete(runId);
  }

  /**
   * A runner could not execute (binary missing, auth failure, crash). Surface it
   * loudly and free the runner — but never mark the agent done, complete the
   * task, or integrate a branch. A broken runner must not look like success.
   */
  private async fail(runId: string, reason: string): Promise<void> {
    // Out of credits/quota (a billing wall, not a bug): trip the key breaker so
    // the fleet stops feeding runs to a dead key, and escalate this run as
    // resumable. Checked first — it's a distinct, key-level condition, not one of
    // the N generic failures that trip the failure-count guard.
    if (isCreditExhaustionError(reason)) {
      await this.tripKeyBreaker(runId, reason);
      return;
    }
    // "Ran out of turns" is a resumable checkpoint, not a crash — the worktree +
    // committed work are intact and the runner already tried to continue on its
    // own. Escalate straight to a human (Resume / Reassign / Stop) rather than
    // counting it as a failure and parking in `review` for another doomed try.
    if (/error_max_turns|out of turns/i.test(reason)) {
      await this.escalate(
        runId,
        "The agent hit its turn budget before finishing. Its work so far is saved on the branch — resume to continue where it left off, reassign it, or stop.",
        "turns",
      );
      return;
    }
    // Count failures on this run; past the threshold, hand it to a human
    // (escalation) instead of quietly parking in `review` for another doomed try.
    const priorCount = this.failCounts.get(runId) ?? 0;
    const count = priorCount + 1;
    this.failCounts.set(runId, count);
    const live = this.live.get(runId);
    // Session circuit-breaker: this run failing is one bad autonomy outcome for
    // its project — counted once per RUN (the first fail() call for this
    // runId), not once per internal retry attempt. The same run can call
    // fail() several times before its own runMaxFailures escalation above
    // trips (see tests/escalation.test.ts's 3-strikes test, which does exactly
    // that on one runId) — that's still just ONE run going badly, not several;
    // double/triple-counting it would let a single flaky run alone trip the
    // project breaker on top of (and racing) its own dedicated escalation.
    if (priorCount === 0) {
      await this.noteProjectRunFailure(runId, live?.taskId ?? null, reason).catch(() => undefined);
    }
    // Escalate on EVERY generic failure while the guard is enabled — not just
    // once the count crosses config.runMaxFailures. Below-threshold used to
    // fall through to a plain "review" parking with no HITL, but nothing here
    // ever retries the run on its own (there is no retry loop consuming the
    // count — each fail() call already fully terminates the run), so that
    // branch was just as terminal as escalating, minus the actionable
    // Resume/Reassign/Stop card. The result was runs quietly dead-ending in
    // review with nothing to click — exactly the "a lot of tasks stuck in
    // review" symptom this fixes. `count` still varies (a run resumed after an
    // earlier escalation can fail again, incrementing it) — it just no longer
    // gates WHETHER the operator is told, only what the reason text says.
    if (config.runMaxFailures > 0) {
      await this.escalate(runId, `${count} failed attempt(s) — latest: ${reason}`, "failures");
      return;
    }
    // Explicit opt-out (SKYNET_RUN_MAX_FAILURES=0): park silently, as before.
    await this.freeRunner(live?.agentId ?? null);
    await this.hub.runLog(runId, `runner failed — ${reason}. Not completed; needs attention.`);
    await this.hub.runStatus(runId, "review"); // visible needs-attention, NOT "done"
    await this.moveTaskToReview(live?.taskId); // don't strand the card in Ongoing
    if (live?.git) await live.git.worktrees.retire(runId).catch(() => undefined);
    await this.releaseScratchCwd(live?.scratchCwd);
    this.live.delete(runId);
  }

  /** Session circuit-breaker input: a run just failed — count it as one bad
   *  autonomy outcome for its project (see noteAutonomyBadOutcome). Excludes
   *  the credential-exhaustion and turn-budget cases above (fail()'s early
   *  returns) — those are a distinct billing wall / a resumable checkpoint,
   *  not the run "going badly", and each already has its own dedicated
   *  breaker/escalation. */
  private async noteProjectRunFailure(runId: string, taskId: string | null, reason: string): Promise<void> {
    if (config.autonomyMaxConsecutiveFailures <= 0) return;
    const run = await this.store.getRun(runId);
    if (!run) return;
    const project = await this.store.getProject(run.projectId);
    if (!project) return;
    const task = taskId ? await this.store.getTask(taskId) : null;
    const label = task ? `"${task.text}" failed — ${reason}` : `a run failed — ${reason}`;
    await this.noteAutonomyBadOutcome(project, runId, label);
  }

  /** Startup failed (no runner configured, worktree provisioning, runner.start
   *  threw): free the runner, surface it, and leave the agent visibly errored —
   *  never silently degraded. The caller rethrows so the API returns the error. */
  private async failStartup(runId: string, agentId: string, reason: string): Promise<void> {
    await this.freeRunner(agentId);
    await this.hub.runLog(runId, `failed to start — ${reason}. Needs attention.`);
    await this.hub.runStatus(runId, "review");
    await this.moveTaskToReview(this.live.get(runId)?.taskId); // don't strand the card in Ongoing
    // A worktree may have been provisioned before start threw — retire it.
    const ctx = await this.gitContextForAgent(runId).catch(() => undefined);
    if (ctx) await ctx.worktrees.retire(runId).catch(() => undefined);
    this.live.delete(runId);
  }

  /** Return a runner to the idle pool (no-op if it's already gone). */
  private async freeRunner(agentId: string | null): Promise<void> {
    if (!agentId) return;
    const runner = await this.store.getAgent(agentId);
    if (runner) await this.hub.upsertAgent({ ...runner, status: "idle", idleSince: now() });
  }

  /** Move a run's linked task into the `review` column. Called wherever a run
   *  enters `review` — including the needs-attention exits (commit/runner/startup
   *  failure, unanswered question), which previously flipped only the RUN to
   *  review and stranded its task in `ongoing`. The board places cards by
   *  task.state, so such a task showed a "review" chip while sitting in the
   *  Ongoing lane — locked and undraggable. Idempotent; only advances an in-flight
   *  task, never knocks a done / re-opened task back into review. */
  private async moveTaskToReview(taskId: string | null | undefined): Promise<void> {
    if (!taskId) return;
    const task = await this.store.getTask(taskId);
    if (task && task.state === "ongoing") await this.hub.upsertTask({ ...task, state: "review" });
  }

  /** Raise the `diff` review that gates a finished agent's branch into the queue. */
  private async raiseDiffReview(
    runId: string,
    stat: { add: number; del: number; files: string[] },
    patch: string,
    opts: { skipFullAutonomy?: boolean } = {},
  ): Promise<void> {
    const agent = await this.store.getRun(runId);
    if (!agent) return;
    // Modules the diff ACTUALLY touched, derived from the changed files via the
    // project's own module map — not the agent's declared scope (`agent.modules`,
    // initialized []), which would under- or mis-report what changed (#6).
    const project = await this.store.getProject(agent.projectId);
    const modules = this.moduleMapFor(project).modulesForFiles(stat.files);
    // Record what actually changed on the run so every view reflects it (the run
    // itself, not just the review card). `modifiedFiles` was never populated.
    await this.hub.runModifiedFiles(runId, stat.files);
    // A fixed path-policy list (migrations/**, .github/workflows/**, auth/**,
    // dependency manifests) always reads as high risk here, regardless of
    // diff size — same list the ready-to-merge briefing checks (see
    // mergeRequiresHumanGlobs's own comment); this is the earliest review
    // surface, so the marker should already be visible here, not just later.
    const requiresHumanGlobs = mergeRequiresHumanGlobs(stat.files);
    const risk: Risk = requiresHumanGlobs.length > 0 || stat.del > 200 || stat.files.length > 40 ? "high" : "medium";
    // Drafted BEFORE the item is raised — the reviewer should never see a diff
    // gate that later "pops in" a walkthrough or brief. Best-effort: any
    // failure (no consult support, no credential, unreadable reply) yields
    // null and the gate raises exactly as it did before either existed. Two
    // DISTINCT consults (different framing: "explain your diff" vs "name its
    // merge risks") — run CONCURRENTLY so guided merge adds one consult's
    // worth of latency to the gate, not two back-to-back.
    const [walkthrough, mergeBrief] = await Promise.all([
      this.draftDiffWalkthrough(agent, project, stat.files, patch),
      this.draftMergeBrief(agent, project, stat.files, patch),
    ]);
    // Guided merge — the branch this approval integrates into by default. The
    // SAME resolution deliver() uses (GitHub PR flow when connected, else the
    // local merge queue's integration branch) so the picker's default always
    // matches where an unmodified "Approve" would actually go.
    const git = this.gitContextFor(project);
    const conn = await githubService.get(agent.workspaceId).catch(() => null);
    const usesGithubFlow = !!(conn?.connected && project?.repo && git);
    const defaultTargetBranch = usesGithubFlow
      ? this.baseBranchFor(project)
      : git
        ? git.merge.integrationBranch(agent.projectId)
        : null;
    const item: HitlItem = {
      id: `q-diff-${runId}-${++this.seq}`,
      workspaceId: agent.workspaceId,
      runId,
      kind: "diff",
      // Concise, scannable title — the run/task is shown separately in every view
      // (queue card, audit row, run header), so embedding the whole task prompt
      // here just bloats the row. The stats + branch live in `why`.
      title: `Review diff — ${stat.add}+/${stat.del}− (${stat.files.length} file${stat.files.length === 1 ? "" : "s"})`,
      why:
        `Finished on ${agent.branch} — ${stat.add}+/${stat.del}- across ${stat.files.length} file(s). Approve to integrate.` +
        (requiresHumanGlobs.length > 0 ? ` Touches ${requiresHumanGlobs.join(", ")} — always needs a human look.` : ""),
      risk,
      raisedAt: now(),
      expiresAt: null,
      resolvedAt: null,
      resolution: null,
      rationale: null,
      command: null,
      options: null,
      recommended: null,
      steps: null,
      diff: { add: stat.add, del: stat.del, modules, files: stat.files, walkthrough, mergeBrief, defaultTargetBranch },
      output: null,
      // The fixed path-policy hits, as scannable chips — the evidence behind a
      // "high" risk on an otherwise-small diff. Empty when nothing in the
      // policy list matched, same as every other gate kind's `flags`.
      flags: requiresHumanGlobs,
      sourceBranchOverride: null,
    };
    // `full` autonomy (see ApprovalLevel in @skynet/shared) skips even a diff's
    // OWN human decision, unconditionally — no second agent, no LLM consult.
    // This is distinct from (and stacks on top of) `autoReview` below: a
    // "trusted" multi-agent project can ALREADY merge unattended when a
    // DIFFERENT fleet agent reviews this run's diff and approves it, but that
    // needs a second agent and its favorable verdict. `full` needs neither.
    // Requires the project's `autonomy` toggle too (the master "let agents act
    // without me" switch), and still gates a `high`-risk (unusually large)
    // diff for a human even at this level. Recorded via the SILENT hub path —
    // same pattern as the command-gate auto-approver in raise() — so it's a
    // real audited decision, not a human notification that immediately
    // self-cancels.
    // Known gap: this success never feeds the session circuit-breaker's good-
    // outcome signal (noteAutonomyGoodOutcome) — only autoReview's approve
    // does, per the breaker's explicit scope. A `full`-approval-level project
    // whose failures happen to interleave with (rather than follow) enough
    // full-auto-merges could accumulate toward the threshold without ever
    // resetting. Flagged, not silently missing — narrowing the breaker to
    // exactly the two mechanisms its spec named, rather than expanding scope.
    // `skipFullAutonomy`: forceIntegrateRun's own completeness check already
    // judged this diff incomplete — a `full`-autonomy policy auto-merging it
    // anyway right here would silently undo that finding, so this ONE caller
    // opts out of the fast path regardless of the project's approval level.
    if (!opts.skipFullAutonomy && project?.approvalLevel === "full" && project.autonomy && risk !== "high") {
      const resolution: Resolution = { action: "approve", optionIndex: null, guidance: null, targetBranch: null, memoryNote: null, resetWork: false, by: "policy:full-autonomy", at: now() };
      await this.hub.runLog(runId, `auto-merged (policy:full-autonomy): ${item.title}`);
      await this.hub.raiseAndAutoResolveHitl(item, resolution);
      await this.deliver(item, resolution);
      return;
    }
    await this.hub.raiseHitl(item);
  }

  /**
   * Ask the run's OWN provider/model whether a about-to-run command looks
   * steered by untrusted content the agent read earlier — a stateless
   * one-shot `consult`, same pattern as `draftDiffWalkthrough`/`autoReview`.
   * No `consult` support (most CLI runners today) → treated as "nothing to
   * check", not an error; classifyCommand's own gate still applies.
   */
  private async checkInjectionSteering(
    run: TaskRun,
    command: string,
    reads: UntrustedRead[],
  ): Promise<{ steered: boolean; reason: string; source: string | null }> {
    const provider = await this.getProvider(run.provider);
    if (!provider.consult) {
      return { steered: false, reason: "provider has no consult support — check skipped", source: null };
    }
    const apiKey = await secretService.resolve(run.workspaceId, run.credentialId ?? run.provider);
    const reply = await provider.consult(
      { task: run.name, model: run.model, cwd: config.runnerCwd, apiKey },
      buildInjectionPrompt(command, reads),
    );
    return parseInjectionVerdict(reply);
  }

  /**
   * Ask the run's OWN provider/model to explain its diff — a stateless
   * one-shot `consult`, same pattern as `autoReview` — before the diff HITL is
   * raised. Grounded on the real patch (`context`), not the agent's
   * self-reported summary. Empty patch (no git worktree) or no `consult`
   * support (most CLI runners today) → no walkthrough, not an error.
   */
  private async draftDiffWalkthrough(
    run: TaskRun,
    project: Project | null | undefined,
    files: string[],
    patch: string,
  ): Promise<DiffWalkthrough | null> {
    if (!patch) return null;
    try {
      const provider = await this.getProvider(run.provider);
      if (!provider.consult) return null;
      const apiKey = await secretService.resolve(run.workspaceId, run.credentialId ?? run.provider);
      const reply = await provider.consult(
        {
          task: buildAgentContext({ project, body: run.name }),
          model: run.model,
          cwd: config.runnerCwd,
          apiKey,
          context: patch,
          system: DIFF_WALKTHROUGH_SYSTEM,
        },
        DIFF_WALKTHROUGH_INSTRUCTION,
      );
      return parseDiffWalkthrough(reply, files);
    } catch {
      return null; // best-effort — a draft failure never blocks the review
    }
  }

  /**
   * Guided merge — synthesize the plain-English merge brief for the diff
   * HITL, BEFORE the operator decides. Composes three inputs (per the
   * roadmap's "wrap, don't rebuild"): the files/modules already known from
   * the diff stat (never re-derived), the task's recorded auto-review
   * verdict when one exists (Task.reviewVerdict — set by `autoReview`, not
   * this method), and a genuinely NEW stateless consult asking the run's own
   * provider to name the RISKS in its diff (same discipline as
   * draftDiffWalkthrough). The model is never asked to restate a fact the
   * system already has — only to add risk framing it can actually see in the
   * diff. Best-effort: any failure (no consult support, no credential,
   * unreadable reply) yields null, same as an unreadable walkthrough — the
   * diff HITL raises exactly as it did before this existed.
   */
  private async draftMergeBrief(
    run: TaskRun,
    project: Project | null | undefined,
    files: string[],
    patch: string,
  ): Promise<MergeBrief | null> {
    if (!patch) return null;
    try {
      const provider = await this.getProvider(run.provider);
      if (!provider.consult) return null;
      const apiKey = await secretService.resolve(run.workspaceId, run.credentialId ?? run.provider);
      const reply = await provider.consult(
        {
          task: buildAgentContext({ project, body: run.name }),
          model: run.model,
          cwd: config.runnerCwd,
          apiKey,
          context: patch,
          system: MERGE_BRIEF_SYSTEM,
        },
        MERGE_BRIEF_INSTRUCTION,
      );
      const parsed = parseMergeBrief(reply);
      if (!parsed) return null;
      // System-known facts, prefixed ahead of the model's own suggestions —
      // never asked of the model, since it can't see the reviewer's verdict or
      // the project's check configuration from the diff alone.
      const mitigations: string[] = [];
      const task = (await this.store.listTasks(run.workspaceId)).find((t) => t.runId === run.id);
      if (task?.reviewVerdict) {
        const v = task.reviewVerdict;
        mitigations.push(`Auto-reviewed by ${v.by}: ${v.decision === "approve" ? "approved" : "flagged"} — ${v.reason}`);
      }
      if (config.checkCmd) mitigations.push("Project checks run automatically after merge and roll back the merge on failure.");
      mitigations.push(...parsed.mitigations);
      return { summary: parsed.summary, filesTouched: files, risks: parsed.risks, mitigations };
    } catch {
      return null; // best-effort — a draft failure never blocks the review
    }
  }

  /**
   * Feature-level ready-to-merge brief (make the one human approval
   * reviewable) — composed once, when a Feature's whole task batch completes
   * and its aggregate PR opens (see `openPrForFeature`). The per-task list,
   * aggregate spend, and evidence summary are SYSTEM-composed from data
   * already in hand (`composeFeatureBrief`) — never asked of the model. The
   * one genuinely new thing is a consult-drafted narrative of what the
   * feature now does AS A WHOLE, grounded on the combined branch diff, run on
   * the anchor run's own provider (same discipline as `draftMergeBrief`).
   * Best-effort: no consult support, no credential, or an unreadable reply
   * all just mean `narrative: null` — the system-composed half of the brief
   * still returns, and the PR is never blocked on this.
   */
  private async draftFeatureBrief(
    anchorRun: TaskRun | undefined,
    siblings: Task[],
    runs: TaskRun[],
    patch: string,
    checksConfigured: boolean,
  ): Promise<FeatureBrief> {
    let narrative: string | null = null;
    if (anchorRun && patch) {
      try {
        const provider = await this.getProvider(anchorRun.provider);
        if (provider.consult) {
          const apiKey = await secretService.resolve(anchorRun.workspaceId, anchorRun.credentialId ?? anchorRun.provider);
          const reply = await provider.consult(
            {
              task: anchorRun.name,
              model: anchorRun.model,
              cwd: config.runnerCwd,
              apiKey,
              context: patch,
              system: FEATURE_BRIEF_SYSTEM,
            },
            FEATURE_BRIEF_INSTRUCTION,
          );
          narrative = parseFeatureNarrative(reply);
        }
      } catch {
        // best-effort — a draft failure never blocks the PR; the system-
        // composed half of the brief (below) still carries every fact.
      }
    }
    return composeFeatureBrief(siblings, runs, narrative, checksConfigured);
  }

  /**
   * Whether a provider can actually execute: a CLI-login provider (cursor /
   * copilot), a provider with a credential env var, or one with a stored
   * per-workspace secret. There is no mock — no credential means nothing runs.
   */
  private async providerUsable(
    workspaceId: string,
    provider: Agent["provider"],
    credentialId?: string | null,
  ): Promise<boolean> {
    // Circuit breaker: a key known to be out of credits/quota is refused for new
    // work — regardless of the provider seam — until it's topped up. Checked
    // FIRST so a depleted key can't slip through the injected-provider path.
    if (this.depletedKeys.has(this.keyId(workspaceId, provider, credentialId))) return false;
    // An injected provider (test seam / a deliberately-supplied backend, see
    // getProvider) is a working provider — credentialing is the injector's
    // responsibility, so it's usable regardless of env/secret.
    if (this.providerOverride) return true;
    const credId = credentialId ?? provider;
    if (credId === provider) {
      // Default credential: broad ambient-env detection (OAuth/gateway tokens too)
      // OR a stored default key.
      if (providerUsableFromEnv(provider)) return true;
      return (await secretService.resolve(workspaceId, provider)) !== undefined;
    }
    // Named credential: no ambient-env fallback — it must carry its own stored key.
    return (await secretService.resolve(workspaceId, credId)) !== undefined;
  }

  /** Breaker key for a run's effective credential (`credentialId ?? provider`). */
  private keyId(workspaceId: string, provider: Agent["provider"], credentialId?: string | null): string {
    return `${workspaceId}:${credentialId ?? provider}`;
  }

  /**
   * Trip the key-health breaker for a run that failed on a billing wall (out of
   * credits/quota). Marks the credential depleted — so `providerUsable` refuses
   * it and NO new run is assigned to it (nor auto-provisioned onto it) until it's
   * topped up — logs ONE key-level notice (the first hit), then escalates THIS
   * run so it's resumable once the operator tops up. Returns without counting a
   * generic failure.
   */
  private async tripKeyBreaker(runId: string, reason: string): Promise<void> {
    const run = await this.store.getRun(runId);
    if (run) {
      const key = this.keyId(run.workspaceId, run.provider, run.credentialId);
      if (!this.depletedKeys.has(key)) {
        this.depletedKeys.set(key, { reason, at: now() });
        await this.hub
          .runLog(runId, `provider key out of credits/quota — new runs on it are paused until it's topped up (${reason})`)
          .catch(() => undefined);
      }
    }
    await this.escalate(
      runId,
      `The provider key is out of credits or quota — ${reason}. Top up the key, then resume this run; other work on the same key is paused until then.`,
      "billing",
    );
  }

  /** Clear the breaker for a run's key — its credential is working again (a run on
   *  it succeeded, or the operator resumed an escalation after topping up). */
  private clearDepletedKey(run: TaskRun | undefined): void {
    if (run) this.depletedKeys.delete(this.keyId(run.workspaceId, run.provider, run.credentialId));
  }

  /**
   * Run a runner-acquisition critical section serially. Each call chains onto the
   * previous one so the find-idle → mark-busy sequence inside `fn` is atomic with
   * respect to every other acquisition, closing the double-booking TOCTOU. A
   * prior failure never poisons the chain (we swallow it for the NEXT waiter; the
   * failing call still rejects to its own caller).
   */
  private acquireExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.acquireLock.catch(() => undefined).then(fn);
    this.acquireLock = run.catch(() => undefined);
    return run;
  }

  /** Acquire an idle agent whose provider can actually execute; mark it busy.
   *  Serialized via acquireExclusive so find-idle → mark-busy is atomic (closes
   *  the double-booking TOCTOU). Empty fleet or no key for any idle agent →
   *  RunnerNotConfiguredError (409); agents exist but all busy → NoCapacityError. */
  private acquireAgent(
    workspaceId: string,
    eligible?: TaskAssignment,
    // The project's enabled-key allowlist (secret-store credential ids; empty =
    // any key). A runner is assignable only if its key (credentialId ?? provider)
    // is in this set — the project-level provider-key confinement.
    allowedCredentialIds: string[] = [],
    // The task's saved Start-picker preference (Task.preferredProvider/-Model).
    // A SOFT hint, not a requirement: tried first among idle+usable runners,
    // but any mismatch (no provider match, or matches but none usable) falls
    // straight through to the unchanged default pick below — a preference must
    // never block a task the way `agents`-mode eligibility legitimately can.
    preferred?: { provider?: TaskRun["provider"] | null; model?: string | null },
  ): Promise<{ id: string; provider: TaskRun["provider"]; model: string; credentialId: string | null }> {
    return this.acquireExclusive(async () => {
      const runners = await this.store.listAgents(workspaceId);
      if (runners.length === 0) {
        throw new RunnerNotConfiguredError("No agent configured — add one in Fleet before assigning tasks.");
      }
      // `agents` mode restricts the pool to the eligible set; `any`/undefined
      // considers the whole fleet (historical behavior).
      const inPool = (id: string) =>
        eligible?.mode === "agents" ? eligible.agentIds.includes(id) : true;
      const keyAllowed = (r: Agent) =>
        allowedCredentialIds.length === 0 || allowedCredentialIds.includes(r.credentialId ?? r.provider);
      const pooled = runners.filter((r) => inPool(r.id));
      if (eligible?.mode === "agents" && pooled.length === 0) {
        throw new NoCapacityError("None of this task's assigned agents exist in the fleet.");
      }
      // Confine to runners on a key this project is allowed to run on.
      const eligibleRunners = pooled.filter(keyAllowed);
      if (eligibleRunners.length === 0) {
        throw new NoCapacityError(
          "No fleet runner uses a provider key enabled for this project — enable one of its keys in the project's settings, or add a runner on an allowed key in Fleet.",
        );
      }
      const idle = eligibleRunners.filter((r) => r.status === "idle");
      // Try the preference FIRST, ranked exact-model > provider-only, before the
      // plain "first idle, usable" pick below. `sort` is stable, so when nothing
      // matches (every rank is 0) this reduces to the original order and the
      // loop falls straight through on its first iteration — a task with no
      // preference (or one nothing idle can satisfy) picks exactly as before.
      if (idle.length > 0 && preferred?.provider) {
        const rank = (r: Agent) =>
          r.provider !== preferred.provider ? 0 : preferred.model && r.model === preferred.model ? 2 : 1;
        for (const r of [...idle].sort((a, b) => rank(b) - rank(a))) {
          if (rank(r) === 0) break; // ranked list is sorted — no more candidates
          if (await this.providerUsable(workspaceId, r.provider, r.credentialId)) {
            await this.hub.upsertAgent({ ...r, status: "busy", idleSince: null });
            return { id: r.id, provider: r.provider, model: r.model, credentialId: r.credentialId ?? null };
          }
        }
      }
      if (idle.length === 0) {
        // Auto-scale: every eligible runner is busy. If the workspace policy
        // allows it AND we're under the fleet cap, clone an eligible runner
        // (already on an allowed key) and provision a fresh one instead of
        // making the task wait. At the cap we fall through to NoCapacityError —
        // the task queues until a runner frees up. Atomic under acquireExclusive.
        const settings = await this.fleetPolicy(workspaceId);
        const underCap = !settings.maxRunners || runners.length < settings.maxRunners;
        const template = eligibleRunners[0]; // a busy runner on an allowed key
        if (settings.autoProvisionRunners && underCap && template && (await this.providerUsable(workspaceId, template.provider, template.credentialId))) {
          const id = `runner-auto-${++this.seq}`;
          // Auto-scale clones capacity, not delegation — always 'worker'
          // regardless of the template's role (no manager provisioning exists
          // to make this reachable yet either way).
          const runner: Agent = { id, workspaceId, name: id, provider: template.provider, credentialId: template.credentialId, model: template.model, status: "busy", idleSince: null, autoProvisioned: true, canReview: true, label: template.label ?? null, role: "worker" };
          await this.hub.upsertAgent(runner);
          return { id, provider: template.provider, model: template.model, credentialId: template.credentialId ?? null };
        }
        throw new NoCapacityError(
          eligible?.mode === "agents"
            ? "This task's assigned agents are all busy — it waits until one frees up."
            : undefined,
        );
      }
      for (const r of idle) {
        if (await this.providerUsable(workspaceId, r.provider, r.credentialId)) {
          await this.hub.upsertAgent({ ...r, status: "busy", idleSince: null });
          return { id: r.id, provider: r.provider, model: r.model, credentialId: r.credentialId ?? null };
        }
      }
      // All idle runners exist but none has a usable key. If that's because the
      // key is out of credits (breaker tripped), say so — don't send the operator
      // hunting for a "missing" key that's actually just empty.
      const drained = idle
        .map((r) => this.depletedKeys.get(this.keyId(workspaceId, r.provider, r.credentialId)))
        .find((d): d is { reason: string; at: number } => d !== undefined);
      if (drained) {
        throw new RunnerNotConfiguredError(`Provider key is out of credits/quota — top it up to resume (${drained.reason}).`);
      }
      throw new RunnerNotConfiguredError(
        "No credential for any available agent — add a key for its provider/credential in Settings (or sign in a CLI-login provider). Nothing runs without one.",
      );
    });
  }

  /** The workspace fleet policy, defaulted when never set (so maxRunners=100 and
   *  the reaper TTL apply to unconfigured workspaces too). */
  private async fleetPolicy(ws: string): Promise<WorkspaceSettings> {
    return (await this.store.getWorkspaceSettings(ws)) ?? WorkspaceSettings.parse({ workspaceId: ws });
  }

  /** A project's enabled-runner-key allowlist (empty = any key). */
  private async projectKeyAllowlist(projectId: string): Promise<string[]> {
    return (await this.store.getProject(projectId))?.enabledRunnerCredentialIds ?? [];
  }

  /**
   * Acquire an idle runner, or PROVISION a fresh one on demand when the fleet is
   * fully occupied — used by fork so a family can branch even when every runner
   * is busy (a fork shouldn't be blocked waiting for capacity). The new runner
   * inherits the requested provider/model. Gated on a usable provider, so we
   * never spin up a runner the executor has no credential for.
   */
  private acquireOrProvisionRunner(
    workspaceId: string,
    provider: TaskRun["provider"],
    model: string,
    credentialId?: string | null,
    // The owning project's enabled-key allowlist (empty = any). Confines which
    // idle runner may be reused, so a fork/retry can't land on a key the project
    // isn't allowed to run on. The provisioned fallback uses the requested
    // credential, which the caller already resolved from an allowed run.
    allowedCredentialIds: string[] = [],
    // Reassign's own "give me a DIFFERENT runner" ask — every escalation now
    // frees its runner immediately at raise time (not held busy until reassign
    // itself frees it), so that runner is idle again by the time reassign
    // runs and would otherwise just get re-picked as its own "replacement".
    // Only relaunchEscalated's reassign path sets this.
    excludeAgentId?: string | null,
  ): Promise<{ id: string; provider: TaskRun["provider"]; model: string; credentialId: string | null }> {
    return this.acquireExclusive(async () => {
      const runners = await this.store.listAgents(workspaceId);
      const keyAllowed = (r: Agent) =>
        allowedCredentialIds.length === 0 || allowedCredentialIds.includes(r.credentialId ?? r.provider);
      // Prefer an idle agent that's on an allowed key AND can actually execute.
      for (const r of runners.filter((r) => r.status === "idle" && keyAllowed(r) && r.id !== excludeAgentId)) {
        if (await this.providerUsable(workspaceId, r.provider, r.credentialId)) {
          await this.hub.upsertAgent({ ...r, status: "busy", idleSince: null });
          return { id: r.id, provider: r.provider, model: r.model, credentialId: r.credentialId ?? null };
        }
      }
      // Respect the workspace fleet cap — fork/retry provisioning is auto-creation
      // too, so the ceiling applies here as well (0 = no cap).
      const settings = await this.fleetPolicy(workspaceId);
      if (settings.maxRunners && runners.length >= settings.maxRunners) {
        throw new NoCapacityError(`Fleet is at its maximum of ${settings.maxRunners} runners — free a runner or raise the limit in settings.`);
      }
      // None idle+usable → provision one for the requested provider + credential,
      // but only if that credential is usable (else nothing can run).
      if (!(await this.providerUsable(workspaceId, provider, credentialId))) {
        throw new RunnerNotConfiguredError(
          `No credential for provider "${provider}" — add a key in Settings (or sign in a CLI-login provider). Nothing runs without one.`,
        );
      }
      const id = `runner-auto-${++this.seq}`;
      const runner: Agent = { id, workspaceId, name: id, provider, credentialId: credentialId ?? null, model, status: "busy", idleSince: null, autoProvisioned: true, canReview: true, label: null, role: "worker" };
      await this.hub.upsertAgent(runner);
      return { id, provider, model, credentialId: credentialId ?? null };
    });
  }

  /**
   * Provision the runner's working directory. Without an integration repo this
   * is the operator-configured config.runnerCwd (Phase 0) when set, else a
   * fresh, isolated per-run scratch dir (chat-only mode: a project with no
   * bound repo) — never the server process's own cwd, and never shared with
   * another run. With a repo configured, isolation is REQUIRED: a fresh
   * worktree on `branch`. If that fails we throw rather than silently dropping
   * runs into a shared dir where their branches would collide — the caller
   * surfaces it as a failed agent.
   */
  private async provisionCwd(
    git: GitContext | undefined,
    runId: string,
    branch: string,
    project: Project | null | undefined,
    baseRef?: string,
  ): Promise<{ cwd: string | undefined; baseRef?: string; scratchCwd?: string }> {
    if (!git) {
      if (config.runnerCwd) return { cwd: config.runnerCwd };
      const scratchCwd = await this.scratchCwdFor(runId);
      return { cwd: scratchCwd, scratchCwd };
    }
    const prov = await git.worktrees.provision(runId, branch, { baseRef });
    await this.hub.runLog(runId, `worktree ready on ${branch} (from ${prov.baseRef})`);
    // v4: project Skynet's portable memory (Project.contextSummary) into the
    // freshly-checked-out worktree's own CLAUDE.md / .cursor/rules / Copilot
    // instructions, so a vendor tool opened directly against this checkout
    // (no Skynet in the loop) sees the same grounding an agent's prompt does.
    // Best-effort: a filesystem hiccup here must never stop the run itself.
    await syncRepoNativeMemory(prov.cwd, project?.contextSummary).catch((err) =>
      this.hub.runLog(runId, `repo-native memory sync failed: ${(err as Error).message}`).catch(() => undefined),
    );
    return { cwd: prov.cwd, baseRef: prov.baseRef };
  }

  /** A private, per-run scratch directory for a chat-only run (no bound repo,
   *  no operator-configured SKYNET_RUNNER_CWD). Isolates the agent's file
   *  access to a throwaway tmp dir instead of falling back to the server
   *  process's own working directory — the previous behavior when `cwd` was
   *  left `undefined` (every runner-sdk provider defaults an unset cwd to
   *  `process.cwd()`). Caller is responsible for removing it once the run
   *  ends (see the `scratchCwd` cleanup at each `live` teardown site). */
  private async scratchCwdFor(runId: string): Promise<string> {
    const safe = runId.replace(/[^a-zA-Z0-9._-]/g, "_");
    return mkdtemp(join(tmpdir(), `skynet-chat-${safe}-`));
  }

  /** Best-effort removal of a chat-only run's scratch dir, if it had one. */
  private async releaseScratchCwd(scratchCwd: string | undefined): Promise<void> {
    if (!scratchCwd) return;
    await rm(scratchCwd, { recursive: true, force: true }).catch(() => undefined);
  }

  /** The SolutionBrief a task is scoped under (direct `source.briefId`, else
   *  the brief that rolls up into the task's Feature) — see
   *  `resolveTaskBrief` (packages/shared) for the resolution rule itself;
   *  this just supplies the workspace's brief list. undefined on a fetch
   *  failure or when the task has neither a brief source nor a brief-linked
   *  feature — callers already treat "no brief" as the common case (most
   *  tasks aren't under one), so this never throws. */
  private async findTaskBrief(task: Task, workspaceId: string): Promise<SolutionBrief | undefined> {
    const briefs = await this.store.listSolutionBriefs(workspaceId).catch(() => [] as SolutionBrief[]);
    return resolveTaskBrief(task, briefs);
  }

  /** The text threaded into `buildAgentContext`'s `=== SOLUTION BRIEF ===`
   *  section: the chosen approach plus acceptance criteria — the "what to
   *  build and how we'll know it's done" an agent actually needs turn-to-turn,
   *  not the full planning doc (problem framing, options considered, risks,
   *  open questions stay in the brief itself, not every prompt). Capped by
   *  agent-context.ts's SOLUTION_BRIEF_CHAR_CAP, not here. */
  private briefContextText(brief: SolutionBrief): string {
    const approach = brief.approach.trim();
    const criteria = brief.acceptanceCriteria.filter((c) => c.trim());
    const parts: string[] = [];
    if (approach) parts.push(approach);
    if (criteria.length) parts.push(["Acceptance criteria:", ...criteria.map((c) => `- ${c}`)].join("\n"));
    return parts.join("\n\n");
  }

  /**
   * S3: a fresh-start sibling-awareness digest (see buildSiblingDigest) for
   * `project`, excluding `excludeTaskId` — wrapped in the single-element array
   * `buildAgentContext`'s `siblings` field expects (see agent-context.ts).
   * Snapshot-at-start only (a fresh listTasks/listRuns per call, never a live
   * feed) — wired only at the genuine "an agent is starting FRESH on this run"
   * moments (assign, fork, reassign/escalation-relaunch), not at continuations
   * of already-in-progress work (checkpoint restore, revise-after-review)
   * where the agent already has full context of its own prior turns. Never
   * throws — a store failure here shouldn't stop the run from starting.
   */
  private async siblingDigestFor(project: Project, excludeTaskId: string): Promise<string[] | undefined> {
    try {
      const [tasks, runs, features] = await Promise.all([
        this.store.listTasks(project.workspaceId),
        this.store.listRuns(project.workspaceId),
        this.store.listFeatures(project.workspaceId),
      ]);
      const digest = buildSiblingDigest(project, tasks, runs, excludeTaskId, features);
      return digest ? [digest] : undefined;
    } catch {
      return undefined;
    }
  }

  // ── assignTask ────────────────────────────────────────────────────────────
  async assignTask(projectId: string, taskId: string): Promise<TaskRun> {
    const task = await this.store.getTask(taskId);
    if (!task || task.projectId !== projectId) throw new Error("Task not found");
    const project = await this.store.getProject(projectId);
    if (!project) throw new Error("Project not found");

    // DEF-005: a completed task has nothing to (re)assign — refuse rather than
    // spawn an agent on already-finished work.
    if (task.state === "done") {
      throw new TaskAlreadyAssignedError("Task is already done");
    }

    // An archived task is soft-hidden — never spawn a run on it (which would show
    // the archived task "running"). Defense in depth: the autonomy loop already
    // skips archived tasks; this also refuses any other caller (manual API / MCP /
    // Steward). Un-archive it first to work on it again.
    if (task.archived) {
      throw new Error("Task is archived — unarchive it before assigning");
    }

    // DEF-003: re-assigning a task that already owns a live agent must be
    // idempotent — return the existing agent instead of acquiring a second
    // runner and spawning a duplicate (which orphaned the first agent and left
    // its runner stuck "busy"). Only a done/missing agent frees the task to be
    // (re)assigned.
    if (task.runId) {
      const existing = await this.store.getRun(task.runId);
      // A run this orchestrator itself paused (see pauseRun — "Send to Todo,
      // keep the work") sits at `waiting` with its worktree intact and an
      // escalations-map record, same shape as an escalated-and-not-yet-resumed
      // run. A plain "Start →" click on the now-Todo task should actually
      // relaunch it in place, not return the inert record — this is the only
      // way `waiting` shows up on a non-`ongoing` task, so it's unambiguous.
      if (existing && existing.status === "waiting" && this.escalations.has(existing.id)) {
        await this.relaunchEscalated(existing.id, "", false);
        return (await this.store.getRun(existing.id)) ?? existing;
      }
      if (existing && existing.status !== "done") return existing;
    }

    // A human explicitly assigning an `unassigned` task means "any agent" — persist
    // that so the task carries a real eligibility set once it leaves backlog (the
    // deterministic autonomy loop never makes this assumption; it parks unassigned
    // tasks instead). An `agents` pin restricts acquisition to that pool.
    const current: TaskAssignment = task.assignment ?? { mode: "unassigned", agentIds: [] };
    const assignment: TaskAssignment =
      current.mode === "unassigned" ? { mode: "any", agentIds: [] } : current;
    const runner = await this.acquireAgent(project.workspaceId, assignment, project.enabledRunnerCredentialIds, {
      provider: task.preferredProvider,
      model: task.preferredModel,
    });
    const runId = `${this.slug(task.text)}-${++this.seq}`;
    // runId is unique → unique branch & worktree path (two same-named tasks
    // never collide on the same branch).
    const branch = `agent/${runId}`;
    // W5: reserve a sandboxed live-preview URL for visual deliverables.
    const preview = await previewService.resolve({
      workspaceId: project.workspaceId,
      projectId,
      projectName: project.name,
      projectGoal: project.goal,
      runId,
      branch,
      seedVisual: false,
    });
    const agent: TaskRun = {
      id: runId,
      workspaceId: project.workspaceId,
      projectId,
      name: task.text,
      status: "running",
      agentId: runner.id,
      provider: runner.provider,
      credentialId: runner.credentialId,
      model: runner.model,
      branch,
      modules: [],
      progress: 0,
      plan: [],
      usage: null,
      modifiedFiles: [],
      log: [],
      startedAt: now(),
      lastHeartbeatAt: now(),
      visual: preview.visual,
      previewUrl: preview.previewUrl,
      dependsOn: [],
      parentId: null,
      branchFromStep: null,
      archived: false,
      pr: null,
      mergedAt: null,
      flyDeployment: null,
    };

    // Resolve the runner provider first — fail fast (before mutating state) if
    // it can't be resolved, rather than silently running a fake one.
    const provider = await this.getProvider(runner.provider);

    await this.hub.createRun(agent);
    await this.hub.upsertTask({ ...task, state: "ongoing", runId, assignment });
    await this.hub.upsertProject({ ...project, runIds: [...project.runIds, runId] });

    // S8 status: the brief this task is scoped under moves approved→building
    // the moment its FIRST child task leaves todo — a plan stops being "just
    // approved" once real work is actually underway. Only fires on a genuine
    // todo→ongoing transition (not a re-assign of an already-ongoing task, and
    // not from any other originating state) and only from "approved" — a
    // human's manual status edit (or a later completion) is never overridden.
    if (task.state === "todo") {
      const brief = await this.findTaskBrief(task, project.workspaceId);
      if (brief && brief.status === "approved") {
        await this.hub.upsertSolutionBrief({ ...brief, status: "building" });
      }
    }

    // Git backend for this project's repo (local repoPath, else global) — drives
    // the isolated worktree + which merge queue this agent integrates into.
    const git = this.gitContextFor(project);
    let scratchCwd: string | undefined;
    try {
      // Isolated worktree cut from LATEST main: provisionCwd fetches origin and
      // branches from origin/<base> (no baseRef passed), so every run starts on
      // the newest human-merged state — not a stale local integration branch.
      // With no bound repo (chat-only), this instead mints a private scratch dir.
      const prov = await this.provisionCwd(git, runId, branch, project);
      const { cwd, baseRef } = prov;
      scratchCwd = prov.scratchCwd;
      // Inject this workspace's provider key (env fallback when none is stored).
      const apiKey = await secretService.resolve(project.workspaceId, runner.credentialId ?? runner.provider);
      // The agent gets the full brief: the short name plus the longer
      // description when one exists (the run's display name stays the short text).
      const taskBody = (task.description ? `${task.text}\n\n${task.description}` : task.text) + SCOPE_NOTE;
      const feature = task.featureId ? await this.store.getFeature(task.featureId).catch(() => undefined) : undefined;
      const solutionBrief = await this.findTaskBrief(task, project.workspaceId);
      const siblings = await this.siblingDigestFor(project, taskId);
      const brief = buildAgentContext({
        project,
        feature,
        brief: solutionBrief ? this.briefContextText(solutionBrief) : undefined,
        siblings,
        body: taskBody,
      });
      // Opt-in browser tooling is a per-workspace setting, off by default; the
      // runner decides how to expose it (Claude → a Playwright MCP server).
      const { browserTools } = await this.fleetPolicy(project.workspaceId);
      const handle = await provider.start(
        { runId, projectId, task: brief, model: runner.model, branch, cwd, apiKey, browser: browserTools, planModeGate: project.planModeGate, disallowedTools: project.disallowedTools },
        this.events(),
      );
      this.live.set(runId, { handle, agentId: runner.id, taskId, branch, baseRef, git, scratchCwd });
    } catch (err) {
      await this.releaseScratchCwd(scratchCwd);
      await this.failStartup(runId, runner.id, (err as Error).message);
      throw err;
    }
    return agent;
  }

  // ── fork ──────────────────────────────────────────────────────────────────
  async fork(parentId: string): Promise<TaskRun> {
    const parent = await this.store.getRun(parentId);
    if (!parent) throw new Error("Parent agent not found");

    // Fork provisions capacity on demand: if no runner is idle, spin one up
    // (inheriting the parent's provider/model) rather than refusing the fork.
    const runner = await this.acquireOrProvisionRunner(parent.workspaceId, parent.provider, parent.model, parent.credentialId, await this.projectKeyAllowlist(parent.projectId));
    const runId = `${this.slug(parent.name)}-fork-${++this.seq}`;
    const stepIndex = Math.max(0, parent.plan.findIndex((s) => s.state === "now"));
    const forkBranch = `${parent.branch}-fork`;
    const project = await this.store.getProject(parent.projectId);
    // W5: a fork is its own branch, so it gets its own preview URL (inherits the
    // parent's visual nature as the seed signal).
    const preview = await previewService.resolve({
      workspaceId: parent.workspaceId,
      projectId: parent.projectId,
      projectName: project?.name ?? "",
      projectGoal: project?.goal ?? "",
      runId,
      branch: forkBranch,
      seedVisual: parent.visual,
    });
    const agent: TaskRun = {
      ...parent,
      id: runId,
      name: `${parent.name} (fork)`,
      status: "running",
      agentId: runner.id,
      provider: runner.provider,
      credentialId: runner.credentialId,
      model: runner.model,
      branch: `agent/${runId}`,
      progress: parent.progress,
      log: [],
      startedAt: now(),
      lastHeartbeatAt: now(),
      visual: preview.visual,
      previewUrl: preview.previewUrl,
      parentId,
      branchFromStep: stepIndex,
      mergedAt: null, // a fork is a fresh, unmerged run — never inherit the parent's
    };

    const provider = await this.getProvider(runner.provider); // fail fast if it can't resolve

    await this.hub.createRun(agent);
    if (project) await this.hub.upsertProject({ ...project, runIds: [...project.runIds, runId] });

    const git = this.gitContextFor(project);
    let scratchCwd: string | undefined;
    try {
      // A fork branches from its parent (family-internal integration, §7).
      const prov = await this.provisionCwd(git, runId, agent.branch, project, parent.branch);
      const { cwd, baseRef } = prov;
      scratchCwd = prov.scratchCwd;
      const apiKey = await secretService.resolve(parent.workspaceId, runner.credentialId ?? runner.provider);
      const parentTask = (await this.store.listTasks(parent.workspaceId)).find((t) => t.runId === parentId);
      const feature = parentTask?.featureId ? await this.store.getFeature(parentTask.featureId).catch(() => undefined) : undefined;
      const solutionBrief = parentTask ? await this.findTaskBrief(parentTask, parent.workspaceId) : undefined;
      const siblings = project && parentTask ? await this.siblingDigestFor(project, parentTask.id) : undefined;
      const handle = await provider.start(
        {
          runId,
          projectId: parent.projectId,
          task: buildAgentContext({ project, feature, brief: solutionBrief ? this.briefContextText(solutionBrief) : undefined, siblings, body: parent.name }),
          model: runner.model,
          branch: agent.branch,
          cwd,
          parentId,
          branchFromStep: stepIndex,
          apiKey,
          disallowedTools: project?.disallowedTools,
        },
        this.events(),
      );
      this.live.set(runId, { handle, agentId: runner.id, taskId: null, branch: agent.branch, baseRef, git, scratchCwd });
    } catch (err) {
      await this.releaseScratchCwd(scratchCwd);
      await this.failStartup(runId, runner.id, (err as Error).message);
      throw err;
    }
    return agent;
  }

  // ── checkpoint / restore ────────────────────────────────────────────────
  // Snapshot a run's worktree + plan state mid-run so a long task can be
  // rewound in place if it goes sideways — an extension of fork/resume: fork
  // branches a NEW run off wherever the parent currently sits; a checkpoint
  // pins a POINT on THIS run's own branch, and restoreCheckpoint rewinds this
  // SAME run back to it (worktree +, for Claude, the SDK session — best-effort;
  // see the runner-sdk `resumeSessionId` doc for why this can't be a perfect
  // point-in-time conversation rewind, only "resume from that session").

  /** Every checkpoint taken on a run, oldest first. */
  async listCheckpoints(runId: string): Promise<Checkpoint[]> {
    return this.store.listCheckpoints(runId);
  }

  /**
   * Manually snapshot a live run: commit whatever's uncommitted in its
   * worktree, capture the resulting sha (pinned under a stable ref so a later
   * restore's branch reset can't lose it to gc), the run's current plan +
   * progress, and — Claude only — its SDK session id. Requires a live
   * worktree: there's nothing in-flight to snapshot once a run's compute is
   * gone. (Automatic per-plan-step checkpointing was the other option here —
   * this manual trigger is the smaller, safer piece to land first: no new hook
   * into the plan-progress dataflow, no risk of checkpoint spam on a chatty
   * plan. See PR description.)
   */
  async checkpoint(runId: string, label?: string | null): Promise<Checkpoint> {
    const run = await this.store.getRun(runId);
    if (!run) throw new Error("Run not found");
    const live = this.live.get(runId);
    if (!live) throw new Error("This run isn't live — nothing in flight to checkpoint.");
    const git = live.git ?? (await this.gitContextForAgent(runId).catch(() => undefined));
    if (!git || !git.worktrees.exists(runId)) throw new Error("This run has no worktree to checkpoint.");

    await git.worktrees.commitAll(runId, `checkpoint${label ? `: ${label}` : ""}`);
    const sha = await git.worktrees.headSha(runId);
    const id = `cp-${runId}-${++this.seq}`;
    await git.worktrees.pinRef(`refs/skynet/checkpoints/${id}`, sha);

    const checkpoint: Checkpoint = {
      id,
      runId,
      workspaceId: run.workspaceId,
      label: label ?? null,
      sha,
      claudeSessionId: run.provider === "claude" ? (live.handle.getSessionId?.() ?? null) : null,
      plan: run.plan,
      progress: run.progress,
      createdAt: now(),
    };
    await this.store.putCheckpoint(checkpoint);
    await this.hub.runLog(runId, `checkpoint saved${label ? ` — "${label}"` : ""} (${sha.slice(0, 7)})`);
    return checkpoint;
  }

  /**
   * Rewind a run to an earlier checkpoint IN PLACE: stop whatever's currently
   * live, re-provision the worktree at the checkpoint's pinned sha (a hard
   * reset of the run's own branch — forward commits drop off the branch,
   * though the pinned ref keeps them reachable on disk), and relaunch the
   * provider resuming the checkpoint's captured session (Claude) so the
   * conversation, not just the git state, rewinds.
   */
  async restoreCheckpoint(runId: string, checkpointId: string): Promise<TaskRun> {
    const run = await this.store.getRun(runId);
    if (!run) throw new Error("Run not found");
    const checkpoint = await this.store.getCheckpoint(checkpointId);
    if (!checkpoint || checkpoint.runId !== runId) throw new Error("Checkpoint not found");

    const project = await this.store.getProject(run.projectId);
    const live = this.live.get(runId);
    const git = live?.git ?? this.gitContextFor(project);
    if (!git) throw new Error("This run has no git worktree to restore.");

    // Tear down any current execution before rewinding the worktree out from
    // under it — mirrors stopAgent's detach, but keeps the run's own slot
    // (status flips back to running below) rather than marking it done.
    if (live) {
      await live.handle.stop().catch(() => undefined);
      await this.freeRunner(live.agentId);
      this.live.delete(runId);
    }

    const runner = await this.acquireOrProvisionRunner(run.workspaceId, run.provider, run.model, run.credentialId, await this.projectKeyAllowlist(run.projectId));
    const provider = await this.getProvider(runner.provider);
    const { cwd, baseRef } = await this.provisionCwd(git, runId, run.branch, project, checkpoint.sha);
    const apiKey = await secretService.resolve(run.workspaceId, runner.credentialId ?? runner.provider);
    const resumeSessionId = run.provider === "claude" ? checkpoint.claudeSessionId : null;
    const taskId = (await this.store.listTasks(run.workspaceId)).find((t) => t.runId === runId)?.id ?? null;
    const task = taskId ? await this.store.getTask(taskId) : undefined;
    const feature = task?.featureId ? await this.store.getFeature(task.featureId).catch(() => undefined) : undefined;
    const solutionBrief = task ? await this.findTaskBrief(task, run.workspaceId) : undefined;

    await this.hub.runProgress(runId, checkpoint.progress, checkpoint.plan);
    await this.hub.runStatus(runId, "running");
    await this.hub.runLog(
      runId,
      `restored to checkpoint${checkpoint.label ? ` "${checkpoint.label}"` : ""} (${checkpoint.sha.slice(0, 7)}) — worktree rewound, ${resumeSessionId ? "conversation resumed" : "fresh turn started"}`,
    );
    if (task) await this.hub.upsertTask({ ...task, state: "ongoing" });

    try {
      const handle = await provider.start(
        {
          runId,
          projectId: run.projectId,
          task: buildAgentContext({ project, feature, brief: solutionBrief ? this.briefContextText(solutionBrief) : undefined, body: run.name }),
          model: runner.model,
          branch: run.branch,
          cwd,
          apiKey,
          resumeSessionId,
          disallowedTools: project?.disallowedTools,
        },
        this.events(),
      );
      this.live.set(runId, { handle, agentId: runner.id, taskId, branch: run.branch, baseRef, git });
    } catch (err) {
      await this.failStartup(runId, runner.id, (err as Error).message);
      throw err;
    }
    return (await this.store.getRun(runId))!;
  }

  /**
   * The actual push-to-GitHub / local-merge-queue integration a diff/merge/
   * verifier APPROVAL triggers — factored out of {@link deliver} so
   * `forceIntegrateRun` (Force Done's path, below) can trigger the exact
   * same integration without a HITL item to approve. Byte-for-byte the same
   * decision tree deliver() always used (feature-batch retry → feature-batch
   * step 1 → GitHub PR → local merge queue), just parameterized by primitives
   * instead of a HitlItem + Resolution. Returns false when there was nothing
   * to integrate (no run, or no git backend at all) so the caller knows to
   * fall back to a cosmetic-only "done" rather than silently no-op'ing.
   */
  private async integrateRun(
    runId: string,
    opts: {
      sourceBranchOverride?: string | null;
      targetBranch?: string;
      /** Only affects LOG WORDING ("retrying…" vs "queued…") — never the
       *  actual git operation. Defaults to "diff" (fresh-approval wording). */
      kind?: "diff" | "merge" | "verifier";
    } = {},
  ): Promise<boolean> {
    const agent = await this.store.getRun(runId);
    if (!agent) return false;
    const project = await this.store.getProject(agent.projectId);
    const git = this.gitContextFor(project);
    const kind = opts.kind ?? "diff";

    // Feature-scoped branch batching, step 2 retry: this HITL was raised
    // merging a FEATURE branch itself up into the project's integration
    // branch (see raiseMergeHitl/raiseMergeFailedHitl), not any run's own
    // branch — there's no "owning run" to re-derive the source from, so it's
    // stored on the item and replayed exactly, skipping GitHub entirely
    // (this step never opens a PR — see completeFeatureMerged).
    if (opts.sourceBranchOverride && git) {
      await this.hub.runLog(runId, "retrying feature-branch merge after reconciliation");
      git.merge.enqueue({ runId, projectId: agent.projectId, agentBranch: opts.sourceBranchOverride, workspaceId: agent.workspaceId });
      return true;
    }

    // Feature-scoped branch batching, step 1: a task under a Feature merges
    // into the shared feature branch (always via the local queue, even for a
    // GitHub-bound project — see the plan) instead of opening its own PR.
    // Re-derived fresh from the task on every call (same as `agent.branch`
    // below), so a merge-retry after a conflict re-targets correctly too.
    // Falls through to the default routing if the feature's PR already
    // opened — an in-flight aggregate PR doesn't accept more tasks in v1.
    const task = (await this.store.listTasks(agent.workspaceId)).find((t) => t.runId === runId);
    const feature = task?.featureId ? await this.store.getFeature(task.featureId) : undefined;
    if (feature && feature.pr?.state !== "open" && git) {
      await this.hub.runStatus(runId, "review");
      await this.hub.runLog(
        runId,
        kind === "merge"
          ? `retrying merge into the "${feature.name}" feature branch after reconciliation`
          : `diff approved — queued for the "${feature.name}" feature branch`,
      );
      git.merge.enqueue({ runId, projectId: agent.projectId, agentBranch: agent.branch, workspaceId: agent.workspaceId, featureId: feature.id });
      return true;
    }

    const conn = await githubService.get(agent.workspaceId);
    // Guided merge — the caller's explicit choice wins; unset falls back to
    // whatever's already the default (a fresh diff's computed default, or a
    // merge retry's carried-forward target) so a plain approve from ANY
    // surface — including one with no branch picker — still lands where the
    // gate said it would.
    const targetBranch = opts.targetBranch;
    // GitHub PR flow: workspace connected, project bound to one repo, and a
    // worktree to push from. Otherwise fall back to the local merge queue
    // (against the project's own repo when git-backed, else the global one).
    if (conn?.connected && project?.repo && git) {
      // The GitHub PR flow's base branch isn't operator-choosable yet (a
      // separate mechanism from the local merge queue below) — never
      // silently drop a non-default choice, note it instead.
      if (targetBranch && targetBranch !== this.baseBranchFor(project)) {
        await this.hub.runLog(
          runId,
          `note: merge target "${targetBranch}" isn't supported for the GitHub PR flow yet — opening the PR against ${this.baseBranchFor(project)} as usual.`,
        );
      }
      await this.pushToGithub(git, agent, project.repo, project);
      return true;
    }
    if (git) {
      await this.hub.runStatus(runId, "review");
      await this.hub.runLog(
        runId,
        (kind === "merge" ? "retrying merge after reconciliation" : kind === "verifier" ? "retrying merge + checks" : "diff approved — queued for merge") +
          (targetBranch ? ` — into ${targetBranch}` : ""),
      );
      // Verifier gate is per-project (Project.checkCmd, else the
      // workspace-global config.checkCmd) — resolved here, not baked into
      // the cached MergeEngine, so it can never go stale or leak across
      // projects sharing a (repo, baseBranch) cache key. See
      // MergeRequest.checkCmd's doc comment.
      const checkCmd = project?.checkCmd?.trim() || undefined;
      git.merge.enqueue({ runId, projectId: agent.projectId, agentBranch: agent.branch, workspaceId: agent.workspaceId, targetBranch, checkCmd });
      return true;
    }
    return false;
  }

  /**
   * Force Done skips the normal review gate entirely — the one sanity check
   * that survives that skip: a plain "does this satisfy the task" consult on
   * the run's OWN provider (never a separate reviewer agent — Force Done
   * must still work on a single-agent fleet), the SAME prompt/field-based
   * parsing `autoReview`'s own plain-consult path uses (`REVIEW_OUTPUT_INSTRUCTION`
   * / `parseReviewVerdict` — never classifying the model's prose). Returns
   * null — "no signal available", never a block — when there's no linked
   * task to judge against, the provider has no `consult` support, there's
   * nothing to diff, or the consult itself throws; the caller treats null
   * exactly like an "approve" so Force Done's override still works on a
   * fleet/provider that simply can't answer this.
   */
  private async judgeForceDoneCompleteness(
    agent: TaskRun,
    project: Project | undefined,
    git: GitContext,
    baseRef: string,
  ): Promise<{ approve: boolean; reason: string; stat: DiffStat; patch: string } | null> {
    const task = (await this.store.listTasks(agent.workspaceId)).find((t) => t.runId === agent.id);
    if (!task) return null;
    const provider = await this.getProvider(agent.provider);
    if (!provider.consult) return null;
    const stat = await git.worktrees.diffStat(agent.id, baseRef);
    const patch = await git.worktrees.patch(agent.id, baseRef);
    if (!patch) return null; // nothing changed — nothing to judge
    const apiKey = await secretService.resolve(agent.workspaceId, agent.credentialId ?? agent.provider);
    const feature = task.featureId ? await this.store.getFeature(task.featureId).catch(() => undefined) : undefined;
    const reply = await provider.consult(
      { task: buildAgentContext({ project, feature, body: task.text }), model: agent.model, cwd: config.runnerCwd, apiKey, context: patch },
      `Review whether this run satisfies the task "${task.text}". ${REVIEW_OUTPUT_INSTRUCTION}`,
    );
    const verdict = parseReviewVerdict(reply);
    return { approve: verdict.approve, reason: verdict.reason, stat, patch };
  }

  /**
   * Force Done's completeness check came back "flag": don't push/merge —
   * raise a REAL diff review instead (bypassing raiseDiffReview's own
   * `full`-autonomy fast path, which would otherwise silently auto-merge
   * straight past the finding this function exists to surface) and stamp the
   * verdict onto the task immediately so the "⚠ flagged for you" banner shows
   * without waiting for a later autonomy tick. Raising the HITL is also the
   * notification — Telegram/push already fires for every newly-raised gate,
   * so the operator hears about this the moment it happens, not silently.
   */
  private async flagForceDoneIncomplete(
    runId: string,
    workspaceId: string,
    taskId: string | null,
    judged: { reason: string; stat: DiffStat; patch: string },
  ): Promise<void> {
    await this.hub.runStatus(runId, "review");
    await this.hub.runLog(runId, `Force Done held back — looks incomplete: ${judged.reason}`);
    const resolvedTaskId = taskId ?? (await this.store.listTasks(workspaceId)).find((t) => t.runId === runId)?.id ?? null;
    if (resolvedTaskId) {
      const task = await this.store.getTask(resolvedTaskId);
      if (task) {
        await this.hub.upsertTask({
          ...task,
          state: "review",
          reviewVerdict: { decision: "flag", reason: judged.reason, by: "force-done-check", at: now(), evidence: null, breaker: null },
        });
      }
    }
    await this.raiseDiffReview(runId, judged.stat, judged.patch, { skipFullAutonomy: true });
  }

  /**
   * Force Done's git-aware path when there's no open HITL to approve:
   * commits whatever's sitting uncommitted in a still-LIVE run's worktree
   * (mirroring what `complete()` already does at the end of a normal turn —
   * a live run may be mid-turn and never reached that point), frees the
   * runner the same way `stopAgent()`/`restoreCheckpoint()` already do, then
   * checks completeness before pushing: an "approve" (or no signal — see
   * {@link judgeForceDoneCompleteness}) routes the branch through
   * {@link integrateRun} exactly as before; a "flag" withholds the push and
   * raises a real diff review instead (see {@link flagForceDoneIncomplete}).
   * Returns "nothing" when there's genuinely nothing to integrate (no run,
   * already done, or no worktree/git backend at all) so the caller falls
   * back to a cosmetic-only "done" rather than fabricating one over unlanded
   * work; "integrated" or "flagged" both mean real work happened here and
   * the caller must NOT also cosmetically flip the task.
   */
  async forceIntegrateRun(runId: string): Promise<"integrated" | "flagged" | "nothing"> {
    const agent = await this.store.getRun(runId);
    if (!agent || agent.status === "done") return "nothing";
    const live = this.live.get(runId);
    const project = await this.store.getProject(agent.projectId);
    const git = live?.git ?? this.gitContextFor(project);
    if (!git || !git.worktrees.exists(runId)) return "nothing";

    // Commit whatever's uncommitted right now — idempotent (a no-op on a
    // clean worktree, same as complete()'s own call).
    await git.worktrees
      .commitAll(runId, `Skynet agent ${runId}: ${agent.name} (force-completed by operator)`)
      .catch(() => undefined);

    const taskId = live?.taskId ?? null;
    const baseRef = live?.baseRef ?? this.baseBranchFor(project);

    // A live run holds its runner exclusively — free it before handing the
    // worktree to the merge/push pipeline, the same release restoreCheckpoint()
    // already performs before rewinding a live run's worktree out from under it.
    if (live) {
      await live.handle.stop().catch(() => undefined);
      await this.freeRunner(live.agentId);
      this.live.delete(runId);
    }

    const judged = await this.judgeForceDoneCompleteness(agent, project, git, baseRef).catch(() => null);
    if (judged && !judged.approve) {
      await this.flagForceDoneIncomplete(runId, agent.workspaceId, taskId, judged);
      return "flagged";
    }

    return (await this.integrateRun(runId)) ? "integrated" : "nothing";
  }

  // ── deliver a resolved decision ────────────────────────────────────────────
  async deliver(item: HitlItem, resolution: Resolution): Promise<void> {
    const runId = item.runId;

    // Answered (by a human or the timeout) — cancel any pending expiry timer.
    const timer = this.questionTimers.get(item.id);
    if (timer) {
      clearTimeout(timer);
      this.questionTimers.delete(item.id);
    }

    // The session circuit-breaker's summary escalation (see
    // noteAutonomyBadOutcome) is purely informational — it's tied to the LAST
    // bad run only because HitlItem.runId is required, but it's not "about"
    // that run the way a real escalation is. resolveHitl (the caller) already
    // marked it resolved before reaching here, so any action (approve/reject/
    // modify) just dismisses the notice; the real "resume" lever is the
    // project's own autonomy toggle, not a run-lifecycle action.
    if (item.kind === "escalation" && item.flags.includes("autonomy-paused")) return;

    // Escalation has its own resolution semantics (help & resume / reassign / stop).
    if (item.kind === "escalation") {
      await this.deliverEscalation(item, resolution);
      return;
    }

    // diff-approve / merge-retry / verifier-retry → integrate the agent's
    // branch. This is the post-approval half of the `approveBeforePush`
    // guardrail: the diff review gated here, so reaching this point means an
    // operator approved the push (or a failed merge/check is being retried).
    if (resolution.action === "approve" && (item.kind === "diff" || item.kind === "merge" || item.kind === "verifier")) {
      const integrated = await this.integrateRun(runId, {
        sourceBranchOverride: item.sourceBranchOverride,
        targetBranch: resolution.targetBranch ?? item.diff?.defaultTargetBranch ?? undefined,
        kind: item.kind,
      });
      if (integrated) return;
    }

    // Operator escape hatch on a merge conflict: push the run's own branch and
    // open a GitHub PR against the project's base branch REGARDLESS of the
    // local conflict, instead of reconciling it via the (possibly batched)
    // local merge queue — so a human can resolve it on GitHub, which has real
    // conflict-resolution tooling, rather than being blocked on an automated
    // clean merge. Reuses the exact push+PR path a normal diff approval takes
    // when GitHub is connected; pushToGithub/openPrForRun already escalate for
    // a rebase on a stale-base conflict, so that safety net still applies here.
    if (resolution.action === "push" && item.kind === "merge") {
      const agent = await this.store.getRun(runId);
      if (!agent) return;
      const project = await this.store.getProject(agent.projectId);
      const git = this.gitContextFor(project);
      const conn = await githubService.get(agent.workspaceId);
      if (!(conn?.connected && project?.repo && git)) {
        await this.hub.runLog(
          runId,
          "push requested, but no GitHub repo is connected for this project — nothing to open a PR against.",
        );
        return;
      }
      await this.hub.runLog(runId, "pushing the branch and opening a PR despite the local merge conflict — reconcile it there");
      await this.pushToGithub(git, agent, project.repo, project);
      return;
    }

    // Review feedback loop: a `modify` OR `reject` on a finished run's
    // diff/merge/verifier review bounces the agent back to revise rather than
    // abandoning the run — reject needs no typed text to still bounce the agent
    // (a verifier's check failure, or a merge conflict's captured markers, is
    // already actionable guidance on its own). This mirrors the verifier gate's
    // existing reject semantics: "reject" here means "send it back for another
    // pass", not "kill the run" — that stronger action is what Stop is for.
    // Compute was freed for the review, so there's no live handle — re-acquire
    // one and resume the run in its worktree with the guidance
    // (reviseAfterReview), rather than silently dropping it.
    if (
      (item.kind === "diff" || item.kind === "merge" || item.kind === "verifier") &&
      (resolution.action === "modify" || resolution.action === "reject") &&
      !this.live.has(runId)
    ) {
      const typed = resolution.guidance?.trim() || "";
      // Blank guidance falls back to the gate's own captured output — a
      // verifier's check failure. A merge conflict is different: the
      // conflict markers MergeEngine captured before aborting are ALWAYS the
      // agent's primary context (Modify works with zero typing), with any
      // operator guidance appended rather than replacing it — the diff is
      // what needs resolving, not a stand-in for missing instructions.
      const guidance =
        item.kind === "merge"
          ? [item.output, typed ? `Additional guidance from the operator:\n${typed}` : null].filter(Boolean).join("\n\n")
          : typed || (item.kind === "verifier" ? item.output ?? "" : "");
      await this.reviseAfterReview(runId, guidance, item.kind === "merge");
      return;
    }

    const live = this.live.get(runId);
    if (live) {
      await live.handle.resume(resolution);
      return;
    }
    // No live runner to receive the decision — the parked session is gone (a
    // crash, or a server restart dropped the in-memory handle). Recover the way
    // an escalation/revise does: re-acquire compute and resume the run in its
    // worktree carrying the decision, so an approval/answer isn't silently lost.
    if (await this.resumeDecisionOnFreshRunner(item, resolution)) return;
    // Nothing to resume into (no worktree — e.g. a seeded/demo agent or a
    // non-git run) or an unsupported kind. Be honest: record that it couldn't be
    // delivered — don't fake a resume by flipping the agent back to "running".
    await this.hub.runLog(runId, `decision "${resolution.action}" recorded, but no live runner is attached — not delivered to an agent`);
  }

  /** A parked decision (approval / question / plan) whose runner already exited.
   *  Re-acquire compute and start a FRESH turn in the run's worktree carrying the
   *  operator's decision — the same recovery as {@link relaunchEscalated}, but for
   *  the resolve path. Returns true when it took over (resumed, or surfaced a
   *  no-compute failure); false when there's nothing to resume into (no worktree)
   *  or the kind isn't a mid-run gate, so the caller logs it as undelivered. */
  private async resumeDecisionOnFreshRunner(item: HitlItem, resolution: Resolution): Promise<boolean> {
    const runId = item.runId;
    // Only the mid-run "agent is parked, waiting on the operator" kinds resume by
    // re-prompting. diff/merge are review-stage (approve merges, modify revises —
    // both handled above) with different lifecycle semantics.
    if (item.kind !== "approval" && item.kind !== "question" && item.kind !== "plan") return false;
    const run = await this.store.getRun(runId);
    if (!run) return false;
    const git = await this.gitContextForAgent(runId).catch(() => undefined);
    // No worktree on disk → nothing committed to continue in. Fall back to the
    // honest "not delivered" log rather than launching an agent with no context.
    if (!git || !git.worktrees.exists(runId)) return false;

    let acq: { id: string; provider: TaskRun["provider"]; model: string };
    try {
      acq = await this.acquireOrProvisionRunner(run.workspaceId, run.provider, run.model, run.credentialId, await this.projectKeyAllowlist(run.projectId));
    } catch (err) {
      // Couldn't get compute right now — surface it (and park as waiting for a
      // retry) instead of the misleading "no runner attached" line.
      await this.hub.runLog(runId, `decision "${resolution.action}" recorded, but no compute is free to deliver it — ${(err as Error).message}`);
      await this.hub.runStatus(runId, "waiting");
      return true;
    }
    const provider = await this.getProvider(acq.provider);
    const cwd = git.worktrees.pathFor(runId);
    const apiKey = await secretService.resolve(run.workspaceId, run.credentialId ?? run.provider);
    const project = await this.store.getProject(run.projectId);
    const taskId = (await this.store.listTasks(run.workspaceId)).find((t) => t.runId === runId)?.id ?? null;
    const task = taskId ? await this.store.getTask(taskId) : undefined;
    const feature = task?.featureId ? await this.store.getFeature(task.featureId).catch(() => undefined) : undefined;
    const solutionBrief = task ? await this.findTaskBrief(task, run.workspaceId) : undefined;
    const prompt = buildAgentContext({
      project,
      feature,
      brief: solutionBrief ? this.briefContextText(solutionBrief) : undefined,
      body: decisionResumePrompt(item, resolution, run.branch),
    });
    await this.hub.runStatus(runId, "running");
    if (task) await this.hub.upsertTask({ ...task, state: "ongoing" });
    await this.hub.runLog(runId, `re-acquired compute to deliver "${resolution.action}" — resuming in the run's worktree`);
    try {
      const handle = await provider.start(
        { runId, projectId: run.projectId, task: prompt, model: run.model, branch: run.branch, cwd, apiKey, disallowedTools: project?.disallowedTools },
        this.events(),
      );
      this.live.set(runId, { handle, agentId: acq.id, taskId, branch: run.branch, baseRef: config.baseBranch, git });
    } catch (err) {
      await this.failStartup(runId, acq.id, (err as Error).message);
    }
    return true;
  }

  /** A `modify` on a finished run's diff review: re-acquire compute and resume the
   *  agent in its existing worktree with the reviewer's guidance so it can revise
   *  and re-submit. The worktree still holds the committed work (retire happens
   *  only on merge), so a fresh turn edits on top of it; on the agent's next
   *  completion, complete() re-commits and re-raises the review. Loops until the
   *  operator approves. */
  private async reviseAfterReview(runId: string, guidance: string, isConflict = false): Promise<void> {
    const review = this.reviews.get(runId);
    const run = await this.store.getRun(runId);
    if (!run || !review) {
      await this.hub.runLog(runId, `revision requested but this run is no longer resumable — not applied`);
      return;
    }
    let acq: { id: string; provider: TaskRun["provider"]; model: string };
    try {
      acq = await this.acquireOrProvisionRunner(run.workspaceId, run.provider, run.model, run.credentialId, await this.projectKeyAllowlist(run.projectId));
    } catch (err) {
      await this.hub.runLog(runId, `cannot revise — ${(err as Error).message}`);
      return;
    }
    const provider = await this.getProvider(acq.provider);
    const cwd = review.git.worktrees.pathFor(runId);
    const apiKey = await secretService.resolve(run.workspaceId, run.credentialId ?? run.provider);
    const project = await this.store.getProject(run.projectId);
    const task = review.taskId ? await this.store.getTask(review.taskId) : undefined;
    const feature = task?.featureId ? await this.store.getFeature(task.featureId).catch(() => undefined) : undefined;
    const solutionBrief = task ? await this.findTaskBrief(task, run.workspaceId) : undefined;
    const revisePrompt = buildAgentContext({
      project,
      feature,
      brief: solutionBrief ? this.briefContextText(solutionBrief) : undefined,
      body: isConflict
        ? `Your branch (${run.branch}) has a merge conflict integrating into the target branch — it could not be ` +
          `merged automatically. Below is the actual conflict (git diff output, including the ` +
          `<<<<<<</=======/>>>>>>> markers) captured right before the merge attempt was aborted — the first line ` +
          `names the real target branch/ref:\n\n${guidance}\n\n` +
          `Your previous output is already in the working directory, but the target branch's OWN content is not — ` +
          `the diff above is a snapshot, not something to trust blindly for a non-trivial conflict. Before resolving, ` +
          `inspect the target branch's actual current content directly, e.g. \`git show <target branch>:<path>\` or ` +
          `\`git diff <target branch> -- <path>\` for each conflicting file, so your resolution reflects its real ` +
          `current state, not just a reconstruction from the diff snippet. Then resolve the conflict — pick the right ` +
          `resolution for each hunk, remove the conflict markers — commit it, then stop. It'll be retried automatically.`
        : `A reviewer looked at your work and asked for changes before it can be merged:\n\n${guidance}\n\n` +
          `Your previous output is already in the working directory (branch ${run.branch}). Read it, make ` +
          `only the changes needed to address the request, then stop.`,
    });
    await this.hub.runStatus(runId, "running");
    if (task) await this.hub.upsertTask({ ...task, state: "ongoing" });
    await this.hub.runLog(runId, "revising per review guidance");
    try {
      const handle = await provider.start(
        { runId, projectId: run.projectId, task: revisePrompt, model: run.model, branch: run.branch, cwd, apiKey, disallowedTools: project?.disallowedTools },
        this.events(),
      );
      this.live.set(runId, { handle, agentId: acq.id, taskId: review.taskId, branch: run.branch, baseRef: review.baseRef, git: review.git });
      this.reviews.delete(runId);
    } catch (err) {
      await this.failStartup(runId, acq.id, (err as Error).message);
    }
  }

  // ── Escalation: halt a run that can't finish and hand it to a human ─────────

  /** System-driven escalation (too long / too many failures): halt the run and
   *  hand it to a human. Captures the worktree context so it can be resumed,
   *  frees the runner (but never retires the worktree), and raises an
   *  `escalation` HITL. Idempotent per run. Agent-driven escalation goes
   *  through raise() instead — same free-the-runner treatment for a
   *  worktree-backed run (a chat-only run's live gate still stays parked;
   *  see raise()'s own doc comment). */
  private async escalate(runId: string, reason: string, source: EscalationSource): Promise<void> {
    if (this.escalations.has(runId)) return; // already escalated — don't re-raise
    const run = await this.store.getRun(runId);
    if (!run) return;
    const live = this.live.get(runId);
    const git = live?.git ?? (await this.gitContextForAgent(runId).catch(() => undefined));
    // Halt the stuck/failed session so it stops holding its slot + burning
    // tokens, and free the runner — but DO NOT retire the worktree (resume needs it).
    if (live) await live.handle.stop().catch(() => undefined);
    await this.freeRunner(live?.agentId ?? null);
    this.live.delete(runId);
    // live.taskId covers the common (in-flight) case; a caller with no live
    // handle (e.g. reapStuckReviews, sweeping an already-parked run) still
    // needs the task looked up by its runId pointer, or a successful
    // resume/reassign could never move the task back to "ongoing".
    const taskId = live?.taskId ?? (await this.store.listTasks(run.workspaceId)).find((t) => t.runId === run.id)?.id ?? null;
    await this.raiseEscalationCard(run, reason, source, { git, baseRef: live?.baseRef, taskId });
  }

  /** Operator-driven pause (task sent back to Todo with "keep the work"): halts
   *  the run and preserves its worktree exactly like `escalate()`, but raises NO
   *  HITL card — nothing needs the operator's attention right now, they just
   *  chose to come back to it later. Resuming happens the ordinary way: clicking
   *  "Start →" on the task again calls `assignTask`, which detects a `waiting`
   *  run still on record and relaunches it in place (see the DEF-003 guard). */
  async pauseRun(runId: string): Promise<void> {
    const run = await this.store.getRun(runId);
    if (!run) return;
    const live = this.live.get(runId);
    const git = live?.git ?? (await this.gitContextForAgent(runId).catch(() => undefined));
    if (live) await live.handle.stop().catch(() => undefined);
    await this.freeRunner(live?.agentId ?? null);
    this.live.delete(runId);
    const taskId = live?.taskId ?? (await this.store.listTasks(run.workspaceId)).find((t) => t.runId === run.id)?.id ?? null;
    this.escalations.set(runId, { git, baseRef: live?.baseRef, taskId, source: "paused" });
    await this.hub.runStatus(runId, "waiting");
    await this.hub.runLog(runId, "sent back to Todo — work preserved, resume anytime");
  }

  /** Build + raise the actual escalation HITL — factored out of `escalate()` so
   *  `relaunchEscalated`'s failure path (below) can re-raise a fresh, actionable
   *  card after a failed resume/reassign attempt, without `escalate()`'s
   *  idempotency guard swallowing it (at that point `this.escalations` still
   *  holds the ORIGINAL record — the resolved HITL that led here is already
   *  gone, so silently no-op'ing would strand the run with nothing to click). */
  private async raiseEscalationCard(
    run: TaskRun,
    reason: string,
    source: EscalationSource,
    ctx: { git?: GitContext; baseRef?: string; taskId?: string | null; agentId?: string | null },
  ): Promise<void> {
    this.escalations.set(run.id, { git: ctx.git, baseRef: ctx.baseRef, taskId: ctx.taskId ?? null, source, agentId: ctx.agentId });
    const item: HitlItem = {
      id: `q-${run.id}-${++this.seq}`,
      workspaceId: run.workspaceId,
      runId: run.id,
      kind: "escalation",
      title:
        source === "timeout"
          ? "Run stuck — needs a human"
          : source === "conflict"
            ? "Merge conflict with main — needs a rebase"
            : source === "turns"
              ? "Ran out of turns — resume to continue"
              : source === "stalled"
                ? "Runner went silent — resume to continue"
                : source === "billing"
                  ? "Provider key out of credits — top up to resume"
                  : source === "stuck-review"
                    ? "Done — awaiting your review"
                    : source === "paused"
                      ? "Resume failed — needs a human"
                      : "Run keeps failing — needs a human",
      why: reason,
      // Every other source means something actually went wrong (timeout,
      // failures, a conflict, ran dry). stuck-review means the opposite: the
      // run finished, nothing is broken — the operator's review is the only
      // thing pending, so it doesn't carry the same risk.
      risk: source === "stuck-review" ? "low" : "medium",
      rationale: null,
      raisedAt: now(),
      expiresAt: null,
      resolvedAt: null,
      resolution: null,
      command: null,
      options: null,
      recommended: null,
      steps: null,
      diff: null,
      output: null,
      flags: [source],
      sourceBranchOverride: null,
    };
    await this.hub.runStatus(run.id, "waiting");
    await this.hub.raiseHitl(item);
    await this.hub.runLog(run.id, `escalated (${source}) — ${reason}`);
  }

  /**
   * Record one BAD autonomy outcome (a flagged review, or a failed run) for a
   * project and trip the circuit breaker at `config.autonomyMaxConsecutiveFailures`
   * consecutive bad outcomes with no good one in between: turn the project's
   * OWN `autonomy` toggle off (persisted — the existing UI switch reflects it,
   * and flipping it back on resumes + resets the streak) and raise ONE summary
   * `escalation` HITL instead of letting the sweep grind through more tasks.
   * Only tracked while the project is actually autonomous — a manually-
   * supervised project (autonomy already off) isn't "sweeping", so its
   * outcomes don't feed this and can't re-trip it.
   */
  private async noteAutonomyBadOutcome(project: Project, runId: string, entry: string): Promise<void> {
    const max = config.autonomyMaxConsecutiveFailures;
    if (!project.autonomy || max <= 0) return;
    const streak = this.autonomyStreaks.get(project.id) ?? { count: 0, entries: [] };
    streak.count += 1;
    streak.entries.push(entry);
    if (streak.count < max) {
      this.autonomyStreaks.set(project.id, streak);
      return;
    }
    // Tripped. Reset the streak BEFORE anything async can race a fresh bad
    // outcome in (e.g. a review verdict for a run already in flight) into
    // re-tripping on top of an already-paused project.
    this.autonomyStreaks.delete(project.id);
    await this.hub.upsertProject({ ...project, autonomy: false });
    const list = streak.entries.map((e, i) => `${i + 1}) ${e}`).join(" ");
    const item: HitlItem = {
      id: `q-autonomy-${project.id}-${++this.seq}`,
      workspaceId: project.workspaceId,
      runId,
      kind: "escalation",
      title: `Autonomy paused — ${streak.count} bad outcomes in a row`,
      why:
        `${project.name}'s autonomous sweep hit ${streak.count} bad outcomes in a row with no ` +
        `success in between, so autonomy was turned off to stop it grinding through more tasks: ${list} ` +
        `This does NOT auto-resume — re-enable Autonomy on the project page when you're ready; the streak resets.`,
      risk: "medium",
      rationale: null,
      raisedAt: now(),
      expiresAt: null,
      resolvedAt: null,
      resolution: null,
      command: null,
      options: null,
      recommended: null,
      steps: null,
      diff: null,
      output: null,
      // Distinguishes this from a run-level escalation for deliver()'s dispatch
      // (see below): resolving it just dismisses the notice — the real "resume"
      // lever is the project's own autonomy toggle, not a run action (there's no
      // single run to resume/reassign/stop here).
      flags: ["autonomy-paused"],
      sourceBranchOverride: null,
    };
    await this.hub.raiseHitl(item);
    await this.hub.runLog(runId, `project autonomy paused — ${streak.count} consecutive bad outcomes`).catch(() => undefined);
  }

  /** A good autonomy outcome (an auto-review approve) — clears any accumulated
   *  bad streak for the project, same as an operator re-enabling autonomy. */
  private noteAutonomyGoodOutcome(projectId: string): void {
    this.autonomyStreaks.delete(projectId);
  }

  /** Operator re-enabled a project's `autonomy` toggle (operations.ts#updateProject)
   *  — clear any accumulated circuit-breaker streak so it starts fresh instead of
   *  being able to re-trip on the very next bad outcome. */
  resetAutonomyStreak(projectId: string): void {
    this.autonomyStreaks.delete(projectId);
  }

  /** Resolve an `escalation`: help & resume (modify), reassign, stop (reject), or
   *  dismiss (clear the card, no operation on the run — see `dismiss` below). */
  private async deliverEscalation(item: HitlItem, resolution: Resolution): Promise<void> {
    const runId = item.runId;
    const live = this.live.get(runId);
    if (resolution.action === "dismiss") {
      // Genuinely a no-op: the card is already resolved (hub does that before
      // calling deliver()) — don't stop/resume/reassign anything, and leave the
      // escalation's saved git context in `this.escalations` alone, so Help &
      // resume / Reassign are still available later (from the task page) even
      // though this card is gone. A stuck-review escalation is the one case
      // where the run's OWN status ("waiting", forced by raiseEscalationCard so
      // the card would surface) doesn't match reality — it's still genuinely at
      // "review", so put it back rather than leaving it misreported as blocked.
      if (item.flags?.includes("stuck-review")) await this.hub.runStatus(runId, "review");
      await this.hub.runLog(runId, "escalation dismissed — no action taken");
      return;
    }
    if (resolution.action === "reject") {
      // Stop: abandon the run cleanly and reclaim its worktree.
      const taskId = this.escalations.get(runId)?.taskId ?? live?.taskId ?? null;
      if (live) await live.handle.stop().catch(() => undefined);
      await this.freeRunner(live?.agentId ?? null);
      this.live.delete(runId);
      const git = this.escalations.get(runId)?.git ?? live?.git;
      if (git) await git.worktrees.retire(runId).catch(() => undefined);
      await this.releaseScratchCwd(live?.scratchCwd);
      this.escalations.delete(runId);
      this.failCounts.delete(runId);
      await this.hub.runStatus(runId, "done");
      await this.hub.runLog(runId, "escalation resolved — operator stopped the run");
      // Same invariant haltAgent upholds for a plain (non-escalated) Stop: a
      // stopped run integrates no change, so its task must not be left
      // stranded "ongoing"/"review" with no live run behind it — that reads as
      // in-progress while nothing is working it. Without this, EVERY
      // escalation stopped via this path (a reap, a stalled runner, an agent
      // escalation the operator declines) orphans its task in the kanban
      // forever — found live, 10 of 11 "ongoing" tasks on a real deployment
      // had already-done runs behind them, none reachable by drag (ongoing's
      // only legal human move is → todo, and nothing was making that move).
      if (taskId) {
        const task = await this.store.getTask(taskId).catch(() => undefined);
        if (task && (task.state === "ongoing" || task.state === "review")) {
          await this.hub.upsertTask({ ...task, state: "todo", runId: null, reviewVerdict: null }).catch(() => undefined);
        }
      }
      return;
    }
    // A worktree-backed escalation frees its runner + clears `this.live` the
    // moment it's raised (see raise()/escalate()), so `live` is normally gone
    // by the time an operator resolves the card — falls through to
    // relaunchEscalated below. The one case this DOES still fire: a chat-only
    // run (no bound repo), which raise() deliberately leaves parked, because
    // relaunchEscalated has no worktree to reacquire into for it — this is
    // that run's only real resume path, not a hypothetical safety net.
    if (resolution.action === "modify" && live) {
      await this.hub.runStatus(runId, "running");
      await live.handle.resume(resolution);
      this.escalations.delete(runId);
      this.failCounts.delete(runId);
      await this.hub.runLog(runId, "escalation resolved — resuming the agent with your guidance");
      return;
    }
    // Reassign + reset: the operator explicitly wants a CLEAN slate on the new
    // runner, not a continuation — same effect as Stop, then a fresh assignTask
    // for the same task (new run id, new branch, new worktree). Only meaningful
    // alongside a real reassign; a bare "reset" isn't itself an action.
    if (resolution.action === "reassign" && resolution.resetWork) {
      const run = await this.store.getRun(runId);
      const taskId = this.escalations.get(runId)?.taskId ?? live?.taskId ?? null;
      if (live) await live.handle.stop().catch(() => undefined);
      await this.freeRunner(live?.agentId ?? null);
      this.live.delete(runId);
      const git = this.escalations.get(runId)?.git ?? live?.git;
      if (git) await git.worktrees.retire(runId).catch(() => undefined);
      await this.releaseScratchCwd(live?.scratchCwd);
      this.escalations.delete(runId);
      this.failCounts.delete(runId);
      await this.hub.runStatus(runId, "done");
      await this.hub.runLog(runId, "escalation resolved — operator reassigned with a clean slate (previous work discarded)");
      if (run && taskId) await this.assignTask(run.projectId, taskId).catch(() => undefined);
      return;
    }
    // Reassign, or help a run whose handle was already torn down → relaunch a
    // fresh session in the worktree (it picks up the committed work + guidance).
    await this.relaunchEscalated(runId, resolution.guidance?.trim() || "", resolution.action === "reassign");
  }

  /** Re-acquire compute for an escalated run and start a fresh session in its
   *  worktree with the operator's guidance. `reassign` moves it to a DIFFERENT
   *  runner (acquire the replacement BEFORE freeing the current, so the same idle
   *  runner isn't re-picked). */
  private async relaunchEscalated(runId: string, guidance: string, reassign: boolean): Promise<void> {
    const run = await this.store.getRun(runId);
    const ctx = this.escalations.get(runId);
    if (!run) return;
    // Resuming a run implies the operator addressed whatever blocked it — if it
    // was a billing wall, clear the breaker so this run (and others on the key)
    // can acquire a runner again. Done before the worktree check so the key is
    // freed even when this particular run can't be relaunched.
    this.clearDepletedKey(run);
    const live = this.live.get(runId);
    const git = ctx?.git ?? live?.git ?? (await this.gitContextForAgent(runId).catch(() => undefined));
    if (!git) {
      await this.hub.runLog(runId, "cannot resume — this run has no worktree to continue in");
      return;
    }
    // The worktree may have been cleaned up while the run sat escalated (the
    // reaper frees long-dead runs; restarts and disk hygiene prune their
    // directories) — but `git worktree remove` never deletes the BRANCH, so the
    // committed work survives in the shared repo. Re-attach a fresh worktree
    // from that branch instead of spawning the agent into a nonexistent cwd,
    // which dies instantly with a misleading low-level error (the SDK guesses
    // "binary/libc mismatch" when spawn fails on a missing directory). Checked
    // BEFORE acquiring a runner so a hopeless relaunch never burns capacity.
    if (!git.worktrees.exists(runId)) {
      try {
        await git.worktrees.reattach(runId, run.branch);
        await this.hub.runLog(runId, `worktree was cleaned up while this run waited — re-attached from branch ${run.branch} (committed work preserved)`);
      } catch (err) {
        await this.hub.runLog(runId, `cannot ${reassign ? "reassign" : "resume"} — worktree is gone and ${(err as Error).message}`);
        await this.raiseEscalationCard(run, `${reassign ? "reassign" : "resume"} failed — worktree is gone and ${(err as Error).message}`, ctx?.source ?? "stalled", {
          git,
          baseRef: ctx?.baseRef,
          taskId: ctx?.taskId ?? null,
        }).catch(() => undefined);
        return;
      }
    }
    let acq: { id: string; provider: TaskRun["provider"]; model: string };
    try {
      if (!reassign && live) {
        await live.handle.stop().catch(() => undefined);
        await this.freeRunner(live.agentId);
        this.live.delete(runId);
      }
      acq = await this.acquireOrProvisionRunner(
        run.workspaceId,
        run.provider,
        run.model,
        undefined,
        await this.projectKeyAllowlist(run.projectId),
        reassign ? (live?.agentId ?? ctx?.agentId) : undefined,
      );
      if (reassign && live) {
        await live.handle.stop().catch(() => undefined);
        await this.freeRunner(live.agentId);
        this.live.delete(runId);
      }
    } catch (err) {
      // Same dead-end as the provider.start() failure below, one step earlier:
      // no runner could be acquired at all (e.g. the assigned agent was removed
      // — "reassign when the runner left" — or every eligible runner is busy).
      // The HITL that got us here is already resolved (resolveHitl resolves it
      // BEFORE this runs), so just logging + "waiting" left nothing on screen
      // to click — re-raise a fresh escalation instead.
      await this.hub.runLog(runId, `cannot ${reassign ? "reassign" : "resume"} — ${(err as Error).message}`);
      await this.raiseEscalationCard(run, `${reassign ? "reassign" : "resume"} failed — ${(err as Error).message}`, ctx?.source ?? "stalled", {
        git,
        baseRef: ctx?.baseRef,
        taskId: ctx?.taskId ?? null,
      }).catch(() => undefined);
      return;
    }
    // The previous agent is now confirmed stopped (both branches above call
    // live.handle.stop() before reaching here). If it was killed mid-`git
    // merge`/`git rebase` — plausibly WHY it got stuck in the first place, if
    // it hit a conflict it didn't know how to resolve — the new agent would
    // otherwise inherit that half-finished operation with no idea it's there,
    // and has to reverse-engineer it via ad-hoc `git log`/`status`/`fsck`
    // archaeology before it can even start (observed in the wild: exactly
    // that sequence, ending in a second stuck-escalation). Abort is always
    // safe — only the interrupted merge/rebase itself is undone, never any
    // committed or uncommitted file changes.
    const cleanedGitState = await git.worktrees.sanitizeInterrupted(runId).catch(() => []);
    if (cleanedGitState.length > 0) {
      await this.hub.runLog(
        runId,
        `found an interrupted git ${cleanedGitState.join("/")} left by the previous agent — aborted it (no file changes touched) before handing off`,
      );
    }
    const provider = await this.getProvider(acq.provider);
    const cwd = git.worktrees.pathFor(runId);
    const apiKey = await secretService.resolve(run.workspaceId, run.provider);
    const project = await this.store.getProject(run.projectId);
    const task = ctx?.taskId ? await this.store.getTask(ctx.taskId) : undefined;
    const feature = task?.featureId ? await this.store.getFeature(task.featureId).catch(() => undefined) : undefined;
    const solutionBrief = task ? await this.findTaskBrief(task, run.workspaceId) : undefined;
    const siblings = project && task ? await this.siblingDigestFor(project, task.id) : undefined;
    const gitStateNote =
      cleanedGitState.length > 0
        ? `\n\nNote: the previous agent was interrupted mid-\`git ${cleanedGitState.join("/")}\` — it's been aborted for you (no file changes were touched), so the working directory reflects only real committed/uncommitted work, not a half-finished merge. No need to investigate this further.`
        : "";
    const prompt = buildAgentContext({
      project,
      feature,
      brief: solutionBrief ? this.briefContextText(solutionBrief) : undefined,
      siblings,
      body: reassign
        ? `You are taking over a task another agent escalated because it got stuck. Its work so far is already in the working directory (branch ${run.branch}).${gitStateNote}${guidance ? `\n\nOperator guidance:\n\n${guidance}` : ""}\n\nReview what's there, then continue and finish the task. If you also get stuck, escalate (AskUserQuestion with header "ESCALATE").`
        : `You escalated this task for help, and the operator responded:\n\n${guidance || "(no specific guidance — use your best judgement, or escalate again if still blocked)"}\n\nYour work so far is already in the working directory (branch ${run.branch}).${gitStateNote} Continue with this guidance and finish, or escalate again (AskUserQuestion with header "ESCALATE") if you're still blocked.`,
    });
    // Reflect the (re)acquired runner on the persisted run: a reassign moves the
    // run to a DIFFERENT agent, and the board/subway attribute runs by agentId —
    // without this the run stays drawn under the agent it was escalated from
    // (which is now idle), looking like a stray/duplicate station.
    const running = await this.store.getRun(runId);
    if (running) await this.hub.upsertRun({ ...running, status: "running", agentId: acq.id });
    else await this.hub.runStatus(runId, "running");
    if (task) await this.hub.upsertTask({ ...task, state: "ongoing" });
    await this.hub.runLog(runId, reassign ? "reassigned to another runner after escalation" : "resuming after escalation with operator guidance");
    try {
      const handle = await provider.start(
        { runId, projectId: run.projectId, task: prompt, model: run.model, branch: run.branch, cwd, apiKey, disallowedTools: project?.disallowedTools },
        this.events(),
      );
      this.live.set(runId, { handle, agentId: acq.id, taskId: ctx?.taskId ?? null, branch: run.branch, baseRef: ctx?.baseRef ?? this.baseBranchFor(project), git });
      this.escalations.delete(runId);
      this.failCounts.delete(runId);
    } catch (err) {
      // NOT failStartup() — that retires the worktree and dumps the run into a
      // dead "review" limbo with no HITL to act on, which is exactly right for
      // a brand-new run that never produced anything, but wrong here: this
      // worktree holds real prior work, the operator already tried to resume
      // it once, and the resolved HITL that got us here is gone. Re-raise a
      // fresh, actionable escalation instead (worktree untouched) so Resume /
      // Reassign / Stop are on the table again — the one-shot failure (a
      // transient provider outage, say) doesn't have to be the end of the run.
      await this.freeRunner(acq.id);
      await this.raiseEscalationCard(run, `resume failed — ${(err as Error).message}`, ctx?.source ?? "stalled", {
        git,
        baseRef: ctx?.baseRef,
        taskId: ctx?.taskId ?? null,
      }).catch(() => undefined);
    }
  }

  /** Merge committed: free the runner, mark the owning task done, finish the agent. */
  private async completeMerged(runId: string, branch: string): Promise<void> {
    const review = this.reviews.get(runId);
    this.reviews.delete(runId); // integrated — no longer awaiting a revise
    const agent = await this.store.getRun(runId);
    await this.freeRunner(agent?.agentId ?? null);
    // Advance the owning task to done alongside the run. Resolve it by the EXACT
    // taskId we stashed when the review was raised (reliable), falling back to a
    // runId match. The find-by-runId alone left tasks stranded in `review` after
    // their run reached `done` (an incoherent lifecycle) whenever that lookup came
    // up empty — a task's `runId` is set at assign, but this closes the gap and,
    // if a task still can't be resolved, says so loudly rather than silently
    // leaving it behind.
    const taskId =
      review?.taskId ??
      (agent ? (await this.store.listTasks(agent.workspaceId)).find((t) => t.runId === runId)?.id : undefined);
    if (taskId) {
      const task = await this.store.getTask(taskId);
      if (task && task.state !== "done") await this.hub.upsertTask({ ...task, state: "done" });
    } else {
      await this.hub.runLog(runId, "merged, but could not resolve the owning task to mark it done");
    }
    await this.hub.runStatus(runId, "done");
    const merged = await this.store.getRun(runId);
    if (merged) await this.hub.upsertRun({ ...merged, mergedAt: now() });
    await this.hub.runCompleted(runId, branch);
    const live = this.live.get(runId);
    if (live) {
      await live.handle.stop().catch(() => undefined);
      this.live.delete(runId);
    }
    // Integrated — retire the agent's worktree (the branch is kept in history).
    const ctx = await this.gitContextForAgent(runId).catch(() => undefined);
    if (ctx) await ctx.worktrees.retire(runId).catch(() => undefined);
    // A change just landed on the integration branch → nudge a live preview to
    // re-point at the new tip so the operator sees the app update (docs/live-preview.md).
    if (agent?.projectId) void projectPreview.refresh(agent.projectId).catch(() => undefined);

    // Feature-scoped branch batching: this task just merged into its feature
    // branch (step 1). If every sibling task under the same Feature is now
    // also done, close out the batch instead of waiting on nothing further.
    if (taskId && agent) {
      const task = await this.store.getTask(taskId);
      if (task?.featureId) {
        await this.checkFeatureCompletion(task.featureId, agent.workspaceId, agent.projectId).catch((err) =>
          this.hub.runLog(runId, `feature completion check failed: ${(err as Error).message}`).catch(() => undefined),
        );
      }
    }
  }

  /** Feature-scoped branch batching: after a task under a Feature merges into
   *  the feature branch, check whether every sibling task is now done — if so,
   *  close out the batch: open ONE aggregate PR (feature branch → project
   *  base) for a GitHub-bound project, or merge the feature branch up into the
   *  project's own integration branch for a local-only one. A feature whose PR
   *  is already open is left alone — a later task falls back to default
   *  per-task routing at diff-approval time instead of trying to append to an
   *  in-flight aggregate PR (see `deliver()`). */
  private async checkFeatureCompletion(featureId: string, workspaceId: string, projectId: string): Promise<void> {
    const feature = await this.store.getFeature(featureId);
    if (!feature || feature.pr?.state === "open") return;
    const siblings = (await this.store.listTasks(workspaceId)).filter((t) => t.featureId === featureId && !t.archived);
    if (siblings.length === 0 || siblings.some((t) => t.state !== "done")) return;

    // S8 status: the feature just completed — if a SolutionBrief rolls up
    // into it and is still "building", it's done too. Checked first and
    // independent of the PR/merge machinery below (which can bail out for
    // reasons unrelated to the brief, e.g. no git backend) — the brief's
    // status reflects the WORK being done, not whether it got merged yet.
    const briefs = await this.store.listSolutionBriefs(workspaceId).catch(() => [] as SolutionBrief[]);
    const brief = briefs.find((b) => b.featureId === featureId);
    if (brief && brief.status === "building") {
      await this.hub.upsertSolutionBrief({ ...brief, status: "done" });
    }

    const anchorRunId = siblings.map((t) => t.runId).find((r): r is string => !!r);
    if (!anchorRunId) return; // no run to anchor a log line / HITL to — nothing more we can safely do

    const project = await this.store.getProject(projectId);
    const git = this.gitContextFor(project);
    if (!git) return;
    const taskNames = siblings.map((t) => t.text);
    const conn = await githubService.get(workspaceId);
    if (conn?.connected && project?.repo) {
      await this.openPrForFeature(git, feature, project, project.repo, taskNames, anchorRunId);
      return;
    }
    // Local-only: merge the feature branch up into the project's own
    // integration branch. `featureId` unset on this request — the
    // DESTINATION is the normal integration branch; the SOURCE (`agentBranch`)
    // is the feature branch itself.
    await this.hub.runLog(anchorRunId, `"${feature.name}" — all ${siblings.length} task(s) done, merging the feature branch up`).catch(() => undefined);
    git.merge.enqueue({ runId: anchorRunId, projectId, agentBranch: `${FEATURE_BRANCH_PREFIX}${featureId}`, workspaceId });
  }

  /** Feature-scoped branch batching step 2 completion (local-only projects):
   *  the feature branch merged cleanly into the project's integration branch.
   *  There's no single owning run to finalize (every task already reached
   *  `done` in step 1) — just mark the feature shipped and nudge the preview,
   *  mirroring the tail of `completeMerged` without any per-run cleanup. */
  private async completeFeatureMerged(req: MergeRequest): Promise<void> {
    const featureId = req.agentBranch.slice(FEATURE_BRANCH_PREFIX.length);
    const feature = await this.store.getFeature(featureId);
    if (feature) await this.hub.upsertFeature({ ...feature, status: "shipped" });
    await this.hub.runLog(req.runId, `"${feature?.name ?? featureId}" — feature branch merged into the integration branch. Shipped.`).catch(() => undefined);
    void projectPreview.refresh(req.projectId).catch(() => undefined);
  }

  /**
   * Integrate an approved agent branch via GitHub: run the safety preflight,
   * then (if clean) mint an installation token, push the branch, and open a PR.
   * The agent stays in `review` until the PR is merged on GitHub. Enforcement is
   * server-side here — the runner never had credentials to push around it.
   */
  /**
   * The real diff of a run's branch (unified patch + stat), for the diff-review
   * UI. Lazily produced from the worktree so patches never bloat the snapshot.
   * Returns an empty patch if the run has no git worktree (non-git project) or
   * it's already been retired.
   */
  async runDiff(runId: string): Promise<{ patch: string; add: number; del: number; files: string[] }> {
    const review = this.reviews.get(runId);
    const ctx = review?.git ?? (await this.gitContextForAgent(runId).catch(() => undefined));
    if (!ctx) return { patch: "", add: 0, del: 0, files: [] };
    // The worktree is branched off the project's integration tip, NOT `main`, so
    // diff against that base — the review's captured baseRef when we have it,
    // else the project's integration branch.
    const run = await this.store.getRun(runId);
    const baseRef = review?.baseRef ?? (run ? ctx.merge.integrationBranch(run.projectId) : config.baseBranch);
    const stat = await ctx.worktrees.diffStat(runId, baseRef);
    const patch = await ctx.worktrees.patch(runId, baseRef);
    return { patch, add: stat.add, del: stat.del, files: stat.files };
  }

  private async pushToGithub(git: GitContext, agent: TaskRun, repo: string, project?: Project | null): Promise<void> {
    // What the branch syncs to, is diffed against, and PRs into — normally the
    // project's effective base branch (its own `baseBranch` when set, else the
    // global default), or the run's manager's branch first when it's a
    // manager-delegated worker (see mergeTargetBranchFor; inert today).
    const base = await this.mergeTargetBranchFor(agent, project);
    // Bring the branch up to the LATEST base before the PR opens, so it merges
    // cleanly and the reviewer/GitHub never hits a stale-base conflict at merge
    // time. On conflict, escalate for a human rebase instead of opening a broken PR.
    const sync = await git.worktrees.mergeBase(agent.id);
    if (!sync.ok) {
      const files = sync.conflicts?.length ? `: ${sync.conflicts.join(", ")}` : "";
      await this.hub.runLog(agent.id, `${base} moved and merges conflict${files} — not opening a PR until it's rebased.`);
      await this.escalate(agent.id, `merge conflict with ${base}${files} — rebase the branch, then re-approve to open the PR.`, "conflict");
      return;
    }
    await this.openPrForRun(git, agent, repo, project, base, sync);
  }

  /** Push a base-synced branch and open (or refresh, idempotently) its PR, then
   *  record the ready-to-merge PR + advance the task to done. Shared by the first
   *  open (pushToGithub) and the "Update branch" re-sync (updateReadyPrBranch);
   *  the caller runs `mergeBase` first and decides how to handle a conflict. */
  private async openPrForRun(
    git: GitContext,
    agent: TaskRun,
    repo: string,
    project: Project | null | undefined,
    base: string,
    sync: { depsChanged?: boolean },
  ): Promise<void> {
    // If folding in the base changed a dependency manifest, reconcile the worktree's
    // deps so a revise loop / checks / preview run against the right ones.
    if (sync.depsChanged) {
      const r = await git.worktrees.installDeps(agent.id);
      await this.hub.runLog(
        agent.id,
        r.installed
          ? `${base} changed dependencies — re-installed (${r.note}).`
          : `${base} changed dependencies${r.note ? ` — ${r.note}` : " — no local node_modules to reconcile, skipped install"}.`,
      );
    }
    const worktreePath = git.worktrees.pathFor(agent.id);
    // Diff against the FETCHED remote-tracking ref, not the bare `base` branch
    // name: `base` resolves to this shared repo's own local branch pointer,
    // which nothing here ever fast-forwards (the caller's `mergeBase()` only
    // ever advances `refs/remotes/origin/<base>`, via fetchBase() — never the
    // local branch itself). A stale local `main` makes `main...HEAD` compute
    // its merge-base far in the past, so the "diff" balloons to include every
    // commit real `main` has gained since then, misattributed to this one PR
    // (surfaced live: a one-line ROADMAP edit reporting 900+ files changed).
    // freshBase() is a no-op ref lookup here — mergeBase() already fetched.
    const diffBase = await git.worktrees.freshBase();
    const stat = await git.worktrees.diffStat(agent.id, diffBase);
    const modules = this.moduleMapFor(project).modulesForFiles(stat.files);
    await this.hub.runStatus(agent.id, "review");
    // A task imported from a GitHub issue (Task.source) gets GitHub's own
    // "Closes #N" convention in the PR body, so merging the PR auto-closes the
    // source issue — belt-and-suspenders alongside task-sync.ts's direct
    // close-on-done write-back, since the human merge and the task reaching
    // `done` don't necessarily happen in the same order.
    const sourcedTask = (await this.store.listTasks(agent.workspaceId)).find((t) => t.runId === agent.id);
    const issueRef =
      sourcedTask?.source?.kind === "github_issue"
        ? sourcedTask.source.repo === repo
          ? `#${sourcedTask.source.number}`
          : `${sourcedTask.source.repo}#${sourcedTask.source.number}`
        : null;
    try {
      const result = await githubService.pushAndOpenPr({
        workspaceId: agent.workspaceId,
        runId: agent.id,
        repo,
        branch: agent.branch,
        baseBranch: base,
        worktreePath,
        changedFiles: stat.files,
        modules,
        allowedModules: agent.modules, // [] = unconstrained (no scope declared)
        force: false,
        githubCredentialId: project?.githubCredentialId ?? null, // push to the project's pinned account
        title: agent.name,
        body: `Automated by Skynet agent \`${agent.id}\`.\n\n${stat.add}+/${stat.del}- across ${stat.files.length} file(s).${issueRef ? `\n\nCloses ${issueRef}` : ""}`,
      });
      if (!result.ok) {
        await this.hub.runLog(agent.id, `push blocked by safety policy: ${result.violations.map((v) => v.message).join("; ")}`);
        return;
      }
      await this.hub.runLog(agent.id, `pushed ${agent.branch} → opened PR ${result.pr?.url ?? "(opened)"}`);

      // Opening the PR completes the task's WORK — advance it to `done` so the
      // pipeline never stalls. Merging is decoupled: the PR is recorded as
      // "ready to merge" (with the AI reviewer's briefing) and a human makes the
      // final merge call from that list. Skynet never auto-merges to the real
      // base branch — opening the PR is automated, the merge decision is a
      // human's. The worktree + review handle are KEPT (retire happens on merge)
      // so "rework with comment" can resume the agent on the same branch.
      if (result.pr) {
        const briefing = await this.buildMergeBriefing(agent, stat, modules);
        const fresh = await this.store.getRun(agent.id);
        if (fresh) {
          await this.hub.upsertRun({
            ...fresh,
            pr: { number: result.pr.number, url: result.pr.url, repo, branch: agent.branch, base, state: "open", openedAt: now(), briefing, dismissed: false },
          });
        }
        await this.hub.runLog(agent.id, `ready to merge — ${briefing.recommendation} (risk: ${briefing.risk}). Review + merge from the Ready-to-merge list; Skynet won't auto-merge.`);
        await this.markTaskDoneForRun(agent.id);
        await this.hub.runStatus(agent.id, "done");
      } else {
        // No PR ref came back (shouldn't happen) — keep the safe parked behavior.
        await this.hub.runStatus(agent.id, "review");
        await this.hub.runLog(agent.id, "PR opened but no reference returned — merge it on GitHub to complete.");
      }
    } catch (err) {
      await this.hub.runLog(agent.id, `GitHub push failed: ${(err as Error).message}`);
    }
  }

  /** Feature-scoped branch batching: push the shared feature branch and open
   *  ONE PR (feature branch → project base) for a batch of tasks that are all
   *  now done — instead of the N PRs `openPrForRun` would have opened one at a
   *  time. No live worktree exists for a feature branch the way one does for a
   *  single run (every task's own worktree already retired when it merged into
   *  this branch) — pushes straight from the shared repo path (`git.repo`);
   *  `pushBranch` pushes a named ref, not `HEAD`, so no checkout is needed.
   *  Diff-stat is read directly branch-to-branch (`MergeEngine.diffStat`), not
   *  from a worktree. `anchorRunId` is one of the batch's own (already-done)
   *  runs, borrowed purely so log lines and a future ready-to-merge briefing
   *  have somewhere to attach — the feature's own record (`Feature.pr`) is
   *  what the ready-to-merge list actually reads. */
  private async openPrForFeature(
    git: GitContext,
    feature: Feature,
    project: Project,
    repo: string,
    taskNames: string[],
    anchorRunId: string,
  ): Promise<void> {
    const base = this.baseBranchFor(project);
    const branch = `${FEATURE_BRANCH_PREFIX}${feature.id}`;
    // Same fix as openPrForRun's: `base` is a bare branch name — this shared
    // repo's own local pointer for it, which MergeEngine never fast-forwards
    // (it has no fetch of its own at all, unlike openPrForRun's caller). Fetch
    // + diff against the tracked remote ref instead, or the "diff" balloons to
    // include everything real `main` has gained since the local ref was last
    // touched. `git.worktrees` operates on the SAME repo path `git.merge`
    // does (both constructed from the one `gitContextForRepo` call) — reused
    // here purely for its fetch/ref-resolution, no worktree needed for either.
    await git.worktrees.fetchBase();
    const diffBase = await git.worktrees.freshBase();
    const stat = await git.merge.diffStat(branch, diffBase);
    const modules = this.moduleMapFor(project).modulesForFiles(stat.files);
    const siblings = (await this.store.listTasks(feature.workspaceId)).filter((t) => t.featureId === feature.id && !t.archived);
    const heuristic = this.buildFeatureMergeBriefing(feature, taskNames, stat, modules, siblings);
    // Feature-level brief (make the one human approval reviewable): drafted
    // alongside the heuristic, never blocking the PR on failure. `anchorRun`
    // supplies the provider/model/credential for the narrative consult; the
    // sibling runs supply the aggregate spend.
    const anchorRun = await this.store.getRun(anchorRunId);
    const siblingRuns = (
      await Promise.all(siblings.map((t) => (t.runId ? this.store.getRun(t.runId) : Promise.resolve(undefined))))
    ).filter((r): r is TaskRun => r != null);
    const patch = await git.merge.patch(branch, diffBase); // same fresh ref as the stat above — not the bare `base`
    const checksConfigured = !!(project.checkCmd?.trim() || config.checkCmd);
    const featureBrief = await this.draftFeatureBrief(anchorRun, siblings, siblingRuns, patch, checksConfigured);
    const briefing: MergeBriefing = { ...heuristic, featureBrief };
    try {
      const result = await githubService.pushAndOpenPr({
        workspaceId: feature.workspaceId,
        runId: anchorRunId,
        repo,
        branch,
        baseBranch: base,
        worktreePath: git.repo,
        changedFiles: stat.files,
        modules,
        allowedModules: [], // no single run's declared scope applies to a batch
        force: false,
        githubCredentialId: project.githubCredentialId ?? null,
        title: `${feature.name} (${taskNames.length} task${taskNames.length === 1 ? "" : "s"})`,
        body:
          `Automated by Skynet — batched feature merge.\n\n${stat.add}+/${stat.del}- across ${stat.files.length} file(s).\n\nTasks:\n` +
          taskNames.map((n) => `- ${n}`).join("\n"),
      });
      if (!result.ok) {
        await this.hub.runLog(anchorRunId, `feature PR push blocked by safety policy: ${result.violations.map((v) => v.message).join("; ")}`);
        return;
      }
      await this.hub.runLog(anchorRunId, `pushed ${branch} → opened feature PR ${result.pr?.url ?? "(opened)"}`);
      if (result.pr) {
        await this.hub.upsertFeature({
          ...feature,
          pr: { number: result.pr.number, url: result.pr.url, repo, branch, base, state: "open", openedAt: now(), briefing, dismissed: false },
        });
        await this.hub.runLog(
          anchorRunId,
          `"${feature.name}" ready to merge — ${briefing.recommendation} (risk: ${briefing.risk}). Review + merge from the Ready-to-merge list; Skynet won't auto-merge.`,
        );
      } else {
        await this.hub.runLog(anchorRunId, "feature PR opened but no reference returned — merge it on GitHub to complete.");
      }
    } catch (err) {
      await this.hub.runLog(anchorRunId, `GitHub push failed for feature branch: ${(err as Error).message}`);
    }
  }

  /** Same decision-aid heuristic as `buildMergeBriefing`, generalized for a
   *  batch of tasks sharing one feature PR instead of a single run: risk from
   *  the combined diff + sensitive-area check (unchanged heuristic), the
   *  summary/impact list the bundled task names, and the recommendation
   *  aggregates every sibling's recorded review verdict (any flagged task →
   *  "rework", so a batch never hides one task's flagged concern behind its
   *  siblings' clean ones).
   *
   *  Also applies the feature-batch SIZE guardrail (checkFeatureBatchSize):
   *  feature-scoped batching lets one human approval cover every task in the
   *  batch, but nothing else caps how big that batch gets — past the
   *  configured task/line/file thresholds, risk floors at "high" (never
   *  downgraded by the diff-size heuristic above) and the rationale names
   *  which threshold(s) tripped and by how much, so the single gate stays
   *  meaningful instead of rubber-stamping a mega-diff. Never blocks the PR
   *  from opening — see checkFeatureCompletion/openPrForFeature. */
  private buildFeatureMergeBriefing(
    feature: Feature,
    taskNames: string[],
    stat: { add: number; del: number; files: string[] },
    modules: string[],
    siblings: Task[],
  ): MergeBriefing {
    const flagged = siblings.filter((t) => t.reviewVerdict?.decision === "flag");
    const briefing = computeFeatureMergeBriefing({
      featureName: feature.name,
      taskNames,
      stat,
      modules,
      flaggedCount: flagged.length,
      anyReviewed: siblings.some((t) => t.reviewVerdict),
    });
    const sizeCheck = checkFeatureBatchSize(
      { taskCount: taskNames.length, changedLines: stat.add + stat.del, filesChanged: stat.files.length },
      { maxTasks: config.featureBatchMaxTasks, maxChangedLines: config.featureBatchMaxChangedLines, maxFiles: config.featureBatchMaxFiles },
    );
    if (!sizeCheck.tripped) return briefing;
    // Size guardrail floors risk to "high" (never downgraded by the diff-size
    // heuristic above) and names the tripped threshold(s) in the rationale, so
    // the single human gate stays meaningful instead of rubber-stamping a
    // mega-diff. Never blocks the PR from opening.
    return { ...briefing, risk: "high", rationale: `${briefing.rationale} Batch exceeds the size guardrail — ${sizeCheck.reason}.` };
  }

  /** A deterministic decision-aid for the ready-to-merge card, from data already
   *  in hand — the diff stat + mapped modules — plus the AI reviewer's recorded
   *  verdict (task.reviewVerdict) when present: approve→merge, flag→rework. No LLM
   *  call here; the reviewer already ran (see autoReview). Falls back cleanly when
   *  no review was recorded (e.g. a human approved the diff directly). */
  private async buildMergeBriefing(
    run: TaskRun,
    stat: { add: number; del: number; files: string[] },
    modules: string[],
  ): Promise<MergeBriefing> {
    const task = (await this.store.listTasks(run.workspaceId)).find((t) => t.runId === run.id);
    return computeMergeBriefing({ runName: run.name, authoredBy: run.agentId, verdict: task?.reviewVerdict ?? null, stat, modules });
  }

  /** Mark a run's owning task done (idempotent) — used the moment its PR opens,
   *  so the pipeline completes and the PR moves to the decoupled merge list. */
  private async markTaskDoneForRun(runId: string): Promise<void> {
    const run = await this.store.getRun(runId);
    if (!run) return;
    const taskId =
      this.reviews.get(runId)?.taskId ??
      (await this.store.listTasks(run.workspaceId)).find((t) => t.runId === runId)?.id;
    if (!taskId) return;
    const task = await this.store.getTask(taskId);
    if (task && task.state !== "done") await this.hub.upsertTask({ ...task, state: "done" });
  }

  // ── Ready-to-merge: the human's final PR merge decision, from the list ──────
  /** Runs whose PR is open and not set-aside — the ready-to-merge list. */
  async listReadyPrs(workspaceId: string): Promise<TaskRun[]> {
    const runs = await this.store.listAllRuns().catch(() => [] as TaskRun[]);
    return runs.filter((r) => r.workspaceId === workspaceId && r.pr?.state === "open" && !r.pr.dismissed);
  }

  /** Live GitHub check-run status for a ready PR — a real API call (never part
   *  of the polled snapshot), so the ready-to-merge card can show whether CI
   *  actually ran and passed BEFORE a human clicks Merge, not just learn it
   *  from `classifyMergeBlock` after GitHub already blocked the attempt.
   *  Best-effort: null on any failure (unreachable, no connection, etc.) — the
   *  card falls back to showing no check-status affordance, same as today. */
  async prChecksForRun(workspaceId: string, runId: string): Promise<PrChecksStatus | null> {
    const run = await this.store.getRun(runId);
    if (!run || run.workspaceId !== workspaceId || !run.pr) return null;
    const cred = (await this.store.getProject(run.projectId))?.githubCredentialId ?? null;
    const status = await githubService.prStatus(workspaceId, run.pr.repo, run.pr.number, cred).catch(() => null);
    return status ? { checks: status.checks, mergeable: status.mergeable, runs: status.runs } : null;
  }

  /** Merge an open PR from the ready list. Success → integrate + settle to done
   *  (completeMerged). GitHub may block it (branch protection / required checks) —
   *  returned as `{merged:false, reason}`, and the PR stays ready. */
  async mergeReadyPr(
    workspaceId: string,
    runId: string,
    method: "merge" | "squash" | "rebase" = "squash",
  ): Promise<{ merged: boolean; reason?: string; blocked?: "conflict" | "checks" | "protection" }> {
    const run = await this.store.getRun(runId);
    if (!run || run.workspaceId !== workspaceId || run.pr?.state !== "open") throw new Error("No open PR for this run.");
    const res = await githubService.mergePr(workspaceId, run.pr.repo, run.pr.number, method);
    if (!res.merged) {
      const blocked = await this.classifyMergeBlock(workspaceId, run.projectId, run.pr, res.reason);
      await this.hub.runLog(runId, `merge blocked (${blocked.blocked}): ${blocked.reason}`);
      return { merged: false, ...blocked };
    }
    const fresh = await this.store.getRun(runId);
    if (fresh?.pr) await this.hub.upsertRun({ ...fresh, pr: { ...fresh.pr, state: "merged" } });
    await this.hub.runLog(runId, `PR #${run.pr.number} merged (${method}).`);
    await this.completeMerged(runId, run.branch); // integrate + retire; task/run → done
    return res;
  }

  /** Explain WHY a merge was blocked — a conflict (base moved under the PR), a
   *  failing/pending check, or a policy block (branch protection / required
   *  reviews) — by reading the PR's mergeability + checks. Best-effort: if the
   *  status read fails, fall back to GitHub's own message as a policy block.
   *  Decomposed args (not a full TaskRun) so both a per-run PR and a feature's
   *  aggregate PR can share this — same GitHub status shape either way. */
  private async classifyMergeBlock(
    workspaceId: string,
    projectId: string,
    pr: PullRequest,
    ghMessage?: string,
  ): Promise<{ reason: string; blocked: "conflict" | "checks" | "protection" }> {
    const cred = (await this.store.getProject(projectId))?.githubCredentialId ?? null;
    const status = await githubService.prStatus(workspaceId, pr.repo, pr.number, cred).catch(() => null);
    if (status?.mergeable === false) {
      return { blocked: "conflict", reason: `conflicts with ${pr.base} — the base moved under this PR. Update branch to re-sync, or Rework so the agent resolves it.` };
    }
    if (status?.checks === "failing") return { blocked: "checks", reason: "required checks are failing on this PR." };
    if (status?.checks === "pending") return { blocked: "checks", reason: "required checks are still running — try again once they finish." };
    return { blocked: "protection", reason: ghMessage ?? "blocked by branch protection (required reviews/approvals)." };
  }

  /** "Update branch": fold the latest base into a ready PR's branch and re-push,
   *  so a merge blocked only by a stale base becomes mergeable again WITHOUT
   *  spinning the agent. A real textual conflict can't be auto-resolved — it
   *  returns the conflicting files so the operator can Rework (agent resolves).
   *  Works even after a restart (the worktree persists; git context is rebuilt). */
  async updateReadyPrBranch(workspaceId: string, runId: string): Promise<{ updated: boolean; conflicts?: string[] }> {
    const run = await this.store.getRun(runId);
    if (!run || run.workspaceId !== workspaceId || run.pr?.state !== "open") throw new Error("No open PR for this run.");
    const project = await this.store.getProject(run.projectId);
    const git = this.gitContextFor(project);
    if (!git) throw new Error("This project has no git backend to update the branch from.");
    // Re-sync against whatever this PR actually targets (recorded when it was
    // opened via mergeTargetBranchFor) rather than recomputing — a manager-
    // delegated worker's PR targets its manager's branch, not the project base.
    const base = run.pr.base;
    let sync: { ok: boolean; conflicts?: string[]; depsChanged?: boolean };
    try {
      sync = await git.worktrees.mergeBase(run.id);
    } catch (err) {
      await this.hub.runLog(runId, `couldn't update the branch — ${(err as Error).message}. Use Rework instead.`);
      return { updated: false, conflicts: [] };
    }
    if (!sync.ok) {
      const files = sync.conflicts?.length ? `: ${sync.conflicts.join(", ")}` : "";
      await this.hub.runLog(runId, `can't auto-update ${run.pr.branch} — real conflict with ${base}${files}. Use Rework so the agent resolves it.`);
      return { updated: false, conflicts: sync.conflicts ?? [] };
    }
    await this.openPrForRun(git, run, run.pr.repo, project, base, sync); // re-push + refresh the ready record
    await this.hub.runLog(runId, `updated ${run.pr.branch} to the latest ${base} — re-check the merge.`);
    return { updated: true };
  }

  /** Send a ready PR back for changes: optionally comment on the PR, then resume
   *  the agent to revise (new commits push to the same branch; it returns to the
   *  ready list when it re-finishes and is re-reviewed). Clears the ready record
   *  while it's being reworked. */
  async reworkReadyPr(workspaceId: string, runId: string, guidance: string, comment?: string): Promise<void> {
    const run = await this.store.getRun(runId);
    if (!run || run.workspaceId !== workspaceId || run.pr?.state !== "open") throw new Error("No open PR for this run.");
    if (comment?.trim()) {
      const cred = (await this.store.getProject(run.projectId))?.githubCredentialId ?? null;
      await githubService
        .commentIssue(workspaceId, run.pr.repo, run.pr.number, comment.trim(), cred)
        .catch((e) => this.hub.runLog(runId, `couldn't comment on PR: ${(e as Error).message}`));
    }
    await this.hub.upsertRun({ ...run, pr: null }); // leaves the ready list while revising
    await this.hub.runLog(runId, `rework requested on PR #${run.pr.number} — resuming the agent to revise.`);
    await this.reviseAfterReview(runId, guidance);
  }

  /** No-op: set a ready PR aside — hide it from the list WITHOUT touching the PR
   *  on GitHub (recoverable). */
  async dismissReadyPr(workspaceId: string, runId: string): Promise<void> {
    const run = await this.store.getRun(runId);
    if (!run || run.workspaceId !== workspaceId || !run.pr) throw new Error("No PR for this run.");
    await this.hub.upsertRun({ ...run, pr: { ...run.pr, dismissed: true } });
    await this.hub.runLog(runId, `PR #${run.pr.number} set aside (no-op) — still open on GitHub.`);
  }

  // ── Ready-to-merge, feature-scoped batches ──────────────────────────────────
  // Feature-scoped branch batching's aggregate PR (see checkFeatureCompletion /
  // openPrForFeature) lives on `Feature.pr`, not any `TaskRun.pr` — every task
  // in the batch already finished its own lifecycle (worktree retired, review
  // handle freed) when it merged into the feature branch, so there's no
  // per-run state left to reconcile here. Only Merge + Dismiss are supported —
  // no Rework/Update-branch for a batch (see the plan): a stale/conflicting
  // feature PR surfaces as a normal GitHub conflict on the PR itself; changes
  // go through a follow-up task under the same feature.

  /** Features whose aggregate PR is open and not set-aside. */
  async listReadyFeaturePrs(workspaceId: string): Promise<Feature[]> {
    const features = await this.store.listFeatures(workspaceId).catch(() => [] as Feature[]);
    return features.filter((f) => f.pr?.state === "open" && !f.pr.dismissed);
  }

  /** Live GitHub check-run status for a feature's aggregate ready PR — see
   *  `prChecksForRun`'s comment; same real-API-call, best-effort contract. */
  async prChecksForFeature(workspaceId: string, featureId: string): Promise<PrChecksStatus | null> {
    const feature = await this.store.getFeature(featureId);
    if (!feature || feature.workspaceId !== workspaceId || !feature.pr) return null;
    const cred = (await this.store.getProject(feature.projectId))?.githubCredentialId ?? null;
    const status = await githubService.prStatus(workspaceId, feature.pr.repo, feature.pr.number, cred).catch(() => null);
    return status ? { checks: status.checks, mergeable: status.mergeable, runs: status.runs } : null;
  }

  /** Merge a feature's aggregate PR. Success → mark the feature shipped.
   *  GitHub may block it exactly as a per-run PR can — same blocked reasons,
   *  same decision to leave it ready rather than pretend it merged. */
  async mergeReadyFeaturePr(
    workspaceId: string,
    featureId: string,
    method: "merge" | "squash" | "rebase" = "squash",
  ): Promise<{ merged: boolean; reason?: string; blocked?: "conflict" | "checks" | "protection" }> {
    const feature = await this.store.getFeature(featureId);
    if (!feature || feature.workspaceId !== workspaceId || feature.pr?.state !== "open") throw new Error("No open PR for this feature.");
    const res = await githubService.mergePr(workspaceId, feature.pr.repo, feature.pr.number, method);
    if (!res.merged) {
      const blocked = await this.classifyMergeBlock(workspaceId, feature.projectId, feature.pr, res.reason);
      return { merged: false, ...blocked };
    }
    await this.hub.upsertFeature({ ...feature, status: "shipped", pr: { ...feature.pr, state: "merged" } });
    void projectPreview.refresh(feature.projectId).catch(() => undefined);
    return res;
  }

  /** No-op: set a feature's ready PR aside — hide it from the list WITHOUT
   *  touching the PR on GitHub (recoverable). */
  async dismissReadyFeaturePr(workspaceId: string, featureId: string): Promise<void> {
    const feature = await this.store.getFeature(featureId);
    if (!feature || feature.workspaceId !== workspaceId || !feature.pr) throw new Error("No PR for this feature.");
    await this.hub.upsertFeature({ ...feature, pr: { ...feature.pr, dismissed: true } });
  }

  /** One open merge gate per run — approving one that fails again may raise a
   *  successor, but two simultaneously open ones are always noise. */
  private async hasOpenMergeGate(workspaceId: string, runId: string): Promise<boolean> {
    const queue = await this.store.listQueue(workspaceId);
    return queue.some((q) => q.runId === runId && q.kind === "merge" && q.resolvedAt == null);
  }

  /** Same one-at-a-time dedup as {@link hasOpenMergeGate}, for verifier gates. */
  private async hasOpenVerifierGate(workspaceId: string, runId: string): Promise<boolean> {
    const queue = await this.store.listQueue(workspaceId);
    return queue.some((q) => q.runId === runId && q.kind === "verifier" && q.resolvedAt == null);
  }

  /** Merge couldn't run (NOT a textual conflict) → an honest gate with git's
   *  real reason, never a phantom "Merge conflict — 0 files". */
  private async raiseMergeFailedHitl(req: MergeRequest, reason: string): Promise<void> {
    const agent = await this.store.getRun(req.runId);
    if (!agent) return;
    const featureUp = isFeatureUpMerge(req);
    // A feature-branch-up merge (step 2) has no single owning run — the anchor
    // run already legitimately reached `done` in its own step-1 merge, so don't
    // bounce it back to "review" (see raiseMergeHitl's own note).
    if (!featureUp) await this.hub.runStatus(req.runId, "review");
    if (await this.hasOpenMergeGate(agent.workspaceId, req.runId)) return;
    await this.hub.raiseHitl({
      id: `q-merge-${req.runId}-${++this.seq}`,
      workspaceId: agent.workspaceId,
      runId: req.runId,
      kind: "merge",
      title: "Integration failed — not a conflict",
      why: featureUp
        ? `git could not merge the feature branch ${req.agentBranch} into the project's integration branch: ${reason}. Fix the repo state, then approve to retry.`
        : `git could not merge ${req.agentBranch}: ${reason}. Fix the repo state, then approve to retry (reject bounces the run back for revision).`,
      risk: "high",
      raisedAt: now(),
      expiresAt: null,
      resolvedAt: null,
      resolution: null,
      rationale: null,
      command: null,
      options: null,
      recommended: null,
      steps: null,
      // Carry the originally-attempted target branch forward so a plain retry
      // lands in the same place the operator chose (or the default) the first
      // time — deliver() re-reads this on approve (see resolution.targetBranch).
      diff: { add: 0, del: 0, modules: agent.modules, files: [], walkthrough: null, mergeBrief: null, defaultTargetBranch: req.targetBranch ?? null },
      output: null,
      flags: [reason],
      sourceBranchOverride: featureUp ? req.agentBranch : null,
    });
  }

  /** Textual merge conflict → raise a `merge` HITL for an operator to reconcile.
   *  `conflictDiff` (the actual `<<<<<<<`/`=======`/`>>>>>>>` markers, captured
   *  by MergeEngine before it aborts the merge) rides on `output` — the same
   *  field a verifier gate's check output uses, and the same field `deliver()`
   *  falls back to as Modify's guidance when the operator leaves it blank, so
   *  clicking Modify with no typed text is enough to have the agent resolve
   *  the conflict it's actually looking at. `targetBranch` (the RESOLVED
   *  destination — see `MergeCallbacks.onConflict`) is prefixed onto `output`
   *  so an agent asked to fix this later (reviseAfterReview) knows the real
   *  ref name and can inspect its actual current content directly with git,
   *  instead of reconstructing the merge blind from the diff snippet alone. */
  private async raiseMergeHitl(req: MergeRequest, files: string[], conflictDiff: string, targetBranch: string): Promise<void> {
    const agent = await this.store.getRun(req.runId);
    if (!agent) return;
    // Feature-scoped branch batching: a step-1 conflict (task → feature branch)
    // is a normal per-run gate, unchanged. A step-2 conflict (feature branch →
    // project integration branch) has no single owning run — `req.runId` here
    // is just an anchor (one of the batch's own, already-done runs) borrowed so
    // this HITL has somewhere to attach; don't bounce that run back to "review"
    // for a merge it isn't actually part of. `sourceBranchOverride` is what lets
    // `deliver()`'s retry re-target the feature branch correctly either way.
    const featureUp = isFeatureUpMerge(req);
    if (!featureUp) await this.hub.runStatus(req.runId, "review");
    if (await this.hasOpenMergeGate(agent.workspaceId, req.runId)) return;
    await this.hub.raiseHitl({
      id: `q-merge-${req.runId}-${++this.seq}`,
      workspaceId: agent.workspaceId,
      runId: req.runId,
      kind: "merge",
      title: `Merge conflict — ${files.length} file${files.length === 1 ? "" : "s"}`,
      why: featureUp
        ? `${files.length} file(s) conflict merging the feature branch ${req.agentBranch} into the project's integration branch. Reconcile yourself and approve to retry, or click Modify (guidance optional — it'll use the conflict below) to have the agent resolve it.`
        : `${files.length} file(s) conflict integrating ${req.agentBranch}. Reconcile yourself and approve to retry, or click Modify (guidance optional — it'll use the conflict below) to have the agent resolve it.`,
      risk: "high",
      raisedAt: now(),
      expiresAt: null,
      resolvedAt: null,
      resolution: null,
      rationale: null,
      command: null,
      options: null,
      recommended: null,
      steps: null,
      // Same carry-forward as raiseMergeFailedHitl above.
      diff: { add: 0, del: 0, modules: agent.modules, files: [], walkthrough: null, mergeBrief: null, defaultTargetBranch: req.targetBranch ?? null },
      output: conflictDiff
        ? `Target branch: ${targetBranch}\n\n${conflictDiff}`.slice(0, Orchestrator.VERIFIER_OUTPUT_CAP)
        : null,
      flags: files, // the conflicting files — shown as chips
      sourceBranchOverride: featureUp ? req.agentBranch : null,
    });
  }

  // Cap on the check output carried on a verifier gate — generous enough for a
  // real stack trace / failing-test summary, bounded so a runaway command can't
  // bloat the HitlItem that rides every WS snapshot/delta. runBounded already
  // caps total captured output further upstream (SKYNET_CMD_MAX_OUTPUT_BYTES);
  // this is specifically about what's fit to put in front of an operator.
  private static readonly VERIFIER_OUTPUT_CAP = 50_000;

  /**
   * The project's check command failed AFTER a successful merge — MergeEngine
   * already undid the merge commit (`bounce`) before calling this, so the
   * integration branch is exactly as it was. Raise a real `verifier` gate
   * carrying the full (capped) output, instead of silently parking the run in
   * review with a truncated log line: approve retries the merge + check
   * (`deliver()`), reject/modify bounces the agent to revise with the output as
   * guidance (also `deliver()`) — the same two-outcome shape `merge` already
   * uses, not a new one.
   */
  private async raiseVerifierFailedHitl(req: MergeRequest, output: string): Promise<void> {
    const agent = await this.store.getRun(req.runId);
    if (!agent) return;
    const firstLine = output.split("\n").find((l) => l.trim())?.trim().slice(0, 200) ?? "no output";
    await this.hub.runLog(req.runId, `checks failed: ${firstLine}`);
    await this.hub.runStatus(req.runId, "review");
    if (await this.hasOpenVerifierGate(agent.workspaceId, req.runId)) return;
    const capped =
      output.length > Orchestrator.VERIFIER_OUTPUT_CAP
        ? output.slice(0, Orchestrator.VERIFIER_OUTPUT_CAP) + "\n… (output truncated — see the full run log)"
        : output;
    await this.hub.raiseHitl({
      id: `q-verifier-${req.runId}-${++this.seq}`,
      workspaceId: agent.workspaceId,
      runId: req.runId,
      kind: "verifier",
      title: "Checks failed — merge undone",
      why: `${req.agentBranch}'s checks failed after merging; the merge commit was undone. Approve to retry the merge + checks, or reject/modify to send the agent the output as revision guidance.`,
      risk: "high",
      raisedAt: now(),
      expiresAt: null,
      resolvedAt: null,
      resolution: null,
      rationale: null,
      command: null,
      options: null,
      recommended: null,
      steps: null,
      diff: null,
      output: capped,
      flags: [],
      sourceBranchOverride: null,
    });
  }

  // ── chat ────────────────────────────────────────────────────────────────────
  async chat(runId: string, text: string): Promise<string> {
    await this.hub.runLog(runId, `you: ${text}`);
    const live = this.live.get(runId);

    // No live session (finished, in review, or the server restarted since it ran)
    // → answer statelessly via the provider, grounded in the agent's stored log.
    // A `done` agent is also answered statelessly even if a stale live entry
    // lingers: it has nothing left to relay to, so we must never block on its
    // handle's chat waiter (which would hang until the 45s timeout).
    if (!live || (await this.store.getRun(runId))?.status === "done") {
      const reply = await this.consultFinished(runId, text);
      await this.hub.runLog(runId, `↳ ${reply}`);
      return reply;
    }

    return this.liveChat(runId, text, live);
  }

  /**
   * Streaming counterpart of {@link chat}: yields the reply as text deltas so
   * the UI can render it live. The stateless (finished / no-live-session) path —
   * the "ask me anything about what shipped" case — streams token-level deltas
   * from the provider's consultStream. The live-session path has no delta
   * protocol yet, so it yields the single reply as one chunk (same content as
   * chat(), just over the streaming transport — keeps the client uniform).
   */
  async *chatStream(runId: string, text: string): AsyncGenerator<string> {
    await this.hub.runLog(runId, `you: ${text}`);
    const live = this.live.get(runId);
    if (!live || (await this.store.getRun(runId))?.status === "done") {
      let full = "";
      for await (const delta of this.consultFinishedStream(runId, text)) {
        full += delta;
        yield delta;
      }
      await this.hub.runLog(runId, `↳ ${full}`);
      return;
    }
    yield await this.liveChat(runId, text, live);
  }

  /** The live-session chat turn: relay to the running handle and resolve with
   *  its reply (or a timeout note). Shared by chat() + chatStream(). */
  private liveChat(runId: string, text: string, live: { handle: RunnerHandle }): Promise<string> {
    return new Promise<string>((resolve) => {
      // A real model turn can take well over 5s; give it room before giving up.
      const timer = setTimeout(() => {
        this.chatWaiters.delete(runId);
        resolve("(no reply yet — it may still be working; check the agent's log)");
      }, 45_000);
      this.chatWaiters.set(runId, (reply) => {
        clearTimeout(timer);
        resolve(reply);
      });
      void live.handle.message(text);
    });
  }

  // ── inform ─────────────────────────────────────────────────────────────────
  // A third interaction type alongside chat (a real extra turn, above) and
  // resolve (a HITL decision, elsewhere): a note that rides a live run's NEXT
  // prompt at no extra turn of its own — no reply expected, nothing to resolve,
  // never routed through raise(). Delivery is the runner's job (RunnerHandle
  // .inform, optional); this just finds the live handle and logs the attempt.

  /**
   * Queue `note` on `runId`'s next turn. Returns false (never throws) when the
   * run has no live session or its runner doesn't implement `inform` — a
   * finished/queued/no-longer-live run has nothing to ride, and we never fake
   * delivery by falling back to a real chat turn (that would defeat the whole
   * point: no extra turn, ~free). Always logged, so the audit trail shows
   * exactly what was (or wasn't) delivered.
   */
  async inform(runId: string, note: string): Promise<boolean> {
    const live = this.live.get(runId);
    if (!live?.handle.inform) {
      await this.hub.runLog(runId, `ℹ note (not delivered — no live session to attach it to): ${note}`);
      return false;
    }
    await this.hub.runLog(runId, `ℹ note queued for the next turn: ${note}`);
    await live.handle.inform(note);
    return true;
  }

  /** Every currently-live run id belonging to `projectId` — the resolved set
   *  for "inform this whole project"'s bulk-select. Only live runs are
   *  meaningful targets (a finished/queued run has no next turn to ride). */
  async liveRunIdsForProject(projectId: string): Promise<string[]> {
    const ids: string[] = [];
    for (const runId of this.live.keys()) {
      const run = await this.store.getRun(runId);
      if (run?.projectId === projectId) ids.push(runId);
    }
    return ids;
  }

  /**
   * BYOK intent-parse path for the Telegram conversational bridge. Interpret a
   * natural-language operator message using the operator's OWN provider key —
   * never a Skynet-hosted model. Iterate the fleet, pick the FIRST provider that
   * has a resolvable key AND a stateless `.consult`, and ask it `question` (the
   * classifier instruction) with `context` (the operator message + workspace
   * snapshot) as grounding data. Returns the raw model reply, or `null` when no
   * provider/key/consult is available (the caller then falls back to slash
   * commands). Reuses the same consult plumbing as assessTask/autoReview.
   *
   * The operator message rides inside `context` as DATA (not as the question),
   * so a misparse or a prompt-injection attempt can only ever produce a reply
   * the caller re-validates against a closed whitelist — it can never escalate.
   */
  async consult(
    ws: string,
    question: string,
    context?: string,
    system?: string,
  ): Promise<string | null> {
    // Candidate (provider, model) pairs to interpret with: the configured fleet
    // agents first (real model choices), THEN a fallback to a consult-capable
    // provider that has a resolvable key even when NO agent is configured yet —
    // so conversational control works before the fleet exists. Without this
    // fallback, a key set in .env/skynet.env was ignored unless a Claude *agent*
    // happened to be in the fleet. (Today Claude is the only provider with
    // `.consult`; the catalog lookup keeps this correct if others gain it.)
    const agents = await this.store.listAgents(ws).catch(() => [] as Agent[]);
    const candidates: Array<{ provider: ProviderId; model: string }> = agents.map((a) => ({
      provider: a.provider,
      model: a.model,
    }));
    if (!candidates.some((c) => c.provider === "claude")) {
      const claude = (await this.store.listProviders().catch(() => [] as ProviderInfo[])).find(
        (p) => p.id === "claude",
      );
      const models = claude?.models ?? [];
      // Prefer a cheap/fast model for a tiny classification call.
      const model =
        models.find((m) => /haiku/i.test(m)) ??
        models.find((m) => /sonnet/i.test(m)) ??
        models[0] ??
        "sonnet-4.6";
      candidates.push({ provider: "claude", model });
    }

    for (const c of candidates) {
      const apiKey = await secretService.resolve(ws, c.provider).catch(() => undefined);
      if (!apiKey) continue;
      let provider: RunnerProvider;
      try {
        provider = await this.getProvider(c.provider);
      } catch {
        continue; // unresolvable provider — try the next candidate
      }
      if (!provider.consult) continue;
      try {
        return await provider.consult(
          {
            task: system ? "Interpret an operator remote-control message" : "Classify an operator remote-control message",
            model: c.model,
            cwd: config.runnerCwd,
            apiKey,
            context,
            ...(system ? { system } : {}),
          },
          question,
        );
      } catch {
        // A provider round-trip failure is treated as "no interpretation" — the
        // caller degrades to slash commands rather than guessing.
        return null;
      }
    }
    return null;
  }

  /** Answer a follow-up when there's no live session, via the provider's
   *  stateless consult, grounded in the stored log — works even across a server
   *  restart. The reply is truthful about the agent's actual status (DEF-002):
   *  we only say "finished" when the agent is really done. */
  private async consultFinished(runId: string, question: string): Promise<string> {
    let reply = "";
    for await (const delta of this.consultFinishedStream(runId, question)) reply += delta;
    return reply;
  }

  /** Streaming form of {@link consultFinished}: yields the provider's answer as
   *  text deltas (via consultStream when available, else the whole consult() as
   *  one chunk). The status/availability guard replies are yielded whole. */
  private async *consultFinishedStream(runId: string, question: string): AsyncGenerator<string> {
    const agent = await this.store.getRun(runId);
    if (!agent) {
      yield `(${runId}) no such agent.`;
      return;
    }
    const provider = await this.getProvider(agent.provider);
    if (!provider.consult && !provider.consultStream) {
      // No stateless consult available. Don't claim the agent "finished" unless
      // it actually did — otherwise chatting a running/waiting agent gets a
      // misleading canned reply.
      yield agent.status === "done"
        ? "This agent has finished; follow-up chat isn't supported for its runner."
        : `This agent is ${agent.status}, but chat isn't wired to a live runner in this config, so I can't relay your message to it right now.`;
      return;
    }
    const apiKey = await secretService.resolve(agent.workspaceId, agent.credentialId ?? agent.provider);
    const logText = agent.log.slice(-40).map((l) => l.line).join("\n").slice(-4000);
    // A run that didn't finish cleanly (failed / escalated / needs-attention) is
    // RESUMABLE from its own controls — so the consult must not dead-end the
    // operator by telling them to relaunch or spin up a fresh agent themselves.
    const note =
      agent.status === "done"
        ? ""
        : "SITUATION: This run did not finish — it is paused / needs attention and can be RESUMED to keep working, from the run's own controls (its escalation card: Help & resume · Reassign · Stop). You are read-only in this chat: explain what happened or advise on the work, but never tell the operator to relaunch, retry, or start a fresh agent themselves, and don't imply you can edit files or resume from here.\n\n";
    const context = note + logText;
    const spec = { task: agent.name, model: agent.model, cwd: config.runnerCwd, apiKey, context };
    try {
      if (provider.consultStream) {
        yield* provider.consultStream(spec, question);
      } else {
        yield await provider.consult!(spec, question);
      }
    } catch (err) {
      yield `couldn't look into that right now (${(err as Error).message}).`;
    }
  }

  /**
   * Detach an agent's live session — stop its runner if live, free the runner it
   * holds (so a stuck "busy" runner is released), retire its worktree, and record
   * why. Works even for an ORPHAN (no live handle after a restart): the agent's
   * recorded agentId is the only handle to the stuck runner.
   *
   * It deliberately does NOT change the agent's status: the caller owns the
   * terminal state. Operator "stop" ({@link haltAgent}) and the reaper mark the
   * agent done themselves; a restart-orphan is left running/waiting so a
   * follow-up chat can still report its real status (DEF-002) rather than a
   * misleading "finished".
   */
  async stopAgent(runId: string, reason = "stopped by operator"): Promise<void> {
    const agent = await this.store.getRun(runId);
    if (!agent) return;
    const live = this.live.get(runId);
    if (live) await live.handle.stop().catch(() => undefined);
    // Free the runner using the live mapping OR the agent's recorded agentId
    // (an orphan has no live entry, so agent.agentId is the only handle).
    await this.freeRunner(live?.agentId ?? agent.agentId ?? null);
    const ctx = live?.git ?? (await this.gitContextForAgent(runId).catch(() => undefined));
    if (ctx) await ctx.worktrees.retire(runId).catch(() => undefined);
    await this.releaseScratchCwd(live?.scratchCwd);
    await this.hub.runLog(runId, reason);
    this.live.delete(runId);
  }

  /**
   * Reap presumed-dead runs: a `running`/`waiting` agent whose heartbeat has
   * been silent past `config.agentReapMs` (a live runner beats every few
   * seconds, so prolonged silence means the runner crashed or the server
   * restarted and orphaned it). `review` runs are intentionally parked with no
   * runner awaiting operator approval, so they never beat and are NOT reaped.
   * Runs periodically and once at startup (which clears restart orphans).
   */
  /** Limbo runs already warned about this process — warn once, not every sweep. */
  private limboWarned = new Set<string>();

  /**
   * Worktree GC (boot + interval). Two safe reclaims and one warning:
   *  1. Remove ZOMBIE worktrees — a worktree under our root whose branch belongs
   *     to no live run (run done/archived, or unknown entirely — e.g. a crash or
   *     a memory-store restart forgot it). Live runs (running/waiting/paused/
   *     review) keep theirs: the revise loop + diff review depend on them.
   *  2. Delete agent/* BRANCHES already merged into their project's integration
   *     branch, once no live run uses them — integrated refs are pure clutter
   *     (and a branch held by a stale worktree blocks checkouts elsewhere).
   *  3. SURFACE (never delete) limbo: a run parked in `review` with no open gate
   *     gets escalated immediately (actionable, not just logged) — nothing else
   *     is asking the operator to decide, and its worktree may hold the only
   *     copy of unmerged work. Once it's ALSO old enough (heartbeat past
   *     worktreeTtlDays), a one-time log line additionally flags it for disk
   *     retention, separate from the escalation.
   */
  async gcWorktrees(): Promise<{ worktreesRemoved: number; branchesDeleted: number; limbo: number }> {
    const stats = { worktreesRemoved: 0, branchesDeleted: 0, limbo: 0 };
    const runs = await this.store.listAllRuns().catch(() => [] as TaskRun[]);
    const fleet = await this.store.listAllAgents().catch(() => [] as Agent[]);

    // Discover every git context we own: the global integration repo + each
    // git-backed project repo (workspaces derived from what the store knows).
    const workspaces = new Set<string>([...runs.map((r) => r.workspaceId), ...fleet.map((a) => a.workspaceId)]);
    const projects: Project[] = [];
    for (const ws of workspaces) projects.push(...(await this.store.listProjects(ws).catch(() => [] as Project[])));
    const byRepo = new Map<string, { ctx: GitContext; projects: Project[] }>();
    if (config.integrationRepo) {
      const ctx = this.gitContextForRepo(config.integrationRepo);
      byRepo.set(ctx.repo, { ctx, projects: [] });
    }
    for (const p of projects) {
      const ctx = this.gitContextFor(p);
      if (!ctx) continue;
      const entry = byRepo.get(ctx.repo) ?? { ctx, projects: [] };
      entry.projects.push(p);
      byRepo.set(ctx.repo, entry);
    }

    const liveBranches = new Set(runs.filter((r) => r.status !== "done" && !r.archived).map((r) => r.branch));
    for (const { ctx, projects: ps } of byRepo.values()) {
      // 1. Zombie worktrees (ours only — list() is scoped to our root).
      for (const wt of await ctx.worktrees.list().catch(() => [])) {
        if (basename(wt.path).startsWith("integration-")) continue; // merge-engine scratch, self-managed
        if (wt.branch && liveBranches.has(wt.branch)) continue;
        await ctx.worktrees.removeAt(wt.path).catch(() => undefined);
        stats.worktreesRemoved++;
      }
      // 2. Integrated agent branches nobody live is using — the project
      // integration branch AND every project's feature branches (a task under
      // a Feature merges there first, via targetBranchFor, never straight into
      // the integration branch — see checkFeatureCompletion).
      for (const p of ps) {
        const merged = await ctx.worktrees.mergedAgentBranches(ctx.merge.integrationBranch(p.id)).catch(() => []);
        for (const name of merged) {
          if (liveBranches.has(name)) continue;
          await ctx.worktrees.deleteBranch(name).catch(() => undefined);
          stats.branchesDeleted++;
        }
        const features = await this.store.listFeatures(p.workspaceId).catch(() => [] as Feature[]);
        for (const f of features) {
          if (f.projectId !== p.id) continue;
          const mergedF = await ctx.worktrees.mergedAgentBranches(`${FEATURE_BRANCH_PREFIX}${f.id}`).catch(() => []);
          for (const name of mergedF) {
            if (liveBranches.has(name)) continue;
            await ctx.worktrees.deleteBranch(name).catch(() => undefined);
            stats.branchesDeleted++;
          }
        }
      }
    }

    // 3. Limbo surfacing — parked reviews with nothing asking for a decision.
    // Two distinct signals sharing one query:
    //  a) IMMEDIATELY escalate any review with no open gate, regardless of age.
    //     A run only reaches `review` with nothing waiting on it via a code path
    //     that failed to raise a proper decision (a startup failure that retired
    //     the worktree, a legacy run from before failures started escalating —
    //     see `fail()` — or any future gap in the same spirit): the operator has
    //     no way to know it's there short of stumbling on the card. Reusing
    //     `escalate()` (idempotent per run) means one card, Resume/Reassign/Stop,
    //     not a repeat every sweep.
    //  b) The existing worktreeTtlDays-gated log line below, once the run is ALSO
    //     old enough — a separate, disk-retention-focused note, not a decision.
    const cutoff = now() - config.worktreeTtlDays * 24 * 60 * 60 * 1000;
    for (const r of runs) {
      if (r.status !== "review" || r.archived) continue;
      const open = (await this.store.listQueue(r.workspaceId).catch(() => [] as HitlItem[])).some(
        (q) => q.runId === r.id && q.resolvedAt == null,
      );
      if (open) continue; // a gate is waiting — the operator already has a handle
      // Framed as "done, awaiting review" rather than a generic alarm — nothing
      // is broken here (contrast timeout/failures/conflict below): the run
      // already reached `review`, it just has no open gate pointing at it, so
      // the operator's own review is the only thing missing.
      await this.escalate(r.id, "the run finished and reached review, but no decision was raised for it — nothing failed, it's just waiting for your review", "stuck-review").catch(
        () => undefined,
      );
      if (r.lastHeartbeatAt > cutoff) continue;
      stats.limbo++;
      if (this.limboWarned.has(r.id)) continue;
      this.limboWarned.add(r.id);
      await this.hub
        .runLog(
          r.id,
          `parked in review ${config.worktreeTtlDays}+ days with no open gate — worktree kept (may hold unmerged work); resolve, stop, or archive to reclaim`,
        )
        .catch(() => undefined);
    }
    return stats;
  }

  /**
   * Keep the fleet on latest main: fetch each active project's base from origin
   * (so a new run branches off fresh main), and flag any in-flight run whose
   * branch has fallen behind — a one-time nudge; the actual sync happens when its
   * PR opens (mergeBase in pushToGithub). Cheap + safe to run periodically and at
   * startup: fetch only updates remote-tracking refs, never a checked-out branch.
   */
  async syncBaseAndFlagStale(): Promise<void> {
    const runs = (await this.store.listAllRuns().catch(() => [] as TaskRun[])).filter(
      (r) => r.status !== "done" && !r.archived && r.branch,
    );
    const byProject = new Map<string, { git: GitContext | undefined; base: string }>();
    const fetched = new Set<GitContext>();
    for (const r of runs) {
      let entry = byProject.get(r.projectId);
      if (!entry) {
        const project = await this.store.getProject(r.projectId).catch(() => null);
        entry = { git: this.gitContextFor(project), base: this.baseBranchFor(project) };
        byProject.set(r.projectId, entry);
      }
      const git = entry.git;
      if (!git) continue;
      if (!fetched.has(git)) {
        await git.worktrees.fetchBase().catch(() => undefined);
        fetched.add(git);
      }
      const behind = await git.worktrees.baseAheadOf(`refs/heads/${r.branch}`).catch(() => false);
      if (behind && !this.baseMovedFlagged.has(r.id)) {
        this.baseMovedFlagged.add(r.id);
        await this.hub
          .runLog(r.id, `${entry.base} has moved since this run started — it'll be synced into the branch before its PR opens.`)
          .catch(() => undefined);
      } else if (!behind) {
        this.baseMovedFlagged.delete(r.id); // caught up (e.g. after a resync) → re-arm
      }
    }
  }

  async reapStaleAgents(): Promise<void> {
    await this.sweepStuckRuns().catch(() => undefined);
    const ms = config.agentReapMs;
    if (!ms || ms <= 0) return; // disabled
    const cutoff = now() - ms;
    const runs = await this.store.listAllRuns().catch(() => [] as TaskRun[]);
    for (const a of runs) {
      if (a.status !== "running" && a.status !== "waiting") continue;
      if (a.lastHeartbeatAt > cutoff) continue;
      if (this.escalations.has(a.id)) continue; // already an open escalation card — don't re-raise or clobber it
      const silentSec = Math.round((now() - a.lastHeartbeatAt) / 1000);
      const reason = `reaped — no heartbeat for ${silentSec}s; runner freed`;
      // A `running` agent that went silent is presumed dead (crashed runner or a
      // server restart that orphaned it). Rather than a dead-end `done` (which
      // retires the worktree and drops any uncommitted work with no way back),
      // route it into the SAME escalation → Resume path as an out-of-turns run:
      // free the runner but KEEP the worktree, and surface a resumable card so
      // one click relaunches a fresh session on its branch.
      if (a.status === "running") {
        await this.escalate(a.id, reason, "stalled").catch(() => undefined);
        continue;
      }
      // A `waiting` run with a frozen heartbeat that ISN'T an escalation was
      // parked on a gate whose session died — free its runner + mark it terminal.
      await this.stopAgent(a.id, reason).catch(() => undefined);
      await this.hub.runStatus(a.id, "done").catch(() => undefined);
      await this.hub.runCompleted(a.id, a.branch).catch(() => undefined);
      // stopAgent retired the worktree — this run integrates no change, so its
      // owning task must not be left stranded "ongoing" (or "review") showing
      // a live-looking column next to a run whose chip now reads "done". Same
      // invariant haltAgent/settleArchivedRun uphold; this sweep was the one
      // termination path missing it (reported live: a kanban card sitting in
      // a mid-pipeline column while its status chip showed done).
      const reapedTask = (await this.store.listTasks(a.workspaceId).catch(() => [] as Task[])).find(
        (t) => t.runId === a.id,
      );
      if (reapedTask && (reapedTask.state === "ongoing" || reapedTask.state === "review")) {
        await this.hub.upsertTask({ ...reapedTask, state: "todo", runId: null, reviewVerdict: null }).catch(() => undefined);
      }
    }
  }

  /**
   * Auto-decommission: retire SYSTEM-provisioned runners (auto-scale / fork
   * created) that have sat idle past the workspace's TTL, so auto-scaled capacity
   * doesn't accumulate. Only touches `autoProvisioned` idle runners — an operator's
   * manually-added fleet is never auto-retired, and a busy runner is never touched.
   * Per-workspace TTL (retireIdleRunnersAfterMinutes; 0 = off). Returns the count
   * retired. Runs as a janitorial sweep, independent of the pause/kill switch.
   */
  async reapIdleRunners(): Promise<number> {
    const allAgents = await this.store.listAllAgents().catch(() => [] as Agent[]);
    const workspaces = [...new Set(allAgents.map((a) => a.workspaceId))];
    let retired = 0;
    for (const ws of workspaces) {
      const ttlMin = (await this.fleetPolicy(ws)).retireIdleRunnersAfterMinutes;
      if (!ttlMin || ttlMin <= 0) continue; // reaping disabled for this workspace
      const cutoff = now() - ttlMin * 60_000;
      for (const a of allAgents) {
        if (a.workspaceId !== ws || !a.autoProvisioned) continue; // operator runners are off-limits
        if (a.status !== "idle" || a.idleSince == null || a.idleSince > cutoff) continue; // busy or still fresh
        if (this.isBusy(a.id)) continue; // a live run is mid-flight despite the status
        await this.hub.deleteAgent(a.id).catch(() => undefined);
        retired++;
      }
    }
    return retired;
  }

  /** "Too long" guard: a run that has been actively `running` past config
   *  .runStuckMs (since it started) without finishing is escalated to a human
   *  rather than left to spin. 0 disables. Skips runs already escalated or parked
   *  on another gate (only `running` counts as "at it too long"). */
  private async sweepStuckRuns(): Promise<void> {
    const ms = config.runStuckMs;
    if (!ms || ms <= 0) return; // disabled
    const runs = await this.store.listAllRuns().catch(() => [] as TaskRun[]);
    for (const a of runs) {
      if (a.status !== "running") continue;
      if (this.escalations.has(a.id)) continue;
      if (now() - a.startedAt < ms) continue;
      const mins = Math.round((now() - a.startedAt) / 60_000);
      await this.escalate(a.id, `working for ${mins} min without finishing`, "timeout").catch(() => undefined);
    }
  }

  private autonomyTicking = false;

  /**
   * The daily-budget safety floor: false once a project's KNOWN spend today
   * has reached its `dailyBudgetUsd` — the only thing this blocks is
   * autonomous auto-pick (tickAutonomy step 2); a human can still assign
   * manually at any time (assignTask itself is never gated). null budget =
   * always true (no limit, today's behavior). Logs the pause transition once
   * via the hub (not every tick) and re-arms silently once spend drops back
   * under budget — which happens on its own at local midnight, since
   * computeDailySpend always recomputes "today" from `now()`.
   */
  private async underDailyBudget(project: Project, runs: TaskRun[]): Promise<boolean> {
    if (project.dailyBudgetUsd == null) {
      this.budgetPausedFlagged.delete(project.id); // re-arm if a budget was cleared while paused
      return true;
    }
    const spend = computeDailySpend(runs, project.id, now());
    const exhausted = spend.spentUsd >= project.dailyBudgetUsd;
    if (!exhausted) {
      this.budgetPausedFlagged.delete(project.id);
      return true;
    }
    if (!this.budgetPausedFlagged.has(project.id)) {
      this.budgetPausedFlagged.add(project.id);
      const floorNote = spend.unknownCostRuns > 0 ? ` (+${spend.unknownCostRuns} run(s) with unreported cost, not counted)` : "";
      await this.hub
        .runLog(
          `budget-${project.id}`,
          `autonomy paused for today — $${spend.spentUsd.toFixed(2)} of $${project.dailyBudgetUsd.toFixed(2)} budget spent${floorNote}. You can still assign tasks manually.`,
        )
        .catch(() => undefined);
    }
    return false;
  }

  /**
   * Budget-as-allocation, selection half: from `pickable` (already priority-
   * sorted), greedily choose which tasks actually fit the budget available
   * right now — walking in the SAME order, so priority always wins among
   * whatever's affordable; a task is only ever SKIPPED (never reordered)
   * when its rough cost band (`costBandFor`, from the free triage effort
   * signal) would blow the remaining allowance, and the walk continues past
   * it so a cheaper lower-priority task can still fit. No budget set → the
   * full list, unchanged (byte-for-byte the pre-existing behavior). Logs
   * once per tick (not once per skipped task) when anything was skipped, so
   * a tight budget doesn't spam the run log every 15s.
   */
  private async selectAffordable(project: Project, runs: TaskRun[], pickable: Task[]): Promise<Task[]> {
    if (project.dailyBudgetUsd == null || pickable.length === 0) return pickable;
    const spend = computeDailySpend(runs, project.id, now());
    let available = pacedAvailableUsd(project, spend.spentUsd, now(), config.budgetPacingWindowMs);
    const selected: Task[] = [];
    const skipped: Task[] = [];
    for (const t of pickable) {
      const band = costBandFor(t.assessmentEffort);
      if (band <= available) {
        selected.push(t);
        available -= band;
      } else {
        skipped.push(t);
      }
    }
    if (skipped.length > 0) {
      const names = skipped.map((t) => `"${t.text}"`).join(", ");
      await this.hub
        .runLog(`budget-${project.id}`, `skipped ${skipped.length} task(s) this tick — over today's remaining allowance: ${names}`)
        .catch(() => undefined);
    }
    return selected;
  }

  /**
   * Autonomy loop: for each project with `autonomy` on and idle-agent capacity,
   * do the low-risk moves so tasks flow without a human — triage a backlog item
   * (agent writes an assessment), start an auto-pick todo task, and review a
   * finished run (approve → merge → done, else flag it for a human). The human
   * gate (triage → todo) is never crossed here. Bounded per project per tick.
   */
  async tickAutonomy(): Promise<void> {
    if (!config.autonomyMs || config.autonomyMs <= 0) return;
    if (this.paused) return; // kill switch engaged — no autonomous work until /resume
    if (this.autonomyTicking) return; // never overlap ticks
    this.autonomyTicking = true;
    try {
      const allAgents = await this.store.listAllAgents().catch(() => [] as Agent[]);
      const workspaces = [...new Set(allAgents.map((a) => a.workspaceId))];
      for (const ws of workspaces) {
        // Iterate ALL projects — the TRIAGE step runs regardless of the project's
        // `autonomy` toggle (it's just a fleet read, no work executed). The
        // action steps (auto-pick, auto-review) still respect `autonomy` because
        // those spend real time/tokens.
        const projects = await this.store.listProjects(ws);
        if (projects.length === 0) continue;
        const tasks = await this.store.listTasks(ws);
        // Only fetched when at least one project actually has a budget set —
        // every other workspace's tick stays exactly as cheap as before.
        const runs = projects.some((p) => p.dailyBudgetUsd != null) ? await this.store.listRuns(ws) : [];
        for (const p of projects) {
          // Re-read idle capacity per project (an earlier project may have used it).
          const idle = (await this.store.listAgents(ws)).filter((a) => a.status === "idle");
          if (idle.length === 0) break; // no capacity left in this workspace
          // Archived tasks are a soft-hide: off the board and out of the
          // assistant's grounding context — autonomy must ignore them too, or it
          // re-triages / auto-picks / auto-reviews a task the operator hid,
          // spawning a run that then shows the archived task "running".
          const mine = tasks.filter((t) => t.projectId === p.id && !t.archived);
          try {
            // 1) Triage one backlog item → assessment + duration + clarity.
            //    ALWAYS runs (no p.autonomy gate) — it's informative, not
            //    action. Skip `unassigned` tasks: an eligibility choice is still
            //    the operator's, and autonomy never guesses one.
            //    If the LLM self-reports clarity=clear, auto-promote triage→todo
            //    in the SAME write — that's the "reduce human dependence" step.
            //    Unclear (or missing signal) parks in triage for a human read.
            const backlog = mine.find(
              (t) => t.state === "backlog" && (t.assignment?.mode ?? "unassigned") !== "unassigned",
            );
            if (backlog) await this.triageOne(ws, idle[0]!, backlog);
            // 2) Start auto-pick todo tasks (todo → ongoing) while capacity lasts.
            //    Gated by `p.autonomy` — this is where money/time actually gets
            //    spent, so it stays under the project autonomy toggle. Also
            //    honors each task's eligibility set via assignTask → acquireAgent.
            //    Fired concurrently, not awaited one at a time: acquireAgent's
            //    find-idle→mark-busy step is already serialized by acquireExclusive
            //    (orchestrator.ts:752), so racing N eligible tasks here is safe —
            //    it just lets their (slower) provider-session starts overlap
            //    instead of queuing behind each other. allSettled isolates each
            //    task's failure (busy fleet, no credential) from the rest, same
            //    as the try/catch/continue this replaces. Sorted by `order` (the
            //    same rank field the ↑/↓ column control writes) before firing so
            //    that when capacity is short, the acquireExclusive queue — which
            //    serializes in call order — grants idle agents to the
            //    highest-priority tasks first instead of array/insertion order.
            if (p.autonomy && (await this.underDailyBudget(p, runs))) {
              const pickable = mine
                .filter((t) => t.state === "todo" && t.autoPick && (t.assignment?.mode ?? "unassigned") !== "unassigned")
                // S7: a task generated from a brief decomposition may declare
                // dependencies on other tasks from the same plan — skip it
                // until every one of those is `done`. `mine` already holds
                // the full live project task set for this tick, so this is a
                // pure in-memory check. A missing dependency (e.g. deleted)
                // counts as unsatisfied — the safe default, never silently
                // skip a gate on ambiguity. A manual "Start now" (assignTask
                // called directly, outside this loop) still bypasses it, same
                // as autoPick itself is bypassed by a manual start.
                .filter((t) => (t.dependsOnTaskIds ?? []).every((depId) => mine.find((d) => d.id === depId)?.state === "done"))
                .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.id.localeCompare(b.id));
              // Budget-as-allocation: still fires in the SAME priority order —
              // this only trims tasks that don't fit what's left (see
              // selectAffordable's own comment) — a no-op list transform when
              // no budget is set.
              const affordable = await this.selectAffordable(p, runs, pickable);
              await Promise.allSettled(affordable.map((t) => this.assignTask(p.id, t.id)));
            }
            // 3) Review a finished run — runs REGARDLESS of `p.autonomy`.
            //    Recording a verdict is diagnostic (an LLM consult), not a
            //    spending action, so every review-state task deserves a
            //    reviewer's opinion for the human's audit trail. The
            //    APPROVE-and-merge step inside autoReview stays gated on
            //    `p.autonomy` — verdict recorded either way; auto-resolve
            //    only when the project has opted in to autonomous spending.
            //    Skip tasks that already carry a verdict (idempotent) so we
            //    don't rewrite the same LLM call every tick.
            const review = mine.find((t) => t.state === "review" && t.runId && !t.reviewVerdict);
            if (review?.runId) {
              // The reviewer must NOT be the agent that did the work — a run
              // reviewing itself is a rubber-stamp that opens a PR without a real
              // second look. Pick the first idle agent that (a) isn't the run's
              // own agent and (b) is reviewer-eligible (Agent.canReview, default
              // true). If none is free, leave it for a human this tick rather than
              // self-approve — a later tick retries when another agent frees up.
              const doerId = (await this.store.getRun(review.runId))?.agentId;
              const reviewer = idle.find((a) => a.id !== doerId && a.canReview !== false);
              if (reviewer) {
                const open = (await this.store.listQueue(ws)).find(
                  (h) => h.runId === review.runId && !h.resolvedAt,
                );
                if (open) await this.autoReview(ws, reviewer, review, open, p.autonomy);
              }
            }
          } catch (err) {
            await this.hub.runLog(p.id, `autonomy skipped ${p.id}: ${(err as Error).message}`).catch(() => undefined);
          }
        }
      }
    } finally {
      this.autonomyTicking = false;
    }
  }

  /**
   * Run one triage assessment for `task` via `agent` and write the resulting
   * state/assessment/clarification/grouping fields. Factored out of
   * `tickAutonomy`'s triage step so the periodic sweep (a `backlog` task) and
   * `requestRetriage` (an operator re-triaging a `triage` task on demand) go
   * through the EXACT same write logic — including the clarification loop
   * breaker below — rather than two copies that can drift.
   */
  private async triageOne(ws: string, agent: Agent, task: Task): Promise<void> {
    const { assessment, assessmentEffort, assessmentRisks, estimatedDurationMs, clarity, featureId, milestoneId, questions } =
      await this.assessTask(ws, agent, task);
    // Only OVERWRITE an existing estimate when triage produced a new one —
    // leaves an operator-set estimate intact if triage failed to guess (or on
    // a re-triage of a task that already had one).
    const nextEst = estimatedDurationMs != null ? estimatedDurationMs : task.estimatedDurationMs;
    // File under a suitable feature/milestone — but only when the task isn't
    // ALREADY grouped, so triage never clobbers an operator's choice. A
    // feature carries its milestone (assessTask nulls a direct milestone
    // when a feature was picked).
    const nextFeatureId = task.featureId ?? featureId;
    const nextMilestoneId = task.featureId || task.milestoneId ? task.milestoneId : milestoneId;
    // Loop breaker: this task already went through ONE ask-and-answer round
    // (its description carries the operator's answer, stamped by
    // answerClarification — see CLARIFICATION_ANSWERED_MARKER). A model that
    // still comes back "unclear" after that — same underlying ambiguity, or
    // just not confident — would otherwise re-ask forever (backlog → triage →
    // backlog → ...), each lap burning a consult AND a Steward draft for a
    // question the operator already answered. Trust the self-report only
    // ONCE per round: force a promote here rather than opening a second
    // clarification, and surface the model's continued doubt as a risk
    // instead of another question.
    const alreadyAnsweredOnce = (task.description ?? "").includes(CLARIFICATION_ANSWERED_MARKER);
    const forcedClear = clarity === "unclear" && alreadyAnsweredOnce;
    // Auto-promote to todo when the LLM said "clear" — a task only ever
    // reaches triage (whether via the periodic sweep or a manual re-triage)
    // once its eligibility is already set, so nothing else gates the move.
    const nextState: Task["state"] = clarity === "clear" || forcedClear ? "todo" : "triage";
    // Unclear WITH specific questions → ask, and have Steward draft an answer
    // the operator can accept or edit. Without this the task just parked in
    // triage with nobody told what was missing, and an agent later
    // rediscovered the same ambiguity at agent prices. A clear task (or a
    // forced one, see above) never carries a clarification; re-triage clears
    // a stale one rather than leaving an answered question on the card.
    const clarification =
      !forcedClear && questions.length > 0
        ? { questions, draft: await this.draftClarificationAnswer(ws, task, questions).catch(() => null), askedAt: now() }
        : null;
    const nextAssessmentRisks = forcedClear
      ? [
          ...assessmentRisks,
          "Triage still flagged this unclear after the operator's answer — proceeding anyway; confirm scope before/while working it.",
        ]
      : assessmentRisks;
    await this.hub.upsertTask({
      ...task,
      state: nextState,
      assessment,
      assessmentEffort,
      assessmentRisks: nextAssessmentRisks,
      clarification,
      estimatedDurationMs: nextEst,
      featureId: nextFeatureId,
      milestoneId: nextMilestoneId,
    });
  }

  /**
   * Manual "Request re-triage" — an operator forcing a fresh triage pass on a
   * task already parked in `triage`, instead of waiting for it to cycle back
   * through `backlog` (the only path the periodic sweep picks up on its own).
   * Useful once project context changed (goal, instructions, a newly added
   * feature) since the original read, after editing the task's description
   * directly, or just to get a second opinion without dragging the card
   * around. Reuses `triageOne` — the identical read+write the periodic tick
   * uses (same clarification loop breaker, same grouping validation), just an
   * eager entry point. Throws `NoTriageTargetError` when the task isn't
   * sitting in `triage` (nothing to re-triage) and `NoCapacityError` when no
   * agent is idle right now.
   */
  async requestRetriage(ws: string, taskId: string): Promise<void> {
    const task = await this.store.getTask(taskId);
    if (!task || task.workspaceId !== ws || task.state !== "triage") throw new NoTriageTargetError();
    const agent = (await this.store.listAgents(ws)).find((a) => a.status === "idle");
    if (!agent) throw new NoCapacityError();
    await this.triageOne(ws, agent, task);
  }

  /**
   * A short agent-written assessment for autonomous triage — plus a duration
   * estimate, a clarity self-report, and the structured triage card
   * (effort size + a short risks list), all parsed from a trailing JSON tag
   * on the model's reply the same defensive, field-based way as the
   * auto-review verdict (never regex/keyword-classify free text — see
   * `splitEstMinutesTag`). We convert minutes to ms (cap 24h) and use
   * clarity to gate auto-promote (triage→todo). A missing signal stays
   * missing — never fabricated. `assessment` doubles as the card's summary
   * line; `assessmentEffort`/`assessmentRisks` are additive siblings, so a
   * task assessed before this shipped (or by the no-consult/error fallback
   * below) just renders its `assessment` alone. Falls back to a
   * deterministic note when the provider has no stateless consult (e.g. mock).
   */
  private async assessTask(
    ws: string,
    agent: Agent,
    task: Task,
  ): Promise<{
    assessment: string;
    assessmentEffort: "small" | "medium" | "large" | null;
    assessmentRisks: string[];
    estimatedDurationMs: number | null;
    clarity: "clear" | "unclear" | null;
    featureId: string | null;
    milestoneId: string | null;
    questions: string[];
  }> {
    try {
      const provider = await this.getProvider(agent.provider);
      if (!provider.consult) {
        return {
          assessment: `Auto-triaged — "${task.text}" looks actionable; no blockers noted.`,
          assessmentEffort: null,
          assessmentRisks: [],
          estimatedDurationMs: null,
          clarity: null,
          featureId: null,
          milestoneId: null,
          questions: [],
        };
      }
      const apiKey = await secretService.resolve(ws, agent.credentialId ?? agent.provider);
      const project = await this.store.getProject(task.projectId);
      // Offer the project's OPEN features + milestones so triage can file the task
      // under a suitable one. The model must pick an id FROM these lists (or null);
      // we validate its pick against them below — never trust a fabricated id.
      const features = (await this.store.listFeatures(ws).catch(() => [] as Feature[]))
        .filter((f) => f.projectId === task.projectId && !f.archived && f.status !== "shipped");
      const milestones = (await this.store.listMilestones(ws).catch(() => [] as Milestone[]))
        .filter((m) => m.projectId === task.projectId && !m.archived && m.status !== "shipped");
      const groupingInstr =
        features.length || milestones.length
          ? [
              "",
              "GROUPING: file this task under a suitable EXISTING feature and/or milestone if one clearly fits.",
              features.length ? `Features (id — name): ${features.map((f) => `${f.id} — ${f.name}`).join("; ")}` : "Features: (none)",
              milestones.length ? `Milestones (id — name): ${milestones.map((m) => `${m.id} — ${m.name}`).join("; ")}` : "Milestones: (none)",
              'Add "featureId" and/or "milestoneId" to the JSON tag with an id COPIED EXACTLY from the lists above — or null if none clearly fits. Prefer a feature (its milestone is inherited); set milestoneId directly only when no feature fits. Do NOT invent ids; when unsure, use null.',
            ].join("\n")
          : "";
      // The estimate is for AGENT wall-clock time, not human developer time —
      // these differ by an order of magnitude on typical coding tasks (an
      // autonomous agent's 20-minute feature is a person's afternoon). Without
      // this anchor the LLM defaults to its stronger "human developer time"
      // prior and returns estimates 10–30× too high, so we spell it out AND
      // give concrete agent-wall-clock anchors for S/M/L.
      const taskBody = task.description ? `${task.text}\n\n${task.description}` : task.text;
      const feature = task.featureId ? features.find((f) => f.id === task.featureId) : undefined;
      // This task already went through one ask-and-answer round — the operator's
      // answer is IN taskBody (see CLARIFICATION_ANSWERED_MARKER), so tell the
      // model explicitly rather than let it silently re-derive "unclear" from
      // the same original ambiguity and re-ask a question that's already been
      // answered. A code-level breaker also catches this (see tickAutonomy) if
      // the model ignores the instruction, but getting a genuinely better
      // "clear" verdict here means never falling back to that breaker at all.
      const alreadyAnsweredInstr = taskBody.includes(CLARIFICATION_ANSWERED_MARKER)
        ? "\nThis task already had clarifying questions asked and ANSWERED once (see the \"Clarifications\" section above) — treat that answer as authoritative and do NOT ask the same or a rephrased version of it again. Only report \"unclear\" again if the answer reveals a genuinely NEW gap it doesn't cover; otherwise report \"clear\" and note any residual doubt in \"risks\" instead."
        : "";
      const reply = await provider.consult(
        { task: buildAgentContext({ project, feature, body: taskBody }), model: agent.model, cwd: config.runnerCwd, apiKey },
        [
          "You are triaging a backlog item for a coding project.",
          "In ONE short line: summarize the ask (is it clear, what's the gist). Be terse — the effort size and any risks go in the JSON tag below, not this line.",
          "END your reply with a JSON tag on its OWN line:",
          '  {"estMinutes": <int>, "clarity": "clear"|"unclear", "effort": "small"|"medium"|"large", "risks": ["<short risk>", ...]}',
          "estMinutes = the AGENT'S wall-clock time to complete this task — NOT a human developer's time.",
          "An autonomous coding agent works fast: a task that would take a person hours typically takes an agent minutes.",
          "Anchors (agent wall-clock): small ≈ 5m (rename, config tweak, single small edit), medium ≈ 20m (a real feature — new endpoint, migration, small refactor), large ≈ 60m (multi-file change, cross-module work). Cap at 240m even for very large asks. `effort` should agree with `estMinutes`.",
          "clarity = \"clear\" ONLY if the ask is well-scoped and actionable AS WRITTEN (an agent could start without more info).",
          '"unclear" if it needs clarification, is missing acceptance criteria, or the scope is ambiguous. When in doubt, choose "unclear".' + alreadyAnsweredInstr,
          'When (and ONLY when) clarity is "unclear", add "questions": 1-3 SHORT, SPECIFIC, ANSWERABLE things you need from the operator before an agent could start — name the actual missing decision or fact ("which auth flow should this use?", "what counts as done here?"), never a generic "please clarify". These get asked directly, so a vague question wastes the exchange.',
          '"risks" = 0-3 short, CONCRETE risks specific to this task (e.g. "touches auth — check session handling", "no tests in this area yet") — omit the field entirely (not an empty array) if you see none worth flagging; never pad with generic filler like "could have bugs".',
          "Omit any field you can't confidently supply; a missing signal is honest, a fabricated one is not." + groupingInstr,
        ].join("\n"),
      );
      const raw = reply.trim();
      const parsed = splitEstMinutesTag(raw);
      const estimatedDurationMs =
        parsed.estMinutes != null && parsed.estMinutes > 0
          ? Math.min(parsed.estMinutes * 60_000, 24 * 60 * 60_000) // cap at 24h
          : null;
      const assessment = (parsed.body || raw).slice(0, 500) || `Auto-triaged — "${task.text}".`;
      // Validate the model's grouping picks against the offered ids — never write a
      // fabricated id. A feature carries its milestone, so take a direct milestone
      // ONLY when no feature was chosen (avoids a conflicting double-assignment).
      const featureId = parsed.featureId && features.some((f) => f.id === parsed.featureId) ? parsed.featureId : null;
      const milestoneId =
        !featureId && parsed.milestoneId && milestones.some((m) => m.id === parsed.milestoneId) ? parsed.milestoneId : null;
      return {
        assessment,
        assessmentEffort: parsed.effort,
        assessmentRisks: parsed.risks ?? [],
        estimatedDurationMs,
        clarity: parsed.clarity,
        featureId,
        milestoneId,
        // Only meaningful alongside "unclear" — a model that answers "clear"
        // and still lists questions is contradicting itself, and promoting a
        // task while claiming to need input would be the worse reading.
        questions: parsed.clarity === "unclear" ? parsed.questions ?? [] : [],
      };
    } catch (err) {
      return {
        assessment: `Auto-triaged — "${task.text}" (assessment unavailable: ${(err as Error).message}).`,
        assessmentEffort: null,
        assessmentRisks: [],
        estimatedDurationMs: null,
        clarity: null,
        featureId: null,
        milestoneId: null,
        questions: [],
      };
    }
  }

  /**
   * Draft a PROPOSED answer to triage's clarifying questions, grounded in the
   * project's own goal/instructions and the task itself — so the operator's job
   * becomes "confirm or correct" rather than "write from scratch".
   *
   * Deliberately advisory, never applied on its own. A model guessing at the
   * operator's intent is exactly what produced the ambiguity being asked about;
   * the draft is a starting point the operator sends, edits, or discards.
   * Cheap by construction: a mid-tier model, no repo tools, one short reply.
   * Any failure (no credential, unreadable reply) degrades to `null` — the
   * questions are still asked, just without a suggested answer.
   */
  private async draftClarificationAnswer(ws: string, task: Task, questions: string[]): Promise<string | null> {
    const apiKey = (await secretService.resolve(ws, "claude").catch(() => undefined)) ?? undefined;
    if (!apiKey) return null; // no usable key — ask without a draft rather than fail the tick
    const project = await this.store.getProject(task.projectId).catch(() => null);
    const prompt = [
      "You are Steward, helping an operator answer questions their triage step raised about a task.",
      "Draft the answer the OPERATOR would most likely give, grounded strictly in the context below.",
      "Be concrete and short — a few sentences or bullets, no preamble, no restating the questions.",
      "Where the context genuinely doesn't settle something, say plainly what you'd assume and flag it as an assumption; never invent a decision as though it were established fact.",
      "You have NO tools here — no code search, no repo access, nothing beyond the text below — and this is a single one-shot reply, not a conversation: there is no later turn to report back on. " +
        "Answer from the context given, right now. Never say you'll investigate further, look at the code, launch a subagent, or get back to the operator once you have more information — you cannot do any of that, and claiming to is simply false. " +
        "If the context truly isn't enough to guess even roughly, say that plainly in one line instead — do not describe an investigation you're not actually able to perform.",
      "",
      `PROJECT: ${project?.name ?? "(unknown)"}`,
      `GOAL: ${project?.goal?.trim() || "(none set)"}`,
      project?.instructions?.trim() ? `PROJECT INSTRUCTIONS:\n${project.instructions.trim()}` : "",
      "",
      `TASK: ${task.text}`,
      task.description?.trim() ? `TASK DETAIL:\n${task.description.trim()}` : "",
      "",
      "QUESTIONS:",
      ...questions.map((q, i) => `${i + 1}. ${q}`),
    ]
      .filter((l) => l !== "")
      .join("\n");
    const reply = (await oneShotText({ prompt, model: CLARIFY_DRAFT_MODEL, apiKey })).trim();
    return reply || null;
  }

  /**
   * `Project.deepReview` opt-in: instead of a stateless consult reading the
   * last 30 log lines, spin up a SECOND real, bounded agent (browser tools on,
   * edit tools off) that opens a live preview of the run's own branch and
   * actually exercises the change before writing its verdict. Deliberately
   * NOT plumbed through the normal assignTask()/`this.live` machinery — it
   * must stay invisible on the kanban board (no TaskRun, no fleet-runner
   * "busy" TaskRun row), so its RunnerEvents are a private, minimal adapter
   * that captures the reviewer's final text + browser actions, auto-resolves
   * any tool gate itself (there's no human to ask), and is discarded once the
   * run ends. Returns null on ANY failure (no repo, wrong provider, preview
   * won't start, timeout, unreadable verdict) — the caller falls back to the
   * plain consult path; deep review only ever strengthens the pipeline, never
   * blocks it.
   */
  private async runDeepReview(
    ws: string,
    reviewer: Agent,
    task: Task,
    run: TaskRun,
    hitl: HitlItem,
    project: Project,
  ): Promise<{ decision: "approve" | "flag"; reason: string; evidence: string[]; proposals: ProposedTask[] } | null> {
    // Browser tools + the read-only lockdown below are verified only for the
    // Claude runner today — see StartSpec.disallowedTools/browser docs.
    if (reviewer.provider !== "claude") return null;
    if (!project.repoPath) return null; // a preview needs a real local checkout

    const previewMgr = this.previewOverride ?? projectPreview;
    const previewKey = `run:${run.id}`;
    let preview;
    try {
      preview = await previewMgr.startRun(run.id, {
        repoPath: project.repoPath,
        projectId: project.id,
        branch: run.branch,
        workspaceId: ws,
      });
    } catch {
      return null;
    }
    if (preview.status !== "live" || !preview.url) {
      // Cheap, common failure (no start recipe, install/health-check failure,
      // branch not pushed yet) — not worth logging as an error; consult covers it.
      await previewMgr.stop(previewKey).catch(() => undefined);
      return null;
    }
    const cwd = previewMgr.dirFor(previewKey);
    if (!cwd) {
      await previewMgr.stop(previewKey).catch(() => undefined);
      return null;
    }

    try {
      const provider = await this.getProvider(reviewer.provider);
      const apiKey = await secretService.resolve(ws, reviewer.credentialId ?? reviewer.provider);
      const diffSummary = hitl.diff
        ? `Files changed (${hitl.diff.files.length}): ${hitl.diff.files.slice(0, 25).join(", ")}${hitl.diff.files.length > 25 ? ", …" : ""} (+${hitl.diff.add}/-${hitl.diff.del})`
        : "No diff stat available for this run.";
      const brief = [
        `You are reviewing another agent's finished work on this task: "${task.text}"`,
        project.instructions ? `Project instructions: ${project.instructions}` : null,
        diffSummary,
        `A live preview of this EXACT change is running at: ${preview.url}\nUse your browser tools to load it and actually exercise the changed behavior — click through the relevant flow, don't just read code. Ground your verdict in what you observe in the browser, not assumptions.`,
        "You are a REVIEWER ONLY — you have no edit tools and must not attempt to fix anything you find. If something's broken, that IS the finding: report it, don't repair it.",
        `When you're done, reply with ONLY the required JSON — no other text. ${REVIEW_OUTPUT_INSTRUCTION}`,
      ]
        .filter((l): l is string => !!l)
        .join("\n\n");

      const reviewRunId = `review-${run.id}-${++this.seq}`;
      let lastText = "";
      const evidence: string[] = [];
      let handle: RunnerHandle | undefined;
      const outcome = await Promise.race([
        new Promise<"completed" | "failed">((resolve) => {
          const events: RunnerEvents = {
            onLog: (_id, line, detail) => {
              if (detail === undefined) {
                if (line.trim()) lastText = line;
                return;
              }
              // Browser-tool calls are the "evidence" of what was exercised —
              // capped so a long browsing session doesn't bloat the verdict.
              if (/^▸ mcp__browser__/.test(line)) {
                evidence.push(line.slice(2));
                if (evidence.length > 12) evidence.shift();
              }
            },
            onProgress: () => {},
            onHeartbeat: () => {},
            onStatus: () => {},
            // No human is watching this run — resolve every gate ourselves.
            // Tool-call ("approval") gates (browser actions, WebFetch) are
            // auto-approved so browsing proceeds unattended; anything else
            // (a question, an escalation) is rejected with guidance nudging
            // the reviewer back to just answering, rather than left to hang.
            onHitl: (_id, raise) => {
              if (!handle) return;
              const resolution: Resolution =
                raise.kind === "approval"
                  ? { action: "approve", optionIndex: null, guidance: null, targetBranch: null, memoryNote: null, resetWork: false, by: "deep-review-harness", at: now() }
                  : {
                      action: "reject",
                      optionIndex: null,
                      guidance: "Don't ask questions or make a plan — just use the browser to check the change, then reply with only the required JSON verdict.",
                      targetBranch: null,
                      memoryNote: null,
                      resetWork: false,
                      by: "deep-review-harness",
                      at: now(),
                    };
              void handle.resume(resolution).catch(() => undefined);
            },
            onCompleted: () => resolve("completed"),
            onFailed: () => resolve("failed"),
            onChatReply: () => {},
          };
          provider
            .start(
              {
                runId: reviewRunId,
                projectId: project.id,
                task: brief,
                model: reviewer.model,
                branch: run.branch,
                cwd,
                apiKey,
                browser: true,
                maxTurns: DEEP_REVIEW_MAX_TURNS,
                // Categorically no edits/shell — a reviewer can browse and read,
                // it cannot touch code (see the method doc).
                disallowedTools: ["Edit", "MultiEdit", "Write", "NotebookEdit", "Bash"],
              },
              events,
            )
            .then((h) => {
              handle = h;
            })
            .catch(() => resolve("failed"));
        }),
        new Promise<"failed">((resolve) => setTimeout(() => resolve("failed"), DEEP_REVIEW_TIMEOUT_MS)),
      ]);
      await handle?.stop().catch(() => undefined);

      if (outcome !== "completed" || !lastText) return null;
      // Only trust a genuinely readable verdict field — anything else falls
      // back to consult (Do #4), rather than treating unreadable prose as a
      // real "flag" the way parseReviewVerdict's own safe-default would.
      const obj = extractJsonObject(lastText);
      const field = obj && typeof obj.verdict === "string" ? obj.verdict.trim().toLowerCase() : "";
      if (field !== "approve" && field !== "flag") return null;
      const verdict = parseReviewVerdict(lastText);
      return {
        decision: verdict.approve ? "approve" : "flag",
        reason: verdict.reason,
        evidence: [...evidence],
        proposals: parseReviewProposals(lastText),
      };
    } finally {
      await previewMgr.stop(previewKey).catch(() => undefined);
    }
  }

  /**
   * `Project.breakerReview` opt-in (requires `deepReview`): after the deepReview
   * reviewer above already APPROVED a run, spin up a THIRD real, bounded agent
   * run — same invisible-on-the-board mechanics as runDeepReview (a private
   * RunnerEvents adapter, no TaskRun, no fleet-runner row) but ADVERSARIAL:
   * told to actively try to break the change against the SAME kind of live
   * preview, rather than judge whether it works. The verifier above confirms a
   * change works; this tries to prove it doesn't.
   *
   * Unlike the reviewer, Bash is NOT categorically removed — probing malformed
   * input / concurrent actions / auth boundaries often needs it — so a Bash
   * approval gate goes through the SAME command-safety classification + the
   * project's own approval policy a real run's Bash gate would (Do #5:
   * "standard command gates still apply to everything else it tries to do"):
   * auto-approved only when the project's trust level would already allow it,
   * denied otherwise (there's no human here to escalate a gate to). Browser
   * tools against the preview stay unconditionally allowed, same as the
   * reviewer — that's the sanctioned mechanism, not "everything else". WebFetch/
   * WebSearch are removed from context entirely (general internet access is
   * outside "the loopback preview URL it is given").
   *
   * Returns null only when the run genuinely never happened (no repo, wrong
   * provider, preview wouldn't start) — nothing to record. A run that DID
   * start but produced no readable verdict (timeout, unreadable reply) instead
   * returns a "clean" result with `note` set: it's recorded as an attempt, but
   * NEVER treated as broken (Do #2 — a broken breaker must not block the
   * pipeline; the verifier already approved this change).
   */
  private async runBreakerReview(
    ws: string,
    reviewer: Agent,
    task: Task,
    run: TaskRun,
    hitl: HitlItem,
    project: Project,
  ): Promise<BreakerVerdictOut & { note: string | null } | null> {
    if (reviewer.provider !== "claude") return null; // browser tools are Claude-only, same as the reviewer
    if (!project.repoPath) return null;

    const previewMgr = this.previewOverride ?? projectPreview;
    const previewKey = `run:${run.id}`;
    let preview;
    try {
      preview = await previewMgr.startRun(run.id, {
        repoPath: project.repoPath,
        projectId: project.id,
        branch: run.branch,
        workspaceId: ws,
      });
    } catch {
      return null;
    }
    if (preview.status !== "live" || !preview.url) {
      await previewMgr.stop(previewKey).catch(() => undefined);
      return null;
    }
    const cwd = previewMgr.dirFor(previewKey);
    if (!cwd) {
      await previewMgr.stop(previewKey).catch(() => undefined);
      return null;
    }

    try {
      const provider = await this.getProvider(reviewer.provider);
      const apiKey = await secretService.resolve(ws, reviewer.credentialId ?? reviewer.provider);
      // Resolved once, up front — decideAutoApproval below needs the workspace's
      // ACTIVE command policy, same as a real run's Bash gate (see raise()).
      const policy = await resolveActivePolicy(this.store, ws);
      const diffSummary = hitl.diff
        ? `Files changed (${hitl.diff.files.length}): ${hitl.diff.files.slice(0, 25).join(", ")}${hitl.diff.files.length > 25 ? ", …" : ""} (+${hitl.diff.add}/-${hitl.diff.del})`
        : "No diff stat available for this run.";
      const brief = [
        `Another agent finished this task: "${task.text}" — a reviewer already checked it in the browser and found no problems. Your job is ADVERSARIAL: try to prove the reviewer wrong.`,
        project.instructions ? `Project instructions: ${project.instructions}` : null,
        diffSummary,
        `A live preview of this EXACT change is running at: ${preview.url}\nActively try to make it misbehave: malformed/edge-case input, unexpected sequences of actions, rapid/concurrent actions, and any auth or permission boundary the new behavior touches. Try what a careless or malicious user might do — don't just re-check the happy path the reviewer already covered.`,
        "You are a BREAKER ONLY — you have no edit tools and must not attempt to fix anything. Report ONLY what you ACTUALLY did against the live preview and observed — every finding needs concrete repro steps. Never speculate or report something you didn't personally trigger; an unreproduced guess is worse than no finding at all.",
        `When you're done, reply with ONLY the required JSON — no other text. ${BREAKER_OUTPUT_INSTRUCTION}`,
      ]
        .filter((l): l is string => !!l)
        .join("\n\n");

      const breakerRunId = `breaker-${run.id}-${++this.seq}`;
      let lastText = "";
      let handle: RunnerHandle | undefined;
      const outcome = await Promise.race([
        new Promise<"completed" | "failed">((resolve) => {
          const events: RunnerEvents = {
            onLog: (_id, line, detail) => {
              if (detail === undefined && line.trim()) lastText = line;
            },
            onProgress: () => {},
            onHeartbeat: () => {},
            onStatus: () => {},
            // No human is watching this run — resolve every gate ourselves.
            onHitl: (_id, raise) => {
              if (!handle) return;
              let resolution: Resolution;
              // Matches claude.ts's actionTitle()'s Bash branch exactly — the
              // only reliable signal HitlRaise carries for "this is a shell
              // command", since it has no explicit tool-name field.
              const isBash = /^Run a shell command:/.test(raise.title);
              if (raise.kind === "approval" && isBash) {
                const auto = decideAutoApproval({ command: raise.command, level: project.approvalLevel, rules: project.approvalRules, policy });
                resolution = auto
                  ? { action: "approve", optionIndex: null, guidance: null, targetBranch: null, memoryNote: null, resetWork: false, by: auto.by, at: now() }
                  : {
                      action: "reject",
                      optionIndex: null,
                      guidance: "That command isn't auto-approved under this project's policy (no human is available to review it here). Try a different way to exercise the change against the live preview, or report what you've already found.",
                      targetBranch: null,
                      memoryNote: null,
                      resetWork: false,
                      by: "breaker-harness",
                      at: now(),
                    };
              } else if (raise.kind === "approval") {
                // Browser actions against the preview are the sanctioned
                // mechanism — same unattended auto-approve as the reviewer.
                resolution = { action: "approve", optionIndex: null, guidance: null, targetBranch: null, memoryNote: null, resetWork: false, by: "breaker-harness", at: now() };
              } else {
                resolution = {
                  action: "reject",
                  optionIndex: null,
                  guidance: "Don't ask questions or make a plan — just try to break the change against the live preview, then reply with only the required JSON verdict.",
                  targetBranch: null,
                  memoryNote: null,
                  resetWork: false,
                  by: "breaker-harness",
                  at: now(),
                };
              }
              void handle.resume(resolution).catch(() => undefined);
            },
            onCompleted: () => resolve("completed"),
            onFailed: () => resolve("failed"),
            onChatReply: () => {},
          };
          provider
            .start(
              {
                runId: breakerRunId,
                projectId: project.id,
                task: brief,
                model: reviewer.model,
                branch: run.branch,
                cwd,
                apiKey,
                browser: true,
                maxTurns: BREAKER_MAX_TURNS,
                // Edits stay off, same as the reviewer. Bash deliberately stays
                // AVAILABLE (gated for real above, not removed) — general
                // internet access does not (Do #5: preview URL only).
                disallowedTools: ["Edit", "MultiEdit", "Write", "NotebookEdit", "WebFetch", "WebSearch"],
              },
              events,
            )
            .then((h) => {
              handle = h;
            })
            .catch(() => resolve("failed"));
        }),
        new Promise<"failed">((resolve) => setTimeout(() => resolve("failed"), BREAKER_TIMEOUT_MS)),
      ]);
      await handle?.stop().catch(() => undefined);

      if (outcome !== "completed" || !lastText) {
        return { verdict: "clean", findings: [], note: "breaker run did not finish in time — treated as clean" };
      }
      const parsed = parseBreakerVerdict(lastText);
      if (!parsed) {
        return { verdict: "clean", findings: [], note: "breaker run produced no readable verdict — treated as clean" };
      }
      return { ...parsed, note: null };
    } finally {
      await previewMgr.stop(previewKey).catch(() => undefined);
    }
  }

  /**
   * S6: opt-in rigor for a SolutionBrief (S4) — before an operator approves
   * it, spin up a real bounded agent run that actually READS the codebase (a
   * detached checkout of the project's base branch, via the same
   * `prepareWorktree` the local preview and Fly deploy engines share) and
   * annotates the draft: wrong assumptions, real touchpoints, blast radius —
   * instead of trusting the brief's prose alone. Same "invisible, private
   * RunnerEvents adapter" shape as `runDeepReview` (no TaskRun, no
   * fleet-runner row, no human to ask — every gate auto-resolves), but no
   * live preview/browser: this reads code, it doesn't exercise a running app.
   * Categorically no write/edit/shell tools (`disallowedTools`) — a run that
   * could mutate the checkout wouldn't be trustworthy grounding for an
   * approval decision. Returns null on ANY failure (no repo, no usable Claude
   * credential, worktree prep fails, timeout, unreadable output) — purely
   * advisory, never blocks approval; the caller (Operations.exploreBrief)
   * turns a null into a visible error and leaves the brief untouched.
   */
  async exploreBrief(ws: string, brief: SolutionBrief, project: Project): Promise<{ findings: string[]; touchpoints: string[] } | null> {
    if (!project.repoPath) return null; // nothing to check out and read

    const dir = join(this.exploreWorktreesDirOverride ?? config.worktreesDir ?? resolve(process.cwd(), ".skynet-worktrees"), `explore-${brief.id}`);
    let cwd: string;
    try {
      cwd = await prepareWorktree(project.repoPath, dir, this.baseBranchFor(project));
    } catch {
      return null;
    }

    try {
      const provider = await this.getProvider("claude").catch(() => null);
      if (!provider) return null;
      const apiKey = (await secretService.resolve(ws, "claude").catch(() => undefined)) ?? undefined;

      const prompt = [
        `You are grounding a DRAFT plan against the ACTUAL codebase before a human decides whether to approve it. Read the repo — don't assume.`,
        `Draft brief: "${brief.title}"`,
        brief.problem ? `Problem:\n${brief.problem}` : null,
        brief.approach ? `Proposed approach:\n${brief.approach}` : null,
        brief.risks.length ? `Risks already named:\n${brief.risks.map((r) => `- ${r}`).join("\n")}` : null,
        brief.acceptanceCriteria.length ? `Acceptance criteria:\n${brief.acceptanceCriteria.map((c) => `- ${c}`).join("\n")}` : null,
        `Actually verify the plan's assumptions against the real code — don't just restate the brief. List concrete, real touchpoints (files/modules/areas this plan would actually touch), and note any wrong assumptions, missing risks, or blast radius the brief didn't mention.`,
        `You are a READ-ONLY explorer — you have no edit/write/shell tools and must not attempt to fix or scaffold anything. Reading and reporting is the whole job.`,
        `Reply with ONLY this JSON — no other text, no code fence: {"findings": ["<string>", ...], "touchpoints": ["<string>", ...]}. Empty arrays are fine if you genuinely found nothing to flag.`,
      ]
        .filter((l): l is string => !!l)
        .join("\n\n");

      const exploreRunId = `explore-${brief.id}-${++this.seq}`;
      let lastText = "";
      let handle: RunnerHandle | undefined;
      const outcome = await Promise.race([
        new Promise<"completed" | "failed">((resolvePromise) => {
          const events: RunnerEvents = {
            onLog: (_id, line, detail) => {
              if (detail === undefined && line.trim()) lastText = line;
            },
            onProgress: () => {},
            onHeartbeat: () => {},
            onStatus: () => {},
            // No human is watching — auto-resolve every gate. A read-only
            // explorer should never need a tool-call gate (Read/LS/Glob/Grep
            // don't raise one), but a question/escalation is nudged back to
            // just answering with the required JSON rather than left to hang.
            onHitl: (_id, raise) => {
              if (!handle) return;
              const resolution: Resolution =
                raise.kind === "approval"
                  ? { action: "approve", optionIndex: null, guidance: null, targetBranch: null, memoryNote: null, resetWork: false, by: "explore-harness", at: now() }
                  : {
                      action: "reject",
                      optionIndex: null,
                      guidance: "Don't ask questions — just read the code, then reply with only the required JSON.",
                      targetBranch: null,
                      memoryNote: null,
                      resetWork: false,
                      by: "explore-harness",
                      at: now(),
                    };
              void handle.resume(resolution).catch(() => undefined);
            },
            onCompleted: () => resolvePromise("completed"),
            onFailed: () => resolvePromise("failed"),
            onChatReply: () => {},
          };
          provider
            .start(
              {
                runId: exploreRunId,
                projectId: project.id,
                task: prompt,
                model: EXPLORE_MODEL,
                branch: this.baseBranchFor(project),
                cwd,
                apiKey,
                maxTurns: EXPLORE_MAX_TURNS,
                disallowedTools: ["Edit", "MultiEdit", "Write", "NotebookEdit", "Bash"],
              },
              events,
            )
            .then((h) => {
              handle = h;
            })
            .catch(() => resolvePromise("failed"));
        }),
        new Promise<"failed">((resolvePromise) => setTimeout(() => resolvePromise("failed"), EXPLORE_TIMEOUT_MS)),
      ]);
      await handle?.stop().catch(() => undefined);

      if (outcome !== "completed" || !lastText) return null;
      const obj = extractJsonObject(lastText);
      if (!obj || !Array.isArray(obj.findings) || !Array.isArray(obj.touchpoints)) return null;
      return {
        findings: obj.findings.filter((f): f is string => typeof f === "string"),
        touchpoints: obj.touchpoints.filter((t): t is string => typeof t === "string"),
      };
    } catch {
      return null;
    }
  }

  /**
   * Autonomous review of a finished run's open HITL. Always records a verdict
   * on the task (approve OR flag) so the human has an audit trail of what the
   * reviewer thought. Only when `canResolve` is true does an approve verdict
   * also drive the HITL → merge/done path; with autonomy off, the verdict is
   * recorded and the human retains the merge decision.
   */
  private async autoReview(
    ws: string,
    agent: Agent,
    task: Task,
    hitl: HitlItem,
    canResolve: boolean,
  ): Promise<void> {
    const run = task.runId ? await this.store.getRun(task.runId) : undefined;
    let decision: "approve" | "flag" = "approve";
    let reason = "auto-approved";
    let evidence: string[] | undefined;
    let breaker: (BreakerVerdictOut & { note: string | null }) | null = null;
    let proposals: ProposedTask[] = [];
    let project: Project | undefined;
    try {
      project = await this.store.getProject(task.projectId);
      // `deepReview` opt-in: try a real, browser-driven second agent run first.
      // runDeepReview returns null on ANY failure (wrong provider, no repo,
      // preview wouldn't start, timeout, unreadable verdict) — every one of
      // those falls straight through to the plain consult path below, byte-
      // for-byte the same as when the project never opted in at all.
      const deep = project?.deepReview && run
        ? await this.runDeepReview(ws, agent, task, run, hitl, project).catch(() => null)
        : null;
      if (deep) {
        decision = deep.decision;
        reason = deep.reason;
        evidence = deep.evidence;
        proposals = deep.proposals;
      } else {
        const provider = await this.getProvider(agent.provider);
        if (provider.consult && run) {
          const apiKey = await secretService.resolve(ws, agent.credentialId ?? agent.provider);
          const context = run.log.slice(-30).map((l) => l.line).join("\n").slice(-3000);
          const feature = task.featureId ? await this.store.getFeature(task.featureId).catch(() => undefined) : undefined;
          const reply = await provider.consult(
            { task: buildAgentContext({ project, feature, body: task.text }), model: agent.model, cwd: config.runnerCwd, apiKey, context },
            `Review whether this run satisfies the task "${task.text}". ${REVIEW_OUTPUT_INSTRUCTION}`,
          );
          // The verdict is the MODEL's, read from a structured field — we never
          // classify its prose (a reason mentioning "flagged" once false-flagged an
          // APPROVE). An unreadable verdict flags for a human, never auto-approves.
          const verdict = parseReviewVerdict(reply);
          decision = verdict.approve ? "approve" : "flag";
          reason = verdict.reason;
          proposals = parseReviewProposals(reply);
        }
      }
      // `breakerReview` opt-in (requires `deepReview` — a no-op otherwise, since
      // `deep` is only ever set by a genuine deepReview pass): only after the
      // deepReview reviewer ITSELF approved — never spend a breaker run
      // confirming a flag a human already needs to look at, and never on the
      // plain-consult path (nothing was actually verified there for a breaker
      // to try to break). runBreakerReview never throws (self-caught below);
      // a genuinely reproduced medium+ finding on a "broken" verdict is the
      // ONLY thing that flips decision — everything else (clean, unreadable,
      // couldn't run at all) leaves the verifier's approve exactly as it was.
      if (deep && decision === "approve" && project?.breakerReview) {
        breaker = await this.runBreakerReview(ws, agent, task, run!, hitl, project).catch(() => null);
        if (breaker) {
          const severe = breaker.findings.filter((f) => f.severity !== "low");
          if (breaker.verdict === "broken" && severe.length > 0) {
            decision = "flag";
            reason = `Breaker reproduced ${severe.length} issue(s) the verifier missed: ${severe.map((f) => f.what).join("; ").slice(0, 280)}`;
          }
        }
      }
    } catch (err) {
      decision = "flag";
      reason = `review consult failed: ${(err as Error).message}`;
    }
    // The consult above is slow (an LLM round-trip); meanwhile an operator — or
    // another actor — may have resolved this same gate and driven the run to
    // done. Re-validate against fresh state before writing so autonomy defers to
    // whatever already happened and never clobbers a task that moved on (a stale
    // `{...task, state:"review"}` write would knock a merged→done task back to
    // review). DEF-001: derive the write from fresh state, not the snapshot.
    const freshHitl = await this.store.getHitl(hitl.id);
    if (!freshHitl || freshHitl.resolvedAt) return; // already handled — defer
    const freshTask = await this.store.getTask(task.id);
    if (!freshTask || freshTask.state !== "review" || freshTask.runId !== task.runId) return;
    // If a verdict raced in ahead of us (parallel tick, unlikely but safe),
    // don't clobber it with another consult's answer.
    if (freshTask.reviewVerdict) return;
    const reviewer = agent.name || agent.id;
    const at = now();
    // Record the auto-review on the run's live log — a short verdict line that
    // folds open to the reviewer's full reasoning. Mirrors how a human's
    // decision is auditable; here the reviewer is a fleet agent, not a person.
    if (task.runId) {
      const suffix = decision === "approve"
        ? canResolve ? "approved (integrating)" : "approved (awaiting human)"
        : "flagged for a human";
      await this.hub.runLog(task.runId, `⟳ auto-reviewed by ${reviewer} — ${suffix}`, reason);
    }
    // ALWAYS persist the verdict on the task so the detail view can show it —
    // approve OR flag, autonomy on OR off. This is the audit trail.
    const verdict = { decision, reason, by: reviewer, at, evidence: evidence ?? null, breaker };
    const withVerdict = await this.hub.upsertTask({ ...freshTask, reviewVerdict: verdict });
    // Session circuit-breaker: a flag is a bad autonomy outcome for the
    // project, an approve is a good one — tracked regardless of `canResolve`
    // (autonomy on/off), same as the verdict itself; noteAutonomyBadOutcome's
    // own guard is what actually skips a non-autonomous project.
    const breakerProject = await this.store.getProject(freshTask.projectId);
    if (breakerProject) {
      if (decision === "flag") {
        await this.noteAutonomyBadOutcome(breakerProject, hitl.runId, `"${freshTask.text}" flagged — ${reason}`);
      } else {
        this.noteAutonomyGoodOutcome(breakerProject.id);
      }
      // Self-replenishing backlog: independent of the verdict itself — a
      // flagged run's reviewer can still have noticed something worth a task,
      // same as an approved one. Never blocks/slows the verdict path above;
      // best-effort, logged rather than thrown into the caller on failure.
      if (proposals.length > 0) {
        await this.processFleetProposals(breakerProject, freshTask, hitl.runId, proposals).catch((err) =>
          this.hub.runLog(hitl.runId, `fleet proposal processing failed: ${(err as Error).message}`).catch(() => undefined),
        );
      }
    }
    if (decision === "approve" && canResolve) {
      const resolution: Resolution = { action: "approve", optionIndex: null, guidance: null, targetBranch: null, memoryNote: null, resetWork: false, by: "autonomy", at };
      const resolved = await this.hub.resolveHitl(hitl.id, resolution);
      if (resolved && resolved.resolution?.at === resolution.at) await this.deliver(hitl, resolution);
      // Once an agent has approved a review-state task, move it to `done` and
      // sync the run's status — regardless of the downstream integration path.
      // The local merge queue's completeMerged() ALSO writes this on merge
      // (idempotent no-op), but for the GitHub-PR path pushToGithub deliberately
      // leaves the run in `review` waiting for a human to merge the PR — that
      // would strand the KANBAN task in `review` too. Advancing the card here
      // reflects Skynet's view: the AGENT signed off; the PR is the follow-
      // through on GitHub, not a Skynet blocker. Re-fetch to avoid a stale-
      // snapshot clobber, and only advance if the task is still ours to move.
      const afterDeliver = await this.store.getTask(task.id);
      if (afterDeliver && afterDeliver.state === "review" && afterDeliver.runId === task.runId) {
        await this.hub.upsertTask({ ...afterDeliver, state: "done" });
        if (afterDeliver.runId) await this.hub.runStatus(afterDeliver.runId, "done").catch(() => undefined);
      }
    }
    // decision === "flag" OR (approve without autonomy) → verdict is recorded
    // (`withVerdict`), HITL stays open for the human. Nothing else to do here.
    void withVerdict;
  }

  /**
   * Manual "Request review" — an operator forcing a review pass on demand,
   * instead of waiting for a periodic tick to happen to find an idle
   * reviewer (the periodic path in tick() above only reviews opportunistically
   * when one already exists). Reuses `autoReview` — same deepReview/
   * breakerReview opt-ins, same verdict-writing, same audit trail — this is
   * just an eager entry point for the SAME reviewer-selection the tick does.
   * Throws an honest, specific error rather than silently doing nothing: a
   * task already reviewed, a run with no open gate to review, or no eligible
   * reviewer free right now (a single-agent project can never satisfy this —
   * a run can't review itself).
   */
  async requestReview(ws: string, taskId: string): Promise<void> {
    const task = await this.store.getTask(taskId);
    if (!task || task.workspaceId !== ws || task.state !== "review" || !task.runId) {
      throw new NoOpenReviewGateError();
    }
    if (task.reviewVerdict) {
      throw new AlreadyReviewedError(task.reviewVerdict.by, task.reviewVerdict.decision, task.reviewVerdict.reason);
    }
    const hitl = (await this.store.listQueue(ws)).find(
      (h) => h.runId === task.runId && !h.resolvedAt && (h.kind === "diff" || h.kind === "merge" || h.kind === "verifier"),
    );
    if (!hitl) throw new NoOpenReviewGateError();
    const doerId = (await this.store.getRun(task.runId))?.agentId;
    const reviewer = (await this.store.listAgents(ws)).find((a) => a.status === "idle" && a.id !== doerId && a.canReview !== false);
    if (!reviewer) throw new NoReviewerAvailableError();
    const project = await this.store.getProject(task.projectId);
    await this.autoReview(ws, reviewer, task, hitl, project?.autonomy ?? false);
  }

  /**
   * Self-replenishing backlog: turn a review's fleet-authored proposals into
   * real tasks, per resolveProposalPlacement's scope taxonomy. Gathers the
   * context each proposal is judged against ONCE per batch (open task titles,
   * the source task's Feature + its current sibling count, today's budget),
   * then walks the (already ≤ MAX_PROPOSALS_PER_REVIEW) proposals in order,
   * updating that context as it goes so two proposals in the SAME batch never
   * both create the same title, and a second in-scope proposal for the same
   * Feature sees the first one's sibling count.
   */
  private async processFleetProposals(
    project: Project,
    sourceTask: Task,
    runId: string,
    proposals: ProposedTask[],
  ): Promise<void> {
    const ws = project.workspaceId;
    const allTasks = await this.store.listTasks(ws);
    const projectTasks = allTasks.filter((t) => t.projectId === project.id);
    const openTitles = new Set(
      projectTasks.filter((t) => !t.archived && t.state !== "done").map((t) => normalizeProposalTitle(t.text)),
    );
    let dailyCount = countFleetProposalsToday(projectTasks, now());
    const feature = sourceTask.featureId ? (await this.store.getFeature(sourceTask.featureId)) ?? null : null;
    // S8 feedback: resolved once per source run (not per proposal) — every
    // proposal from this run shares the same source task, so the same brief.
    const brief = await this.findTaskBrief(sourceTask, ws);
    let siblingCount = feature
      ? projectTasks.filter((t) => t.featureId === feature.id && !t.archived).length
      : 0;
    const runs = await this.store.listRuns(ws);
    const underBudget = await this.underDailyBudget(project, runs);
    let cappedLogged = false;

    for (const proposal of proposals) {
      if (dailyCount >= config.fleetProposalMaxPerProjectPerDay) {
        if (!cappedLogged) {
          cappedLogged = true;
          const line = `fleet proposal daily cap (${config.fleetProposalMaxPerProjectPerDay}/day) reached — "${proposal.title}" and any further proposals today are dropped, not parked`;
          console.warn(`[project ${project.id}] ${line}`);
          await this.hub.runLog(runId, line).catch(() => undefined);
        }
        continue;
      }
      const placement = resolveProposalPlacement(proposal, {
        openTaskTitles: openTitles,
        featureStatus: feature?.status ?? null,
        siblingCountInFeature: siblingCount,
        featureBatchMaxTasks: config.featureBatchMaxTasks,
        underBudget,
      });
      if (placement.action === "skip-duplicate") continue;
      const created = await this.createFleetTask(project, sourceTask, runId, proposal, placement, feature, brief);
      dailyCount++;
      openTitles.add(normalizeProposalTitle(created.text));
      if (placement.action === "create-active") siblingCount++;
    }
  }

  /** Write one fleet proposal as a real Task, per the placement
   *  resolveProposalPlacement already decided. `create-active` lands it
   *  directly in the source task's Feature, `todo`, auto-pickable — no extra
   *  human step, since every gate that matters already passed. Anything else
   *  parks in `backlog`, unassigned, never auto-picked, with the degraded
   *  reason (if any) folded into the run log so the operator sees WHY an
   *  in-scope proposal didn't auto-promote, not just that it didn't. */
  private async createFleetTask(
    project: Project,
    sourceTask: Task,
    runId: string,
    proposal: ProposedTask,
    placement: ProposalPlacement,
    feature: Feature | null,
    brief: SolutionBrief | undefined,
  ): Promise<Task> {
    const ws = project.workspaceId;
    const inProject = (await this.store.listTasks(ws)).filter((t) => t.projectId === project.id);
    const source: TaskSource = { kind: "fleet", byRun: runId, reason: proposal.why, proposedAt: now() };
    const base: Task = {
      id: `t-${this.slug(project.name)}-${++this.seq}`,
      workspaceId: ws,
      projectId: project.id,
      text: proposal.title,
      description: null,
      state: "backlog",
      runId: null,
      autoPick: false,
      assessment: null,
      assessmentEffort: null,
      assessmentRisks: [],
      clarification: null,
      reviewVerdict: null,
      assignment: { mode: "unassigned", agentIds: [] },
      order: inProject.length,
      archived: false,
      estimatedDurationMs: null,
      plannedStartAt: null,
      featureId: null,
      milestoneId: null,
      source,
      dependsOnTaskIds: [],
      lint: null,
      preferredProvider: null,
      preferredModel: null,
    };
    if (placement.action === "create-active" && feature) {
      const task = await this.hub.upsertTask({
        ...base,
        state: "todo",
        featureId: feature.id,
        assignment: { mode: "any", agentIds: [] },
        autoPick: true,
      });
      await this.hub
        .runLog(runId, `⊕ fleet proposed + auto-promoted an in-scope task under "${feature.name}": "${proposal.title}"`, proposal.why)
        .catch(() => undefined);
      return task;
    }
    const degradeNote =
      placement.action === "create-parked" && placement.degradedReason ? ` — parked (${placement.degradedReason})` : " — parked for a human";
    // S8 feedback loop: a discovery from a run whose task belongs to a
    // Solution Brief's feature is attached to that SAME feature even when
    // parked (unlike create-active's auto-promote above, which only fires
    // when the placement gates all pass) — visible in the brief's scope for
    // a human to judge in backlog/triage as today, not floating unscoped.
    const briefFeatureId = feature?.id ?? brief?.featureId ?? null;
    const parked = brief && briefFeatureId ? { ...base, featureId: briefFeatureId } : base;
    const task = await this.hub.upsertTask(parked);
    await this.hub.runLog(runId, `⊕ fleet proposed a task${degradeNote}: "${proposal.title}"`, proposal.why).catch(() => undefined);
    return task;
  }

  /**
   * Release runners that are persisted "busy" but held by no live agent —
   * "orphaned busy" state. It happens across a restart (the in-memory live map
   * is empty, but the file/pg store still says busy) or if a freeRunner was ever
   * missed. Left alone, such a runner shows "busy" forever with no work, and the
   * retire guard refuses to remove it. Runs once at startup, where nothing is
   * live yet — so any busy runner is definitionally an orphan and safe to reset.
   * `isBusy` (the live map) is the source of truth for "actually executing".
   */
  async reconcileRunners(): Promise<void> {
    const runners = await this.store.listAllAgents().catch(() => [] as Agent[]);
    for (const r of runners) {
      if (r.status === "busy" && !this.isBusy(r.id)) {
        await this.hub.upsertAgent({ ...r, status: "idle", idleSince: now() });
      }
    }
  }

  /** Pause a running/waiting agent — halts its runner but keeps the session. */
  async pauseAgent(runId: string): Promise<TaskRun | undefined> {
    const agent = await this.store.getRun(runId);
    if (!agent || agent.status === "done" || agent.status === "paused") return agent;
    const live = this.live.get(runId);
    if (live) await live.handle.pause().catch(() => undefined);
    await this.hub.runStatus(runId, "paused");
    return this.store.getRun(runId);
  }

  /** Resume a paused agent back into the running state. */
  async resumeAgent(runId: string): Promise<TaskRun | undefined> {
    const agent = await this.store.getRun(runId);
    if (!agent || agent.status !== "paused") return agent;
    const live = this.live.get(runId);
    if (live) await live.handle.resume().catch(() => undefined);
    await this.hub.runStatus(runId, "running");
    return this.store.getRun(runId);
  }

  /** Operator "stop / remove": halt execution, free the runner, mark the agent done. */
  async haltAgent(runId: string): Promise<TaskRun | undefined> {
    const agent = await this.store.getRun(runId);
    if (!agent) return undefined;
    const live = this.live.get(runId);
    if (live?.agentId) {
      const runner = await this.store.getAgent(live.agentId);
      if (runner) await this.hub.upsertAgent({ ...runner, status: "idle", idleSince: now() });
    }
    await this.stopAgent(runId); // stop the handle + retire the worktree + drop the session
    // stopAgent detaches but leaves the status untouched — halt is the terminal
    // operator action, so mark it done and emit the completion event.
    if (agent.status !== "done") {
      await this.hub.runStatus(runId, "done");
      await this.hub.runCompleted(runId, agent.branch);
    }
    // A stopped run integrates no change, so its owning task must not be left
    // stranded "ongoing" (or "review") with no live run behind it — that reads as
    // in-progress while nothing is working it. Return the task to `todo` (cleanly
    // re-pickable) and archive+detach the dead run, mirroring the abandon path
    // (transitionTask ongoing/review → todo). Invariant: an `ongoing` task always
    // has a live run.
    const task = (await this.store.listTasks(agent.workspaceId)).find((t) => t.runId === runId);
    if (task && (task.state === "ongoing" || task.state === "review")) {
      await this.hub.setRunArchived(runId, true).catch(() => undefined);
      await this.hub.upsertTask({ ...task, state: "todo", runId: null, reviewVerdict: null });
    }
    return this.store.getRun(runId);
  }

  /**
   * Settle a run that has been ARCHIVED while still in a non-terminal state.
   *
   * Archiving used to be cosmetic — `setRunArchived` flipped a boolean and
   * nothing else — so a run archived from `review` kept that status, kept its
   * `agentId`, and kept offering live controls (Fork/Pause/Stop) forever. And
   * because gcWorktrees' stuck-review sweep deliberately SKIPS archived runs,
   * nothing could ever settle it: found live with 14 such zombies, the oldest
   * idle for days.
   *
   * Archiving IS the operator saying "I'm done with this", so settle it: stop
   * any live handle, hand the runner back, mark the run terminal, and release
   * the owning task rather than leaving it stranded pointing at a hidden run
   * (the same invariant haltAgent upholds — see the escalation-reject fix).
   *
   * Deliberately does NOT retire the worktree, unlike haltAgent/stopAgent.
   * Archive is documented as a REVERSIBLE soft-hide that "never deletes", so
   * the branch and its work must survive: this settles the run's bookkeeping,
   * it doesn't throw away what the run produced.
   */
  async settleArchivedRun(runId: string): Promise<void> {
    const run = await this.store.getRun(runId);
    if (!run || run.status === "done") return; // already terminal — nothing to settle
    const live = this.live.get(runId);
    if (live) await live.handle.stop().catch(() => undefined);
    await this.freeRunner(live?.agentId ?? run.agentId ?? null);
    await this.releaseScratchCwd(live?.scratchCwd);
    this.live.delete(runId);
    this.escalations.delete(runId);
    this.failCounts.delete(runId);
    // Any gate still pointing at this run is now unanswerable — the run is
    // hidden and settled, so leaving the card would strand it in the Inbox.
    const open = (await this.store.listQueue(run.workspaceId).catch(() => [] as HitlItem[])).filter(
      (q) => q.runId === runId && q.resolvedAt == null,
    );
    for (const q of open) {
      await this.hub
        .resolveHitl(q.id, {
          action: "dismiss",
          by: "system",
          at: now(),
          optionIndex: null,
          guidance: null,
          targetBranch: null,
          memoryNote: null,
          resetWork: false,
        })
        .catch(() => undefined);
    }
    await this.hub.runStatus(runId, "done");
    await this.hub.runLog(runId, "archived — run settled, runner freed (its branch is kept)");
    const task = (await this.store.listTasks(run.workspaceId).catch(() => [] as Task[])).find((t) => t.runId === runId);
    if (task && (task.state === "ongoing" || task.state === "review")) {
      await this.hub.upsertTask({ ...task, state: "todo", runId: null, reviewVerdict: null });
    }
  }

  /** Self-heal: settle any run that is already archived but stuck in a
   *  non-terminal state. Runs on the periodic sweep so the zombies created
   *  before archiving settled anything are cleaned up without a migration. */
  async settleArchivedRuns(): Promise<number> {
    const runs = await this.store.listAllRuns().catch(() => [] as TaskRun[]);
    const stuck = runs.filter((r) => r.archived && r.status !== "done");
    for (const r of stuck) await this.settleArchivedRun(r.id).catch(() => undefined);
    return stuck.length;
  }

  isBusy(agentId: string): boolean {
    for (const l of this.live.values()) if (l.agentId === agentId) return true;
    return false;
  }

  /** Kill switch state — read/write the pause flag. When paused, tickAutonomy is
   *  a no-op; live runs are unaffected until {@link stopAll} halts them. */
  setPaused(p: boolean): void {
    this.paused = p;
  }
  isPaused(): boolean {
    return this.paused;
  }

  /**
   * Remote kill switch: pause autonomy AND halt every in-flight run. "Stop all
   * processing" = no new autonomous work + no live runs still executing. The
   * janitorial loops (reaper/GC) keep running by design. Each run is halted
   * independently (a per-run failure is logged and skipped so one bad run can't
   * abort the sweep). Returns how many runs were stopped.
   */
  async stopAll(reason: string): Promise<number> {
    this.paused = true;
    // Snapshot the fleet first (haltAgent mutates run status as we go).
    const runs = await this.store.listAllRuns().catch(() => [] as TaskRun[]);
    const live = runs.filter((r) => r.status === "running" || r.status === "waiting");
    let stopped = 0;
    for (const run of live) {
      try {
        await this.haltAgent(run.id);
        stopped++;
      } catch (err) {
        // One run failing to halt must not abort the sweep — record and continue.
        await this.hub.runLog(run.id, `kill switch: failed to halt — ${(err as Error).message}`).catch(() => undefined);
      }
    }
    console.log(`[orchestrator] kill switch: ${reason} — paused autonomy, halted ${stopped} run(s)`);
    return stopped;
  }
}
