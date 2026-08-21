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
type ContextProject = Pick<Project, "name" | "goal" | "instructions">;

export interface AgentContextOptions {
  project: ContextProject | null | undefined;
  // The Feature a task belongs to, when it belongs to one. Undefined/null both
  // mean "no feature" — callers that haven't resolved one yet can pass either.
  feature?: Feature | null;
  // S2 (not yet built): a per-project "primer" doc. Optional so this call
  // never has to be re-plumbed once S2 lands — it just starts passing data.
  primer?: string | null;
  // S8 (not yet built): the project's Solution Brief.
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
const SOLUTION_BRIEF_CHAR_CAP = 2_000;
// S3's buildSiblingDigest self-caps its own combined string at ~1.2k chars —
// this per-element cap matches that (raised from an earlier 200, sized for
// many independent one-liners) so a caller's single combined digest survives
// intact rather than getting clipped to a fifth of its own budget.
const SIBLING_CHAR_CAP = 1_200;
const MAX_SIBLINGS = 10;

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
 * (later) a primer doc, the task's Feature, (later) a Solution Brief,
 * (later) in-flight sibling summaries, and finally the task body itself.
 *
 * Sections are emitted in a FIXED order (project → instructions → primer →
 * feature → solution brief → in-flight → task) so any section can be added or
 * removed without reshuffling the ones around it, and omitted entirely when
 * there's nothing to say. When every optional section is empty, the output is
 * exactly `=== TASK ===\n<body>` — never a bare, unfenced body — so a caller
 * checking for the task text with `.toContain(...)` still finds it.
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
  let primer = opts.primer?.trim() || null;
  let siblings = (opts.siblings ?? [])
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, MAX_SIBLINGS);

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

  const taskSection = `=== TASK ===\n${body}`;

  const assemble = (): string =>
    [
      projectSection,
      instructionsSection,
      primer ? `=== PRIMER ===\n${truncateTail(primer, PRIMER_CHAR_CAP)}` : null,
      featureSection,
      briefSection,
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
