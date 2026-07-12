// The agentId→runId rename on HitlItem shipped without a data migration, so a
// file store written before it holds queue items with `agentId` and no `runId`.
// The Snapshot contract now requires runId and the client parses the snapshot
// atomically — so one legacy item blanked the whole UI ("Connecting…" forever).
// FileStore.load() now backfills runId from the legacy agentId and drops any
// item that still can't satisfy the contract. These lock that in.
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_WORKSPACE, HitlItem, Snapshot } from "@skynet/shared";
import { FileStore } from "../apps/server/src/store/file.js";

const legacyItem = {
  id: "q-legacy-1",
  workspaceId: DEFAULT_WORKSPACE,
  agentId: "run-42", // legacy field — pre agentId→runId rename, no runId present
  kind: "approval",
  title: "Approve: Edit",
  why: "wants to edit a file",
  risk: "medium",
  raisedAt: 1,
};

function storeFileWith(queue: unknown[]): string {
  const path = join(mkdtempSync(join(tmpdir(), "file-store-migration-")), "skynet-data.json");
  writeFileSync(path, JSON.stringify({ queue }));
  return path;
}

describe("FileStore legacy HITL migration", () => {
  it("backfills runId from the legacy agentId so the snapshot satisfies the contract", async () => {
    const store = FileStore.create(storeFileWith([legacyItem]));
    const snap = await store.snapshot(DEFAULT_WORKSPACE);

    expect(snap.queue).toHaveLength(1);
    expect(snap.queue[0].runId).toBe("run-42");
    expect(HitlItem.safeParse(snap.queue[0]).success).toBe(true);
    // The client parses the whole snapshot atomically — it must validate.
    expect(Snapshot.safeParse(snap).success).toBe(true);
  });

  it("drops an unrepairable HITL item rather than wedging the whole store", async () => {
    const good = { ...legacyItem, id: "q-good", runId: "run-1" };
    const broken = { id: "q-broken", workspaceId: DEFAULT_WORKSPACE }; // no runId/agentId, missing required fields
    const store = FileStore.create(storeFileWith([good, broken]));
    const snap = await store.snapshot(DEFAULT_WORKSPACE);

    const ids = snap.queue.map((q) => q.id);
    expect(ids).toContain("q-good");
    expect(ids).not.toContain("q-broken");
    expect(Snapshot.safeParse(snap).success).toBe(true);
  });

  it("drops a task whose state the enum no longer allows (e.g. legacy 'assigned')", async () => {
    // Real regression: persistent sim data held a task in state "assigned" after
    // the state enum switched to the kanban pipeline — one such row blanked the app.
    const good = { id: "t-good", workspaceId: DEFAULT_WORKSPACE, projectId: "p-1", text: "ok", state: "ongoing", runId: "r-1", order: 0 };
    const legacy = { id: "t-assigned", workspaceId: DEFAULT_WORKSPACE, projectId: "p-1", text: "Sim: task", state: "assigned", runId: "r-2", order: 0 };
    const path = join(mkdtempSync(join(tmpdir(), "file-store-migration-")), "skynet-data.json");
    writeFileSync(path, JSON.stringify({ tasks: [good, legacy] }));

    const snap = await FileStore.create(path).snapshot(DEFAULT_WORKSPACE);
    const ids = snap.tasks.map((t) => t.id);
    expect(ids).toContain("t-good");
    expect(ids).not.toContain("t-assigned");
    expect(Snapshot.safeParse(snap).success).toBe(true);
  });
});
