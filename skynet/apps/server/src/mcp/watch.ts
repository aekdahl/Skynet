// ─── MCP event waits ──────────────────────────────────────────────────────
// The blocking primitive behind the wait_for_* tools: an agent client calls a
// tool that parks until something happens (a HITL gate is raised, an agent
// reaches a status) instead of hot-polling. Each wait subscribes to the
// workspace's bus channel, resolves on the first matching event, and always
// unsubscribes — on match, on timeout, whichever comes first.

import type { ServerEvent } from "@skynet/shared";
import type { Bus } from "../bus.js";

/** Longest a single wait_for_* tool call may park before returning timedOut. */
export const MAX_WAIT_MS = 300_000;
export const DEFAULT_WAIT_MS = 30_000;

/**
 * Resolve with the first bus event on `workspaceId` for which `match` is true,
 * or `null` if `timeoutMs` elapses first. Never rejects; always unsubscribes.
 */
export function waitForEvent(
  bus: Bus,
  workspaceId: string,
  match: (event: ServerEvent) => boolean,
  timeoutMs: number,
): Promise<ServerEvent | null> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value: ServerEvent | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      unsubscribe();
      resolve(value);
    };
    const unsubscribe = bus.subscribe(workspaceId, (event) => {
      if (match(event)) finish(event);
    });
    const timer = setTimeout(() => finish(null), Math.min(timeoutMs, MAX_WAIT_MS));
  });
}

/** Clamp a caller-supplied timeout into the allowed range (with a default). */
export function clampWait(timeoutMs?: number): number {
  if (timeoutMs == null) return DEFAULT_WAIT_MS;
  return Math.max(1_000, Math.min(timeoutMs, MAX_WAIT_MS));
}
