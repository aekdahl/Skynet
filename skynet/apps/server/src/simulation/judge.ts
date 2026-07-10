// ─── Simulation behavioral judge ───────────────────────────────────────────
// The Simulation view runs persistent operator "journeys" that drive the real
// API and assert control-plane facts deterministically. This adds an LLM review
// ON TOP of those asserts: given the journey's goal, the operator actions it
// took (steps), and the resulting board/audit state, does the outcome actually
// achieve the goal and hang together coherently? Deterministic asserts can all
// pass while the whole experience is subtly wrong (an orphaned entity, a runner
// left in a nonsense state, an audit row that doesn't match the action) — that's
// what this catches.
//
// It runs through the SAME transport a live runner + the evals judge use
// (runner-sdk `oneShotText` → the `claude` CLI): authenticates identically and
// works both standalone and nested inside a Claude Code session (where a raw
// fetch to the API has no egress). Distinct from evals/judge.ts, which grades a
// real agent's CODE diff against a rubric — this grades SYSTEM BEHAVIOR across a
// multi-step operator journey run on the mock runner.

import { oneShotText } from "@skynet/runner-sdk/claude";

export interface JourneyStep {
  label: string;
  ok: boolean;
  skip?: boolean;
  detail?: string;
}

/** What the web captures from a journey run for the judge to review. */
export interface JourneyEvidence {
  id: string;
  name: string;
  goal: string; // the journey's stated intent (its `desc`)
  steps: JourneyStep[];
  /** Sim-tagged slice of the resulting board + a recent audit tail. */
  board: unknown;
}

export interface BehaviorVerdict {
  pass: boolean;
  score: number; // 0–5, holistic
  summary: string;
  findings: string[]; // concrete observations / concerns, most important first
}

// A behavioral review is a lighter task than grading a code diff — sonnet is a
// fine default, override with the same knob the evals judge uses.
const MODEL = process.env.SKYNET_JUDGE_MODEL || "sonnet";

function prompt(e: JourneyEvidence): string {
  const steps = e.steps
    .map((s) => `- [${s.skip ? "skip" : s.ok ? "ok" : "FAIL"}] ${s.label}${s.detail ? ` — ${s.detail}` : ""}`)
    .join("\n");
  return [
    "You are a behavioral QA judge for Skynet, a console for supervising autonomous coding agents.",
    "You are reviewing one OPERATOR JOURNEY: a scripted sequence of real API actions an operator would take, run against a live server (agents execute on a mock runner). The journey already checked deterministic facts; your job is the holistic review those checks can't do.",
    "",
    "Grade ONLY on the evidence below. Judge whether the journey ACHIEVED ITS GOAL and whether the resulting system state is COHERENT — no orphaned or contradictory entities, and statuses that match the actions taken. A journey where every step 'ok' but the end state is nonsensical should NOT pass.",
    "Do not invent problems that the evidence doesn't show; if it looks correct and coherent, pass it.",
    "",
    "## What the evidence contains (don't penalize expected gaps)",
    "- The `board` is a Sim-tagged SLICE of the system (projects/tasks/agents/runners/openHitl + an audit count), not the whole store. Judge what's present; don't demand fields the slice doesn't carry.",
    "- `auditCount`/`recentAudit` is the human-in-the-loop DECISION log — it records approvals/rejections/option-picks on HITL gates, NOT routine CRUD. Creating a project, task, or runner, or stopping/archiving an agent, does NOT produce an audit row. Only expect the audit to grow when the journey actually RESOLVED a HITL gate. Absence of audit rows for pure create/lifecycle journeys is EXPECTED, not a failure.",
    "",
    `## Journey: ${e.name}`,
    `Goal: ${e.goal}`,
    "",
    "## Operator actions + deterministic checks (in order)",
    steps || "(no steps recorded)",
    "",
    "## Resulting board state (Sim-tagged entities + recent audit)",
    "```json",
    JSON.stringify(e.board, null, 2),
    "```",
    "",
    "## Output format",
    "Respond with a SINGLE JSON object and NOTHING else — no markdown, no code fence, no prose around it. Shape:",
    '{"pass": boolean, "score": number (0-5), "summary": string, "findings": [string, ...]}',
    "`pass` is true only if the journey achieved its goal AND the end state is coherent. `findings` lists concrete observations (most important first); cite specific ids/statuses from the evidence. Keep summary to one sentence.",
  ].join("\n");
}

function parseVerdict(text: string): BehaviorVerdict {
  let s = text.trim();
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) s = fenced[1].trim();
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start >= 0 && end > start) s = s.slice(start, end + 1);
  const obj = JSON.parse(s) as Record<string, unknown>;
  const findings = Array.isArray(obj.findings) ? obj.findings.map((f) => String(f)) : [];
  return {
    pass: obj.pass === true,
    score: Number(obj.score) || 0,
    summary: String(obj.summary ?? ""),
    findings,
  };
}

export async function judgeJourney(evidence: JourneyEvidence): Promise<BehaviorVerdict> {
  const out = await oneShotText({ prompt: prompt(evidence), model: MODEL });
  if (!out.trim()) throw new Error("judge returned no output (no Claude credential, or the CLI produced nothing)");
  try {
    return parseVerdict(out);
  } catch {
    // One repair pass — coerce whatever came back into the strict shape.
    const repaired = await oneShotText({
      prompt:
        "Reformat the text below into a SINGLE JSON object with exactly these keys and nothing else: " +
        "pass (boolean), score (number 0-5), summary (string), findings (array of strings).\n\n" +
        out,
      model: MODEL,
    });
    return parseVerdict(repaired);
  }
}
