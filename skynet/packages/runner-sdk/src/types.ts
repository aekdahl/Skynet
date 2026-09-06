import type {
  ModelRates,
  TaskRunStatus,
  HitlItem,
  LogVerb,
  PlanStep,
  ProviderId,
  Resolution,
  Usage,
} from "@skynet/shared";

/**
 * One user-configured MCP server this run may call — resolved (decrypted) by
 * the orchestrator from the project's `mcpServerIds` (see
 * apps/server/src/mcp-servers/service.ts), so a runner never sees a store id,
 * only the concrete spec, same "orchestrator resolves, runner just executes"
 * contract as `apiKey`/`baseUrl` above. `stdio` launches a local command
 * (env vars only reach that one subprocess); `remote` calls a URL (Sentry's
 * own MCP server, for example, is remote — `https://mcp.sentry.dev/mcp`).
 *
 * SECURITY: a write-capable server here (e.g. a real GitHub PAT) lets the
 * agent act OUTSIDE Skynet's own git-operation guardrails (PR-only writes,
 * no-force-push, the module allowlist) — those wrap Skynet's own git code
 * path, not arbitrary MCP tool calls a runner CLI makes. Accepted tradeoff,
 * same trust model as every integration in docs/integrations-catalog.md (the
 * operator's own credentials); the existing per-tool-call HITL approval gate
 * (already governing browser MCP tool calls below) is the mitigation.
 */
export type McpServerSpec =
  | { name: string; transport: "stdio"; command: string; args: string[]; env?: Record<string, string> }
  | { name: string; transport: "remote"; url: string; headers?: Record<string, string> };

/** Reserved MCP server names no user-configured server may use — collides
 *  with the always-on browser server (cli-runner.ts's `BROWSER_MCP_NAME`) or
 *  (Claude only) the manager's in-process spawn_worker server (claude.ts's
 *  `MANAGER_MCP_NAME`). Enforced authoritatively at MCP-server *creation*
 *  time (apps/server/src/mcp-servers/service.ts); the per-vendor checks
 *  further down the pipeline are defense in depth. Spelled out as literal
 *  strings here (not derived from either file's own constant) so this stays
 *  a plain type module with no cross-file coupling. */
export const RESERVED_MCP_NAMES = new Set(["browser", "skynet-manager"]);

/** What the orchestrator hands a provider to start an agent on a task. */
export interface StartSpec {
  runId: string;
  projectId: string;
  task: string; // the task text the agent owns
  model: string;
  branch: string;
  /** Working directory (the agent's git worktree). Real runners execute here. */
  cwd?: string;
  /** Set when forked — provider should clone the parent's context. */
  parentId?: string | null;
  branchFromStep?: number | null;
  /**
   * Explicit session/conversation id to resume — set when restoring a
   * checkpoint, so the provider picks up that captured session instead of
   * whatever `parentId` would otherwise resolve to (checkpoint restore isn't a
   * fork: there's no parent run, just an earlier point on this same run).
   * Only the Claude runner acts on it today; other providers ignore it (git-
   * branch continuity only).
   */
  resumeSessionId?: string | null;
  /**
   * Per-workspace provider API key, resolved by the orchestrator from the
   * secret store and injected into the runner's environment/SDK so each
   * workspace uses its own credentials. Null/absent → fall back to the ambient
   * environment (the local-dev default). Never logged.
   */
  apiKey?: string | null;
  /**
   * A Claude-COMPATIBLE endpoint to talk to instead of the vendor's own API —
   * Moonshot/Kimi, Z.ai/GLM, MiniMax, a LiteLLM proxy: anything speaking the
   * Anthropic wire protocol. Resolved by the orchestrator from the run's
   * credential (see SecretMeta.baseUrl); null/absent = the vendor's API.
   *
   * Only the Claude runner acts on it, and that's the point: routing a cheaper
   * model through the Agent SDK keeps the ENTIRE agent loop — canUseTool
   * gating, question/plan/escalation HITL, resume-with-guidance, per-model cost
   * metering — none of which the CLI-backed runners have.
   */
  baseUrl?: string | null;
  /**
   * Published per-million-token rates for (endpoint, model), resolved by the
   * orchestrator from the shared catalog. Present so a run on a compatible
   * endpoint reports REAL spend: the SDK prices everything from Claude Code's
   * own Anthropic table, which is meaningless once another vendor served the
   * tokens. Absent → keep the SDK's own figure rather than invent one.
   */
  rates?: ModelRates | null;
  /**
   * Opt-in: give the agent a real browser for this run (a Playwright/Chrome MCP
   * server exposed to the runner). Resolved by the orchestrator from the
   * per-workspace `browserTools` setting; off by default. Claude, Codex, Gemini,
   * Cursor, and Copilot all act on it; Hermes doesn't (no evidence it supports
   * MCP). Each vendor wires it its own way — see claude.ts's
   * `browserMcpServers` and cli-runner.ts's `browserMcpServerSpec` /
   * `CliVendor.prepareWorktree` for the per-vendor mechanics (some take a
   * per-invocation flag, some need a worktree-local config file). Browser
   * actions still gate through the normal HITL approval flow.
   */
  browser?: boolean;
  /**
   * Opt-in: user-configured MCP servers this run may call, resolved by the
   * orchestrator from the project's `mcpServerIds` (empty/absent = none, the
   * default — unchanged behavior). See `McpServerSpec` above for the shape and
   * the security note. Claude, Codex, Gemini, Cursor, and Copilot all wire
   * these in, merged alongside the `browser` server where both are set (see
   * cli-runner.ts's `mergeMcpConfig`/`userMcpServerEntries`); Hermes, Kimi, and
   * OpenCode have no MCP mechanism today and ignore this field.
   */
  mcpServers?: McpServerSpec[] | null;
  /**
   * Opt-in: start this run in the Claude Agent SDK's plan mode
   * (`permissionMode: "plan"`) — the agent must propose a plan and call
   * ExitPlanMode before making any edits; the runner intercepts that call and
   * raises a `plan` HITL the operator approves before writes happen. Resolved
   * by the orchestrator from the project's `planModeGate` setting, off by
   * default. Only the Claude runner acts on it today.
   */
  planModeGate?: boolean;
  /**
   * Tool names this run may never use — resolved by the orchestrator from the
   * project's `disallowedTools` setting, null/absent (the default) = no
   * restriction. Only the Claude runner acts on it today (passed straight
   * through to the SDK's own `disallowedTools`, which removes the tool from
   * the model's context entirely, not just a per-call gate) — CLI vendors
   * have no equivalent SDK primitive.
   */
  disallowedTools?: string[] | null;
  /**
   * Override the runner's default turn budget (Claude: 60) — set for a
   * deliberately short-lived run (e.g. a deep-review reviewer agent) that
   * should terminate quickly rather than run to the normal cap. Only the
   * Claude runner acts on it today.
   */
  maxTurns?: number;
  /**
   * Opt-in: this run is a "manager" (agent-hierarchy.md) — an agent whose job
   * is to decompose its area/task and delegate to worker agents rather than
   * edit code itself. Resolved by the orchestrator from the run's `Agent.role`;
   * absent/"worker" (the default) is today's plain behavior, unchanged. Only
   * the Claude runner acts on it today: it exposes a `spawn_worker` tool
   * (see `RunnerEvents.onSpawnWorker`) that a worker-role run never gets.
   */
  role?: "manager" | "worker";
}

/**
 * One piece of content the agent read from outside the operator's own task
 * during this run — a fetched URL, a vendored/dependency file — that the
 * prompt-injection-steering check (apps/server/src/injection-firewall.ts)
 * treats as untrusted. Populated only by providers that track it (today:
 * the Claude runner, via a capped in-memory buffer on the handle); absent
 * elsewhere.
 */
export interface UntrustedRead {
  /** e.g. the fetched URL, or the file path that was read. */
  source: string;
  /** Clipped excerpt of what was actually read. */
  snippet: string;
}

/**
 * Callbacks a running agent emits. The orchestrator maps these 1:1 onto the
 * `ServerEvent` union and persists as it goes.
 */
export interface RunnerEvents {
  /**
   * A log line. `detail` is optional expandable content (e.g. a tool's full
   * input/output). `meta` is additive structured info for the Run Detail
   * view's fixed verb column — `line` stays the source of truth and every
   * provider that doesn't populate `meta` still renders correctly from it.
   */
  onLog(runId: string, line: string, detail?: string, meta?: { verb?: LogVerb; resultKind?: "ok" | "error" }): void;
  /**
   * Token-level text delta for the line currently being generated — live
   * "typing" only, called far more often than onLog (once per streamed chunk,
   * not once per finished message). Optional: a provider with no token-level
   * transport just never calls it, and the UI falls back to whole-message
   * onLog jumps. Never treat this as the persisted record — onLog with the
   * complete text is still called once the message finishes; that's the only
   * write that lands in the log.
   */
  onLogDelta?(runId: string, delta: string): void;
  onProgress(runId: string, progress: number, plan: PlanStep[]): void;
  onHeartbeat(runId: string): void;
  onStatus(runId: string, status: TaskRunStatus): void;
  /**
   * TaskRun blocked on a human — orchestrator turns this into a HitlItem.
   * `untrustedReads` (when the provider tracks it) is the recent buffer of
   * content the agent read from outside the operator's own task — a fetched
   * URL, a vendored/dependency file — so the orchestrator can run the
   * prompt-injection-steering check before deciding on auto-approval. Absent
   * or empty just means "nothing to check," never a signal on its own.
   */
  onHitl(runId: string, raise: HitlRaise, untrustedReads?: UntrustedRead[]): void;
  /**
   * A manager-role run (see `StartSpec.role`) delegating a subtask — the
   * orchestrator provisions a real, first-class worker `TaskRun` under this
   * manager (own runner/worktree/branch/HITL/merge, `parentId` set to this
   * run) and returns its id. Only ever called from the `spawn_worker` tool the
   * Claude runner exposes to a manager-role run. Optional (like `onUsage`)
   * since most `RunnerEvents` consumers — every headless review/consult
   * harness in this codebase — never start a manager-role session and so
   * never need it; the real orchestrator's `events()` always supplies it.
   */
  onSpawnWorker?(runId: string, task: string, modules: string[]): Promise<{ agentId: string }>;
  onCompleted(runId: string, branch: string): void;
  /**
   * The runner could NOT execute (binary missing, auth failure, crash). This is
   * a real failure — distinct from onCompleted. The orchestrator surfaces it
   * loudly (error log + needs-attention status) and never marks the agent done
   * or merges its branch. A runner must call this, not onCompleted, when it
   * could not actually do the work.
   */
  onFailed(runId: string, reason: string): void;
  /** Reply to a `message()` (chat) — does not resolve a HITL item. */
  onChatReply(runId: string, text: string): void;
  /**
   * Token/cost telemetry, when the vendor reports it (Claude's result message
   * gives exact numbers; some CLIs surface them best-effort). Optional so a
   * provider that has no usage data — or a hand-rolled test harness — can skip
   * it. Called with the cumulative totals for the run.
   */
  onUsage?(runId: string, usage: Usage): void;
}

/** The kind-specific fields an agent supplies when it raises a HITL gate. */
export type HitlRaise = Pick<
  HitlItem,
  "kind" | "title" | "why" | "risk" | "rationale" | "command" | "options" | "recommended" | "steps" | "diff"
>;

/** A live agent the orchestrator can steer. */
export interface RunnerHandle {
  readonly runId: string;
  readonly provider: ProviderId;
  pause(): Promise<void>;
  /** Deliver an operator decision and resume; resolves a pending HITL. */
  resume(decision?: Resolution): Promise<void>;
  /** Discuss without resolving — agent keeps working; reply via onChatReply. */
  message(text: string): Promise<void>;
  stop(): Promise<void>;
  /**
   * Queue an informational note to ride the run's NEXT prompt/turn — no reply
   * expected, and critically no extra turn of its own (unlike `message`, which
   * blocks the session on a live chat round-trip). Optional: a provider that
   * has no such mechanism just doesn't implement it, and the caller (Orchestrator
   * .inform) reports the run as skipped rather than faking delivery. Where
   * implemented: Claude (the Agent SDK's `shouldQuery:false` streaming-input
   * message — appended to the transcript, merged into whichever real turn comes
   * next) and the shared CLI runner base (buffered, prepended to the next stdin
   * write the run would make anyway).
   */
  inform?(text: string): Promise<void>;
  /**
   * Best-effort snapshot of the provider's current session/conversation id —
   * for checkpointing (captured onto the `Checkpoint` record so a later restore
   * can resume it via `StartSpec.resumeSessionId`). Undefined when the provider
   * has no such concept, or none has been captured yet.
   */
  getSessionId?(): string | undefined;
}

/** A provider backend. One per vendor; all share this shape. */
/** Context for a stateless follow-up about a finished agent (no live session). */
export interface ConsultSpec {
  task: string;
  model: string;
  cwd?: string;
  apiKey?: string | null;
  /** Claude-compatible endpoint for this consult — same meaning and same
   *  credential source as {@link StartSpec.baseUrl}. Side calls (review,
   *  injection checks, digests) are a real share of spend, so they follow the
   *  runner's credential rather than always hitting the vendor API. */
  baseUrl?: string | null;
  /** Published rates for this consult's (endpoint, model) — see StartSpec.rates. */
  rates?: ModelRates | null;
  /** What the agent did — its final summary and/or recent log, for grounding. */
  context?: string;
  /**
   * Optional system framing for callers that want to control the model's ROLE and
   * output contract themselves — e.g. the Telegram intent classifier, which
   * supplies its own "You are Skynet's assistant, return {reply, action}" prompt
   * plus a data payload framed as "OPERATOR MESSAGE (untrusted)". When set, the
   * runner uses THIS as the primary framing instead of its default "finished
   * agent answering follow-ups" wrapper (the default wrapper mis-labels a caller-
   * supplied system prompt as "operator's question", which Claude then correctly
   * treats as a prompt-injection attempt). `question` remains the actual user
   * message; `context` is untrusted data to classify/ground against.
   */
  system?: string;
}

export interface RunnerProvider {
  readonly id: ProviderId;
  start(spec: StartSpec, events: RunnerEvents): Promise<RunnerHandle>;
  /**
   * Optional: answer an operator's follow-up about an already-finished agent
   * whose live handle is gone (e.g. after a server restart). A fresh one-shot,
   * tool-less query seeded from stored state — returns the answer text.
   */
  consult?(spec: ConsultSpec, question: string): Promise<string>;
  /**
   * Optional streaming variant of {@link consult}: yields the answer as text
   * deltas (token-level when the provider supports it) so the UI can render the
   * reply as it's generated. Callers fall back to `consult` (a single chunk)
   * when a provider doesn't implement this.
   */
  consultStream?(spec: ConsultSpec, question: string): AsyncIterable<string>;
}
