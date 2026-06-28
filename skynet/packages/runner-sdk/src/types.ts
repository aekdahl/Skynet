import type {
  AgentStatus,
  HitlItem,
  PlanStep,
  ProviderId,
  Resolution,
} from "@skynet/shared";

/** What the orchestrator hands a provider to start an agent on a task. */
export interface StartSpec {
  agentId: string;
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
}

/**
 * Callbacks a running agent emits. The orchestrator maps these 1:1 onto the
 * `ServerEvent` union and persists as it goes.
 */
export interface RunnerEvents {
  /** A log line. `detail` is optional expandable content (e.g. a tool's full input/output). */
  onLog(agentId: string, line: string, detail?: string): void;
  onProgress(agentId: string, progress: number, plan: PlanStep[]): void;
  onHeartbeat(agentId: string): void;
  onStatus(agentId: string, status: AgentStatus): void;
  /** Agent blocked on a human — orchestrator turns this into a HitlItem. */
  onHitl(agentId: string, raise: HitlRaise): void;
  onCompleted(agentId: string, branch: string): void;
  /** Reply to a `message()` (chat) — does not resolve a HITL item. */
  onChatReply(agentId: string, text: string): void;
}

/** The kind-specific fields an agent supplies when it raises a HITL gate. */
export type HitlRaise = Pick<
  HitlItem,
  "kind" | "title" | "why" | "risk" | "command" | "options" | "recommended" | "steps" | "diff"
>;

/** A live agent the orchestrator can steer. */
export interface RunnerHandle {
  readonly agentId: string;
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
}
