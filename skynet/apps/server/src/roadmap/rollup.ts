// ─── Workspace roadmap roll-up (Phase 29 — TASK 32) ─────────────────────────
// Pure aggregation over a project's already-parsed RoadmapDoc — no store/live
// access here, so it's unit-testable without a repo or a database. See
// packages/shared/src/roadmap-doc.ts for the shapes this produces.

import type { Project, RoadmapProposal } from "@skynet/shared";
import type { RoadmapChecklistItemNode, RoadmapDoc, RoadmapDriftVerdict, RoadmapMilestoneGroup, RoadmapMilestoneRepoBar, RoadmapRollupRow, RoadmapSection } from "@skynet/shared";

function checklistLines(doc: RoadmapDoc): RoadmapChecklistItemNode[] {
  return doc.ast.filter((n): n is RoadmapChecklistItemNode => n.type === "checklistItem");
}

/**
 * A section's own risk verdict, derived ONLY from its lines' own
 * RoadmapLine.forecast (TASK 31's field to populate — every real doc today
 * has `forecast: null` on every line, so this always reads "unknown" until
 * then; see the field's own doc comment). Never inferred from anything else —
 * a missing signal stays "unknown", not guessed at.
 */
export function driftVerdictFor(lines: RoadmapChecklistItemNode[]): RoadmapDriftVerdict {
  const forecasted = lines.filter((l) => l.forecast != null);
  if (forecasted.length === 0) return "unknown";
  return forecasted.some((l) => l.forecast!.confidence === "low") ? "at_risk" : "on_track";
}

/** One project's whole-doc summary — the repo table's row. */
export function computeRollupRow(
  project: Pick<Project, "id" | "name" | "repo">,
  doc: RoadmapDoc,
  proposalCount: number,
  atRiskReason: string | null,
): RoadmapRollupRow {
  const lines = checklistLines(doc);
  return {
    projectId: project.id,
    projectName: project.name,
    repo: project.repo ?? null,
    path: doc.path,
    syncState: doc.syncState,
    lineCount: lines.length,
    withTasksCount: lines.filter((l) => l.taskIds.length > 0).length,
    withCriteriaCount: lines.filter((l) => l.acceptanceCriteria != null).length,
    doneCount: lines.filter((l) => l.state === "done").length,
    drift: driftVerdictFor(lines),
    proposalCount,
    atRiskReason,
  };
}

/** One project's contribution to a single milestone (section) bar. */
function computeRepoBar(
  project: Pick<Project, "id" | "name" | "repo">,
  doc: RoadmapDoc,
  section: RoadmapSection,
  atRiskReason: string | null,
): RoadmapMilestoneRepoBar {
  const ids = new Set(section.lineIds);
  const lines = checklistLines(doc).filter((l) => ids.has(l.id));
  return {
    projectId: project.id,
    projectName: project.name,
    repo: project.repo ?? null,
    lineCount: lines.length,
    doneCount: lines.filter((l) => l.state === "done").length,
    drift: driftVerdictFor(lines),
    atRiskReason,
  };
}

/**
 * Group by milestone NAME — a plain, trimmed string match against each
 * project's own `##` section heading, per the confirmed decision (no new
 * stored cross-repo entity). Only a heading shared by 2+ projects becomes a
 * group; a heading unique to one repo (or the null preamble "section")
 * never appears here at all.
 */
export function groupMilestones(
  entries: Array<{ project: Pick<Project, "id" | "name" | "repo">; doc: RoadmapDoc; atRiskReason: string | null }>,
): RoadmapMilestoneGroup[] {
  const byName = new Map<string, RoadmapMilestoneRepoBar[]>();
  for (const { project, doc, atRiskReason } of entries) {
    for (const section of doc.sections) {
      const name = section.heading?.trim();
      if (!name) continue;
      const bar = computeRepoBar(project, doc, section, atRiskReason);
      if (bar.lineCount === 0) continue; // an empty section under that heading isn't a real contribution
      const bucket = byName.get(name) ?? [];
      bucket.push(bar);
      byName.set(name, bucket);
    }
  }
  const groups: RoadmapMilestoneGroup[] = [];
  for (const [name, repos] of byName) {
    // Distinct PROJECTS, not distinct bars — a project can't contribute the
    // same heading twice (RoadmapSection ids are unique per doc), but this
    // guards the intent explicitly rather than relying on that invariant.
    if (new Set(repos.map((r) => r.projectId)).size < 2) continue;
    groups.push({ name, repos, mostAtRiskProjectId: mostAtRisk(repos) });
  }
  return groups.sort((a, b) => a.name.localeCompare(b.name));
}

/** The repo most likely to miss: an "at_risk" verdict first, else the first
 *  with a real (non-fabricated) at-risk reason, else null. */
function mostAtRisk(repos: RoadmapMilestoneRepoBar[]): string | null {
  return (repos.find((r) => r.drift === "at_risk") ?? repos.find((r) => r.atRiskReason != null))?.projectId ?? null;
}

/** Open + held_conflict proposals — the ones still actually pending a
 *  decision; approved/rejected/superseded are history, not a live count. */
export function pendingProposalCount(proposals: RoadmapProposal[]): number {
  return proposals.filter((p) => p.state === "open" || p.state === "held_conflict").length;
}
