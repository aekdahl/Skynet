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

// ─── TaskRun ──────────────────────────────────────────────────────────────────

export const TaskRun = z.object({
  id: z.string(),
  workspaceId: z.string(),
  projectId: z.string(),
  name: z.string(), // the task this agent owns
  status: TaskRunStatus,
  agentId: z.string().nullable(), // which fleet runner executes it
  provider: ProviderId,
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
});
export type TaskRun = z.infer<typeof TaskRun>;

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
  // A project binds to a repository one of two ways (they can coexist):
  //  • repoPath — an absolute local folder the runs work in. When it contains
  //    a .git, `gitBacked` is set and Skynet auto-manages a worktree per agent
  //    + the merge queue against THAT repo. This is the desktop-first default.
  //  • repo — a connected GitHub repository "owner/repo" the branches are pushed
  //    to (PR flow). Optional; used for the cloud/publish path.
  repoPath: z.string().nullable().default(null),
  gitBacked: z.boolean().default(false),
  repo: z.string().optional(),
});
export type Project = z.infer<typeof Project>;

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
  // (backlog → triage): clarity / rough effort / risks.
  assessment: z.string().nullable().default(null),
  // Set when an autonomous review couldn't confidently approve and flagged the
  // task for a human (the task stays in `review`).
  reviewFlaggedReason: z.string().nullable().default(null),
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
});
export type Task = z.infer<typeof Task>;

// ─── HITL item & resolution ───────────────────────────────────────────────

export const DiffSummary = z.object({
  add: z.number().int().nonnegative(),
  del: z.number().int().nonnegative(),
  modules: z.array(z.string()), // module ids — never a raw patch
});
export type DiffSummary = z.infer<typeof DiffSummary>;

// "reassign" resolves an escalation by handing the run to a different runner.
export const ResolveAction = z.enum(["approve", "reject", "modify", "option", "reassign"]);
export type ResolveAction = z.infer<typeof ResolveAction>;

export const Resolution = z.object({
  action: ResolveAction,
  optionIndex: z.number().int().nullable().default(null), // for 'option'
  guidance: z.string().nullable().default(null), // for 'modify'
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
  model: z.string(),
  status: AgentStatus,
  idleSince: Timestamp.nullable().default(null),
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
});
export type ResolveRequest = z.infer<typeof ResolveRequest>;

export const ChatRequest = z.object({ text: z.string().min(1) });
export type ChatRequest = z.infer<typeof ChatRequest>;

export const CreateProjectRequest = z.object({
  name: z.string().min(1),
  goal: z.string().default(""),
  repoPath: z.string().optional(), // absolute path to a local folder to work in
  repo: z.string().optional(), // or bind to one connected GitHub repo at creation
});
export type CreateProjectRequest = z.infer<typeof CreateProjectRequest>;

export const UpdateProjectRequest = z.object({
  name: z.string().min(1).optional(),
  goal: z.string().optional(),
  status: ProjectStatus.optional(),
  autonomy: z.boolean().optional(),
  repoPath: z.string().nullable().optional(),
  repo: z.string().optional(),
});
export type UpdateProjectRequest = z.infer<typeof UpdateProjectRequest>;

export const CreateTaskRequest = z.object({
  text: z.string().min(1),
  description: z.string().optional(),
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
});
export type UpdateTaskRequest = z.infer<typeof UpdateTaskRequest>;

// A human-initiated kanban move; the server validates it against the allowed
// (human) transition map before applying.
export const MoveTaskRequest = z.object({ to: TaskState });
export type MoveTaskRequest = z.infer<typeof MoveTaskRequest>;

export const ConfigureRunnerRequest = z.object({
  provider: ProviderId,
  model: z.string().min(1),
  name: z.string().optional(),
});
export type ConfigureRunnerRequest = z.infer<typeof ConfigureRunnerRequest>;

export const UpdateRunnerRequest = z.object({
  model: z.string().min(1).optional(),
  name: z.string().optional(),
});
export type UpdateRunnerRequest = z.infer<typeof UpdateRunnerRequest>;

// ─── Secrets (per-workspace provider credentials) ──────────────────────────
// The raw key is write-only — it is never returned over the wire. The UI only
// ever sees this metadata (which provider has a key, and a last-4 fingerprint
// so an operator can confirm which key is stored).

export const SecretMeta = z.object({
  workspaceId: z.string(),
  provider: ProviderId,
  last4: z.string(), // last 4 chars of the key — for recognition, not reuse
  updatedAt: Timestamp,
  updatedBy: z.string(), // operator id — audit trail
});
export type SecretMeta = z.infer<typeof SecretMeta>;

/** Body for setting/rotating a workspace's provider key. */
export const SetSecretRequest = z.object({
  apiKey: z.string().min(1),
});
export type SetSecretRequest = z.infer<typeof SetSecretRequest>;

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
