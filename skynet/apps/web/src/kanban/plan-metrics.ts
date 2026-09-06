// Product Steward Phase 1 (docs/product-steward.md) — pure rollup logic for
// the project-view Plan panel (plan-panel.tsx). Deliberately does NOT define
// its own milestone structure: the project's real `Milestone` entity already
// exists and `Task`/`Feature` already link into it — this just groups them,
// matching Milestone's own doc comment ("the project's roadmap view is
// derived by grouping features + orphan tasks under their milestone").
import type { Feature, Milestone, Task } from "@skynet/shared";

export interface MilestoneTaskLink {
  task: Task;
  // true = Task.milestoneId points here directly (an orphan task, unlinkable
  // from the panel); false = inherited through the task's Feature
  // (Feature.milestoneId) — that's the feature's own setting, so the panel
  // only offers to unlink direct links, never a feature-inherited one.
  direct: boolean;
}

export interface MilestoneRollup {
  milestone: Milestone;
  /** Every task under this milestone — directly assigned (Task.milestoneId,
   *  for orphan tasks with no feature) or inherited through the task's
   *  Feature (Feature.milestoneId). A milestone with nothing under it yet
   *  still gets an entry (tasks: []) so it stays visible on the panel. */
  tasks: MilestoneTaskLink[];
}

export function rollupMilestones(milestones: Milestone[], tasks: Task[], features: Feature[]): MilestoneRollup[] {
  const featureMilestoneId = new Map(features.map((f) => [f.id, f.milestoneId]));
  return milestones.map((milestone) => ({
    milestone,
    tasks: tasks
      .filter((t) => {
        const effective = t.milestoneId ?? (t.featureId ? (featureMilestoneId.get(t.featureId) ?? null) : null);
        return effective === milestone.id;
      })
      .map((task) => ({ task, direct: task.milestoneId === milestone.id })),
  }));
}
