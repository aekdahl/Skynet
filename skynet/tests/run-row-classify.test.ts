// The global Runs dashboard's per-row classification: which bucket a run lands
// in (running/blocked/paused/done), its status label, and sort order. Locks the
// fix for a live report — a run reading "starting…" with a growing elapsed
// clock 20+ hours in. Root cause: a run whose OWN status says it's no longer
// running (e.g. `review`, left with no pending decision — see orchestrator.ts's
// fail()/gcWorktrees fix) and has no open HITL fell through to the generic
// "running" bucket, which computes elapsed since START and never stops growing
// regardless of whether anything is actually happening.
import { describe, it, expect } from "vitest";
import type { HitlItem, TaskRun } from "@skynet/shared";
import { classifyRun } from "../apps/web/src/lib/derive.js";

const NOW = 1_000_000_000;
const STALE_AFTER = 60; // seconds — matches home.tsx's STALE_HEARTBEAT_SEC

const run = (over: Partial<TaskRun> = {}): TaskRun =>
  ({
    id: "r1", workspaceId: "ws", projectId: "p1", name: "r1", status: "running",
    agentId: "a1", provider: "claude", model: "opus", branch: "agent/r1", modules: [],
    progress: 0, plan: [], usage: null, modifiedFiles: [], log: [],
    startedAt: NOW - 5_000, lastHeartbeatAt: NOW - 5_000, visual: false, previewUrl: null,
    dependsOn: [], parentId: null, branchFromStep: null, archived: false, ...over,
  }) as TaskRun;

const hitl = (over: Partial<HitlItem> = {}): HitlItem =>
  ({
    id: "q1", workspaceId: "ws", runId: "r1", kind: "diff", title: "Review", why: "",
    risk: "medium", raisedAt: NOW - 30_000, expiresAt: null, resolvedAt: null, resolution: null,
    command: null, options: null, recommended: null, steps: null, diff: null, ...over,
  }) as HitlItem;

describe("classifyRun", () => {
  it("done → 'done', sorted most-recently-finished first", () => {
    const r = classifyRun(run({ status: "done", lastHeartbeatAt: NOW - 1000 }), undefined, NOW, STALE_AFTER);
    expect(r.tag).toBe("done");
    expect(r.statusLabel).toBe("done");
  });

  it("an open HITL always wins — 'blocked', labeled by the HITL kind", () => {
    const r = classifyRun(run({ status: "running" }), hitl({ kind: "escalation" }), NOW, STALE_AFTER);
    expect(r.tag).toBe("blocked");
    expect(r.statusLabel).toBe("needs help"); // KIND_META["escalation"].label.toLowerCase()
  });

  it("paused with no HITL → 'paused'", () => {
    const r = classifyRun(run({ status: "paused", lastHeartbeatAt: NOW - 5_000 }), undefined, NOW, STALE_AFTER);
    expect(r.tag).toBe("paused");
    expect(r.statusLabel).toBe("paused");
  });

  it("a genuinely fresh running run → 'running', labeled by its current plan step", () => {
    const r = classifyRun(run({ status: "running", lastHeartbeatAt: NOW - 2_000 }), undefined, NOW, STALE_AFTER);
    expect(r.tag).toBe("running");
    expect(r.statusLabel).toBe("starting…"); // empty plan, curStep()'s own fallback
  });

  it("'running' with a stale heartbeat is left alone — the reaper's job, not the dashboard's", () => {
    // Might just be one reaper-sweep-interval away from being escalated; not a
    // dead end yet, so it stays in the normal "running" bucket.
    const r = classifyRun(
      run({ status: "running", lastHeartbeatAt: NOW - (STALE_AFTER + 30) * 1000 }),
      undefined,
      NOW,
      STALE_AFTER,
    );
    expect(r.tag).toBe("running");
  });

  it("THE FIX: a non-running status (review) with a stale heartbeat and no open HITL → 'blocked', not 'running'", () => {
    // The exact reported shape: status 'review', no HITL (the dead-end bug),
    // heartbeat frozen hours ago since the runner that would refresh it is long
    // gone. Previously fell through to 'running' — this run "isn't running and
    // won't finish on its own" is the whole point.
    const stuckHeartbeat = NOW - 20 * 60 * 60 * 1000; // 20h ago, matching the live report
    const r = classifyRun(
      run({ status: "review", startedAt: stuckHeartbeat, lastHeartbeatAt: stuckHeartbeat }),
      undefined,
      NOW,
      STALE_AFTER,
    );
    expect(r.tag).toBe("blocked");
    expect(r.statusLabel).toContain("stuck in review");
    expect(r.statusLabel).not.toContain("starting");
  });

  it("also catches a stale 'waiting' with no matching HITL (defensive — shouldn't normally happen)", () => {
    const stuckHeartbeat = NOW - 2 * 60 * 60 * 1000;
    const r = classifyRun(
      run({ status: "waiting", lastHeartbeatAt: stuckHeartbeat }),
      undefined,
      NOW,
      STALE_AFTER,
    );
    expect(r.tag).toBe("blocked");
    expect(r.statusLabel).toContain("stuck in waiting");
  });

  it("sorts a stuck-review row by how long it's been stuck, same ordering as an open HITL", () => {
    const a = classifyRun(run({ id: "a", status: "review", lastHeartbeatAt: NOW - 2 * 60 * 60 * 1000 }), undefined, NOW, STALE_AFTER);
    const b = classifyRun(run({ id: "b", status: "review", lastHeartbeatAt: NOW - 20 * 60 * 60 * 1000 }), undefined, NOW, STALE_AFTER);
    // Both "blocked"; the longer-stuck one sorts first (more negative sortKey).
    expect(b.sortKey).toBeLessThan(a.sortKey);
  });
});
