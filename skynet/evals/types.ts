// ─── LLM-judged acceptance suite — types ──────────────────────────────────
// Behavioral evals: run a real agent through a scenario, capture what it did,
// have a judge model score it. See docs/llm-acceptance.md. This folder lives
// OUTSIDE the pnpm workspace on purpose — `pnpm -r` / vitest never touch it.

/** One thing the judge scores — an outcome or performance question. */
export interface Rubric {
  dimension: string;
  question: string;
}

/** How the operator responds to one HITL gate. Consumed in order (the nth gate
 *  gets the nth reply); when the list is exhausted the executor defaults to
 *  approve. This scripts cases like reject-then-revise or picking an option. */
export interface HitlReply {
  action: "approve" | "reject" | "modify" | "option";
  guidance?: string; // for modify / reject rationale
  optionIndex?: number; // for option
}

/** A behavioral test: a task for the agent + how to judge the result. */
export interface Scenario {
  id: string;
  title: string;
  category: string;
  /** What the operator asks the agent to do. */
  task: string;
  /** The governing repository policy, stated to the AGENT (folded into its
   *  instructions), the way a real repo states conventions in CONTRIBUTING /
   *  AGENTS.md. Distinct from `setup`, which is judge-facing only. Without this
   *  a safety scenario tests telepathy — the agent can't cite a policy it was
   *  never told, so it improvises a reason and the "explains" rubric misfires. */
  policy?: string;
  /** Human-readable note about the fixture/setup (shown to the judge). */
  setup?: string;
  /** Files the executor writes + commits to the repo base before the run, so
   *  the agent has something concrete to work on. Path → contents. */
  fixture?: Record<string, string>;
  /** Human-readable note about the HITL script (shown to the judge). */
  hitl?: string;
  /** Scripted operator responses to HITL gates, in order (default: approve). */
  replies?: HitlReply[];
  rubric: Rubric[];
}

/** What the executor captures from a real run for the judge to inspect. */
export interface Artifacts {
  /** `git diff` of the agent branch vs its base. */
  diff?: string;
  /** The agent's event/log lines, in order. */
  log?: string[];
  /** HITL items the agent raised (and, if resolved, how). */
  hitl?: { kind: string; title: string; why?: string; resolvedWith?: string }[];
  prOpened?: boolean;
  /** Final agent status: running | waiting | review | done | failed. */
  finalStatus?: string;
  // Performance counters (undefined if the executor didn't measure them).
  turns?: number;
  tokens?: number;
  wallMs?: number;
  /** Anything else worth handing the judge. */
  notes?: string;
}

export interface DimScore {
  dimension: string;
  score: number; // 0–5
  pass: boolean;
  rationale: string;
}

export interface Verdict {
  pass: boolean;
  overall: number; // 0–5
  dimensions: DimScore[];
  summary: string;
}

/**
 * Runs a scenario's agent to completion and returns the captured artifacts.
 * The integration point: implement this against the orchestrator (provision a
 * runner, assign the task, script HITL replies, collect the diff/log/PR).
 */
export interface Executor {
  run(scenario: Scenario): Promise<Artifacts>;
}
