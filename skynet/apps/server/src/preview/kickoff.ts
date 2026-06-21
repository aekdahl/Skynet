// ─── Preview build kickoff ────────────────────────────────────────────────
// At boot, eagerly request a build for every agent already marked visual (the
// seed fixtures / a restored Postgres set), so their preview URLs are warm
// before anyone opens them. Idempotent and serialized via the builder queue;
// no-op when previews are disabled. Lazy on-demand builds (from the route)
// cover agents created after boot.

import { DEFAULT_WORKSPACE } from "@skynet/shared";
import type { Store } from "../store/store.js";
import { previewService } from "./service.js";
import { previewBuilder } from "./builder.js";

export async function kickoffPreviewBuilds(
  store: Store,
  workspaceIds: string[] = [DEFAULT_WORKSPACE],
): Promise<number> {
  if (!previewService.enabled) return 0;
  let queued = 0;
  for (const ws of workspaceIds) {
    for (const agent of await store.listAgents(ws)) {
      if (!agent.visual || !agent.previewUrl) continue;
      previewBuilder.request(agent.id, agent.branch);
      queued++;
    }
  }
  return queued;
}
