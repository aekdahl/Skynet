import type { HitlItem, TaskRun } from "@skynet/shared";
import { useStore } from "../lib/store";
import { DiffView } from "../components/diff-view";
import { useConfirm } from "../components/confirm";

const providerLabel = (run: TaskRun): string => `${run.provider} · ${run.model}`;

// Cross-vendor consensus run comparison — N sibling TaskRuns sharing one
// `bakeoffId` (same task, same base commit, different providers), each
// rendered with its own diff column. Picking a winner is just approving that
// sibling's own `diff` HITL (deliver()'s collapseBakeoff then retires every
// other sibling and repoints the task) — there's no separate "pick" endpoint.
//
// Derived entirely from `bakeoffId` (not taskId): TaskRun.bakeoffId is never
// cleared once set, even after a winner is picked, so this view still renders
// correctly (read-only) after the fact — Task.bakeoffId, by contrast, IS
// cleared on resolution, which is why the route carries the group id instead.
export function BakeoffView({ bakeoffId, onBack, onOpenTask }: { bakeoffId: string; onBack: () => void; onOpenTask: (runId: string) => void }) {
  const { runs, queue, tasks, resolveHitl } = useStore();
  const confirm = useConfirm();
  const siblings = runs.filter((r) => r.bakeoffId === bakeoffId).sort((a, b) => a.startedAt - b.startedAt);
  const task = tasks.find((t) => t.bakeoffId === bakeoffId) ?? null;
  const resolved = siblings.length > 0 && !task; // every sibling ended up NOT owning the task → someone already won

  if (siblings.length === 0) {
    return (
      <section className="queue">
        <div className="vw-head">
          <button className="btn btn-ghost btn-back" onClick={onBack}>← Back</button>
          <h1>Bake-off</h1>
          <p>This bake-off's runs are gone (retired or never existed).</p>
        </div>
      </section>
    );
  }

  const openDiffFor = (runId: string): HitlItem | undefined =>
    queue.find((h) => h.runId === runId && h.kind === "diff" && !h.resolvedAt);

  const pick = async (run: TaskRun) => {
    const hitl = openDiffFor(run.id);
    if (!hitl) return;
    const ok = await confirm({
      title: `Pick ${providerLabel(run)}?`,
      body: `This merges ${providerLabel(run)}'s diff and retires the other ${siblings.length - 1} contestant${siblings.length - 1 === 1 ? "" : "s"} — their worktrees and branches go away. This can't be undone.`,
      confirmLabel: "Pick this one",
    });
    if (!ok) return;
    await resolveHitl(hitl.id, "approve");
  };

  return (
    <section className="queue">
      <div className="vw-head">
        <button className="btn btn-ghost btn-back" onClick={onBack}>← Back</button>
        <h1>Bake-off — {siblings[0]!.name}</h1>
        <p>
          {resolved
            ? "Resolved — a winner was already picked. Shown here for reference."
            : `${siblings.length} providers, same task, same base commit. Review each diff and pick a winner — the rest retire automatically.`}
        </p>
      </div>
      <div className="bakeoff-grid">
        {siblings.map((run) => {
          const hitl = openDiffFor(run.id);
          const isWinner = task ? task.runId === run.id : run.status !== "done" || !!run.mergedAt;
          return (
            <div key={run.id} className="bakeoff-col">
              <div className="bakeoff-col-head">
                <button className="bakeoff-col-title" onClick={() => onOpenTask(run.id)} title="Open this run">
                  {providerLabel(run)}
                </button>
                <span className="bakeoff-col-status mono">{run.status}</span>
              </div>
              {hitl?.diff ? (
                <DiffView
                  runId={run.id}
                  add={hitl.diff.add}
                  del={hitl.diff.del}
                  walkthrough={hitl.diff.walkthrough}
                  mergeBrief={hitl.diff.mergeBrief}
                  defaultOpen
                />
              ) : (
                <p className="dv-empty">
                  {run.status === "done" ? (isWinner ? "Picked — merged." : "Retired — lost this bake-off.") : "Still running…"}
                </p>
              )}
              {hitl && !resolved && (
                <button className="btn btn-primary bakeoff-pick" onClick={() => void pick(run)}>
                  Pick this one →
                </button>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
