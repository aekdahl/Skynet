// ─── Skynet domain contracts ──────────────────────────────────────────────
// The single source of truth for the frontend/backend seam. Zod schemas here
// define both runtime validators and (via z.infer) the TypeScript types both
// apps import. Change a field and both sides fail to compile until they agree.
//
// Field names follow the Backend Integration Brief §03 (server-side canonical).

import { z } from "zod";

// ─── Enums & primitives ───────────────────────────────────────────────────

export const ProviderId = z.enum([
  "claude",
  "codex",
  "gemini",
  "cursor",
  "copilot",
  "hermes",
]);
export type ProviderId = z.infer<typeof ProviderId>;

// A credential in the secret store belongs to a fleet provider OR to "github" — a
// GitHub PAT, so a project can be pinned to a specific GitHub account (business vs
// personal billing/storage). `github` is deliberately NOT a fleet provider: it
// never appears in the runner catalog or provider-availability, only as a stored
// credential a project's git operations can authenticate with.
export const CredentialProvider = z.union([ProviderId, z.literal("github")]);
export type CredentialProvider = z.infer<typeof CredentialProvider>;

export const TaskRunStatus = z.enum(["running", "waiting", "paused", "review", "done"]);
export type TaskRunStatus = z.infer<typeof TaskRunStatus>;

export const PlanStepState = z.enum(["done", "now", "todo"]);
export type PlanStepState = z.infer<typeof PlanStepState>;

// "escalation" = a run has HALTED and needs a human — the agent gave up (tried
// enough / fundamentally blocked), or the system tripped a guard (too long, too
// many failures). Distinct from "question" (which resumes on an answer): the
// human decides whether to help & resume, reassign, or stop.
export const HitlKind = z.enum(["approval", "question", "plan", "diff", "merge", "escalation"]);
export type HitlKind = z.infer<typeof HitlKind>;

/** Default single-tenant workspace until real provisioning lands. */
export const DEFAULT_WORKSPACE = "cyberdyne";

export const Risk = z.enum(["low", "medium", "high"]);
export type Risk = z.infer<typeof Risk>;

export const AgentStatus = z.enum(["busy", "idle"]);
export type AgentStatus = z.infer<typeof AgentStatus>;

// The kanban pipeline. A task flows backlog → triage → todo → ongoing → review →
// done. Agents autonomously handle backlog→triage (assessment) and, when a task
// is flagged autoPick, todo→ongoing; a human gates triage→todo and can demote
// done→triage/backlog. ongoing/review/done carry a linked TaskRun (see Task.runId).
export const TaskState = z.enum([
  "backlog",
  "triage",
  "todo",
  "ongoing",
  "review",
  "done",
]);
export type TaskState = z.infer<typeof TaskState>;

// A task's agent *eligibility* — WHO may take it, distinct from who actually did
// (that's TaskRun.agentId). The set, not a hard binding: any idle eligible agent
// runs it.
//  • unassigned — no choice made yet. Only legal while the task sits in `backlog`;
//                 leaving backlog requires a real choice (any | agents).
//  • any         — any idle fleet agent may take it (the historical behavior).
//  • agents      — only agents in `agentIds` (a pool of ≥1) may take it; whichever
//                  is idle first runs it. Enables affinity ("agent A must do this")
//                  and dependency-aware routing; the seam an agent-picks-agent
//                  feature writes to later.
export const TaskAssignment = z
  .object({
    mode: z.enum(["unassigned", "any", "agents"]).default("unassigned"),
    agentIds: z.array(z.string()).default([]),
  })
  .superRefine((v, ctx) => {
    if (v.mode === "agents" && v.agentIds.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "assignment mode 'agents' requires at least one agentId",
        path: ["agentIds"],
      });
    }
  });
export type TaskAssignment = z.infer<typeof TaskAssignment>;

export const ProjectStatus = z.enum(["active", "paused", "done"]);
export type ProjectStatus = z.infer<typeof ProjectStatus>;

/** Epoch milliseconds. Clients derive elapsed/wait/since-beat from these. */
export const Timestamp = z.number().int().nonnegative();

// ─── Plan & log ───────────────────────────────────────────────────────────

export const PlanStep = z.object({
  text: z.string(),
  state: PlanStepState,
});
export type PlanStep = z.infer<typeof PlanStep>;

// ─── Token usage & cost ─────────────────────────────────────────────────────
// What a runner has spent so far, reported by the vendor (Claude's result
// message carries exact numbers; some CLIs surface them best-effort, others
// not at all). `costUsd`/`durationMs` are nullable when the vendor omits them.
export const Usage = z.object({
  inputTokens: z.number().int().nonnegative().default(0),
  outputTokens: z.number().int().nonnegative().default(0),
  costUsd: z.number().nonnegative().nullable().default(null),
  turns: z.number().int().nonnegative().default(0),
  durationMs: z.number().int().nonnegative().nullable().default(null),
});
export type Usage = z.infer<typeof Usage>;

/** Append-only activity log line. Streamed via the `agent.log` event. */
export const LogLine = z.object({
  at: Timestamp,
  line: z.string(),
  // Optional expandable detail (e.g. a tool call's full input or output). When
  // present, the UI renders the line as a fold/unfold entry.
  detail: z.string().optional(),
});
export type LogLine = z.infer<typeof LogLine>;

// ─── Pull request (ready-to-merge) ───────────────────────────────────────────
// When a run's diff is approved and pushed, Skynet opens a PR and the task
// completes (→ done). The PR is then listed as "ready to merge": a human makes
// the final merge call from that list, informed by the AI reviewer's briefing.
// Skynet never auto-merges to the real base branch — the merge is a human's.

/** The decision aid shown on the ready-to-merge card. `impact`/`risk` are
 *  system-derived (diff size + modules touched); `recommendation` + `rationale`
 *  carry the AI reviewer's verdict (or a deterministic heuristic when none ran). */
export const MergeBriefing = z.object({
  summary: z.string(), // what changed, one line
  impact: z.string(), // what it touches / who's affected
  risk: Risk, // low | medium | high
  recommendation: z.enum(["merge", "rework", "hold"]), // the suggested action
  rationale: z.string(), // WHY — the reviewer's words (or the heuristic's reason)
  by: z.string(), // reviewer agent name, or "heuristic"
});
export type MergeBriefing = z.infer<typeof MergeBriefing>;

export const PullRequest = z.object({
  number: z.number().int(),
  url: z.string(),
  repo: z.string(), // "owner/name"
  branch: z.string(), // head (the agent branch)
  base: z.string(), // base branch it targets
  state: z.enum(["open", "merged", "closed"]).default("open"),
  openedAt: Timestamp,
  briefing: MergeBriefing.nullable().default(null),
  // Human chose "no-op" on the ready list — hide it from the default view without
  // touching the PR on GitHub (recoverable). Merge/rework clear it implicitly.
  dismissed: z.boolean().default(false),
});
export type PullRequest = z.infer<typeof PullRequest>;

// ─── TaskRun ──────────────────────────────────────────────────────────────────

export const TaskRun = z.object({
  id: z.string(),
  workspaceId: z.string(),
  projectId: z.string(),
  name: z.string(), // the task this agent owns
  status: TaskRunStatus,
  agentId: z.string().nullable(), // which fleet runner executes it
  provider: ProviderId,
  // Which named credential the run authenticates with (copied from the agent at
  // spawn). null → the provider's default credential (id === provider).
  credentialId: z.string().nullable().default(null),
  model: z.string(),
  branch: z.string(),
  modules: z.array(z.string()), // architectural module ids it touches
  progress: z.number().min(0).max(1),
  plan: z.array(PlanStep),
  usage: Usage.nullable().default(null), // token/cost telemetry, when the vendor reports it
  modifiedFiles: z.array(z.string()), // surfaced to UI as modules, never raw paths
  log: z.array(LogLine),
  startedAt: Timestamp,
  lastHeartbeatAt: Timestamp,
  visual: z.boolean().default(false), // has a renderable live-preview delivery
  previewUrl: z.string().nullable().default(null), // live-preview artifact/URL (W5)
  dependsOn: z.array(z.string()).default([]), // upstream agent ids this is gated on (W4)
  // Set when forked — shares context with its parent (same conflict "family"):
  parentId: z.string().nullable().default(null),
  branchFromStep: z.number().int().nullable().default(null),
  // Archived runs are hidden from the project board but kept in the store and
  // reachable via the project's Archive section.
  archived: z.boolean().default(false),
  // The GitHub PR opened for this run's approved diff, if any. Present → the run
  // reached "ready to merge"; a human merges (or reworks) it from that list. The
  // task itself is already `done` — merging is decoupled so the pipeline never
  // stalls on a human. Null → no PR (a local-merge project, or not pushed yet).
  pr: PullRequest.nullable().default(null),
  // Set exactly once, inside `completeMerged` (the single lifecycle function both
  // the local merge queue and `mergeReadyPr` funnel through) — the moment code
  // actually landed on the base branch. Unlike `status === "done"`, which also
  // fires for zero-diff self-completion, an operator Stop, a reaper timeout, or a
  // GitHub PR merely opened (not yet merged), this is the one field that means a
  // real merge happened. Null → never merged.
  mergedAt: Timestamp.nullable().default(null),
});
export type TaskRun = z.infer<typeof TaskRun>;

// ─── Checkpoint ───────────────────────────────────────────────────────────
// A durable snapshot of a run's worktree + plan state, taken mid-run so a long
// task can be rewound in place if it goes sideways. Extends fork/resume
// (`parentId`/`branchFromStep` above): a fork branches a NEW run off wherever
// the parent's branch/session currently sits; a checkpoint records a specific
// earlier POINT on the same run's own branch (a pinned sha, not "whatever HEAD
// is right now"), so `restoreCheckpoint` can rewind that one run in place.
export const Checkpoint = z.object({
  id: z.string(),
  runId: z.string(),
  workspaceId: z.string(),
  // Operator-supplied note ("before the refactor"); null for an unlabeled checkpoint.
  label: z.string().nullable().default(null),
  sha: z.string(), // the run's worktree commit at checkpoint time
  // Claude's SDK session id at checkpoint time, so a restore can resume the
  // conversation instead of starting a fresh turn. Null for non-Claude
  // providers (git-branch continuity only) or if no session was captured yet.
  claudeSessionId: z.string().nullable().default(null),
  plan: z.array(PlanStep),
  progress: z.number().min(0).max(1),
  createdAt: Timestamp,
});
export type Checkpoint = z.infer<typeof Checkpoint>;

// ─── Approval policy (agent-action gating) ──────────────────────────────────
// How aggressively a project auto-approves an agent's GATED actions, so the
// operator isn't asked to confirm every reversible in-sandbox command. The
// medium/high line is the trust boundary: everything genuinely dangerous or
// outward-facing (git push, merge, infra CLIs, destructive git) classifies as
// high-risk or is hard-denied by command-safety, so it ALWAYS needs a human
// regardless of level — with exactly ONE opt-in exception (see `full` below).
// Agents run in isolated worktrees, so low/medium commands are reversible and
// contained until the diff review.
//   manual   — gate every gated action (nothing auto-approved; today's behavior)
//   assisted — auto-approve LOW-risk commands; gate medium/high
//   trusted  — auto-approve LOW+MEDIUM commands; gate high (deny stays deny).
// This level does NOT by itself guarantee a human reviews every diff: with the
// project's `autonomy` toggle on (the default) AND a second reviewer-eligible
// fleet agent, the autonomy tick already lets that OTHER agent LLM-judge a
// finished run's diff and auto-merge on an "approve" verdict — a person is
// only in the loop if the fleet has just one agent, or the reviewer flags it,
// or autonomy is off (see orchestrator.ts autoReview). `full` below is the
// unconditional version of that: no second agent or LLM judgment call needed.
//   full     — everything `trusted` does, PLUS every finished run's OWN diff
//              auto-merges into the base branch immediately — no second
//              agent, no LLM consult, no human — while `autonomy` is on (off
//              → `full` alone changes nothing). An unusually large diff (see
//              the `high` risk threshold in orchestrator.ts) still gates for
//              a human even at this level. Pick it deliberately for zero-touch
//              merges to main, understanding `trusted` + a multi-agent fleet
//              can already merge unattended too, just conditionally.
export const ApprovalLevel = z.enum(["manual", "assisted", "trusted", "full"]);
export type ApprovalLevel = z.infer<typeof ApprovalLevel>;

// A standing "approve always" allowance: an exact command the operator approved
// once and chose to remember, so future identical commands auto-approve without
// asking again. Bounded by the safety floor — a rule NEVER auto-approves a
// command that classifies above `riskCap` or is hard-denied, and high-risk /
// boundary commands can never be remembered in the first place.
export const ApprovalRule = z.object({
  id: z.string(),
  command: z.string(), // normalized (whitespace-collapsed) command matched exactly
  riskCap: Risk, // the command's risk when remembered — the ceiling this rule may auto-approve
  createdBy: z.string(),
  createdAt: Timestamp,
});
export type ApprovalRule = z.infer<typeof ApprovalRule>;

// ─── Project · Task ───────────────────────────────────────────────────────

export const Project = z.object({
  id: z.string(),
  workspaceId: z.string(),
  name: z.string(),
  goal: z.string(),
  runIds: z.array(z.string()),
  status: ProjectStatus,
  // When true, the autonomy loop may act on this project's tasks (triage,
  // auto-pick, auto-review). Off = the board is fully human-driven.
  autonomy: z.boolean().default(true),
  // Agent-action approval policy (see ApprovalLevel). Defaults to `trusted` so
  // reversible in-sandbox commands flow without a confirm each time; high-risk /
  // boundary ops still gate. `approvalRules` are this project's standing
  // "approve always" exact-command allowances (see ApprovalRule).
  approvalLevel: ApprovalLevel.default("trusted"),
  approvalRules: z.array(ApprovalRule).default([]),
  // Opt-in: start each run in the Claude Agent SDK's plan mode
  // (`permissionMode: "plan"`) — the agent must propose a plan and call
  // ExitPlanMode before making any edits; that call is intercepted and raised
  // as a `plan` HITL the operator approves (or rejects/modifies) before any
  // writes happen. Off by default — most tasks are small enough that the
  // end-of-run diff review is sufficient; this is for higher-stakes work where
  // a human wants to see the approach BEFORE anything changes. Only the Claude
  // runner acts on it today.
  planModeGate: z.boolean().default(false),
  // A project binds to a repository one of two ways (they can coexist):
  //  • repoPath — an absolute local folder the runs work in. When it contains
  //    a .git, `gitBacked` is set and Skynet auto-manages a worktree per agent
  //    + the merge queue against THAT repo. This is the desktop-first default.
  //  • repo — a connected GitHub repository "owner/repo" the branches are pushed
  //    to (PR flow). Optional; used for the cloud/publish path.
  repoPath: z.string().nullable().default(null),
  gitBacked: z.boolean().default(false),
  repo: z.string().optional(),
  // The branch this project's runs cut from, sync to, and open PRs against. null
  // → the server-global default (SKYNET_BASE_BRANCH, usually "main"). Set it to a
  // feature branch to STACK a project's work onto that branch instead of main —
  // every run branches off it and its PRs target it.
  baseBranch: z.string().nullable().default(null),
  // Free-form markdown that rides EVERY agent prompt on this project — the
  // "house rules" for this codebase (which packages to use, code structure,
  // conventions the agent should follow). Steward also sees it in its
  // grounding. Nullable = no rules set; equivalent to today's behavior.
  //
  // Repo-file convention: when set, this is Skynet's copy of what would
  // otherwise live in `.skynet/instructions.md` at the repo root. A future
  // "sync to repo" toggle can push this back to a committed file so a
  // vendor-neutral rule set travels with the codebase; for now it's stored
  // on the project record for instant editability without a commit.
  instructions: z.string().nullable().default(null),
  // Which stored GitHub credential this project's git operations (clone / push /
  // PR / repo listing) authenticate with — a secret-store credential id of a
  // `github` PAT. null → the workspace's default GitHub connection. Lets one
  // workspace keep work repos on the business account and personal repos on a
  // personal account (separate billing + storage).
  githubCredentialId: z.string().nullable().default(null),
  // Which provider keys this project may run agents on — a list of secret-store
  // credential ids (a runner's effective id is `credentialId ?? provider`, so a
  // provider's default key is the provider id itself). Assignment to this project
  // is confined to fleet runners whose key is in this set, and a project-scoped
  // MCP token may only create runners with these keys. EMPTY = every key in the
  // workspace (the default — unchanged behavior); a non-empty list confines it.
  enabledRunnerCredentialIds: z.array(z.string()).default([]),
  // Opt-in: write task status changes back to their imported source of truth
  // (e.g. close/comment the GitHub issue on done). Outward-facing, so off by
  // default. See docs/task-source-sync.md.
  syncSourceStatus: z.boolean().default(false),
});
export type Project = z.infer<typeof Project>;

// Provenance for a task imported from an external source of truth, so Skynet can
// write status changes BACK to it (see docs/task-source-sync.md). Set at import;
// carried for the task's life. `syncedAt`/`sourceRev` reserve a future two-way sync.
export const TaskSource = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("github_issue"), repo: z.string(), number: z.number().int(), url: z.string().default("") }),
  z.object({ kind: z.literal("repo_file"), path: z.string(), anchor: z.string().default("") }), // Phase 2
  z.object({ kind: z.literal("external"), system: z.string(), id: z.string(), url: z.string().default("") }), // Phase 3
]);
export type TaskSource = z.infer<typeof TaskSource>;

// One quality concern from the task linter v0 (see Task.lint below).
export const TaskLintConcern = z.object({
  kind: z.enum(["vague", "multi-module", "no-done-definition"]),
  note: z.string(),
});
export type TaskLintConcern = z.infer<typeof TaskLintConcern>;

export const Task = z.object({
  id: z.string(),
  workspaceId: z.string(),
  projectId: z.string(),
  text: z.string(), // the short task NAME (kept concise for the board/subway)
  // Optional longer detail — the full brief the agent gets, but not shown as the
  // name. Keeps names scannable while allowing a rich description when needed.
  description: z.string().nullable().default(null),
  state: TaskState,
  runId: z.string().nullable().default(null),
  // Marked for autonomous pickup: when true and an agent is idle, the autonomy
  // loop starts this task (todo → ongoing) without a human. Off = waits for a
  // human "Start now".
  autoPick: z.boolean().default(false),
  // Short agent-written assessment produced during autonomous triage
  // (backlog → triage): clarity / rough effort / risks. Doubles as the
  // structured card's SUMMARY line for a task triaged after the fields below
  // were added, and as the whole read-out (rendered as one paragraph) for an
  // older task triaged before — never fabricated for a legacy task, so a
  // missing `assessmentEffort` there is just "not part of this task's shape",
  // not an error.
  assessment: z.string().nullable().default(null),
  // Structured triage read-out (v1.5 "Structured triage card") — additive
  // siblings of `assessment` above, so an older task keeps rendering fine via
  // its free-text `assessment` alone (`.nullable().default(null)` / `[]`
  // means a legacy record with neither field still parses). Parsed the same
  // defensive, field-based way as the auto-review verdict (never regex/
  // keyword-classify free text) — see `splitEstMinutesTag` in orchestrator.ts.
  assessmentEffort: z.enum(["small", "medium", "large"]).nullable().default(null),
  assessmentRisks: z.array(z.string()).default([]),
  // Task linter v0 (assistive) — cheap quality hints computed in the
  // background right after the task is created or its text/description is
  // edited (see apps/server/src/task-linter.ts). NEVER blocks creation or
  // edits, and NEVER auto-splits a task: `concerns` is a dismissible hint the
  // operator can act on or ignore. Empty `concerns` = the linter ran and found
  // nothing worth flagging (or its reply was unreadable — same "nothing to
  // report" outcome, never a thrown error). `null` = not linted yet for the
  // CURRENT text (freshly created, or the text/description just changed).
  lint: z
    .object({
      concerns: z.array(TaskLintConcern),
      at: Timestamp,
      dismissed: z.boolean().default(false),
    })
    .nullable()
    .default(null),
  // Auto-review verdict left by an agent on a review-state task. ALWAYS
  // recorded once an agent has looked at the run — approve OR flag — so a
  // human can audit what the reviewer thought regardless of whether the
  // merge went through. When `decision === "flag"`, the task stays in
  // `review` and the reason is the "flagged for you" note.
  reviewVerdict: z
    .object({
      decision: z.enum(["approve", "flag"]),
      reason: z.string(),
      by: z.string(), // reviewer agent name (or id, as a fallback)
      at: Timestamp,
    })
    .nullable()
    .default(null),
  // Agent eligibility — who may take this task (see TaskAssignment). Defaults to
  // `unassigned`; a task must carry `any`/`agents` before it can leave `backlog`.
  assignment: TaskAssignment.default({ mode: "unassigned", agentIds: [] }),
  // Manual backlog priority — lower sorts higher (top = next up). Operators
  // promote/demote to reorder; unset sorts as 0 (legacy tasks / pre-ordering).
  order: z.number().int().optional(),
  // Soft-hide flag, mirroring `TaskRun.archived`: an archived task is kept in the
  // store (recoverable) but hidden from the board and the assistant's grounding
  // context. Reversible — un-archive restores it. Never a hard delete.
  archived: z.boolean().default(false),
  // ── Scheduling (see docs/scheduling.md) ─────────────────────────────────
  // How long we EXPECT this task to take, in ms. Produced by the autonomous
  // triage step (LLM estimate from the task text + description) OR set by the
  // operator via Steward / the UI. Nullable = we haven't estimated it.
  estimatedDurationMs: z.number().int().positive().nullable().default(null),
  // Operator-set start time (when the task should begin). Optional — many
  // tasks never get scheduled, they just flow through the board. When both
  // `plannedStartAt` and `estimatedDurationMs` are set, the timeline can
  // render a scheduled bar (start + duration → end).
  plannedStartAt: Timestamp.nullable().default(null),
  // ── Grouping & roadmap ──────────────────────────────────────────────────
  // Optional Feature the task rolls up into. Features let a project view
  // "what capabilities are being worked on" one level above the task board.
  // See Feature below. Null = the task doesn't belong to any feature.
  featureId: z.string().nullable().default(null),
  // Optional direct milestone assignment. Usually the milestone flows through
  // the Feature (Feature.milestoneId); this field is for orphan tasks that
  // don't sit under a feature but still need to appear on the roadmap.
  milestoneId: z.string().nullable().default(null),
  // Where this task was imported from (GitHub issue / repo file / tracker), so a
  // status change can be written back to it. null → a native Skynet task.
  source: TaskSource.nullable().default(null),
  // Operator-saved provider/model preference for auto-pick — set via the Start
  // picker. Null (the default) leaves acquisition exactly as it's always been:
  // the first idle, usable runner in fleet order. When set, acquireAgent tries
  // an idle runner on this provider (preferring an exact model match too)
  // BEFORE falling back to that same default order — never a hard requirement,
  // since a preference with no matching idle runner shouldn't block the task.
  preferredProvider: ProviderId.nullable().default(null),
  preferredModel: z.string().nullable().default(null),
});
export type Task = z.infer<typeof Task>;

// ─── Feature: task grouping ──────────────────────────────────────────────
// A named capability that groups related tasks. One-per-project entity so
// operators can see "what's being worked on" above the task grain, and so
// tasks can inherit a roadmap milestone via the feature.
export const FeatureStatus = z.enum(["active", "paused", "shipped"]);
export type FeatureStatus = z.infer<typeof FeatureStatus>;

export const Feature = z.object({
  id: z.string(),
  workspaceId: z.string(),
  projectId: z.string(),
  name: z.string(),
  description: z.string().nullable().default(null),
  status: FeatureStatus.default("active"),
  // Milestone this feature rolls up into (see Milestone below). Tasks under
  // the feature inherit this — that's the roadmap linkage.
  milestoneId: z.string().nullable().default(null),
  // Manual order within the project (lower = higher). Unset sorts as 0.
  order: z.number().int().optional(),
  archived: z.boolean().default(false),
  createdAt: Timestamp,
});
export type Feature = z.infer<typeof Feature>;

// ─── Milestone: roadmap grouping ─────────────────────────────────────────
// A planned release / checkpoint / target-date bucket. Per-project (matches
// Feature scoping). Features and tasks reference a milestone; the project's
// roadmap view is derived by grouping features + orphan tasks under their
// milestone and sorting by `targetAt`.
export const MilestoneStatus = z.enum(["planned", "in-progress", "shipped"]);
export type MilestoneStatus = z.infer<typeof MilestoneStatus>;

export const Milestone = z.object({
  id: z.string(),
  workspaceId: z.string(),
  projectId: z.string(),
  name: z.string(),
  description: z.string().nullable().default(null),
  // Planned delivery moment (epoch ms). Null = no committed date yet.
  targetAt: Timestamp.nullable().default(null),
  status: MilestoneStatus.default("planned"),
  order: z.number().int().optional(),
  archived: z.boolean().default(false),
  createdAt: Timestamp,
});
export type Milestone = z.infer<typeof Milestone>;

// ─── HITL item & resolution ───────────────────────────────────────────────

// Agent-authored explanation of its own diff — drafted once, grounded on the
// real patch, before the diff HITL is raised (see Orchestrator.raiseDiffReview
// / draftDiffWalkthrough). Null when the draft failed or the provider doesn't
// support `consult` — the review always proceeds on the raw diff either way.
export const DiffWalkthroughComment = z.object({
  file: z.string(),
  line: z.number().int().positive().nullable().default(null), // null → file-level note
  note: z.string(),
});
export type DiffWalkthroughComment = z.infer<typeof DiffWalkthroughComment>;

export const DiffWalkthrough = z.object({
  summary: z.string(),
  comments: z.array(DiffWalkthroughComment).default([]),
});
export type DiffWalkthrough = z.infer<typeof DiffWalkthrough>;

export const DiffSummary = z.object({
  add: z.number().int().nonnegative(),
  del: z.number().int().nonnegative(),
  modules: z.array(z.string()), // module ids — never a raw patch
  // The changed file paths, so a reviewer (esp. on Telegram) sees WHAT changed
  // without opening the full diff. Optional/defaulted so the empty-diff merge
  // gates that carry no file list stay valid.
  files: z.array(z.string()).default([]),
  walkthrough: DiffWalkthrough.nullable().default(null),
});
export type DiffSummary = z.infer<typeof DiffSummary>;

// "reassign" resolves an escalation by handing the run to a different runner.
export const ResolveAction = z.enum(["approve", "reject", "modify", "option", "reassign"]);
export type ResolveAction = z.infer<typeof ResolveAction>;

export const Resolution = z.object({
  action: ResolveAction,
  optionIndex: z.number().int().nullable().default(null), // for 'option'
  guidance: z.string().nullable().default(null), // for 'modify'
  // Approve-with-memory (roadmap: "the Inbox becomes how policy/memory get
  // authored") — an operator's own words on a durable project/workspace
  // preference this decision suggests, captured in-flow alongside 'approve'.
  // Distinct from the command-specific "Always allow" rule (see ApprovalRule
  // above): this applies to any gate kind, not just exact commands, and isn't
  // an auto-approval — it's a fact for Memory v0 to adopt as a write path once
  // it lands (ROADMAP.md "Memory v0"). Until then this is plumbing only:
  // persisted on the resolution + audit trail so the intent isn't lost, but
  // nothing reads it back or injects it into a runner yet.
  memoryNote: z.string().nullable().default(null),
  by: z.string(), // operator id — audit trail
  at: Timestamp,
});
export type Resolution = z.infer<typeof Resolution>;

export const HitlItem = z.object({
  id: z.string(),
  workspaceId: z.string(),
  runId: z.string(),
  kind: HitlKind,
  title: z.string(),
  why: z.string(),
  risk: Risk,
  raisedAt: Timestamp, // UI derives "waited" from this
  // When set, an unanswered `question` auto-resolves at this time (no-operator
  // timeout) so a headless/idle run doesn't hang waiting on a human. Null = no
  // deadline (interactive default). See SKYNET_HITL_QUESTION_TIMEOUT_MS.
  expiresAt: Timestamp.nullable().default(null),
  resolvedAt: Timestamp.nullable().default(null),
  resolution: Resolution.nullable().default(null),
  // The agent's OWN stated reasoning/intent for this action — its words, not the
  // system's — so the operator can see WHY the agent wants it, not just what it is.
  // Distinct from `why` (the system's impact/risk framing). Null when unavailable.
  rationale: z.string().nullable().default(null),
  // kind-specific payload (only the relevant field is populated):
  command: z.string().nullable().default(null), // approval
  options: z.array(z.string()).nullable().default(null), // question
  recommended: z.number().int().nullable().default(null), // question — index
  steps: z.array(z.string()).nullable().default(null), // plan
  diff: DiffSummary.nullable().default(null), // diff
  // System-computed, scannable chips for the decision: the safety classifier's
  // risk reasons (approval) or the conflicting files (merge). Not runner-supplied.
  flags: z.array(z.string()).default([]),
});
export type HitlItem = z.infer<typeof HitlItem>;

// ─── Fleet runner · Module · Dependency · Provider catalog ──────────────────

export const Agent = z.object({
  id: z.string(),
  workspaceId: z.string(),
  name: z.string(),
  provider: ProviderId,
  // Which named credential this agent authenticates with. null → the provider's
  // default credential (id === provider), i.e. the historical single-key path.
  credentialId: z.string().nullable().default(null),
  model: z.string(),
  status: AgentStatus,
  idleSince: Timestamp.nullable().default(null),
  // Optional operator-set label used to group the fleet BEYOND provider — a
  // free-form bucket ("reviewers", "frontend", "backend team") the fleet view
  // groups cards under. Null/"" → the "Ungrouped" bucket (the default; unchanged
  // behavior for existing agents). Purely organizational; never affects routing.
  label: z.string().nullable().default(null),
  // True when the fleet CREATED this runner on demand (auto-scale or fork/retry
  // provisioning) rather than an operator adding it. Such runners are the only
  // ones the idle reaper auto-retires (see retireIdleRunnersAfterMinutes).
  autoProvisioned: z.boolean().default(false),
  // May this agent perform autonomous reviews of OTHER agents' finished runs?
  // Default true = every agent is an eligible reviewer. An agent NEVER reviews
  // its own work regardless of this flag (the autonomy loop excludes the run's
  // own agent) — this only narrows the reviewer pool further. Off = never picked
  // as a reviewer (it still does its own tasks).
  canReview: z.boolean().default(true),
});
export type Agent = z.infer<typeof Agent>;

export const Module = z.object({
  id: z.string(), // e.g. 'api/billing'
  name: z.string(), // e.g. 'Billing'
});
export type Module = z.infer<typeof Module>;

export const Dependency = z.object({
  fromAgentId: z.string(), // upstream — must finish first
  toAgentId: z.string(), // downstream — gated on upstream
});
export type Dependency = z.infer<typeof Dependency>;

/** A persisted HITL decision — the audit trail (Backend Brief §11). Served by W8. */
export const AuditRecord = z.object({
  workspaceId: z.string(),
  hitlId: z.string(),
  runId: z.string(),
  action: z.string(),
  operatorId: z.string(),
  at: Timestamp,
  payload: z.unknown(),
  // Soft-hide flag, mirroring `TaskRun.archived`: an archived decision is kept in
  // the trail but tucked into the view's Archived section. Optional for
  // back-compat with records persisted before this field existed (treat
  // undefined as not-archived).
  archived: z.boolean().optional(),
});
export type AuditRecord = z.infer<typeof AuditRecord>;

/** Provider catalog entry — drives glyphs, colors, and the model dropdown. */
// What a provider needs before it can run — surfaced in the UI (Settings +
// create-agent) so an operator knows whether it wants a CLI on PATH, a login,
// and/or which credential. Static per provider; assembled server-side.
export const ProviderRequirements = z.object({
  // "sdk" runs in-process (no external binary); "cli" spawns a vendor binary.
  runtime: z.enum(["sdk", "cli"]),
  // The CLI binary name (cli runtime only), else null.
  bin: z.string().nullable().default(null),
  // Credential env vars that authenticate it, most-preferred first (may be empty
  // for a pure CLI-login provider).
  authEnvVars: z.array(z.string()).default([]),
  // True when it can authenticate via its own CLI login instead of a key/token.
  cliLogin: z.boolean().default(false),
  // One-line "how to install / set up" hint, and a docs link if we have one.
  installHint: z.string().nullable().default(null),
  docsUrl: z.string().nullable().default(null),
  // Structured install: when set, the UI can offer a one-click "Install CLI"
  // button that runs this exact command server-side and streams the output.
  // Only set for providers whose install is scriptable (`npm i -g <pkg>`); brew,
  // sign-in-required, or manual installs stay null and rely on `installHint` +
  // `docsUrl`. This is what the CLI-installer feature reads to decide whether
  // to expose the button.
  install: z
    .object({
      // Package manager the command uses. Today only "npm" is auto-installable
      // by the server; others are declarative for UI copy / future support.
      packageManager: z.enum(["npm", "brew", "pip", "manual"]),
      // The EXACT command the server will spawn (no shell interpolation). A
      // fixed constant, never user-derived — the UI displays it verbatim before
      // running so the operator sees what's about to happen.
      command: z.string(),
    })
    .nullable()
    .default(null),
});
export type ProviderRequirements = z.infer<typeof ProviderRequirements>;

export const ProviderInfo = z.object({
  id: ProviderId,
  name: z.string(),
  glyph: z.string(),
  color: z.string(),
  models: z.array(z.string()),
  // Whether a credential is configured server-side. Undefined = treat as
  // available (back-compat); the create-agent UI disables providers set to false.
  available: z.boolean().optional(),
  // What it needs to run (static descriptor). Optional for back-compat.
  requirements: ProviderRequirements.optional(),
  // Live detection: is the required CLI binary on the server's PATH? null = not
  // applicable (in-process SDK provider); undefined = not probed.
  binOnPath: z.boolean().nullable().optional(),
});
export type ProviderInfo = z.infer<typeof ProviderInfo>;

// ─── API request bodies ─────────────────────────────────────────────────────

export const ResolveRequest = z.object({
  action: ResolveAction,
  optionIndex: z.number().int().optional(),
  guidance: z.string().optional(),
  // Approve-and-remember: on an `approve` of a command gate, add a standing
  // "approve always" rule for this exact command to the project (only honored for
  // rememberable — low/medium, non-deny — commands). Ignored otherwise.
  remember: z.boolean().optional(),
  // Approve-with-memory — see Resolution.memoryNote. Only honored on `approve`.
  memoryNote: z.string().optional(),
});
export type ResolveRequest = z.infer<typeof ResolveRequest>;

export const ChatRequest = z.object({ text: z.string().min(1) });

// ─── Ready-to-merge actions ──────────────────────────────────────────────────
/** Merge an open PR from the ready list. `method` = the GitHub merge strategy. */
export const MergePrRequest = z.object({
  method: z.enum(["merge", "squash", "rebase"]).default("squash"),
});
export type MergePrRequest = z.infer<typeof MergePrRequest>;

/** Send a ready PR back for changes: optionally comment on the PR, and resume
 *  the agent with `guidance` to revise (new commits push to the same branch). */
export const ReworkPrRequest = z.object({
  guidance: z.string().min(1),
  comment: z.string().optional(), // also posted on the PR (audit trail) when set
});
export type ReworkPrRequest = z.infer<typeof ReworkPrRequest>;
export type ChatRequest = z.infer<typeof ChatRequest>;

// Ask Skynet to create a brand-new GitHub repo at project-creation time, then
// bind the project to it. `owner` is the authenticated user's login or one of
// their org logins (defaults to the user). GitHub repo names allow letters,
// digits, `.`, `-`, `_`.
export const CreateRepoSpec = z.object({
  name: z.string().min(1).max(100).regex(/^[A-Za-z0-9._-]+$/, "letters, digits, . - _ only"),
  private: z.boolean().default(true),
  owner: z.string().optional(),
});
export type CreateRepoSpec = z.infer<typeof CreateRepoSpec>;

export const CreateProjectRequest = z.object({
  name: z.string().min(1),
  goal: z.string().default(""),
  repoPath: z.string().optional(), // absolute path to a local folder to work in
  repo: z.string().optional(), // or bind to one connected GitHub repo at creation ("owner/repo")
  repoUrl: z.string().optional(), // or paste an existing repo's git URL to clone (normalized to "owner/repo")
  createRepo: CreateRepoSpec.optional(), // or have Skynet create a new repo and bind it
  githubCredentialId: z.string().nullable().optional(), // which GitHub account to use (null/omit → default)
  // Governance chosen at creation. Omitted → the server defaults apply (autonomy
  // on; approvalLevel from SKYNET_APPROVAL_LEVEL). Both remain editable later.
  autonomy: z.boolean().optional(),
  approvalLevel: ApprovalLevel.optional(),
  // Project-scoped agent guidance that rides every prompt (see Project.instructions).
  instructions: z.string().optional(),
  baseBranch: z.string().optional(), // branch to stack runs/PRs onto (omit → global default)
  // Import the repo's open GitHub issues as backlog tasks right after creation,
  // and turn on ongoing write-back (Project.syncSourceStatus) so later task
  // transitions comment/close/reopen the issue. No-op for a non-repo-bound
  // project. Defaults to on in the UI when a repo is bound; best-effort —
  // failure doesn't fail project creation. See docs/task-source-sync.md.
  importGithubIssues: z.boolean().optional(),
});
export type CreateProjectRequest = z.infer<typeof CreateProjectRequest>;

// A GitHub account a new repo can be created under: the authenticated user, or
// an org they belong to. Used to populate the "New repo" owner picker.
export const GithubOwner = z.object({
  login: z.string(),
  type: z.enum(["user", "org"]),
});
export type GithubOwner = z.infer<typeof GithubOwner>;

export const UpdateProjectRequest = z.object({
  name: z.string().min(1).optional(),
  goal: z.string().optional(),
  status: ProjectStatus.optional(),
  autonomy: z.boolean().optional(),
  approvalLevel: ApprovalLevel.optional(),
  planModeGate: z.boolean().optional(), // see Project.planModeGate
  repoPath: z.string().nullable().optional(),
  repo: z.string().optional(),
  // Project-scoped agent guidance. `null` clears the field back to "no rules".
  instructions: z.string().nullable().optional(),
  githubCredentialId: z.string().nullable().optional(), // pick the GitHub account (null clears → default)
  baseBranch: z.string().nullable().optional(), // stack onto a branch; null clears → global default

  // Which provider keys the project may run on (secret-store credential ids;
  // empty = all keys). See Project.enabledRunnerCredentialIds.
  enabledRunnerCredentialIds: z.array(z.string()).optional(),
  syncSourceStatus: z.boolean().optional(), // write status changes back to the source of truth
});
export type UpdateProjectRequest = z.infer<typeof UpdateProjectRequest>;

export const CreateTaskRequest = z.object({
  text: z.string().min(1),
  description: z.string().optional(),
  source: TaskSource.optional(), // set when importing from a source of truth
});
export type CreateTaskRequest = z.infer<typeof CreateTaskRequest>;

// Editing a task edits its text / auto-pick flag only. State changes go through
// the guarded move endpoint (MoveTaskRequest) so illegal transitions are rejected.
export const UpdateTaskRequest = z.object({
  text: z.string().min(1).optional(),
  description: z.string().nullable().optional(),
  autoPick: z.boolean().optional(),
  // Set/clear agent eligibility. `unassigned` is only accepted while the task is
  // still in backlog (the server enforces the leaving-backlog gate).
  assignment: TaskAssignment.optional(),
  // Scheduling: set or clear (null) the LLM/operator estimate + planned start.
  estimatedDurationMs: z.number().int().positive().nullable().optional(),
  plannedStartAt: Timestamp.nullable().optional(),
  // Grouping / roadmap linkage. Null clears the assignment. Server enforces
  // that the referenced feature/milestone belongs to the same project.
  featureId: z.string().nullable().optional(),
  milestoneId: z.string().nullable().optional(),
  // Saved provider/model preference for auto-pick (see Task.preferredProvider).
  // Null clears it back to plain auto-pick.
  preferredProvider: ProviderId.nullable().optional(),
  preferredModel: z.string().nullable().optional(),
});
export type UpdateTaskRequest = z.infer<typeof UpdateTaskRequest>;

// ─── Feature CRUD requests ──────────────────────────────────────────────
export const CreateFeatureRequest = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  milestoneId: z.string().nullable().optional(),
});
export type CreateFeatureRequest = z.infer<typeof CreateFeatureRequest>;

export const UpdateFeatureRequest = z.object({
  name: z.string().min(1).optional(),
  description: z.string().nullable().optional(),
  status: FeatureStatus.optional(),
  milestoneId: z.string().nullable().optional(),
  archived: z.boolean().optional(),
});
export type UpdateFeatureRequest = z.infer<typeof UpdateFeatureRequest>;

// ─── Milestone CRUD requests ───────────────────────────────────────────
export const CreateMilestoneRequest = z.object({
  name: z.string().min(1),
  description: z.string().optional(),
  targetAt: Timestamp.nullable().optional(),
});
export type CreateMilestoneRequest = z.infer<typeof CreateMilestoneRequest>;

export const UpdateMilestoneRequest = z.object({
  name: z.string().min(1).optional(),
  description: z.string().nullable().optional(),
  targetAt: Timestamp.nullable().optional(),
  status: MilestoneStatus.optional(),
  archived: z.boolean().optional(),
});
export type UpdateMilestoneRequest = z.infer<typeof UpdateMilestoneRequest>;

// ─── Roadmap doc requests ──────────────────────────────────────────────
// Commit a Steward-drafted edit to a project's ROADMAP.md — only reachable
// after the operator confirms the diff in chat. `baselineHash` (always) and
// `baselineSha` (GitHub-bound projects only) pin the edit to the exact content
// it was drafted against, so a concurrent change is refused, not clobbered.
export const UpdateProjectRoadmapRequest = z.object({
  path: z.enum(["ROADMAP.md", "docs/ROADMAP.md"]),
  content: z.string().min(1),
  baselineHash: z.string().min(1),
  baselineSha: z.string().optional(),
});
export type UpdateProjectRoadmapRequest = z.infer<typeof UpdateProjectRoadmapRequest>;

// A human-initiated kanban move; the server validates it against the allowed
// (human) transition map before applying.
export const MoveTaskRequest = z.object({ to: TaskState });
export type MoveTaskRequest = z.infer<typeof MoveTaskRequest>;

// Drag-reorder within a lane (the backlog): place the task before `beforeId`, or
// at the end when null. Distinct from the up/down MoveTaskRequest step.
export const ReorderTaskRequest = z.object({ beforeId: z.string().nullable() });
export type ReorderTaskRequest = z.infer<typeof ReorderTaskRequest>;

export const ConfigureRunnerRequest = z.object({
  provider: ProviderId,
  model: z.string().min(1),
  name: z.string().optional(),
  // Which named credential this agent authenticates with. Omit → the provider's
  // default credential (id === provider).
  credentialId: z.string().optional(),
  // Optional grouping label (see Agent.label). Omit → ungrouped.
  label: z.string().nullable().optional(),
});
export type ConfigureRunnerRequest = z.infer<typeof ConfigureRunnerRequest>;

export const UpdateRunnerRequest = z.object({
  model: z.string().min(1).optional(),
  name: z.string().optional(),
  canReview: z.boolean().optional(), // toggle reviewer-eligibility (see Agent.canReview)
  // Set/clear the grouping label (see Agent.label). null clears → ungrouped.
  label: z.string().nullable().optional(),
});
export type UpdateRunnerRequest = z.infer<typeof UpdateRunnerRequest>;

// ─── Secrets (per-workspace provider credentials) ──────────────────────────
// The raw key is write-only — it is never returned over the wire. The UI only
// ever sees this metadata (which provider has a key, and a last-4 fingerprint
// so an operator can confirm which key is stored).

// A named provider CREDENTIAL — a key + a display name for a given provider. A
// provider can have several (e.g. "Claude — personal" and "Claude for Business"),
// each with its own key; agents are built from one. `id` is the credential id an
// agent references (Agent.credentialId). The DEFAULT credential per provider has
// `id === provider` and `isDefault: true` — that's the historical single key, so
// existing keys and agents keep working with no migration.
export const SecretMeta = z.object({
  id: z.string().default(""), // credential id (defaults to the provider for legacy rows)
  name: z.string().default(""), // display name ("" → provider's catalog name)
  workspaceId: z.string(),
  provider: CredentialProvider,
  isDefault: z.boolean().default(false),
  last4: z.string(), // last 4 chars of the key — for recognition, not reuse
  updatedAt: Timestamp,
  updatedBy: z.string(), // operator id — audit trail
});
export type SecretMeta = z.infer<typeof SecretMeta>;

/** Body for setting/rotating a credential's key. */
export const SetSecretRequest = z.object({
  apiKey: z.string().min(1),
});
export type SetSecretRequest = z.infer<typeof SetSecretRequest>;

/** Body for creating a NAMED credential (a "duplicate" of a provider, or a
 *  secondary GitHub account PAT). */
export const CreateCredentialRequest = z.object({
  provider: CredentialProvider,
  name: z.string().min(1).max(60),
  apiKey: z.string().min(1),
});
export type CreateCredentialRequest = z.infer<typeof CreateCredentialRequest>;

/** Result of a live verify against the vendor (or its CLI-auth account
 *  endpoint) — a real, cheap call confirming the key actually authenticates.
 *  Never gates the save; the UI shows this as feedback after the fact. */
export const VerifyCredentialResult = z.object({
  ok: z.boolean(),
  message: z.string().optional(),
});
export type VerifyCredentialResult = z.infer<typeof VerifyCredentialResult>;

// ─── GitHub integration ─────────────────────────────────────────────────────
// A workspace connects via a GitHub *App* installation (least-privilege,
// short-lived installation tokens, PR-first). The connection record below is
// non-sensitive metadata — the App private key lives server-side only, never
// per-workspace. See docs/github-integration.md for the full contract.

/** Safety guardrails, enforced server-side before any write reaches GitHub. */
export const SafetyPolicy = z.object({
  prOnly: z.boolean().default(true), // never push to the default branch directly
  noForcePush: z.boolean().default(true), // block force-push / history rewrite
  moduleAllowlist: z.boolean().default(true), // only touch the agent's assigned modules
  approveBeforePush: z.boolean().default(true), // HITL gate before push/merge
});
export type SafetyPolicy = z.infer<typeof SafetyPolicy>;

/** Every guardrail on — the default posture for a new connection. */
export const SAFETY_DEFAULTS: SafetyPolicy = {
  prOnly: true,
  noForcePush: true,
  moduleAllowlist: true,
  approveBeforePush: true,
};

export const GithubInstallation = z.object({
  id: z.number().int(), // GitHub installation id
  account: z.string(), // org or user login the app is installed on
  type: z.enum(["Organization", "User"]),
  appSlug: z.string(),
});
export type GithubInstallation = z.infer<typeof GithubInstallation>;

export const GithubRepo = z.object({
  id: z.number().int(),
  name: z.string(), // "owner/repo"
  defaultBranch: z.string(),
  private: z.boolean(),
  selected: z.boolean().default(true), // included in the installation's selection
});
export type GithubRepo = z.infer<typeof GithubRepo>;

/** How the connection authenticates to GitHub. `app` = GitHub App installation
 *  (least-privilege, server-minted tokens); `pat` = a personal access token the
 *  user supplied (stored encrypted server-side; used directly as the git token —
 *  the local/desktop path that needs no cloud). */
export const GithubAuthMode = z.enum(["app", "pat"]);
export type GithubAuthMode = z.infer<typeof GithubAuthMode>;

/** A workspace's GitHub connection — auth mode + selected repos + policy.
 *  Non-secret: a PAT's plaintext never lands here (only its last4); the
 *  ciphertext lives in the server-side token store. */
export const GithubConnection = z.object({
  workspaceId: z.string(),
  connected: z.boolean(),
  auth: GithubAuthMode.default("app"),
  installation: GithubInstallation.nullable().default(null), // app mode
  tokenLast4: z.string().nullable().default(null), // pat mode — for recognition
  repos: z.array(GithubRepo).default([]),
  safety: SafetyPolicy,
});
export type GithubConnection = z.infer<typeof GithubConnection>;

// ─── Workspace settings (live, per-workspace policy + identity) ─────────────
// Non-secret operator settings that govern the workspace at runtime (no engine
// restart). Persisted as a workspace-keyed singleton, mirroring GithubConnection.
export const WorkspaceSettings = z.object({
  workspaceId: z.string(),
  // Display name (sidebar/shell header). Server-side, not localStorage — a
  // workspace is the auth principal, not a per-browser setting, so the name
  // must be the same on every profile/machine that signs into it.
  name: z.string().default(""),
  // When on, assigning a task with no free runner AUTO-PROVISIONS a fresh runner
  // (cloned from a busy one already on an allowed key) instead of waiting — up to
  // `maxRunners`. Off = today's behavior (the task waits for a runner to free).
  autoProvisionRunners: z.boolean().default(false),
  // Hard ceiling on total fleet size, enforced on every creation path (auto-scale,
  // fork/retry provisioning, and explicit configure). Defaults to 100 — a sane
  // upper bound rather than unbounded; set 0 to explicitly remove the cap. The
  // safety valve that keeps auto-creation from running away.
  maxRunners: z.number().int().min(0).default(100),
  // Auto-decommission: retire a SYSTEM-provisioned runner (one auto-scale/fork
  // created) once it has sat idle this many minutes, so auto-scaled capacity is
  // reclaimed instead of accumulating. Operator-added runners are never touched.
  // 0 = never auto-retire. Default 30.
  retireIdleRunnersAfterMinutes: z.number().int().min(0).default(30),
  // Opt-in: equip Claude runners with a real browser (a Playwright/Chrome MCP
  // server) so an agent can drive a browser inside a coding task — reproduce a
  // bug, verify a UI change end-to-end, read live docs. Off by default; when on,
  // every browser action (navigate/click/…) still rides the normal HITL approval
  // gate like any other non-read tool. Claude runners only for now.
  browserTools: z.boolean().default(false),
});
export type WorkspaceSettings = z.infer<typeof WorkspaceSettings>;

/** Patch for the live workspace settings (all fields optional). */
export const UpdateWorkspaceSettingsRequest = z.object({
  name: z.string().optional(),
  autoProvisionRunners: z.boolean().optional(),
  maxRunners: z.number().int().min(0).optional(),
  retireIdleRunnersAfterMinutes: z.number().int().min(0).optional(),
  browserTools: z.boolean().optional(),
});
export type UpdateWorkspaceSettingsRequest = z.infer<typeof UpdateWorkspaceSettingsRequest>;

/** Body to record/refresh an installation after the App is installed on GitHub. */
export const ConnectGithubRequest = z.object({
  installation: GithubInstallation,
  repos: z.array(GithubRepo).default([]),
});
export type ConnectGithubRequest = z.infer<typeof ConnectGithubRequest>;

/** Body to connect via a personal access token (the local/desktop path). The
 *  token is validated, sealed, and stored server-side — never returned. */
export const ConnectPatRequest = z.object({
  token: z.string().min(1),
  repos: z.array(GithubRepo).default([]),
});
export type ConnectPatRequest = z.infer<typeof ConnectPatRequest>;

/** Partial update to the safety policy — any subset of guardrails. */
export const UpdateSafetyRequest = SafetyPolicy.partial();
export type UpdateSafetyRequest = z.infer<typeof UpdateSafetyRequest>;
