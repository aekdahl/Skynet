// Auto-REVIEWED gates should NOT ping Telegram. The mechanism:
//
// A diff/merge gate on a completed run is raised via the normal path
// (`hub.raiseHitl` → `hitl.raised` event). The autonomy loop (~15s tick +
// an LLM call) then picks it up and, if the reviewer approves, resolves it.
// Naively, the Telegram bridge sent the decision card at t=0 — pinging the
// operator's phone about a decision that was about to auto-approve. The
// reported "approvals are sometimes sent to Telegram even though they've
// been auto approved."
//
// Fix: `shouldAnnounceGate` (pure) waits through the auto-review window,
// then re-checks. If the gate resolved during the buffer, `send: false`.
// This test pins the four cases the fix has to get right:
//   1) diff gate + autonomy on + resolved during window → NO send
//   2) diff gate + autonomy on + still open after window → SEND
//   3) diff gate + autonomy OFF → SEND immediately (no debounce)
//   4) non-review gate (question) → SEND immediately, no debounce path
//
// The re-check is belt-and-suspenders: even without a delay, a same-tick
// auto-resolve should be caught. Covered by case 3's variant (a resolved
// gate with autonomy off still gets suppressed by the re-check).
import { describe, it, expect } from "vitest";
import type { HitlItem } from "@skynet/shared";
import { shouldAnnounceGate } from "../apps/server/src/telegram/index.js";

const baseItem = (over: Partial<HitlItem> = {}): HitlItem => ({
  id: "q-1",
  workspaceId: "ws",
  runId: "run-1",
  kind: "diff",
  title: "Approve diff",
  why: "",
  raisedAt: 0,
  risk: "medium",
  expiresAt: null,
  resolvedAt: null,
  resolution: null,
  rationale: null,
  command: null,
  options: null,
  recommended: null,
  steps: null,
  diff: null,
  flags: [],
  ...over,
});

describe("shouldAnnounceGate — auto-approved suppression", () => {
  it("suppresses a diff gate that auto-resolves during the debounce window", async () => {
    const item = baseItem({ kind: "diff" });
    // Simulate: after `sleep(20000)` the gate is now resolved (auto-reviewer
    // approved during that window). listOpenHitl returns the item WITH
    // resolvedAt set (as `resolveHitl` would have written it).
    let slept = 0;
    const res = await shouldAnnounceGate(item, {
      getRun: async () => ({ projectId: "p-1" }),
      getProject: async () => ({ autonomy: true }),
      listOpenHitl: async () => [{ ...item, resolvedAt: 500 }],
      debounceMs: 20_000,
      sleep: async (ms) => { slept = ms; },
    });
    expect(res.send).toBe(false);
    expect(res.delayedMs).toBe(20_000);
    expect(slept).toBe(20_000); // we DID wait — the debounce is what caught it
  });

  it("sends a diff gate that stays open through the debounce window (real human gate)", async () => {
    const item = baseItem({ kind: "diff" });
    const res = await shouldAnnounceGate(item, {
      getRun: async () => ({ projectId: "p-1" }),
      getProject: async () => ({ autonomy: true }),
      listOpenHitl: async () => [item], // still unresolved after sleep
      debounceMs: 20_000,
      sleep: async () => {},
    });
    expect(res.send).toBe(true);
    expect(res.delayedMs).toBe(20_000);
  });

  it("sends a merge gate the same way it handles diffs (kinds handled symmetrically)", async () => {
    const item = baseItem({ kind: "merge" });
    const suppressed = await shouldAnnounceGate(item, {
      getRun: async () => ({ projectId: "p-1" }),
      getProject: async () => ({ autonomy: true }),
      listOpenHitl: async () => [{ ...item, resolvedAt: 1 }],
      debounceMs: 20_000,
      sleep: async () => {},
    });
    expect(suppressed.send).toBe(false);
    const kept = await shouldAnnounceGate(item, {
      getRun: async () => ({ projectId: "p-1" }),
      getProject: async () => ({ autonomy: true }),
      listOpenHitl: async () => [item],
      debounceMs: 20_000,
      sleep: async () => {},
    });
    expect(kept.send).toBe(true);
  });

  it("does NOT debounce a diff gate on an autonomy-OFF project — no auto-review can happen", async () => {
    // Autonomy off means the auto-reviewer never runs; sending immediately
    // is correct + preserves phone-notification snappiness.
    const item = baseItem({ kind: "diff" });
    let slept = -1;
    const res = await shouldAnnounceGate(item, {
      getRun: async () => ({ projectId: "p-1" }),
      getProject: async () => ({ autonomy: false }),
      listOpenHitl: async () => [item],
      debounceMs: 20_000,
      sleep: async (ms) => { slept = ms; },
    });
    expect(res.send).toBe(true);
    expect(res.delayedMs).toBe(0);
    expect(slept).toBe(-1); // sleep was NEVER called
  });

  it("does NOT debounce non-review gate kinds (question, plan, escalation, approval)", async () => {
    // Only diff/merge are candidates for auto-review. A `question` gate
    // never gets auto-approved — pinging the operator immediately is right.
    for (const kind of ["question", "plan", "escalation", "approval"] as const) {
      const item = baseItem({ kind });
      const res = await shouldAnnounceGate(item, {
        getRun: async () => ({ projectId: "p-1" }),
        getProject: async () => ({ autonomy: true }),
        listOpenHitl: async () => [item],
        debounceMs: 20_000,
        sleep: async () => { throw new Error(`sleep should not be called for kind=${kind}`); },
      });
      expect(res.send).toBe(true);
      expect(res.delayedMs).toBe(0);
    }
  });

  it("still catches a same-tick resolve via the re-check, even with debounceMs=0", async () => {
    // Belt & suspenders: the re-check runs unconditionally. If the gate was
    // resolved between "raised" and "handler ran," we skip. This case
    // covers deployments that configured debounce=0 (immediate notifications).
    const item = baseItem({ kind: "diff" });
    const res = await shouldAnnounceGate(item, {
      getRun: async () => ({ projectId: "p-1" }),
      getProject: async () => ({ autonomy: true }),
      listOpenHitl: async () => [{ ...item, resolvedAt: 1 }],
      debounceMs: 0,
      sleep: async () => {},
    });
    expect(res.send).toBe(false);
    expect(res.delayedMs).toBe(0);
  });

  it("skips (send=false) if the gate has DISAPPEARED from listOpenHitl during the window", async () => {
    // Defensive: if some other path removed the gate (unusual — HITL items
    // aren't deleted, only resolved), we err on the side of NOT sending.
    const item = baseItem({ kind: "diff" });
    const res = await shouldAnnounceGate(item, {
      getRun: async () => ({ projectId: "p-1" }),
      getProject: async () => ({ autonomy: true }),
      listOpenHitl: async () => [],
      debounceMs: 20_000,
      sleep: async () => {},
    });
    expect(res.send).toBe(false);
  });

  it("handles getRun / getProject returning null gracefully — no debounce, but re-check still runs", async () => {
    // If we can't resolve the project (e.g. the run was archived between raise
    // and this call), we can't tell if autonomy is on. Conservative: no
    // debounce (avoid stalling a real gate), but the re-check still fires.
    const item = baseItem({ kind: "diff" });
    const res = await shouldAnnounceGate(item, {
      getRun: async () => null,
      getProject: async () => null,
      listOpenHitl: async () => [item],
      debounceMs: 20_000,
      sleep: async () => { throw new Error("sleep should not be called when project can't be resolved"); },
    });
    expect(res.send).toBe(true);
    expect(res.delayedMs).toBe(0);
  });
});
