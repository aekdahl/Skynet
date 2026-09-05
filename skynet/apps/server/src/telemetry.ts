// ─── Onboarding telemetry (PMF v1.5) ────────────────────────────────────────
// Anonymous, opt-out install-event telemetry for the first-run/onboarding
// path — enough signal to see where new operators drop off (create
// workspace → connect repo → add a key → add a runner → first task) without
// collecting anything identifying.
//
// Each of the 5 milestones below fires AT MOST ONCE per workspace
// (Store.recordTelemetryMilestone is the idempotency guard — see its own
// doc comment). The outbound ping carries ONLY `{event, at}`: no workspace
// id, no operator id, no project/task content, nothing that could be joined
// back to a specific install or person even if the telemetry endpoint were
// compromised. That local idempotency check never leaves this process.
//
// Best-effort throughout: telemetry must never affect the real operation
// it's observing. A failed/slow/unconfigured endpoint, a disabled workspace
// setting, or a missing config value all just mean "nothing was sent" —
// never a thrown error the caller has to handle.
import { config } from "./config.js";
import type { Store } from "./store/store.js";

export const TELEMETRY_MILESTONES = [
  "workspace_created",
  "repo_connected",
  "key_added",
  "runner_added",
  "first_task_created",
] as const;
export type TelemetryMilestone = (typeof TELEMETRY_MILESTONES)[number];

/** POST timeout — generous enough for a slow collector, short enough that a
 *  hung endpoint can never visibly delay the real request that triggered it
 *  (this is always called fire-and-forget, never awaited by the caller's
 *  response path — see each call site's own `void`). */
const TELEMETRY_TIMEOUT_MS = 5000;

/**
 * Fire one onboarding milestone for a workspace, exactly once ever. Safe to
 * call on every request that COULD be the milestone (e.g. every task
 * creation, not just literally the first) — the idempotency check is what
 * makes repeats free no-ops.
 */
export async function fireOnboardingMilestone(store: Store, workspaceId: string, kind: TelemetryMilestone): Promise<void> {
  try {
    if (config.telemetryDisabled) return;
    const settings = await store.getWorkspaceSettings(workspaceId);
    if (settings?.telemetryOptOut) return;
    const isFirst = await store.recordTelemetryMilestone(workspaceId, kind, Date.now());
    if (!isFirst) return; // this workspace already reached this milestone
    if (!config.telemetryEndpoint) return; // recorded locally either way — nothing configured to send to
    await fetch(config.telemetryEndpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ event: kind, at: Date.now() }),
      signal: AbortSignal.timeout(TELEMETRY_TIMEOUT_MS),
    });
  } catch {
    // best-effort only — never surfaces to the caller
  }
}
