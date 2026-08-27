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
  "opencode",
]);
export type ProviderId = z.infer<typeof ProviderId>;

// A credential in the secret store belongs to a fleet provider OR to "github" — a
// GitHub PAT, so a project can be pinned to a specific GitHub account (business vs
// personal billing/storage) — or to "fly", a Fly.io API token so a project can
// deploy to a persistent, shareable Fly app. Neither `github` nor `fly` is a fleet
// provider: they never appear in the runner catalog or provider-availability, only
// as a stored credential a project's git ops / Fly deploys authenticate with.
export const CredentialProvider = z.union([ProviderId, z.literal("github"), z.literal("fly")]);
export type CredentialProvider = z.infer<typeof CredentialProvider>;

export const TaskRunStatus = z.enum(["running", "waiting", "paused", "review", "done"]);
export type TaskRunStatus = z.infer<typeof TaskRunStatus>;

export const PlanStepState = z.enum(["done", "now", "todo"]);
export type PlanStepState = z.infer<typeof PlanStepState>;

// "escalation" = a run has HALTED and needs a human — the agent gave up (tried
// enough / fundamentally blocked), or the system tripped a guard (too long, too
// many failures). Distinct from "question" (which resumes on an answer): the
// human decides whether to help & resume, reassign, or stop.
// "verifier" = the project's check command failed AFTER a diff/merge gate was
// already approved and the merge itself succeeded — the merge commit is undone
// (MergeEngine.process's bounce) pending this decision: approve retries the
// merge+check, reject/modify bounces the agent to revise with the check output.
export const HitlKind = z.enum(["approval", "question", "plan", "diff", "merge", "escalation", "verifier"]);
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

// ─── Fly.io deploy (persistent, human-triggered) ──────────────────────────
// A REAL, shareable deployment — distinct from the ephemeral local live preview
// (docs/live-preview.md): it survives independent of the local Skynet process,
// and is never torn down automatically (an operator stops/destroys it
// explicitly). One target deploys a project's integration branch (the
// "overwatch" slice); a second, optional target deploys a single run's branch
// for pre-merge verification — same shape, different git ref. See
// docs/live-preview.md §"Deploy to Fly.io".
export const FlyDeployStatus = z.enum(["idle", "deploying", "live", "failed", "stopped"]);
export type FlyDeployStatus = z.infer<typeof FlyDeployStatus>;

export const FlyDeployment = z.object({
  status: FlyDeployStatus,
  appName: z.string().nullable().default(null),
  region: z.string().nullable().default(null),
  // The real https://<app>.fly.dev URL once live — reachable with no local
  // Skynet process running.
  url: z.string().nullable().default(null),
  branch: z.string().nullable().default(null), // git ref last deployed
  sha: z.string().nullable().default(null), // commit last deployed
  error: z.string().nullable().default(null),
  deployedAt: Timestamp.nullable().default(null),
  deployedBy: z.string().nullable().default(null), // operatorId who triggered it
});
export type FlyDeployment = z.infer<typeof FlyDeployment>;

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

// Feature-level ready-to-merge brief — makes approving a batched multi-task
// feature PR reviewable instead of a rubber stamp (see Orchestrator.
// openPrForFeature / draftFeatureBrief). `tasks`/`spend`/`evidenceSummary` are
// SYSTEM-composed from data already in hand (sibling Task.reviewVerdict +
// TaskRun.usage — see feature-brief.ts's composeFeatureBrief) — never asked
// of the model. `narrative` is the one genuinely new thing: a consult-drafted
// read of what the feature now does AS A WHOLE, grounded on the combined
// feature-branch diff, same stateless discipline as the diff walkthrough /
// merge brief. Null narrative = the draft failed or the provider has no
// `consult` support — the brief (and the PR) are never blocked on it. Only
// ever set on a BATCHED feature PR's briefing; a single-run PR's
// MergeBriefing never carries one (see buildMergeBriefing below).
export const FeatureBriefTask = z.object({
  taskId: z.string(),
  text: z.string(), // Task.text, the one-liner
  verdict: z.enum(["approve", "flag"]).nullable().default(null), // Task.reviewVerdict.decision, when recorded
  reviewedBy: z.string().nullable().default(null), // Task.reviewVerdict.by
});
export type FeatureBriefTask = z.infer<typeof FeatureBriefTask>;

export const FeatureBrief = z.object({
  tasks: z.array(FeatureBriefTask).default([]),
  spend: Usage.nullable().default(null), // sum of every sibling run's Usage; null when none reported any
  // Short lines naming what verified this batch — today, the recorded review
  // verdicts + whether a verifier gate runs after merge; once Task 5/6 (real
  // verifier + adversarial breaker runs) land, their recorded evidence slots
  // in here too. Never fabricated: an empty array means nothing recorded, not
  // "nothing happened".
  evidenceSummary: z.array(z.string()).default([]),
  narrative: z.string().nullable().default(null), // consult-drafted "what this feature now does"
});
export type FeatureBrief = z.infer<typeof FeatureBrief>;

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
 *  carry the AI reviewer's verdict (or a deterministic heuristic when none ran).
 *
 *  `impact`/`rationale`/`summary` stay as prose (the card's headline text), but
 *  everything that prose was SILENTLY BUILT FROM — the diff stat, the matched
 *  modules, which files actually tripped the sensitive-area heuristic, and who
 *  authored vs. who reviewed — is also carried as real fields below, so the UI
 *  can show the evidence instead of asking an operator to trust a one-line
 *  verdict on a change that (per `risk`) may be exactly the kind not to. */
export const MergeBriefing = z.object({
  summary: z.string(), // what changed, one line
  impact: z.string(), // what it touches / who's affected (prose)
  risk: Risk, // low | medium | high
  recommendation: z.enum(["merge", "rework", "hold"]), // the suggested action
  rationale: z.string(), // WHY — the reviewer's words (or the heuristic's reason)
  by: z.string(), // reviewer agent name, or "heuristic"
  // ── structured, so the UI doesn't have to parse prose ──────────────────────
  add: z.number().int().nonnegative().default(0),
  del: z.number().int().nonnegative().default(0),
  filesChanged: z.number().int().nonnegative().default(0),
  modules: z.array(z.string()).default([]), // mapped module ids; [] = "no mapped module"
  // The actual file paths that tripped the sensitive-area heuristic (auth/data/
  // infra) — not just the boolean fact that one did.
  sensitiveFiles: z.array(z.string()).default([]),
  testsChanged: z.boolean().default(false),
  // Fleet agent ids — null when unknown (e.g. a human-authored branch, or a
  // batched feature PR spanning several authors). Distinct fields (rather than
  // reusing `by`) so the UI can show authorship and review as two separate
  // facts and make independence visible, instead of a single ambiguous name.
  authoredBy: z.string().nullable().default(null),
  reviewedBy: z.string().nullable().default(null),
  reviewDecision: z.enum(["approve", "flag"]).nullable().default(null),
  // Feature-batch-only: see FeatureBrief above. Null for every single-run PR's
  // briefing (see buildMergeBriefing) — nullable + defaulted so an older
  // record written before this field existed still parses.
  featureBrief: FeatureBrief.nullable().default(null),
  // A fixed path-policy list (migrations/**, .github/workflows/**, auth/**,
  // dependency manifests) that ALWAYS reads as "a human must look", regardless
  // of size/risk score — see mergeRequiresHumanGlobs in orchestrator.ts.
  // `requiresHumanGlobs` is the evidence (which categories actually matched),
  // not just the boolean. Defaulted so an older record still parses.
  requiresHuman: z.boolean().default(false),
  requiresHumanGlobs: z.array(z.string()).default([]),
});
export type MergeBriefing = z.infer<typeof MergeBriefing>;

/** Live GitHub check-run status for an open PR — fetched on demand (not part of
 *  the polled snapshot; it's a real GitHub API call), so the ready-to-merge
 *  card can show whether CI actually ran and passed BEFORE a human clicks
 *  Merge, not just after GitHub blocks it. `"none"` = no checks configured on
 *  the repo (distinct from a passing/failing verdict — silence isn't success). */
// A single named CI job (e.g. "lint", "typecheck", "test") — the breakdown
// behind the aggregate `checks` verdict below, so a reviewer sees WHICH gate
// failed/is pending, not just that "checks" as a whole are failing.
export const PrCheckRun = z.object({
  name: z.string(),
  state: z.enum(["pass", "fail", "pending"]),
});
export type PrCheckRun = z.infer<typeof PrCheckRun>;

export const PrChecksStatus = z.object({
  checks: z.enum(["none", "pending", "passing", "failing"]),
  mergeable: z.boolean().nullable(), // null = GitHub is still computing it
  // Per-check-run breakdown backing `checks` — [] when the repo has no CI
  // configured (mirrors `checks:"none"`) or on an older/best-effort read.
  runs: z.array(PrCheckRun).default([]),
});
export type PrChecksStatus = z.infer<typeof PrChecksStatus>;

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
  // A REAL, persistent Fly.io deployment of THIS run's own branch — pre-merge
  // verification with a real shareable URL, distinct from `previewUrl` (the
  // static built-artifact preview) and from the project-level Fly deployment
  // (Project.flyDeployment, which tracks the integration branch). null = never
  // deployed. Explicit operator action only; never auto-deployed or auto-torn-down.
  flyDeployment: FlyDeployment.nullable().default(null),
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

// ─── Project Charter ──────────────────────────────────────────────────────
// LLM-drafted at project creation (Gate G-1). The operator corrects/approves
// before the project is created. Source of truth the whole auto-dev team plans
// against: the Architect reads its constraints, the CoS reports progress against
// its milestones, the Spec Analyst checks briefs against its definition of done.

export const ProjectCharter = z.object({
  goals: z.string(),
  nonGoals: z.string(),
  risks: z.string(),
  constraints: z.string(),
  definitionOfDone: z.string(),
});
export type ProjectCharter = z.infer<typeof ProjectCharter>;

// Request body for the draft-charter endpoint: the operator's raw ask.
export const DraftCharterRequest = z.object({ goal: z.string().min(1) });
export type DraftCharterRequest = z.infer<typeof DraftCharterRequest>;

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
  // A daily USD ceiling on this project's known spend (see budget.ts). Once
  // today's spend reaches it, the autonomy loop stops picking up NEW work for
  // this project — in-flight runs finish, and a human can still assign
  // manually at any time (this only gates autonomous auto-pick). null = no
  // limit (today's behavior, unchanged). Resets automatically at local
  // midnight — "today" is always recomputed from the current runs, there's no
  // separate counter to reset.
  dailyBudgetUsd: z.number().nullable().default(null),
  // Budget-as-allocation: when on (and a dailyBudgetUsd is set), auto-pick
  // spreads spend across a working window instead of committing the whole
  // remaining budget in the first tick — early in the day only a fraction of
  // the budget is available to NEW work, growing toward the full amount as
  // the window elapses (see orchestrator.ts's pacedAvailableUsd). Off by
  // default: with pacing off, a set budget behaves exactly as it did before
  // this field existed (all of it available immediately).
  budgetPacing: z.boolean().default(false),
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
  // Tool names this project's agents may never use (e.g. "Bash") — passed to
  // the SDK's own `disallowedTools`, which removes the tool from the model's
  // context entirely (not just gated per-call). A deny-list, not an allow-list:
  // an allow-list risks silently breaking an agent that needs a tool nobody
  // thought to list, so the safer default is "everything except what's named
  // here". null/empty = no restriction (today's behavior, unchanged). Only the
  // Claude runner acts on it today — CLI vendors have no equivalent SDK
  // primitive (see runner-sdk/src/claude.ts).
  disallowedTools: z.array(z.string()).nullable().default(null),
  // Opt-in: at review time, instead of a stateless one-shot consult reading the
  // last 30 log lines, run a SECOND real bounded agent (browser tools on, no
  // edit tools) that opens a live preview of the run's own branch and actually
  // exercises the changed behavior before writing its verdict. Off by default —
  // it's a real agent run (turns/time/cost), not a cheap text call, so it stays
  // an explicit per-project choice. Needs a local repoPath (a preview needs a
  // real checkout) and a Claude-capable reviewer (browser tools are Claude-only
  // today); falls back to the plain consult path when either is missing, the
  // preview fails to start, or the reviewer times out / returns no readable
  // verdict — deep review never blocks the pipeline, it only strengthens it.
  deepReview: z.boolean().default(false),
  // Opt-in second lens, layered on TOP of `deepReview` (requires it — a no-op
  // while deepReview is off, since there's no verifier pass to run after).
  // After the deepReview reviewer APPROVES, spins up a THIRD bounded agent run
  // against the SAME kind of live preview — this one adversarial: told to
  // actively try to break the change (malformed input, edge cases, auth
  // boundaries, concurrent actions) rather than judge whether it works. Any
  // reproduced finding of medium+ severity flips the task's verdict to flag,
  // with the findings as the reason — the verifier alone can confirm a change
  // *works*; this is what tries to prove it *doesn't*. Off by default, same
  // reasoning as deepReview (a real bounded run, not a cheap check). Never
  // blocks the pipeline: an unreadable/failed breaker run leaves the
  // verifier's approve standing (see Orchestrator.runBreakerReview).
  breakerReview: z.boolean().default(false),
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
  // Command run in a scratch worktree after a successful merge, before it's
  // committed to the integration branch — the project's tests/checks (the
  // Verifier gate). null → the server-global default (SKYNET_CHECK_CMD), same
  // "project override, else global default" convention as `baseBranch`. A
  // failing check undoes the merge commit and raises a `verifier` HITL instead
  // of silently landing broken code; a passing check auto-commits (unchanged).
  checkCmd: z.string().nullable().default(null),
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
  // Which stored Fly.io credential this project's `Deploy to Fly.io` action
  // authenticates with — a secret-store credential id of a `fly` API token.
  // null → the workspace's default Fly connection. Same shape as
  // githubCredentialId (separate Fly orgs can back different projects).
  flyCredentialId: z.string().nullable().default(null),
  // The project-level Fly deployment (integration branch) — a REAL, persistent
  // app that survives independent of the local Skynet process, and is only ever
  // torn down by an explicit operator action (never on Skynet restart). null =
  // never deployed. See FlyDeployment.
  flyDeployment: FlyDeployment.nullable().default(null),
  // Override for where the Roadmap tab reads its doc from, when it isn't at
  // either default candidate (steward/docs.ts's ROADMAP_PATHS —
  // "ROADMAP.md"/"docs/ROADMAP.md"). Set by the operator (or Steward,
  // confirmed) via a "select a file" affordance when the default lookup comes
  // up empty. null = use the default candidates, unchanged behavior.
  roadmapPath: z.string().nullable().default(null),
  // LLM-drafted and operator-approved at creation (Gate G-1). Optional: projects
  // created before this field existed, or created without charter assistance,
  // have null here. When present, this is the source of truth the auto-dev team
  // plans against — goals, non-goals, risks, constraints, definition of done.
  charter: ProjectCharter.nullable().default(null),
  // A per-project running digest of external context the operator has fed in
  // (see ProjectContextEntry) — pasted meeting notes, uploaded docs, emails —
  // condensed by one LLM pass into a short primer any agent's prompt can carry
  // (buildAgentContext's `primer` param — the "S2" slot agent-context.ts
  // already reserved for it). null = no context entries yet, or none
  // condensed. Regenerated whenever an entry is added/removed, or on a manual
  // refresh — see Operations.refreshProjectContext. System-owned: never set
  // directly via UpdateProjectRequest.
  contextSummary: z.string().nullable().default(null),
  contextSummaryUpdatedAt: Timestamp.nullable().default(null),
});
export type Project = z.infer<typeof Project>;

// ─── Project context entries (meeting notes, emails, pasted/uploaded docs) ──
// Raw source material the operator feeds in to build up "what we're aiming
// at" — kept verbatim (never edited by the model) so the operator can always
// see exactly what was fed in; a separate LLM pass condenses the accumulated
// set into `Project.contextSummary` (see steward/context.ts), which is what
// actually rides agent prompts. Append-only from the UI's perspective (no
// edit — delete + re-add if wrong); each entry keeps its own source + date.
export const ProjectContextSource = z.enum(["paste", "upload"]);
export type ProjectContextSource = z.infer<typeof ProjectContextSource>;

export const ProjectContextEntry = z.object({
  id: z.string(),
  workspaceId: z.string(),
  projectId: z.string(),
  source: ProjectContextSource,
  // Operator-given label ("Kickoff call notes", "Client email 8/12"), or the
  // uploaded filename when none was given.
  label: z.string(),
  // Extracted plain text (uploads are converted at ingest time — see
  // steward/extract.ts — never stored as raw binary).
  content: z.string(),
  // Upload provenance — null for a paste entry.
  filename: z.string().nullable().default(null),
  mimeType: z.string().nullable().default(null),
  createdAt: Timestamp,
  createdBy: z.string(),
});
export type ProjectContextEntry = z.infer<typeof ProjectContextEntry>;

// Paste path (POST /api/projects/:id/context — JSON body). Upload is a
// separate multipart route (POST .../context/upload) with no zod body — the
// file itself is the payload.
export const CreateProjectContextEntryRequest = z.object({
  label: z.string().trim().min(1).max(200).optional(),
  content: z.string().trim().min(1).max(200_000),
});
export type CreateProjectContextEntryRequest = z.infer<typeof CreateProjectContextEntryRequest>;

// Provenance for a task imported from an external source of truth, so Skynet can
// write status changes BACK to it (see docs/task-source-sync.md). Set at import;
// carried for the task's life. `syncedAt`/`sourceRev` reserve a future two-way sync.
export const TaskSource = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("github_issue"), repo: z.string(), number: z.number().int(), url: z.string().default("") }),
  z.object({ kind: z.literal("repo_file"), path: z.string(), anchor: z.string().default("") }), // Phase 2
  z.object({ kind: z.literal("external"), system: z.string(), id: z.string(), url: z.string().default("") }), // Phase 3
  // Self-replenishing backlog (v1 "autonomous sweep"): a task the fleet itself
  // proposed while reviewing another run's work, never a human. `byRun` is the
  // run whose review surfaced it; `reason` is the model's own "why" for the
  // proposal, carried through for the operator's audit trail. `proposedAt` is
  // the ONE place a fleet task's real creation time lives — Task itself has no
  // generic createdAt field, and the daily-proposal-cap window needs a real
  // timestamp, not `order` (a priority rank, not a clock). See
  // review-verdict.ts's `ProposedTask` / orchestrator.ts's processFleetProposals.
  z.object({ kind: z.literal("fleet"), byRun: z.string(), reason: z.string().default(""), proposedAt: Timestamp }),
  // A task spawned from an approved SolutionBrief (S7) — the reverse link a
  // brief's own `featureId` doesn't give you: which tasks actually came FROM
  // this plan, not just which feature it rolled up into.
  z.object({ kind: z.literal("brief"), briefId: z.string() }),
]);
export type TaskSource = z.infer<typeof TaskSource>;

// One quality concern from the task linter (see Task.lint below). The first
// three kinds are the v1.5 assistive v0; `missing-dependency` and
// `parallel-candidate` are the v5 "LLM coach" layer on top — same structured
// concern shape, just two more things worth flagging once the linter is also
// given the rest of the open backlog to reason against (see task-linter.ts).
export const TaskLintConcern = z.object({
  kind: z.enum(["vague", "multi-module", "no-done-definition", "missing-dependency", "parallel-candidate"]),
  note: z.string(),
});
export type TaskLintConcern = z.infer<typeof TaskLintConcern>;

// One thing the breaker (Project.breakerReview) actually reproduced against the
// live preview — never a speculative claim. `severity` uses the same low/medium/
// high scale as everywhere else (Risk); only medium+ findings on a "broken"
// verdict flip the task's own verdict to flag (see Orchestrator.runBreakerReview).
export const BreakerFinding = z.object({
  severity: Risk,
  what: z.string(), // what broke / was attempted, in the breaker's own words
  repro: z.string(), // exact steps to reproduce it
});
export type BreakerFinding = z.infer<typeof BreakerFinding>;

// The breaker's structured reply — see Task.reviewVerdict.breaker.
export const BreakerVerdict = z.object({
  verdict: z.enum(["clean", "broken"]),
  findings: z.array(BreakerFinding).default([]),
  // Set only when the breaker run itself couldn't produce a readable verdict
  // (unreadable reply, timeout, crash) — recorded as "clean-with-note" so the
  // pipeline is never blocked by a broken breaker; null on a normal outcome.
  note: z.string().nullable().default(null),
});
export type BreakerVerdict = z.infer<typeof BreakerVerdict>;

// ─── Triage clarifying questions ────────────────────────────────────────────
// Triage could already decide a task was `unclear` — but it had nowhere to say
// WHAT was unclear, and no way to get it resolved. The task just parked in
// `triage` forever, and the expensive failure mode followed: an agent later
// picked it up, burned its whole turn budget rediscovering the same ambiguity,
// and escalated with "no acceptance criteria to aim at". Asking costs one
// cheap consult; discovering it at agent prices costs orders of magnitude more.
//
// `draft` is Steward's PROPOSED answer, grounded in the project + repo — the
// operator sends it as-is, edits it, or replaces it. It is never applied on its
// own: an unanswered question is a question, and a model guessing at the
// operator's intent is exactly what produced the ambiguity in the first place.
export const TaskClarification = z.object({
  /** What triage needs to know. Specific and answerable, not "please clarify". */
  questions: z.array(z.string()).default([]),
  /** Steward's proposed answer for the operator to accept/edit. null = none
   *  drafted (no usable credential, or the draft came back empty). */
  draft: z.string().nullable().default(null),
  askedAt: Timestamp,
});
export type TaskClarification = z.infer<typeof TaskClarification>;

// ─── Project quality: scenario coverage ─────────────────────────────────────
// Answers "how well does the built thing actually work?" in the one way line
// coverage cannot: which of the codebase's ENUMERABLE behaviour sets (union
// types, zod enums — the closed sets it branches on) are exercised by tests at
// all. Derived by scanning a checked-out branch; see server/quality/scenarios.ts
// for the method and, importantly, its stated limits — absence of a case in the
// tests is a strong signal, presence is a weak one.
export const ScenarioCase = z.object({ value: z.string(), covered: z.boolean() });
export type ScenarioCase = z.infer<typeof ScenarioCase>;

export const ScenarioAxis = z.object({
  name: z.string(),
  file: z.string(),
  kind: z.enum(["union", "enum"]),
  cases: z.array(ScenarioCase).default([]),
  covered: z.number().int().nonnegative().default(0),
  total: z.number().int().nonnegative().default(0),
});
export type ScenarioAxis = z.infer<typeof ScenarioAxis>;

/** Line/branch coverage, only when the project already emits a summary — null
 *  means "not configured", which the UI says outright instead of showing 0%. */
export const CoverageSummary = z.object({
  lines: z.number(),
  statements: z.number(),
  branches: z.number(),
  functions: z.number(),
  path: z.string(),
  generatedAt: Timestamp.nullable().default(null),
});
export type CoverageSummary = z.infer<typeof CoverageSummary>;

export const ProjectQuality = z.object({
  axes: z.array(ScenarioAxis).default([]),
  /** How many `describe`/`it` titles the suite declares. A count, not the list:
   *  the UI only ever shows the number, and a monorepo's list is ~100KB. */
  behaviourCount: z.number().int().nonnegative().default(0),
  totalCases: z.number().int().nonnegative().default(0),
  coveredCases: z.number().int().nonnegative().default(0),
  sourceFiles: z.number().int().nonnegative().default(0),
  testFiles: z.number().int().nonnegative().default(0),
  coverage: CoverageSummary.nullable().default(null),
  scannedAt: Timestamp,
});
export type ProjectQuality = z.infer<typeof ProjectQuality>;

/** Why a project has no quality report — stated plainly rather than as an
 *  empty panel the operator has to interpret. */
export const ProjectQualityResult = z.discriminatedUnion("state", [
  z.object({ state: z.literal("ok"), quality: ProjectQuality }),
  z.object({ state: z.literal("unbound") }),           // no repo connected
  z.object({ state: z.literal("missing_local_repo") }), // bound, but not on disk
]);
export type ProjectQualityResult = z.infer<typeof ProjectQualityResult>;

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
  // Triage asked for something it needs before this task can be worked (see
  // TaskClarification). Set when triage self-reports `clarity: "unclear"` AND
  // names what's missing; cleared when the operator answers. Additive and
  // nullable, so every task predating this parses unchanged.
  clarification: TaskClarification.nullable().default(null),
  // Task linter — cheap quality hints computed in the background right after
  // the task is created or its text/description is edited (see
  // apps/server/src/task-linter.ts). NEVER blocks creation or edits, and
  // NEVER auto-splits a task: `concerns` is a dismissible hint the operator
  // can act on or ignore. Empty `concerns` = the linter ran and found nothing
  // worth flagging (or its reply was unreadable — same "nothing to report"
  // outcome, never a thrown error). `null` = not linted yet for the CURRENT
  // text (freshly created, or the text/description just changed). v5 also
  // hands the linter a short list of sibling backlog/todo titles from the
  // same project, so it can flag an implied-but-uncaptured dependency or an
  // open sibling that looks independent enough to run in parallel — the
  // "coach" layered on the v1.5 assistive v0.
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
      // Set only by a `deepReview` run (see Project.deepReview): a short list of
      // what the reviewer actually exercised (e.g. browser actions against the
      // live preview), for later surfacing in the review UI. Null for a plain
      // consult verdict — there's nothing "exercised" to report.
      evidence: z.array(z.string()).nullable().optional(),
      // Set only by a `breakerReview` run (see Project.breakerReview) — the
      // adversarial second lens, run after the reviewer above approves. Records
      // what it actually reproduced against the SAME live preview, even on a
      // clean pass (so "we tried and it held" is visible, not just silence —
      // for later feature-brief evidence). `note` is set only on a breaker run
      // that couldn't produce a readable verdict (a broken breaker never blocks
      // the pipeline — treated as clean-with-note, `decision` above is
      // untouched); null on a normal clean/broken outcome.
      breaker: BreakerVerdict.nullable().optional(),
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
  // Other tasks (same project) this one can't start before — set by S7's brief
  // decomposition so a generated plan's ordering survives past creation (the
  // autonomy loop's auto-pick eligibility filter skips a task until every id
  // here is `done`; a human "Start now" still bypasses it, same as autoPick
  // does for other gates). Distinct from `TaskRun.dependsOn` (upstream RUN ids
  // used for live conflict detection between concurrently executing agents,
  // orchestrator/derive/conflicts.ts) — this is task-to-task ordering of
  // not-yet-started work. Default [] = no dependency, today's behavior.
  dependsOnTaskIds: z.array(z.string()).default([]),
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
  // The aggregate PR for this feature's batched tasks — feature-scoped branch
  // batching (see merge.ts's `targetBranchFor`): tasks under this feature merge
  // into a shared `skynet/feature/<id>` branch, and once every one is done this
  // is set to the single PR opened for the whole batch (feature branch → project
  // base), rather than one PR per task. A dedicated field, not reused per-task
  // `TaskRun.pr` slots — by the time the aggregate PR opens, every sibling run
  // has already gone through its own completion/worktree-retire, so writing a
  // fresh open PR onto those records would leave stale, unmergeable duplicates.
  pr: PullRequest.nullable().default(null),
  // Assistive, non-blocking size-guardrail note: set the FIRST time a task is
  // linked to this feature and the resulting batch crosses
  // SKYNET_FEATURE_BATCH_MAX_TASKS (see operations.ts's updateTask) — an early
  // warning so an operator can split an oversized feature before its batch
  // completes and opens one hard-to-review PR. Fires once (stays set once
  // tripped, never re-overwritten) rather than nagging on every task added
  // past the threshold. Purely advisory: never blocks linking more tasks, and
  // the aggregate PR still opens regardless (see buildFeatureMergeBriefing's
  // separate, PR-time size check, which floors risk instead of gating).
  sizeWarning: z
    .object({
      taskCount: z.number().int(), // task count at the moment this tripped
      threshold: z.number().int(), // the configured max-tasks threshold
      note: z.string(), // operator-facing message
      at: Timestamp,
    })
    .nullable()
    .default(null),
  // Feature-level verification (Project.deepReview opt-in): once every sibling
  // task is done and the feature branch merges, a bounded second agent
  // browses the live merged preview and checks the WHOLE feature — grounded
  // on this feature's own description + its tasks' text/description — against
  // Task.reviewVerdict's per-task, per-diff review. "flag" holds the feature
  // back from `status: "shipped"` (the code stays merged either way; only the
  // ship label is gated) and its findings flow into the self-replenishing
  // backlog the same way a normal review's proposals do. Same shape as
  // Task.reviewVerdict, minus `by` (a run-anchored `runLog` line carries who/
  // when instead — a Feature has no single agent's log to attribute it to).
  verification: z
    .object({
      decision: z.enum(["pass", "flag"]),
      reason: z.string(),
      evidence: z.array(z.string()).nullable().default(null),
      at: Timestamp,
    })
    .nullable()
    .default(null),
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

// ─── SolutionBrief: the persistent pre-work planning doc ─────────────────
// A human-authored (or human-approved) design doc for a chunk of work, BEFORE
// any task/run exists for it — "what are we building and why, what did we
// consider, what's risky, how will we know it's done." Distinct from
// FeatureBrief above (a SYSTEM-composed merge-readiness summary for an
// already-batched, already-built feature) — this is the plan that precedes
// building, plain CRUD content, never LLM-drafted by this entity itself.
// Per-project, same scoping as Feature/Milestone. `status` gates execution:
// downstream tooling (S7) only spins up work off an "approved" brief.
export const SolutionBriefStatus = z.enum(["draft", "approved", "building", "done"]);
export type SolutionBriefStatus = z.infer<typeof SolutionBriefStatus>;

// One option weighed while shaping the approach — kept even for options NOT
// taken, so a reviewer (or a future reader) sees the reasoning, not just the
// conclusion.
export const SolutionBriefOption = z.object({
  name: z.string(),
  verdict: z.string(), // e.g. "chosen", "rejected — too slow", "deferred"
  why: z.string(),
});
export type SolutionBriefOption = z.infer<typeof SolutionBriefOption>;

export const SolutionBrief = z.object({
  id: z.string(),
  workspaceId: z.string(),
  projectId: z.string(),
  title: z.string(),
  problem: z.string(), // markdown — what's wrong / needed, and why now
  approach: z.string(), // markdown — the chosen plan
  optionsConsidered: z.array(SolutionBriefOption).default([]),
  risks: z.array(z.string()).default([]),
  acceptanceCriteria: z.array(z.string()).default([]),
  openQuestions: z.array(z.string()).default([]),
  status: SolutionBriefStatus.default("draft"),
  // Roll-up into a Feature once work starts, same linkage Task uses. Optional:
  // a brief can exist (and even be approved) before any feature is created.
  featureId: z.string().nullable().default(null),
  createdAt: Timestamp,
  updatedAt: Timestamp,
  // Stamped SERVER-SIDE only, when status transitions to "approved" — never
  // accepted from a client (see UpdateSolutionBriefRequest below, which
  // deliberately has no approvedAt/approvedBy fields to send one through).
  approvedAt: Timestamp.nullable().default(null),
  approvedBy: z.string().nullable().default(null),
  // Provenance: a capped excerpt of the conversation/context this brief was
  // drafted from (e.g. a Steward thread), if any — a "why does this exist"
  // breadcrumb, not a full transcript. Truncated at write time (operations.ts),
  // not here — the schema stays permissive; length policy is a product choice.
  sourceConversation: z.string().nullable().default(null),
  // S6 (optional): the result of a bounded, READ-ONLY agent run that actually
  // read the codebase (a detached checkout of the base branch) to verify this
  // draft's assumptions before an operator approves it — see
  // Orchestrator.exploreBrief / POST .../briefs/:bid/explore. Purely advisory:
  // never gates approval, never overwrites operator-authored fields above.
  // Null until an explore run has ever completed successfully; a FAILED run
  // leaves this untouched (see the route's error response instead).
  exploration: z
    .object({
      at: Timestamp,
      findings: z.array(z.string()), // wrong/confirmed assumptions, surprises
      touchpoints: z.array(z.string()), // files/modules/areas this plan would actually touch
    })
    .nullable()
    .default(null),
});
export type SolutionBrief = z.infer<typeof SolutionBrief>;

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

// Guided merge (see Orchestrator.raiseDiffReview / draftMergeBrief): a
// plain-English risk/mitigation read of the diff, drafted once alongside the
// walkthrough — same stateless-consult discipline (structured JSON, never
// prose). `filesTouched` is supplied by the SYSTEM from the real diff stat,
// never trusted from the model. `mitigations` composes the model's own
// diff-grounded read with facts the system already knows (the recorded
// auto-review verdict, whether the project runs checks after merge) — the
// model is never asked to restate those, only to add genuinely new risk
// framing. Null when the draft failed or the provider doesn't support
// `consult` — the diff HITL always still has the raw diff either way.
export const MergeBrief = z.object({
  summary: z.string(),
  filesTouched: z.array(z.string()).default([]),
  risks: z.array(z.string()).default([]),
  mitigations: z.array(z.string()).default([]),
});
export type MergeBrief = z.infer<typeof MergeBrief>;

export const DiffSummary = z.object({
  add: z.number().int().nonnegative(),
  del: z.number().int().nonnegative(),
  modules: z.array(z.string()), // module ids — never a raw patch
  // The changed file paths, so a reviewer (esp. on Telegram) sees WHAT changed
  // without opening the full diff. Optional/defaulted so the empty-diff merge
  // gates that carry no file list stay valid.
  files: z.array(z.string()).default([]),
  walkthrough: DiffWalkthrough.nullable().default(null),
  mergeBrief: MergeBrief.nullable().default(null),
  // The branch a diff/merge APPROVAL integrates into if the operator doesn't
  // choose a different one — the project's local integration branch
  // (`skynet/integration/<projectId>`), or, when GitHub-connected, the PR
  // base branch. A `merge` retry gate (post-conflict/failure) carries forward
  // whatever branch that attempt actually targeted, so a plain retry lands in
  // the same place. Null on a gate predating guided merge, or when it
  // couldn't be resolved (no git backend). See Resolution.targetBranch.
  defaultTargetBranch: z.string().nullable().default(null),
});
export type DiffSummary = z.infer<typeof DiffSummary>;

// "reassign" resolves an escalation by handing the run to a different runner.
// "dismiss" clears an escalation card with NO operation on the run — no stop,
// resume, or reassign (orchestrator.ts's deliverEscalation). Only meaningful
// for `escalation` gates; other kinds don't offer it.
// "push" — `merge`-kind only: push the run's branch and open a GitHub PR
// against the project's base branch REGARDLESS of the local conflict, instead
// of resolving it locally first — an escape hatch so a human can reconcile on
// GitHub (which has real conflict-resolution tooling) instead of blocking on
// automated local merge. Requires the workspace's GitHub connection + the
// project's repo; orchestrator.ts's deliver() logs and no-ops otherwise.
export const ResolveAction = z.enum(["approve", "reject", "modify", "option", "reassign", "dismiss", "push"]);
export type ResolveAction = z.infer<typeof ResolveAction>;

export const Resolution = z.object({
  action: ResolveAction,
  optionIndex: z.number().int().nullable().default(null), // for 'option'
  guidance: z.string().nullable().default(null), // for 'modify'
  // Guided merge — the operator's chosen integration branch for an `approve`
  // on a `diff`/`merge` gate. Null = the default (DiffSummary.defaultTargetBranch).
  // Ignored for every other kind/action.
  targetBranch: z.string().nullable().default(null),
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
  // A `reassign` on an escalation defaults to CONTINUING in the same worktree
  // (the new runner picks up the branch's committed work) — resetWork:true
  // instead retires that worktree and starts the task completely fresh on a
  // new run/branch, same as "Stop" followed by a plain re-assign. Ignored for
  // every other action.
  resetWork: z.boolean().default(false),
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
  // Captured command/check output (verifier). Unlike `diff` (re-fetchable from
  // the agent's worktree on demand, so never stored raw), a failed check runs in
  // a SCRATCH integration worktree that's torn down immediately after — there's
  // nothing left to re-fetch from later, so the (capped) output is captured onto
  // the gate itself at raise time.
  output: z.string().nullable().default(null), // verifier
  // System-computed, scannable chips for the decision: the safety classifier's
  // risk reasons (approval) or the conflicting files (merge). Not runner-supplied.
  flags: z.array(z.string()).default([]),
  // `merge`-kind only, feature-scoped branch batching (merge.ts's `targetBranchFor`):
  // set when this conflict is merging a FEATURE branch itself UP into the
  // project's base (once every task under it is done) — retrying on approve
  // must re-merge THIS ref, never the resolving run's own branch (there's no
  // single "owning run" for that step, unlike a task merging INTO its feature
  // branch, which re-derives correctly from the task's own `featureId` on
  // retry — same as `agent.branch` already does today). Null for every HITL
  // today — additive, no behavior change to existing records.
  sourceBranchOverride: z.string().nullable().default(null),
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
  // Area-manager hierarchy (docs/agent-hierarchy.md), landed additively ahead of
  // the agentic manager runtime: 'worker' (default) is every agent today —
  // unchanged behavior. 'manager' is reserved for a future per-project area
  // manager that delegates to worker subagents; nothing in this codebase sets
  // it yet (no manager provisioning exists), so it's inert until that lands.
  role: z.enum(["manager", "worker"]).default("worker"),
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
  // Tamper-evident hash chain — SHA-256 of the immutable decision fields
  // (workspaceId/hitlId/runId/action/operatorId/at/payload/prevHash). Both
  // fields are optional for back-compat with records written before chaining
  // landed; absent = pre-chain record, not evidence of tampering.
  hash: z.string().optional(),
  prevHash: z.string().nullable().optional(),
});
export type AuditRecord = z.infer<typeof AuditRecord>;

// ─── Compliance evidence pack ─────────────────────────────────────────────
// A one-click, signed "AI change report" for auditors (EU AI Act tailwind):
// every AI-authored change (an approved diff/merge decision) in a chosen
// scope, who approved it — a human operator, a standing approval policy, or a
// fleet agent's auto-review — why, and the risk classification in effect at
// decision time. Built entirely from the existing tamper-evident AuditRecord
// trail — no new decision-recording path, no re-derivation of history.

export const ComplianceApproverType = z.enum(["human", "policy", "agent-review"]);
export type ComplianceApproverType = z.infer<typeof ComplianceApproverType>;

export const ComplianceReportEntry = z.object({
  hitlId: z.string(),
  runId: z.string(),
  taskId: z.string().nullable(),
  taskText: z.string().nullable(),
  projectId: z.string().nullable(),
  projectName: z.string().nullable(),
  branch: z.string().nullable(),
  // The HITL kind at decision time, as a plain string (mirrors AuditRecord.action
  // below) — not the current HitlKind enum, so a report stays parseable even if
  // the live enum grows or narrows after it was signed.
  kind: z.string(),
  title: z.string(),
  why: z.string().nullable(),
  risk: Risk.nullable(),
  decidedAt: Timestamp,
  action: z.string(),
  // The raw AuditRecord.operatorId: a real operator id, or the approval
  // policy's self-description ("policy:trusted", "policy:rule:<id>"), or
  // "autonomy" for a fleet agent's auto-review approval.
  approvedBy: z.string(),
  approverType: ComplianceApproverType,
  // Human-readable attribution detail: the policy string for "policy", the
  // reviewing fleet agent's name for "agent-review", null for "human"
  // (approvedBy is already a real operator id in that case).
  policyDetail: z.string().nullable(),
  // The stated reason: an operator's modify/reassign guidance, an agent's
  // rationale, or a fleet reviewer's verdict reason — whichever applies.
  reason: z.string().nullable(),
  diffAdd: z.number().int().nonnegative().nullable(),
  diffDel: z.number().int().nonnegative().nullable(),
  diffFiles: z.array(z.string()),
});
export type ComplianceReportEntry = z.infer<typeof ComplianceReportEntry>;

export const ComplianceReportScope = z.object({
  projectId: z.string().nullable(),
  projectName: z.string().nullable(),
  runId: z.string().nullable(),
  from: Timestamp.nullable(),
  to: Timestamp.nullable(),
});
export type ComplianceReportScope = z.infer<typeof ComplianceReportScope>;

export const ComplianceReportSummary = z.object({
  totalChanges: z.number().int().nonnegative(),
  humanApproved: z.number().int().nonnegative(),
  policyAutoApproved: z.number().int().nonnegative(),
  agentReviewApproved: z.number().int().nonnegative(),
  highRisk: z.number().int().nonnegative(),
  earliestDecisionAt: Timestamp.nullable(),
  latestDecisionAt: Timestamp.nullable(),
});
export type ComplianceReportSummary = z.infer<typeof ComplianceReportSummary>;

export const ComplianceReport = z.object({
  id: z.string(),
  workspaceId: z.string(),
  generatedAt: Timestamp,
  generatedBy: z.string(), // operatorId who ran the export
  scope: ComplianceReportScope,
  summary: ComplianceReportSummary,
  entries: z.array(ComplianceReportEntry),
});
export type ComplianceReport = z.infer<typeof ComplianceReport>;

export const SignedComplianceReport = z.object({
  report: ComplianceReport,
  // sha256 hex digest of the report's canonical JSON — the thing actually signed.
  contentHash: z.string(),
  algorithm: z.literal("ed25519"),
  // base64 Ed25519 signature over the utf8 bytes of `contentHash`.
  signature: z.string(),
  // base64 SPKI public key for this installation, embedded so a verifier can
  // check authenticity offline from this document alone — no server round-trip.
  publicKey: z.string(),
});
export type SignedComplianceReport = z.infer<typeof SignedComplianceReport>;

export const GenerateComplianceReportRequest = z.object({
  projectId: z.string().nullable().optional(),
  runId: z.string().nullable().optional(),
  from: Timestamp.nullable().optional(),
  to: Timestamp.nullable().optional(),
});
export type GenerateComplianceReportRequest = z.infer<typeof GenerateComplianceReportRequest>;

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
  // Where to create / find your API key for this provider — shown in the
  // onboarding Connect step so the user knows exactly where to go, without
  // having to leave the app to find it. Null for providers that authenticate
  // exclusively via CLI login (no key to create).
  keyUrl: z.string().nullable().default(null),
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
  // Guided merge — approve a `diff`/`merge` gate into a branch other than the
  // default (DiffSummary.defaultTargetBranch). Ignored for every other kind.
  targetBranch: z.string().optional(),
  // Approve-with-memory — see Resolution.memoryNote. Only honored on `approve`.
  memoryNote: z.string().optional(),
  // See Resolution.resetWork. Only honored on `reassign`.
  resetWork: z.boolean().optional(),
});
export type ResolveRequest = z.infer<typeof ResolveRequest>;

export const ChatRequest = z.object({ text: z.string().min(1) });

// `inform` — a third interaction type alongside chat (a real extra turn) and
// resolve (a HITL decision): a note that rides each targeted run's NEXT prompt
// at no extra turn — never a fresh round-trip query, never a HITL gate. Select
// explicit run ids, a whole project's live runs, or both (the two sets union).
export const InformRequest = z.object({
  note: z.string().min(1),
  runIds: z.array(z.string()).default([]),
  projectId: z.string().optional(),
});
export type InformRequest = z.infer<typeof InformRequest>;

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
  dailyBudgetUsd: z.number().nullable().optional(), // see Project.dailyBudgetUsd; omit → no limit
  budgetPacing: z.boolean().optional(), // see Project.budgetPacing; omit → off
  // Project-scoped agent guidance that rides every prompt (see Project.instructions).
  instructions: z.string().optional(),
  baseBranch: z.string().optional(), // branch to stack runs/PRs onto (omit → global default)
  // Import the repo's open GitHub issues as backlog tasks right after creation,
  // and turn on ongoing write-back (Project.syncSourceStatus) so later task
  // transitions comment/close/reopen the issue. No-op for a non-repo-bound
  // project. Defaults to on in the UI when a repo is bound; best-effort —
  // failure doesn't fail project creation. See docs/task-source-sync.md.
  importGithubIssues: z.boolean().optional(),
  // Operator-approved Project Charter (LLM-drafted via POST /api/projects/draft-charter,
  // then corrected in-UI before creation). Optional: omit to skip charter-assisted
  // creation (today's fast-path — a charter can always be written later).
  charter: ProjectCharter.optional(),
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
  dailyBudgetUsd: z.number().nullable().optional(), // see Project.dailyBudgetUsd; null clears → no limit
  budgetPacing: z.boolean().optional(), // see Project.budgetPacing
  approvalLevel: ApprovalLevel.optional(),
  planModeGate: z.boolean().optional(), // see Project.planModeGate
  // Tool names to block for this project's agents. `null` clears back to "no
  // restriction". See Project.disallowedTools.
  disallowedTools: z.array(z.string()).nullable().optional(),
  deepReview: z.boolean().optional(), // see Project.deepReview
  breakerReview: z.boolean().optional(), // see Project.breakerReview (requires deepReview)
  repoPath: z.string().nullable().optional(),
  repo: z.string().optional(),
  // Project-scoped agent guidance. `null` clears the field back to "no rules".
  instructions: z.string().nullable().optional(),
  githubCredentialId: z.string().nullable().optional(), // pick the GitHub account (null clears → default)
  flyCredentialId: z.string().nullable().optional(), // pick the Fly.io account (null clears → default)
  baseBranch: z.string().nullable().optional(), // stack onto a branch; null clears → global default
  checkCmd: z.string().nullable().optional(), // Verifier gate command; null clears → global default

  // Which provider keys the project may run on (secret-store credential ids;
  // empty = all keys). See Project.enabledRunnerCredentialIds.
  enabledRunnerCredentialIds: z.array(z.string()).optional(),
  syncSourceStatus: z.boolean().optional(), // write status changes back to the source of truth
  roadmapPath: z.string().nullable().optional(), // see Project.roadmapPath; null clears → default candidates
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
// The operator's answer to triage's clarifying questions (see TaskClarification).
// Appended to the task's description and the task returned to `backlog` so the
// next triage pass reads it — deliberately a re-triage rather than a direct
// promotion to `todo`, since the answer may change the effort/risk read too.
export const AnswerClarificationRequest = z.object({
  answer: z.string().trim().min(1).max(10_000),
});
export type AnswerClarificationRequest = z.infer<typeof AnswerClarificationRequest>;

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

// ─── SolutionBrief CRUD requests ────────────────────────────────────────
export const CreateSolutionBriefRequest = z.object({
  title: z.string().min(1),
  problem: z.string().optional(),
  approach: z.string().optional(),
  optionsConsidered: z.array(SolutionBriefOption).optional(),
  risks: z.array(z.string()).optional(),
  acceptanceCriteria: z.array(z.string()).optional(),
  openQuestions: z.array(z.string()).optional(),
  featureId: z.string().nullable().optional(),
  sourceConversation: z.string().nullable().optional(),
});
export type CreateSolutionBriefRequest = z.infer<typeof CreateSolutionBriefRequest>;

// PATCH semantics (mind PR #482): omit a field to leave it untouched; a
// nullable field sent as null explicitly clears it. Deliberately carries NO
// approvedAt/approvedBy — those are server-stamped only (see SolutionBrief
// above), so a client literally cannot supply one through this schema; unknown
// keys in the raw request body are dropped by zod's default (non-strict)
// parse, same protection every other Update*Request in this file relies on.
export const UpdateSolutionBriefRequest = z.object({
  title: z.string().min(1).optional(),
  problem: z.string().optional(),
  approach: z.string().optional(),
  optionsConsidered: z.array(SolutionBriefOption).optional(),
  risks: z.array(z.string()).optional(),
  acceptanceCriteria: z.array(z.string()).optional(),
  openQuestions: z.array(z.string()).optional(),
  status: SolutionBriefStatus.optional(),
  featureId: z.string().nullable().optional(),
});
export type UpdateSolutionBriefRequest = z.infer<typeof UpdateSolutionBriefRequest>;

// ─── Roadmap doc requests ──────────────────────────────────────────────
// Commit a Steward-drafted edit to a project's ROADMAP.md — only reachable
// after the operator confirms the diff in chat. `baselineHash` (always) and
// `baselineSha` (GitHub-bound projects only) pin the edit to the exact content
// it was drafted against, so a concurrent change is refused, not clobbered.
// `path` isn't restricted to the two default candidates: Project.roadmapPath
// can point the doc at any file, and validateProjectAction's edit_roadmap
// case (steward/assistant.ts) already refuses a path that doesn't match the
// resolved doc's own — this schema doesn't need a second, stricter opinion.
export const UpdateProjectRoadmapRequest = z.object({
  path: z.string().min(1),
  content: z.string().min(1),
  baselineHash: z.string().min(1),
  baselineSha: z.string().optional(),
});
export type UpdateProjectRoadmapRequest = z.infer<typeof UpdateProjectRoadmapRequest>;

// A human-initiated kanban move; the server validates it against the allowed
// (human) transition map before applying.
export const MoveTaskRequest = z.object({
  to: TaskState,
  // ongoing/review → todo abandons the in-flight run. preserve:true instead
  // PAUSES it (worktree + committed work kept, runner freed) rather than
  // discarding it — a later Start on the same task resumes it in place. See
  // Orchestrator.pauseRun / assignTask's resume-a-paused-run branch. Ignored
  // for every other transition.
  preserve: z.boolean().optional(),
});
export type MoveTaskRequest = z.infer<typeof MoveTaskRequest>;

// Drag-reorder within a lane (the backlog): place the task before `beforeId`, or
// at the end when null. Distinct from the up/down MoveTaskRequest step.
export const ReorderTaskRequest = z.object({ beforeId: z.string().nullable() });
export type ReorderTaskRequest = z.infer<typeof ReorderTaskRequest>;

// ─── Execution intents (S10): start/queue composites ───────────────────────
// The strict request contract for POST /api/projects/:id/steward/actions —
// distinct from (and narrower than) Steward's own free-form AssistantAction
// (apps/server/src/steward/assistant.ts), which is never zod-validated since
// the LLM proposes it. These four kinds are the only ones a client calls this
// endpoint with; every other ProjectActionKind keeps its existing per-kind
// REST route (see steward-dock.tsx's runAction), unchanged.
export const StewardExecutionAction = z.discriminatedUnion("kind", [
  // Direct single-task start — "Start now" on an explicit task.
  z.object({ kind: z.literal("start_task"), taskId: z.string() }),
  // Queue explicit tasks for autonomous pickup (state→todo, autoPick: true).
  z.object({ kind: z.literal("queue_tasks"), taskIds: z.array(z.string()).min(1) }),
  // Composite over one feature's tasks. `execMode: "queue"` queues every
  // eligible task; `"start_now"` assigns as many as idle capacity allows and
  // queues the rest. `feasibleOnly` (default true) drops tasks still parked
  // in triage (never came out clear) from both.
  z.object({
    kind: z.literal("start_feature"),
    featureId: z.string(),
    execMode: z.enum(["queue", "start_now"]),
    feasibleOnly: z.boolean().default(true),
  }),
  // Composite over the project's whole unstarted backlog (backlog+triage+todo)
  // — always queues (no direct-start variant; there's no single scope-defined
  // "now" for the whole backlog the way a feature's own start_now has).
  z.object({ kind: z.literal("process_backlog"), feasibleOnly: z.boolean().default(true) }),
]);
export type StewardExecutionAction = z.infer<typeof StewardExecutionAction>;

export const ExecuteStewardActionRequest = z.object({
  action: StewardExecutionAction,
  // Resolve feasibility and report what WOULD happen — never mutates
  // anything. What S11's confirm chip and S12's MCP `dryRun` param render.
  dryRun: z.boolean().optional(),
});
export type ExecuteStewardActionRequest = z.infer<typeof ExecuteStewardActionRequest>;

export const ExecutableExcludeReason = z.enum(["unclear", "already-running", "done", "over-budget", "not-in-scope"]);
export type ExecutableExcludeReason = z.infer<typeof ExecutableExcludeReason>;

export const StewardActionOutcome = z.object({
  // taskIds directly assigned (todo/whatever → ongoing, right now).
  started: z.array(z.string()),
  // taskIds queued for the autonomy tick to pick up (state→todo, autoPick).
  queued: z.array(z.string()),
  excluded: z.array(z.object({ taskId: z.string(), reason: ExecutableExcludeReason })),
  // True when this call turned the project's autonomy on as a necessary
  // corollary of queuing work — see executeStewardAction's doc comment.
  autonomyEnabled: z.boolean().default(false),
  dryRun: z.boolean().default(false),
});
export type StewardActionOutcome = z.infer<typeof StewardActionOutcome>;

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

/** One credential lifecycle event (created/rotated/removed) — kept past the
 *  credential's own deletion so "why did this provider disconnect" has an
 *  answer: who removed it and when. Never carries the key itself. */
export const SecretAuditEntry = z.object({
  id: z.string(),
  workspaceId: z.string(),
  credentialId: z.string(),
  provider: CredentialProvider,
  label: z.string(), // display name at the time of the event ("" = default)
  action: z.enum(["created", "rotated", "removed"]),
  operatorId: z.string(),
  at: Timestamp,
});
export type SecretAuditEntry = z.infer<typeof SecretAuditEntry>;

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
  // Require the Telegram-OTP / recovery-code second factor on login for this
  // workspace's operators (see apps/server/src/auth/mfa.ts). Off by default —
  // matches today's behavior for a workspace that never touches this toggle.
  // `SKYNET_MFA=true` still forces it on server-wide regardless of this
  // setting (an infra-level override for a hosted deploy that wants MFA
  // non-negotiable); `SKYNET_MFA_DISABLE` (the SSH break-glass) still wins
  // over both. This toggle is the day-to-day operator control — flip it live,
  // no restart, no env var edit.
  requireLoginVerification: z.boolean().default(false),
});
export type WorkspaceSettings = z.infer<typeof WorkspaceSettings>;

/** Patch for the live workspace settings (all fields optional). */
export const UpdateWorkspaceSettingsRequest = z.object({
  name: z.string().optional(),
  autoProvisionRunners: z.boolean().optional(),
  maxRunners: z.number().int().min(0).optional(),
  retireIdleRunnersAfterMinutes: z.number().int().min(0).optional(),
  browserTools: z.boolean().optional(),
  requireLoginVerification: z.boolean().optional(),
});
export type UpdateWorkspaceSettingsRequest = z.infer<typeof UpdateWorkspaceSettingsRequest>;

// ─── Command policy (versioned, per-workspace, operator-editable) ───────────
// Replaces the compiled-in command-safety classifier with DATA: a workspace can
// view, edit, version, and dry-run its own allow/gate/deny rules instead of
// trusting whatever shipped in the binary. A workspace with no custom
// PolicyVersion behaves exactly like the DEFAULT_COMMAND_POLICY shipped in
// apps/server/src/command-safety.ts (same rules, expressed as data). Distinct
// from `SafetyPolicy` above (GitHub push-safety toggles) and from
// `ApprovalRule`/`ApprovalLevel` (the downstream per-PROJECT auto-approval layer
// that decides whether an already-*gated* command still needs a human) — this is
// the upstream classification layer itself: what decides allow/gate/deny at all.

/** Mirrors command-safety.ts's `SafetyDecision`. allow = run without a gate ·
 *  gate = require human approval · deny = never run, even if "approved". */
export const PolicyDecision = z.enum(["allow", "gate", "deny"]);
export type PolicyDecision = z.infer<typeof PolicyDecision>;

/** Which evaluation bucket a rule participates in — deny/gate are whole-string
 *  regex checks (deny wins outright); allow-leader certifies a read-only leading
 *  command (every segment of the command line must match one). */
export const PolicyRuleKind = z.enum(["deny", "gate", "allow-leader"]);
export type PolicyRuleKind = z.infer<typeof PolicyRuleKind>;

export const PolicyRule = z.object({
  id: z.string(),
  kind: PolicyRuleKind,
  /** Regex source (case-insensitive), e.g. String.raw`\bsudo\b`. */
  pattern: z.string(),
  /** Risk surfaced on the HITL gate. Ignored for `allow-leader` (always low). */
  risk: Risk.default("medium"),
  /** Human-readable reason — feeds the HITL `why` chips and the audit trail. */
  reason: z.string(),
  enabled: z.boolean().default(true),
});
export type PolicyRule = z.infer<typeof PolicyRule>;

/** A workspace's editable command-classification policy: an ordered rule set
 *  plus the fallback for commands no rule matches. `resourceCaps` and
 *  `networkEgress` are recorded for visibility/future enforcement — no runtime
 *  enforcement of either exists yet (wall-clock has a separate env-based cap;
 *  token budget is reported after the fact; network egress has no enforcement
 *  mechanism anywhere in the codebase). Editing them here is inert today. */
export const CommandPolicy = z.object({
  rules: z.array(PolicyRule).default([]),
  /** Decision for a command that matches no deny/gate rule and isn't a
   *  certified read-only allow-leader. Today's classifier defaults to "gate". */
  defaultDecision: PolicyDecision.default("gate"),
  defaultRisk: Risk.default("medium"),
  /** Block `allow` whenever the command contains substitution/eval/pipe-to-shell
   *  composition ($(...), backticks, `eval`, redirects) — even if every segment
   *  otherwise matches an allow-leader. On by default; matches today's behavior. */
  unsafeCompositionBlocksAllow: z.boolean().default(true),
  resourceCaps: z
    .object({
      maxWallClockMs: z.number().int().positive().nullable().default(null),
      maxTokenBudget: z.number().int().positive().nullable().default(null),
    })
    .default({}),
  networkEgress: z
    .object({
      enabled: z.boolean().default(false),
      allowlist: z.array(z.string()).default([]),
    })
    .default({}),
});
export type CommandPolicy = z.infer<typeof CommandPolicy>;

/** One immutable, versioned snapshot of a workspace's CommandPolicy — git-like:
 *  every save creates a new version, older versions stay inspectable/diffable,
 *  and exactly one version is `active` at a time. No active PolicyVersion for a
 *  workspace = it runs the shipped DEFAULT_COMMAND_POLICY unmodified. */
export const PolicyVersion = z.object({
  id: z.string(),
  workspaceId: z.string(),
  /** Monotonic per-workspace, starting at 1. */
  version: z.number().int().positive(),
  policy: CommandPolicy,
  active: z.boolean().default(false),
  label: z.string().nullable().default(null),
  createdBy: z.string(),
  createdAt: Timestamp,
});
export type PolicyVersion = z.infer<typeof PolicyVersion>;

/** Body to save a new policy version (becomes active immediately on save). */
export const SavePolicyVersionRequest = z.object({
  policy: CommandPolicy,
  label: z.string().nullable().optional(),
});
export type SavePolicyVersionRequest = z.infer<typeof SavePolicyVersionRequest>;

/** Body to dry-run an unsaved, proposed policy against historical commands. */
export const DryRunPolicyRequest = z.object({
  policy: CommandPolicy,
  /** Cap on distinct historical commands replayed. Default 500. */
  limit: z.number().int().positive().max(2000).optional(),
});
export type DryRunPolicyRequest = z.infer<typeof DryRunPolicyRequest>;

const PolicyVerdictSummary = z.object({
  decision: PolicyDecision,
  risk: Risk,
  reasons: z.array(z.string()),
});

/** One command whose classification would change under the proposed policy. */
export const PolicyDryRunChange = z.object({
  command: z.string(),
  /** How many historical records carried this exact (normalized) command. */
  occurrences: z.number().int(),
  before: PolicyVerdictSummary, // under the workspace's CURRENTLY active policy
  after: PolicyVerdictSummary, // under the proposed (unsaved) policy
});
export type PolicyDryRunChange = z.infer<typeof PolicyDryRunChange>;

export const PolicyDryRunResult = z.object({
  /** Historical audit records considered (post-dedup source rows). */
  sampledRecords: z.number().int(),
  /** Distinct normalized commands classified. */
  uniqueCommands: z.number().int(),
  /** Commands whose decision, risk, or reasons differ before → after. */
  changed: z.array(PolicyDryRunChange),
  /** Distinct commands classified identically before and after. */
  unchanged: z.number().int(),
});
export type PolicyDryRunResult = z.infer<typeof PolicyDryRunResult>;

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
