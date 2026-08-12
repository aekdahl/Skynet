import type {
  TaskRunStatus,
  HitlItem,
  PlanStep,
  ProviderId,
  Resolution,
  Usage,
} from "@skynet/shared";

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
   * Per-workspace provider API key, resolved by the orchestrator from the
   * secret store and injected into the runner's environment/SDK so each
   * workspace uses its own credentials. Null/absent → fall back to the ambient
   * environment (the local-dev default). Never logged.
   */
  apiKey?: string | null;
  /**
   * Opt-in: give the agent a real browser for this run (a Playwright/Chrome MCP
   * server exposed to the runner). Resolved by the orchestrator from the
   * per-workspace `browserTools` setting; off by default. Only the Claude runner
   * acts on it today — CLI runners ignore it until they grow MCP support. Browser
   * actions still gate through the normal HITL approval flow.
   */
  browser?: boolean;
  /**
   * Opt-in: start this run in the Claude Agent SDK's plan mode
   * (`permissionMode: "plan"`) — the agent must propose a plan and call
   * ExitPlanMode before making any edits; the runner intercepts that call and
   * raises a `plan` HITL the operator approves before writes happen. Resolved
   * by the orchestrator from the project's `planModeGate` setting, off by
   * default. Only the Claude runner acts on it today.
   */
  planModeGate?: boolean;
}

/**
 * Callbacks a running agent emits. The orchestrator maps these 1:1 onto the
 * `ServerEvent` union and persists as it goes.
 */
export interface RunnerEvents {
  /** A log line. `detail` is optional expandable content (e.g. a tool's full input/output). */
  onLog(runId: string, line: string, detail?: string): void;
  onProgress(runId: string, progress: number, plan: PlanStep[]): void;
  onHeartbeat(runId: string): void;
  onStatus(runId: string, status: TaskRunStatus): void;
  /** TaskRun blocked on a human — orchestrator turns this into a HitlItem. */
  onHitl(runId: string, raise: HitlRaise): void;
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
}

/** A provider backend. One per vendor; all share this shape. */
/** Context for a stateless follow-up about a finished agent (no live session). */
export interface ConsultSpec {
  task: string;
  model: string;
  cwd?: string;
  apiKey?: string | null;
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
