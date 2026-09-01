// ─── Steward source chips (TASK 21) ─────────────────────────────────────────
// Resolves a server-emitted SourceRef (see @skynet/shared's contracts.ts —
// the "no claim without a chip" citation Steward's reply protocol can append)
// into an actual clickable chip: a label + an href. Pure + client-side —
// the server only names WHAT is being cited (a kind + an id), never builds a
// URL string itself, since these are client hash routes
// (routing.ts's runHref/breakerPanelHref) or an external GitHub link built
// from data the client already has in its store (no second round trip).
import type { Project, SourceRef, TaskRun } from "@skynet/shared";
import { breakerPanelHref, runHref } from "./routing";

export interface SourceChip {
  kind: SourceRef["kind"];
  label: string;
  href: string;
  /** External (opens a new tab, e.g. GitHub) vs an in-app hash route. */
  external: boolean;
}

/** Resolve one SourceRef against the client's already-loaded store data.
 *  Returns null when the referenced entity is gone (a deleted run/project) —
 *  the caller drops it rather than rendering a dead link. */
export function resolveSourceChip(
  ref: SourceRef,
  runs: TaskRun[],
  projects: Project[],
): SourceChip | null {
  switch (ref.kind) {
    case "run": {
      const run = runs.find((r) => r.id === ref.runId);
      if (!run) return null;
      return { kind: "run", label: `run ${shortId(run.id)}`, href: runHref(run.id), external: false };
    }
    case "commit": {
      const run = runs.find((r) => r.id === ref.runId);
      if (!run) return null;
      const project = projects.find((p) => p.id === run.projectId);
      // The run's own PR page once one exists; before that, its branch on
      // GitHub — either way "the commit" means "what actually landed for
      // this run," not a bare sha Steward has no reliable way to know.
      if (run.pr?.url) return { kind: "commit", label: `PR #${run.pr.number}`, href: run.pr.url, external: true };
      if (project?.repo && run.branch) {
        return { kind: "commit", label: run.branch, href: `https://github.com/${project.repo}/tree/${run.branch}`, external: true };
      }
      return null;
    }
    case "breaker": {
      const project = projects.find((p) => p.id === ref.projectId);
      if (!project) return null;
      return { kind: "breaker", label: `${project.name} breaker`, href: breakerPanelHref(project.id), external: false };
    }
  }
}

/** Resolve a whole citation list, dropping anything that no longer resolves —
 *  never a broken chip. */
export function resolveSourceChips(refs: SourceRef[], runs: TaskRun[], projects: Project[]): SourceChip[] {
  return refs.flatMap((r) => {
    const chip = resolveSourceChip(r, runs, projects);
    return chip ? [chip] : [];
  });
}

function shortId(id: string): string {
  // "r-abc123def" → "#abc123" — short enough for a ghost-pill chip, still
  // enough to eyeball-match against the full id shown elsewhere (run detail,
  // audit rows) without a lookup table.
  const tail = id.replace(/^r-/, "");
  return `#${tail.slice(0, 8)}`;
}
