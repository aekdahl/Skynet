// ─── Runner resource caps ──────────────────────────────────────────────────
// A wall-clock ceiling on how long a single agent run may execute before it's
// force-stopped. This is the one resource cap enforceable WITHOUT a container:
// it bounds a runaway or hung agent (an infinite tool loop, a wedged CLI, a
// vendor process that never exits) so it can't hold its fleet slot and burn
// tokens forever. Memory/CPU/network caps need the containerized runner
// (cgroups + an egress proxy) — see docs and the ROADMAP's sandbox item.
//
// Read from the environment at the runner-sdk boundary (like SKYNET_RUNNER_
// SANDBOX) so the SDK stays independent of the server's config module.

const DEFAULT_MAX_RUNTIME_MS = 30 * 60 * 1000; // 30 min — generous for a real coding task

/**
 * The per-run wall-clock ceiling in ms, or 0 when disabled.
 * `SKYNET_RUNNER_MAX_RUNTIME_MS` overrides the default; `0` (or a non-positive /
 * non-numeric value) disables the cap entirely.
 */
export function runtimeCapMs(): number {
  const raw = process.env.SKYNET_RUNNER_MAX_RUNTIME_MS;
  if (raw == null || raw === "") return DEFAULT_MAX_RUNTIME_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

const DEFAULT_IDLE_CAP_MS = 8 * 60 * 1000; // 8 min of NO activity → presumed stalled

/**
 * The idle-stall ceiling in ms — how long a run may make NO progress (no SDK
 * message / stream event) before it's force-failed as stalled — or 0 when
 * disabled. Distinct from {@link runtimeCapMs}: the total cap is armed once and
 * bounds overall wall-clock; this one RESETS on every activity event, so it fires
 * only when the agent has genuinely gone silent (a wedged CLI, a dead stream, a
 * retry loop that never progresses) rather than while it's actively working — the
 * heartbeat is a fixed timer that keeps ticking even for a hung run, so the
 * server-side reaper can't catch this on its own.
 * `SKYNET_RUNNER_IDLE_MS` overrides; `0`/non-positive/non-numeric disables.
 */
export function idleCapMs(): number {
  const raw = process.env.SKYNET_RUNNER_IDLE_MS;
  if (raw == null || raw === "") return DEFAULT_IDLE_CAP_MS;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** A human-readable duration for the cap-exceeded failure message. */
export function fmtDuration(ms: number): string {
  if (ms % 60000 === 0) return `${ms / 60000}m`;
  if (ms >= 1000) return `${Math.round(ms / 1000)}s`;
  return `${ms}ms`;
}
