// ─── Preview backfill ─────────────────────────────────────────────────────
// At boot, stamp visual/previewUrl onto runs already in the store (the seed
// fixtures, a restored Postgres set) so they ride the connect-time snapshot.
// Newly-assigned runs get the same treatment inline in the orchestrator.
// No-op when the configured provider is `off`.

import { DEFAULT_WORKSPACE } from "@skynet/shared";
import type { Store } from "../store/store.js";
import { previewService } from "./service.js";

export async function backfillPreviews(
  store: Store,
  workspaceIds: string[] = [DEFAULT_WORKSPACE],
): Promise<number> {
  if (!previewService.enabled) return 0;
  let updated = 0;
  for (const ws of workspaceIds) {
    const runs = await store.listRuns(ws);
    for (const agent of runs) {
      const project = await store.getProject(agent.projectId);
      const { visual, previewUrl } = await previewService.resolve({
        workspaceId: agent.workspaceId,
        projectId: agent.projectId,
        projectName: project?.name ?? "",
        projectGoal: project?.goal ?? "",
        runId: agent.id,
        branch: agent.branch,
        seedVisual: agent.visual,
      });
      if (agent.visual === visual && agent.previewUrl === previewUrl) continue;
      await store.putRun({ ...agent, visual, previewUrl });
      updated++;
    }
  }
  return updated;
}
