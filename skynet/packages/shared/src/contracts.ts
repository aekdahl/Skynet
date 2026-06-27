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
]);
export type ProviderId = z.infer<typeof ProviderId>;

export const AgentStatus = z.enum(["running", "waiting", "review", "done"]);
export type AgentStatus = z.infer<typeof AgentStatus>;

export const PlanStepState = z.enum(["done", "now", "todo"]);
export type PlanStepState = z.infer<typeof PlanStepState>;

export const HitlKind = z.enum(["approval", "question", "plan", "diff", "merge"]);
export type HitlKind = z.infer<typeof HitlKind>;

/** Default single-tenant workspace until real provisioning lands. */
export const DEFAULT_WORKSPACE = "cyberdyne";

export const Risk = z.enum(["low", "medium", "high"]);
export type Risk = z.infer<typeof Risk>;

export const RunnerStatus = z.enum(["busy", "idle"]);
export type RunnerStatus = z.infer<typeof RunnerStatus>;

export const TaskState = z.enum(["backlog", "assigned", "done"]);
export type TaskState = z.infer<typeof TaskState>;

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

/** Append-only activity log line. Streamed via the `agent.log` event. */
export const LogLine = z.object({
  at: Timestamp,
  line: z.string(),
  // Optional expandable detail (e.g. a tool call's full input or output). When
  // present, the UI renders the line as a fold/unfold entry.
  detail: z.string().optional(),
});
export type LogLine = z.infer<typeof LogLine>;

// ─── Agent ──────────────────────────────────────────────────────────────────

export const Agent = z.object({
  id: z.string(),
  workspaceId: z.string(),
  projectId: z.string(),
  name: z.string(), // the task this agent owns
  status: AgentStatus,
  runnerId: z.string().nullable(), // which fleet runner executes it
  provider: ProviderId,
  model: z.string(),
  branch: z.string(),
  modules: z.array(z.string()), // architectural module ids it touches
  progress: z.number().min(0).max(1),
  plan: z.array(PlanStep),
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
});
export type Agent = z.infer<typeof Agent>;

// ─── Project · Task ───────────────────────────────────────────────────────

export const Project = z.object({
  id: z.string(),
  workspaceId: z.string(),
  name: z.string(),
  goal: z.string(),
  agentIds: z.array(z.string()),
  status: ProjectStatus,
  // The single repository this project's agents branch & PR within (one repo per
  // project). "owner/repo". Optional until GitHub is connected.
  repo: z.string().optional(),
});
export type Project = z.infer<typeof Project>;

export const Task = z.object({
  id: z.string(),
  workspaceId: z.string(),
  projectId: z.string(),
  text: z.string(),
  state: TaskState,
  agentId: z.string().nullable().default(null),
});
export type Task = z.infer<typeof Task>;

// ─── HITL item & resolution ───────────────────────────────────────────────

export const DiffSummary = z.object({
  add: z.number().int().nonnegative(),
  del: z.number().int().nonnegative(),
  modules: z.array(z.string()), // module ids — never a raw patch
});
export type DiffSummary = z.infer<typeof DiffSummary>;

export const ResolveAction = z.enum(["approve", "reject", "modify", "option"]);
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
  agentId: z.string(),
  kind: HitlKind,
  title: z.string(),
  why: z.string(),
  risk: Risk,
  raisedAt: Timestamp, // UI derives "waited" from this
  resolvedAt: Timestamp.nullable().default(null),
  resolution: Resolution.nullable().default(null),
  // kind-specific payload (only the relevant field is populated):
  command: z.string().nullable().default(null), // approval
  options: z.array(z.string()).nullable().default(null), // question
  recommended: z.number().int().nullable().default(null), // question — index
  steps: z.array(z.string()).nullable().default(null), // plan
  diff: DiffSummary.nullable().default(null), // diff
});
export type HitlItem = z.infer<typeof HitlItem>;

// ─── Fleet runner · Module · Dependency · Provider catalog ──────────────────

export const Runner = z.object({
  id: z.string(),
  workspaceId: z.string(),
  name: z.string(),
  provider: ProviderId,
  model: z.string(),
  status: RunnerStatus,
  idleSince: Timestamp.nullable().default(null),
});
export type Runner = z.infer<typeof Runner>;

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
  agentId: z.string(),
  action: z.string(),
  operatorId: z.string(),
  at: Timestamp,
  payload: z.unknown(),
});
export type AuditRecord = z.infer<typeof AuditRecord>;

/** Provider catalog entry — drives glyphs, colors, and the model dropdown. */
export const ProviderInfo = z.object({
  id: ProviderId,
  name: z.string(),
  glyph: z.string(),
  color: z.string(),
  models: z.array(z.string()),
  // Whether a credential is configured server-side. Undefined = treat as
  // available (back-compat); the create-agent UI disables providers set to false.
  available: z.boolean().optional(),
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
  repo: z.string().optional(), // bind the project to one repo at creation
});
export type CreateProjectRequest = z.infer<typeof CreateProjectRequest>;

export const UpdateProjectRequest = z.object({
  name: z.string().min(1).optional(),
  goal: z.string().optional(),
  status: ProjectStatus.optional(),
  repo: z.string().optional(),
});
export type UpdateProjectRequest = z.infer<typeof UpdateProjectRequest>;

export const CreateTaskRequest = z.object({ text: z.string().min(1) });
export type CreateTaskRequest = z.infer<typeof CreateTaskRequest>;

export const UpdateTaskRequest = z.object({
  text: z.string().min(1).optional(),
  state: TaskState.optional(),
});
export type UpdateTaskRequest = z.infer<typeof UpdateTaskRequest>;

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

/** A workspace's GitHub connection — installation + selected repos + policy. */
export const GithubConnection = z.object({
  workspaceId: z.string(),
  connected: z.boolean(),
  installation: GithubInstallation.nullable().default(null),
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

/** Partial update to the safety policy — any subset of guardrails. */
export const UpdateSafetyRequest = SafetyPolicy.partial();
export type UpdateSafetyRequest = z.infer<typeof UpdateSafetyRequest>;
