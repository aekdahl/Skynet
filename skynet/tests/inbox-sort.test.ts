// The Inbox splits into two sections — Approvals (a live gate is blocking a
// run's own progress) sort first, escalations ("Other" — the agent already
// handed back its compute, nothing's actively held up) sort after — while
// staying a SINGLE flat array so QueueView's j/k/a/r/m keyboard nav and
// `selectedIdx` keep indexing straight into it unchanged.
import { describe, it, expect } from "vitest";
import type { HitlItem } from "@skynet/shared";
import { sortForInbox } from "../apps/web/src/lib/derive.js";

const NOW = 1_000_000_000;

const item = (id: string, kind: HitlItem["kind"], waitedMs: number): HitlItem =>
  ({
    id, workspaceId: "ws", runId: id, kind, title: id, why: "",
    risk: "medium", raisedAt: NOW - waitedMs, expiresAt: null, resolvedAt: null, resolution: null,
    rationale: null, command: null, options: null, recommended: null, steps: null, diff: null,
    output: null, flags: [],
  }) as HitlItem;

describe("sortForInbox", () => {
  it("puts every non-escalation kind before every escalation, regardless of wait time", () => {
    const items = [
      item("esc-old", "escalation", 10 * 60_000), // waited longest overall
      item("diff-new", "diff", 1_000),
      item("approval-mid", "approval", 5 * 60_000),
    ];
    const sorted = sortForInbox(items, NOW);
    expect(sorted.map((i) => i.id)).toEqual(["approval-mid", "diff-new", "esc-old"]);
  });

  it("within each group, sorts longest-waiting first", () => {
    const items = [
      item("a-new", "approval", 1_000),
      item("a-old", "diff", 5 * 60_000),
      item("e-new", "escalation", 2_000),
      item("e-old", "escalation", 60_000),
    ];
    const sorted = sortForInbox(items, NOW);
    expect(sorted.map((i) => i.id)).toEqual(["a-old", "a-new", "e-old", "e-new"]);
  });

  it("all-escalations or all-approvals lists sort the same as before (no group boundary)", () => {
    const allEsc = [item("e1", "escalation", 1_000), item("e2", "escalation", 5_000)];
    expect(sortForInbox(allEsc, NOW).map((i) => i.id)).toEqual(["e2", "e1"]);
    const allApprovals = [item("a1", "approval", 1_000), item("a2", "merge", 5_000)];
    expect(sortForInbox(allApprovals, NOW).map((i) => i.id)).toEqual(["a2", "a1"]);
  });

  it("does not mutate the input array", () => {
    const items = [item("a", "escalation", 1_000), item("b", "approval", 1_000)];
    const copy = [...items];
    sortForInbox(items, NOW);
    expect(items).toEqual(copy);
  });

  it("an empty list sorts to an empty list", () => {
    expect(sortForInbox([], NOW)).toEqual([]);
  });
});
