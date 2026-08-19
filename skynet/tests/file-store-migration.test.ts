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

  it("drops audit records that no longer satisfy the schema, keeps the valid ones", async () => {
    // Regression: audit rows were loaded via a raw cast (skipping the schema
    // check every other collection did), so a legacy row from an older schema
    // stayed in memory. `/api/audit` returned the mix; the client's strict
    // `.array().parse()` blew up on the first bad row and blanked the audit
    // page — every approval looked lost. Load now validates per-row.
    const good = {
      workspaceId: DEFAULT_WORKSPACE,
      hitlId: "q-1",
      runId: "run-1",
      action: "approve",
      operatorId: "op-1",
      at: 100,
      payload: { kind: "approval" },
    };
    // Missing required `runId` / `operatorId` — the older schema didn't require them.
    const legacy = { workspaceId: DEFAULT_WORKSPACE, hitlId: "q-legacy", action: "approve", at: 50 };
    const path = join(mkdtempSync(join(tmpdir(), "file-store-migration-")), "skynet-data.json");
    writeFileSync(path, JSON.stringify({ audit: [good, legacy] }));

    const store = FileStore.create(path);
    const rows = await store.listAudit(DEFAULT_WORKSPACE);
    const ids = rows.map((r) => r.hitlId);
    expect(ids).toContain("q-1");
    expect(ids).not.toContain("q-legacy");
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

  it("loads a Feature record whose PR briefing predates featureBrief (defaults to null, not dropped)", async () => {
    // featureBrief was added to MergeBriefing after some batched-feature PRs
    // already had a briefing on disk — those records have no featureBrief key
    // at all. .nullable().default(null) means this is NOT a legacy-drop case
    // like the ones above: the record must load with featureBrief === null,
    // not be rejected.
    const legacyFeature = {
      id: "f-legacy", workspaceId: DEFAULT_WORKSPACE, projectId: "p-1", name: "Old batch",
      status: "active", archived: false, createdAt: 1,
      pr: {
        number: 12, url: "https://github.com/acme/app/pull/12", repo: "acme/app",
        branch: "skynet/feature/f-legacy", base: "main", state: "open", openedAt: 1,
        // No `featureBrief` key — this is the pre-existing on-disk shape.
        briefing: { summary: "s", impact: "i", risk: "low", recommendation: "merge", rationale: "r", by: "heuristic" },
        dismissed: false,
      },
    };
    const path = join(mkdtempSync(join(tmpdir(), "file-store-migration-")), "skynet-data.json");
    writeFileSync(path, JSON.stringify({ features: [legacyFeature] }));

    const store = FileStore.create(path);
    const snap = await store.snapshot(DEFAULT_WORKSPACE);
    const feature = snap.features.find((f) => f.id === "f-legacy");
    expect(feature).toBeDefined();
    expect(feature?.pr?.briefing?.featureBrief).toBeNull();
    expect(Snapshot.safeParse(snap).success).toBe(true);
  });
});
