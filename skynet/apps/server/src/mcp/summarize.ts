// ─── MCP response shaping ────────────────────────────────────────────────
// Why this file exists: TaskRun.log[] carries a run's ENTIRE tool-call history
// (every command + its full output as `detail`), and AuditRecord.payload
// embeds the full unified diff patch for every resolved diff/merge decision.
// Both are exactly right for the HTTP API (the web UI renders them) and
// exactly wrong for an MCP list call — an agent asking "what's running?" does
// not want a workspace-wide dump of every tool transcript. A single real
// workspace hit ~$70+ of token spend partly because list_agents/get_snapshot
// were shipping full TaskRun objects (log included) for every run, every call.
//
// The fix is a summary/detail split, same shape as the app's own
// list-then-drill-in pattern (list_tasks/list_agents → get_task/get_agent):
// list_* tools return small, paginated projections; get_* tools return the
// full record for the ONE the caller cared about. This module holds the
// projections + the pagination helper shared across tools.ts.

import type { AuditRecord, HitlItem, SolutionBrief, Task, TaskRun } from "@skynet/shared";

// ── text clipping ────────────────────────────────────────────────────────
// One marker format everywhere, chosen to tell the READING AGENT two things
// at once: that text is missing, and exactly how much — so it can decide
// whether to drill in rather than assuming it saw everything.
export function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)} …[+${s.length - max} chars]` : s;
}

// ── patch clipping ───────────────────────────────────────────────────────
// run_diff / get_audit return a real unified patch — the ONE payload whose
// size is genuinely unbounded (a big refactor's diff can alone exceed a
// model's context). Default keeps the head (diffs read front-to-back, and the
// first files are usually the point); the caller can raise the cap up to a
// hard ceiling, and `patchTruncated`/`patchChars` make the cut explicit.
export const DEFAULT_PATCH_CHARS = 30_000;
export const MAX_PATCH_CHARS = 200_000;

export function clipPatch(
  patch: string,
  maxChars: number | undefined,
): { patch: string; patchChars: number; patchTruncated: boolean } {
  const cap = Math.min(Math.max(1, maxChars ?? DEFAULT_PATCH_CHARS), MAX_PATCH_CHARS);
  if (patch.length <= cap) return { patch, patchChars: patch.length, patchTruncated: false };
  return {
    patch: `${patch.slice(0, cap)}\n…[patch truncated: showing ${cap} of ${patch.length} chars — re-call with a larger maxPatchChars (ceiling ${MAX_PATCH_CHARS}) for more]`,
    patchChars: patch.length,
    patchTruncated: true,
  };
}

// get_agent log entries: each LogLine.detail carries a tool call's full
// input/output (the runner already caps a single entry at ~6000 chars, but
// 100 entries × 6000 is still worst-case ~600k chars for ONE call). Default
// to a per-entry clip that keeps the shape of what happened; logDetailChars
// raises it (to the runner's own per-entry cap) or 0 drops details entirely.
export const DEFAULT_LOG_DETAIL_CHARS = 600;
export const MAX_LOG_DETAIL_CHARS = 6_000;

// ── pagination ───────────────────────────────────────────────────────────
// Small default (cheap by default), a hard ceiling (a caller can't request
// its way back into an unbounded dump), and always reports `total`/`hasMore`
// so the caller knows to page rather than assuming a short list is everything.
export const DEFAULT_LIST_LIMIT = 30;
export const MAX_LIST_LIMIT = 200;

// get_snapshot embeds runs/tasks directly (see tools.ts) — cap them too, for
// the same reason list_* is paginated: an overview call shouldn't scale
// unboundedly with workspace history. Most-recently-active first, so the cap
// drops old done runs before anything live.
export const SNAPSHOT_CAP = 200;

// get_agent returns ONE run's full log (that's the point of "get one thing"),
// but a single very long-lived run can still blow the context on its own —
// default to the most recent entries, paginate further back on request.
export const DEFAULT_LOG_LIMIT = 100;
export const MAX_LOG_LIMIT = 500;

export interface Page<T> {
  items: T[];
  total: number;
  hasMore: boolean;
}

export function paginate<T>(items: T[], limit: number | undefined, offset: number | undefined): Page<T> {
  const off = Math.max(0, offset ?? 0);
  const lim = Math.min(Math.max(1, limit ?? DEFAULT_LIST_LIMIT), MAX_LIST_LIMIT);
  const page = items.slice(off, off + lim);
  return { items: page, total: items.length, hasMore: off + page.length < items.length };
}

// ── run summary ──────────────────────────────────────────────────────────
// Everything needed to triage/identify a run and decide whether to drill into
// it with get_agent. Deliberately excludes `log` (unbounded, the #1 bloat
// source) and the raw `plan` array (collapsed to counts + the current step).
export interface RunSummary {
  id: string;
  name: string;
  projectId: string;
  agentId: string | null;
  provider: string;
  model: string;
  status: TaskRun["status"];
  progress: number;
  currentStep: string | null; // the plan step in state "now"; null if none
  planDone: number;
  planTotal: number;
  startedAt: number;
  lastHeartbeatAt: number;
  branch: string;
  costUsd: number | null;
  hasPr: boolean;
  merged: boolean;
}

export function summarizeRun(r: TaskRun): RunSummary {
  const plan = r.plan ?? [];
  return {
    id: r.id,
    name: r.name,
    projectId: r.projectId,
    agentId: r.agentId ?? null,
    provider: r.provider,
    model: r.model,
    status: r.status,
    progress: r.progress ?? 0,
    currentStep: plan.find((p) => p.state === "now")?.text ?? null,
    planDone: plan.filter((p) => p.state === "done").length,
    planTotal: plan.length,
    startedAt: r.startedAt ?? 0,
    lastHeartbeatAt: r.lastHeartbeatAt ?? 0,
    branch: r.branch,
    costUsd: r.usage?.costUsd ?? null,
    hasPr: r.pr != null,
    merged: r.mergedAt != null,
  };
}

// ── task summary ─────────────────────────────────────────────────────────
// Drops the free-text fields that compound across a workspace's whole backlog
// (description, the full assessment/risk prose, review reasons, lint notes)
// in favor of presence/counts — enough to know WHICH tasks need a closer look
// via get_task, without paying for every task's full brief up front.
export interface TaskSummary {
  id: string;
  text: string;
  state: Task["state"];
  projectId: string;
  runId: string | null;
  autoPick: boolean;
  archived: boolean;
  hasDescription: boolean;
  assessmentEffort: Task["assessmentEffort"];
  riskCount: number;
  reviewDecision: string | null;
  lintConcernCount: number;
}

export function summarizeTask(t: Task): TaskSummary {
  return {
    id: t.id,
    text: t.text,
    state: t.state,
    projectId: t.projectId,
    runId: t.runId ?? null,
    autoPick: t.autoPick,
    archived: t.archived,
    hasDescription: !!t.description,
    assessmentEffort: t.assessmentEffort ?? null,
    riskCount: t.assessmentRisks?.length ?? 0,
    reviewDecision: t.reviewVerdict?.decision ?? null,
    lintConcernCount: t.lint?.concerns.length ?? 0,
  };
}

// ── audit summary ────────────────────────────────────────────────────────
// AuditRecord.payload is `z.unknown()` (a free-form snapshot taken at resolve
// time — see Hub.doResolveHitl) that, for a diff/merge decision, embeds the
// FULL captured unified patch text. That's the single largest thing in the
// whole MCP surface at scale, and a list caller almost never needs the raw
// diff for every past decision — get_audit reads it for the one that does.
// Narrowed defensively (payload is untyped) rather than trusting its shape.
export interface AuditSummary {
  hitlId: string;
  runId: string;
  action: string;
  operatorId: string;
  at: number;
  archived: boolean;
  kind: string | null;
  title: string | null;
  risk: string | null;
  diffFiles: number;
  diffAdd: number;
  diffDel: number;
}

// ── HITL summary ─────────────────────────────────────────────────────────
// A HitlItem embeds everything the web UI renders on a decision card: the
// full command/preview text, a verifier gate's captured check output, and a
// diff gate's LLM-drafted walkthrough + merge brief — multiplied across the
// queue on every list_hitl / get_snapshot call. The summary keeps what's
// needed to TRIAGE (what kind, how risky, what options) and swaps the prose
// for presence/size signals; get_hitl returns the one full item to act on.
export interface HitlSummary {
  id: string;
  runId: string;
  kind: HitlItem["kind"];
  title: string;
  why: string;
  risk: HitlItem["risk"];
  raisedAt: number;
  expiresAt: number | null;
  resolvedAt: number | null;
  options: string[] | null;
  recommended: number | null;
  flags: string[];
  command: string | null; // clipped — get_hitl for the full text
  outputChars: number; // verifier output present? how big? (never inlined here)
  stepCount: number;
  diff: { add: number; del: number; fileCount: number; defaultTargetBranch: string | null } | null;
  hasWalkthrough: boolean;
  hasMergeBrief: boolean;
}

const HITL_COMMAND_CLIP = 240;

export function summarizeHitl(h: HitlItem): HitlSummary {
  return {
    id: h.id,
    runId: h.runId,
    kind: h.kind,
    title: h.title,
    why: h.why,
    risk: h.risk,
    raisedAt: h.raisedAt,
    expiresAt: h.expiresAt ?? null,
    resolvedAt: h.resolvedAt ?? null,
    options: h.options ?? null,
    recommended: h.recommended ?? null,
    flags: h.flags ?? [],
    command: h.command ? clip(h.command, HITL_COMMAND_CLIP) : null,
    outputChars: h.output?.length ?? 0,
    stepCount: h.steps?.length ?? 0,
    diff: h.diff
      ? { add: h.diff.add, del: h.diff.del, fileCount: h.diff.files?.length ?? 0, defaultTargetBranch: h.diff.defaultTargetBranch ?? null }
      : null,
    hasWalkthrough: !!h.diff?.walkthrough,
    hasMergeBrief: !!h.diff?.mergeBrief,
  };
}

// ── solution-brief summary ───────────────────────────────────────────────
// A brief is a long-form markdown planning doc (problem + approach + options
// + risks + criteria); listing a workspace's briefs shipped every doc in
// full. The summary keeps identity/status plus a problem teaser and counts;
// get_brief returns the one full doc.
export interface BriefSummary {
  id: string;
  projectId: string;
  title: string;
  status: SolutionBrief["status"];
  featureId: string | null;
  createdAt: number;
  updatedAt: number;
  approvedAt: number | null;
  problem: string; // clipped teaser — get_brief for the full doc
  optionCount: number;
  riskCount: number;
  acceptanceCriteriaCount: number;
  openQuestionCount: number;
  hasExploration: boolean;
}

const BRIEF_PROBLEM_CLIP = 200;

export function summarizeBrief(b: SolutionBrief): BriefSummary {
  return {
    id: b.id,
    projectId: b.projectId,
    title: b.title,
    status: b.status,
    featureId: b.featureId ?? null,
    createdAt: b.createdAt,
    updatedAt: b.updatedAt,
    approvedAt: b.approvedAt ?? null,
    problem: clip(b.problem, BRIEF_PROBLEM_CLIP),
    optionCount: b.optionsConsidered?.length ?? 0,
    riskCount: b.risks?.length ?? 0,
    acceptanceCriteriaCount: b.acceptanceCriteria?.length ?? 0,
    openQuestionCount: b.openQuestions?.length ?? 0,
    hasExploration: !!b.exploration,
  };
}

export function summarizeAudit(a: AuditRecord): AuditSummary {
  const p = (a.payload ?? {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" && v ? v : null);
  const strArr = (v: unknown) => (Array.isArray(v) ? (v as unknown[]).filter((x): x is string => typeof x === "string") : null);
  const diff = (p.diff ?? {}) as Record<string, unknown>;
  // `payload.files` (captured fresh at resolve/merge time, see Hub.doResolveHitl)
  // is the more authoritative file list when present; `payload.diff.files` (the
  // DiffSummary captured when the gate was RAISED) is the fallback for decision
  // kinds with no capturedDiff (approval/question/plan never set `files`).
  const files = strArr(p.files) ?? strArr(diff.files) ?? [];
  return {
    hitlId: a.hitlId,
    runId: a.runId,
    action: a.action,
    operatorId: a.operatorId,
    at: a.at,
    archived: a.archived ?? false,
    kind: str(p.kind),
    title: str(p.title),
    risk: str(p.risk),
    diffFiles: files.length,
    diffAdd: typeof diff.add === "number" ? diff.add : 0,
    diffDel: typeof diff.del === "number" ? diff.del : 0,
  };
}
