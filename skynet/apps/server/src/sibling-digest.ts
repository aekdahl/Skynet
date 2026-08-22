// ─── Sibling-awareness digest (S3) ───────────────────────────────────────────
// Every agent starting fresh work on a project is otherwise blind to what its
// siblings are doing RIGHT NOW — two agents can independently pick up
// overlapping work and collide at merge time. Everything needed to warn an
// agent about that is already in the store (tasks by state, runs, `mergedAt`)
// — no LLM call, this is a pure derivation, wired into buildAgentContext's
// `siblings` field (S1) at run-start call sites (see orchestrator.ts).
//
// A snapshot at run-start, not a live feed: the digest is built once when the
// agent's prompt is assembled and never updated mid-run (the `inform` seam
// exists if a future task wants mid-run nudges — out of scope here).

import type { Feature, Project, Task, TaskRun } from "@skynet/shared";

const HARD_CAP = 1_200;
const TEXT_SNIPPET = 80;
const MAX_MERGED = 5;
const MAX_QUEUED = 3;

const INSTRUCTION =
  "If your task overlaps work listed above, prefer building on it over duplicating it; flag genuine conflicts via escalation.";

const snippet = (s: string): string => (s.length > TEXT_SNIPPET ? `${s.slice(0, TEXT_SNIPPET)}…` : s);

/** Join candidate line groups (ongoing/review, merged, queued) plus the fixed
 *  instruction line — the one thing that's never dropped. */
function assemble(ongoing: string[], merged: string[], queued: string[]): string {
  return [...ongoing, ...merged, ...queued, INSTRUCTION].join("\n");
}

/**
 * A short, pure digest of what else is happening on `project` right now, for
 * an agent about to start work on a DIFFERENT task (`excludeTaskId`) in the
 * same project — three sections, in priority order (most collision-relevant
 * first):
 *   1. Ongoing/review siblings — tasks another agent is actively working, or
 *      whose work is awaiting review. The direct "don't duplicate this" signal.
 *   2. Recently merged — the last few tasks that already landed, for context
 *      on what the project just gained.
 *   3. Queued up next — the top of the backlog, so a fresh agent knows what's
 *      about to be picked up after it.
 * Returns "" when the project has no siblings worth mentioning at all (a
 * caller checking `.trim()` truthiness can skip the section entirely — never
 * renders just the bare instruction line with nothing to instruct about).
 *
 * Hard-capped at ~1.2k chars. Over budget, content is dropped in REVERSE
 * priority order — queued first, then merged, then (if still over) the tail
 * of the ongoing/review list — but the instruction line always survives.
 */
export function buildSiblingDigest(
  project: Pick<Project, "id">,
  tasks: Task[],
  runs: TaskRun[],
  excludeTaskId: string,
  features: Feature[] = [],
): string {
  const featureName = (id: string | null | undefined): string | null =>
    id ? (features.find((f) => f.id === id)?.name ?? null) : null;

  const ongoingTasks = tasks.filter(
    (t) => t.projectId === project.id && t.id !== excludeTaskId && !t.archived && (t.state === "ongoing" || t.state === "review"),
  );
  const mergedRuns = runs
    .filter((r) => r.projectId === project.id && r.mergedAt != null)
    // Defense in depth: a run whose OWN task is the one about to start
    // shouldn't describe itself as a "sibling" (shouldn't happen in practice —
    // a task with a merged run is already `done` — but never assume).
    .filter((r) => !tasks.some((t) => t.id === excludeTaskId && t.runId === r.id))
    .sort((a, b) => (b.mergedAt ?? 0) - (a.mergedAt ?? 0))
    .slice(0, MAX_MERGED);
  const queuedTasks = tasks
    .filter((t) => t.projectId === project.id && t.id !== excludeTaskId && !t.archived && t.state === "todo")
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    .slice(0, MAX_QUEUED);

  if (!ongoingTasks.length && !mergedRuns.length && !queuedTasks.length) return "";

  const ongoingLines = ongoingTasks.map((t) => {
    const fn = featureName(t.featureId);
    return `- "${snippet(t.text)}" (${t.state}${fn ? `, Feature: ${fn}` : ""})`;
  });
  const mergedLines = mergedRuns.map((r) => `- "${snippet(r.name)}" (merged)`);
  const queuedLines = queuedTasks.map((t) => `- "${snippet(t.text)}" (queued next)`);

  let out = assemble(ongoingLines, mergedLines, queuedLines);
  if (out.length <= HARD_CAP) return out;

  // Over budget: drop least-important content first. Queued (future work) —
  let queued = queuedLines;
  while (queued.length && assemble(ongoingLines, mergedLines, queued).length > HARD_CAP) queued = queued.slice(0, -1);
  out = assemble(ongoingLines, mergedLines, queued);
  if (out.length <= HARD_CAP) return out;

  // ...then merged (historical context) —
  let merged = mergedLines;
  while (merged.length && assemble(ongoingLines, merged, queued).length > HARD_CAP) merged = merged.slice(0, -1);
  out = assemble(ongoingLines, merged, queued);
  if (out.length <= HARD_CAP) return out;

  // ...then, only if STILL over, the tail of ongoing/review itself. The
  // instruction line (baked into assemble()) always survives regardless.
  let ongoing = ongoingLines;
  while (ongoing.length && assemble(ongoing, merged, queued).length > HARD_CAP) ongoing = ongoing.slice(0, -1);
  return assemble(ongoing, merged, queued);
}
