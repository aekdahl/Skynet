// ─── Shared agent-context assembler ──────────────────────────────────────
// Every agent-facing prompt (assign / fork / resume / revise / escalation-
// resume / consult) is built from the SAME bounded set of sections, in the
// SAME order, so an agent reading any of these prompts always finds project
// grounding before task instructions, and task instructions before the ask
// itself. Previously each call site hand-rolled `withInstructions(...)` (or
// skipped project grounding entirely); this replaces that ad hoc wiring with
// one assembler that every call site threads through, so a new section
// (primer, solution brief, in-flight siblings) is added HERE ONCE rather than
// at every call site.
//
// Sections are optional and omitted when there's nothing to say (no goal, no
// instructions, no feature, ...) — a project that never sets any of this
// renders a prompt identical to today's bare task body.

import type { Feature, Project } from "@skynet/shared";

// Only the fields this module actually reads — decouples it from the full
// Project shape (and lets `withInstructions` below build a throwaway stand-in
// without dragging in every required Project field).
type ContextProject = Pick<Project, "name" | "goal" | "instructions" | "contextSummary">;

export interface AgentContextOptions {
  /** What the PREVIOUS agent on this run had worked out before it escalated or
   *  stalled (TaskRun.handoff). Present only on a relaunch. Placed immediately
   *  before the task so it reads as "here's where things stand", and capped —
   *  a handoff is orientation, not a transcript. */
  handoff?: string;
  project: ContextProject | null | undefined;
  // Memory v0, phase 1: operator-authored facts (workspace/project/agent-
  // family scoped — see memory-digest.ts's factsDigest), pre-formatted by the
  // caller. Treated as durable, operator-set guidance — placed right after
  // PROJECT INSTRUCTIONS, before the more dynamic sections below. Undefined/
  // null/empty all mean "no memory to inject" (no facts recorded yet, or the
  // project has no bound repo to read `.skynet/memory/` from).
  memory?: string | null;
  // The Feature a task belongs to, when it belongs to one. Undefined/null both
  // mean "no feature" — callers that haven't resolved one yet can pass either.
  feature?: Feature | null;
  // S2: an explicit override for the primer section. Rarely needed — when
  // omitted, buildAgentContext falls back to the project's own condensed
  // context (Project.contextSummary, steward/context.ts) automatically, so
  // callers don't have to individually thread it through.
  primer?: string | null;
  // S8: the SolutionBrief a task is scoped under (its approach + acceptance
  // criteria, not the full planning doc) — see Orchestrator.findTaskBrief.
  brief?: string | null;
  // S3: sibling-awareness digest(s) for "don't duplicate that work" context —
  // see buildSiblingDigest (sibling-digest.ts), which composes ongoing/review
  // siblings + recently merged + queued-up-next into ONE combined string, so
  // callers pass a single-element array (`[digest]`); the array shape stays
  // general in case a future caller wants several independent one-liners
  // instead.
  siblings?: string[] | null;
  // The task-specific ask — the one section that's always present.
  body: string;
}

// Total assembled-context budget. Generous enough that today's sections
// (project/instructions/feature/task) essentially never hit it — it exists to
// bound the LATER sections (primer, siblings) once they can carry
// unboundedly long content.
const TOTAL_CHAR_CAP = 6_000;
const PRIMER_CHAR_CAP = 2_000;
const FEATURE_DESCRIPTION_CHAR_CAP = 1_000;
/** A handoff is orientation, not a transcript — enough to skip re-deriving the
 *  situation, not enough to re-bloat the prompt it exists to shrink. */
const HANDOFF_CHAR_CAP = 1500;
const SOLUTION_BRIEF_CHAR_CAP = 1_500;
// S3's buildSiblingDigest self-caps its own combined string at ~1.2k chars —
// this per-element cap matches that (raised from an earlier 200, sized for
// many independent one-liners) so a caller's single combined digest survives
// intact rather than getting clipped to a fifth of its own budget.
const SIBLING_CHAR_CAP = 1_200;
const MAX_SIBLINGS = 10;
const MEMORY_CHAR_CAP = 1_500;

function truncateTail(text: string, cap: number): string {
  if (text.length <= cap) return text;
  return `${text.slice(0, cap)}\n… (truncated)`;
}

/** Prepend the project's `instructions` (the "house rules" for this codebase)
 *  to any prompt an agent will see. When there are no instructions this is a
 *  no-op — the prompt is returned unchanged, so runs on projects that never
 *  set the field behave exactly as they did before. The banner is fenced with
 *  a clear label so an agent that reads a stack of prompts knows what's
 *  project-scoped guidance vs. task-scoped ask.
 *
 *  Superseded by {@link buildAgentContext} for every real call site (it adds
 *  the goal/feature/primer/brief/siblings sections this function doesn't know
 *  about) — kept as a small, independently-tested primitive since it's a pure
 *  no-op-when-unset building block, and deleting it would mean re-deriving
 *  its exact semantics from buildAgentContext's fuller composition. */
export function withInstructions(instructions: string | null | undefined, body: string): string {
  const trimmed = instructions?.trim();
  if (!trimmed) return body;
  return `=== PROJECT INSTRUCTIONS (apply to every task in this project) ===\n${trimmed}\n\n=== TASK ===\n${body}`;
}

/**
 * Assemble a full agent-facing prompt from every grounding source Skynet
 * currently threads through: project name/goal, project instructions,
 * operator-authored memory facts (Memory v0), (later) a primer doc, the
 * task's Feature, (later) a Solution Brief, (later) in-flight sibling
 * summaries, and finally the task body itself.
 *
 * Sections are emitted in a FIXED order (project → instructions → memory →
 * primer → feature → solution brief → in-flight → task) so any section can be
 * added or removed without reshuffling the ones around it, and omitted
 * entirely when there's nothing to say. When every optional section is empty,
 * the output is exactly `=== TASK ===\n<body>` — never a bare, unfenced body —
 * so a caller checking for the task text with `.toContain(...)` still finds it.
 *
 * Bounded to a total character budget so an unbounded primer or a long
 * in-flight list can never balloon a prompt without limit. If the assembled
 * context runs over budget, in-flight siblings are dropped FIRST (the least
 * essential grounding — a nice-to-have, not the ask), then the primer's tail
 * is trimmed. Project instructions and the task body are never truncated.
 */
export function buildAgentContext(opts: AgentContextOptions): string {
  const { project, body } = opts;
  const feature = opts.feature ?? null;
  // S2: the operator's condensed project context (steward/context.ts,
  // Project.contextSummary) IS the primer doc this slot was reserved for —
  // every call site gets it automatically without individually threading it
  // through. An explicit `opts.primer` (none exist yet) would still win.
  let primer = opts.primer?.trim() || project?.contextSummary?.trim() || null;
  let siblings = (opts.siblings ?? [])
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, MAX_SIBLINGS);
  // Memory v0, phase 1 — operator-authored facts (memory-digest.ts's
  // factsDigest already formats+caps per-section). Deliberately NOT dropped
  // by the overflow cascade below (unlike siblings/primer) — this is
  // operator-curated content, closer in weight to project instructions than
  // to dynamically-generated grounding; MEMORY_CHAR_CAP is its only bound.
  const memory = opts.memory?.trim() || null;

  const goal = project?.goal?.trim();
  const projectSection = goal ? `=== PROJECT ===\n${project!.name}\n${goal}` : null;

  const instructions = project?.instructions?.trim();
  const instructionsSection = instructions
    ? `=== PROJECT INSTRUCTIONS (apply to every task in this project) ===\n${instructions}`
    : null;

  const featureSection = feature
    ? `=== FEATURE ===\n${feature.name}${
        feature.description?.trim() ? `\n${truncateTail(feature.description.trim(), FEATURE_DESCRIPTION_CHAR_CAP)}` : ""
      }`
    : null;

  const brief = opts.brief?.trim();
  const briefSection = brief ? `=== SOLUTION BRIEF ===\n${truncateTail(brief, SOLUTION_BRIEF_CHAR_CAP)}` : null;

  const handoffSection = opts.handoff?.trim()
    ? `=== WHERE THIS RUN LEFT OFF (from the previous agent — trust it as a starting point, verify before relying on it) ===\n${truncateTail(opts.handoff.trim(), HANDOFF_CHAR_CAP)}`
    : null;
  const taskSection = `=== TASK ===\n${body}`;

  const assemble = (): string =>
    [
      projectSection,
      instructionsSection,
      memory ? `=== MEMORY (operator-authored facts) ===\n${truncateTail(memory, MEMORY_CHAR_CAP)}` : null,
      primer ? `=== PRIMER ===\n${truncateTail(primer, PRIMER_CHAR_CAP)}` : null,
      featureSection,
      briefSection,
      handoffSection,
      siblings.length ? `=== IN FLIGHT ===\n${siblings.map((s) => truncateTail(s, SIBLING_CHAR_CAP)).join("\n")}` : null,
      taskSection,
    ]
      .filter((s): s is string => s !== null)
      .join("\n\n");

  let out = assemble();
  if (out.length <= TOTAL_CHAR_CAP) return out;

  // Over budget: drop in-flight siblings first...
  if (siblings.length) {
    siblings = [];
    out = assemble();
    if (out.length <= TOTAL_CHAR_CAP) return out;
  }
  // ...then shave the primer's tail down, in chunks, until it fits or is gone.
  while (primer && out.length > TOTAL_CHAR_CAP) {
    primer = primer.length > 500 ? primer.slice(0, primer.length - 500) : null;
    out = assemble();
  }
  return out;
}
