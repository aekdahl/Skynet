// SolutionBrief: the persistent pre-work planning doc (S4). Exercises the full
// Operations path (validation, workspace-scoped existence checks, the
// server-side approval stamp) against a real MemoryStore + Hub — no fleet, no
// HTTP. The approval-stamp SCOPE rule (agent-scoped tokens can't approve) is
// enforced at the HTTP/MCP boundary, not here — see solution-brief-routes.test.ts.
import { describe, it, expect } from "vitest";
import type { ProviderId, ServerEvent } from "@skynet/shared";
import { DEFAULT_WORKSPACE } from "@skynet/shared";
import { Hub } from "../apps/server/src/hub.js";
import { Orchestrator } from "../apps/server/src/orchestrator.js";
import { NotFoundError, Operations } from "../apps/server/src/operations.js";
import { MemoryStore } from "../apps/server/src/store/memory.js";
import type { Bus } from "../apps/server/src/bus.js";
import type { RunnerEvents, RunnerHandle, RunnerProvider, StartSpec } from "@skynet/runner-sdk";

class RecordingBus implements Bus {
  events: { ws: string; event: ServerEvent }[] = [];
  publish(ws: string, event: ServerEvent): void { this.events.push({ ws, event }); }
  subscribe(): () => void { return () => {}; }
}

class NoopProvider implements RunnerProvider {
  readonly id: ProviderId = "claude";
  async start(spec: StartSpec, _e: RunnerEvents): Promise<RunnerHandle> {
    return { runId: spec.runId, provider: this.id, async pause() {}, async resume() {}, async message() {}, async stop() {} };
  }
}

const setup = () => {
  const store = new MemoryStore();
  const bus = new RecordingBus();
  const hub = new Hub(store, bus);
  const orchestrator = new Orchestrator(store, hub, new NoopProvider());
  const ops = new Operations({ store, hub, orchestrator });
  return { store, hub, bus, ops };
};

const mkProject = async (ops: Operations) =>
  ops.createProject(DEFAULT_WORKSPACE, { name: "P", goal: "ship" });

describe("SolutionBrief", () => {
  it("creates a brief under a project with draft status, publishes solutionBrief.upserted", async () => {
    const { ops, bus } = setup();
    const project = await mkProject(ops);
    const brief = await ops.createBrief(DEFAULT_WORKSPACE, project.id, {
      title: "Reconcile webhooks",
      problem: "double-posts on retry",
      approach: "idempotency key",
      optionsConsidered: [{ name: "unique constraint", verdict: "chosen", why: "cheap" }],
      risks: ["needs a migration"],
      acceptanceCriteria: ["no dupes on replay"],
      openQuestions: ["backfill?"],
    });
    expect(brief.projectId).toBe(project.id);
    expect(brief.title).toBe("Reconcile webhooks");
    expect(brief.status).toBe("draft");
    expect(brief.featureId).toBeNull();
    expect(brief.approvedAt).toBeNull();
    expect(brief.approvedBy).toBeNull();
    expect(brief.createdAt).toBe(brief.updatedAt); // fresh record
    const upserts = bus.events.filter((e) => e.event.type === "solutionBrief.upserted");
    expect(upserts.length).toBe(1);
    expect(await ops.listBriefs(DEFAULT_WORKSPACE)).toHaveLength(1);
  });

  it("defaults problem/approach/arrays when omitted", async () => {
    const { ops } = setup();
    const project = await mkProject(ops);
    const brief = await ops.createBrief(DEFAULT_WORKSPACE, project.id, { title: "Bare" });
    expect(brief.problem).toBe("");
    expect(brief.approach).toBe("");
    expect(brief.optionsConsidered).toEqual([]);
    expect(brief.risks).toEqual([]);
    expect(brief.acceptanceCriteria).toEqual([]);
    expect(brief.openQuestions).toEqual([]);
  });

  it("caps sourceConversation at 500 chars, trimmed", async () => {
    const { ops } = setup();
    const project = await mkProject(ops);
    const long = "x".repeat(1000);
    const brief = await ops.createBrief(DEFAULT_WORKSPACE, project.id, { title: "T", sourceConversation: `  ${long}  ` });
    expect(brief.sourceConversation).toHaveLength(500);
    expect(brief.sourceConversation).toBe(long.slice(0, 500));
  });

  it("404s creating a brief under a foreign-workspace project", async () => {
    const { ops } = setup();
    await expect(ops.createBrief(DEFAULT_WORKSPACE, "no-such-project", { title: "T" }))
      .rejects.toThrow(NotFoundError);
  });

  it("rejects cross-project featureId on create and update", async () => {
    const { ops } = setup();
    const p1 = await mkProject(ops);
    const p2 = await ops.createProject(DEFAULT_WORKSPACE, { name: "Other", goal: "" });
    const wrong = await ops.createFeature(DEFAULT_WORKSPACE, p2.id, { name: "In p2" });
    await expect(ops.createBrief(DEFAULT_WORKSPACE, p1.id, { title: "T", featureId: wrong.id }))
      .rejects.toThrow(NotFoundError);

    const brief = await ops.createBrief(DEFAULT_WORKSPACE, p1.id, { title: "T" });
    await expect(ops.updateBrief(DEFAULT_WORKSPACE, brief.id, { featureId: wrong.id }, "op-1"))
      .rejects.toThrow(NotFoundError);
  });

  it("links a brief to a feature in the same project (and clears it)", async () => {
    const { ops } = setup();
    const project = await mkProject(ops);
    const feature = await ops.createFeature(DEFAULT_WORKSPACE, project.id, { name: "F" });
    const brief = await ops.createBrief(DEFAULT_WORKSPACE, project.id, { title: "T" });
    const linked = await ops.updateBrief(DEFAULT_WORKSPACE, brief.id, { featureId: feature.id }, "op-1");
    expect(linked.featureId).toBe(feature.id);
    const cleared = await ops.updateBrief(DEFAULT_WORKSPACE, brief.id, { featureId: null }, "op-1");
    expect(cleared.featureId).toBeNull();
  });

  it("PATCH semantics: omitting a field leaves it untouched", async () => {
    const { ops } = setup();
    const project = await mkProject(ops);
    const brief = await ops.createBrief(DEFAULT_WORKSPACE, project.id, { title: "T", problem: "original problem" });
    const patched = await ops.updateBrief(DEFAULT_WORKSPACE, brief.id, { title: "Renamed" }, "op-1");
    expect(patched.title).toBe("Renamed");
    expect(patched.problem).toBe("original problem"); // untouched
  });

  it("bumps updatedAt on every patch", async () => {
    const { ops } = setup();
    const project = await mkProject(ops);
    const brief = await ops.createBrief(DEFAULT_WORKSPACE, project.id, { title: "T" });
    await new Promise((r) => setTimeout(r, 2));
    const patched = await ops.updateBrief(DEFAULT_WORKSPACE, brief.id, { title: "T2" }, "op-1");
    expect(patched.updatedAt).toBeGreaterThan(brief.createdAt);
  });

  // ── the server-side approval stamp ──────────────────────────────────────
  describe("approval stamping (server-side only)", () => {
    it("stamps approvedAt/approvedBy on the draft → approved transition, using the CALLER'S operatorId", async () => {
      const { ops } = setup();
      const project = await mkProject(ops);
      const brief = await ops.createBrief(DEFAULT_WORKSPACE, project.id, { title: "T" });
      const before = Date.now();
      const approved = await ops.updateBrief(DEFAULT_WORKSPACE, brief.id, { status: "approved" }, "jordan");
      expect(approved.status).toBe("approved");
      expect(approved.approvedBy).toBe("jordan");
      expect(approved.approvedAt).toBeGreaterThanOrEqual(before);
    });

    it("never re-stamps on a later edit while already approved", async () => {
      const { ops } = setup();
      const project = await mkProject(ops);
      const brief = await ops.createBrief(DEFAULT_WORKSPACE, project.id, { title: "T" });
      const approved = await ops.updateBrief(DEFAULT_WORKSPACE, brief.id, { status: "approved" }, "jordan");
      // A different operator edits the title afterward — approval provenance
      // must not silently change hands.
      const edited = await ops.updateBrief(DEFAULT_WORKSPACE, brief.id, { title: "renamed" }, "someone-else");
      expect(edited.approvedBy).toBe("jordan");
      expect(edited.approvedAt).toBe(approved.approvedAt);
    });

    it("moving PAST approved (building/done) does not clear the approval record", async () => {
      const { ops } = setup();
      const project = await mkProject(ops);
      const brief = await ops.createBrief(DEFAULT_WORKSPACE, project.id, { title: "T" });
      const approved = await ops.updateBrief(DEFAULT_WORKSPACE, brief.id, { status: "approved" }, "jordan");
      const building = await ops.updateBrief(DEFAULT_WORKSPACE, brief.id, { status: "building" }, "op-2");
      expect(building.status).toBe("building");
      expect(building.approvedBy).toBe("jordan"); // history preserved
      expect(building.approvedAt).toBe(approved.approvedAt);
    });

    it("a client cannot supply approvedAt/approvedBy — UpdateSolutionBriefRequest has no such fields", async () => {
      const { ops } = setup();
      const project = await mkProject(ops);
      const brief = await ops.createBrief(DEFAULT_WORKSPACE, project.id, { title: "T" });
      // Simulate a malicious/confused client stuffing extra keys into the
      // patch object — TS wouldn't allow this through UpdateSolutionBriefRequest
      // normally, but the route handler parses raw JSON through the zod
      // schema first, which silently drops unknown keys (zod's default,
      // non-strict parse) before this method ever sees them. This asserts
      // the OPERATIONS-layer contract: even if a caller passed something
      // extra through here directly, only a real "approved" transition (via
      // the typed `status` field) ever sets the stamp.
      const patched = await ops.updateBrief(
        DEFAULT_WORKSPACE,
        brief.id,
        { title: "still draft" } as Parameters<typeof ops.updateBrief>[2],
        "op-1",
      );
      expect(patched.status).toBe("draft");
      expect(patched.approvedAt).toBeNull();
      expect(patched.approvedBy).toBeNull();
    });
  });

  it("deletes a brief", async () => {
    const { ops, store } = setup();
    const project = await mkProject(ops);
    const brief = await ops.createBrief(DEFAULT_WORKSPACE, project.id, { title: "Doomed" });
    await ops.deleteBrief(DEFAULT_WORKSPACE, brief.id);
    expect(await store.getSolutionBrief(brief.id)).toBeUndefined();
  });

  it("404s update/delete/get for a foreign-workspace brief", async () => {
    const { ops, store } = setup();
    await store.putSolutionBrief({
      id: "sb-foreign", workspaceId: "other", projectId: "elsewhere", title: "Other's",
      problem: "", approach: "", optionsConsidered: [], risks: [], acceptanceCriteria: [],
      openQuestions: [], status: "draft", featureId: null, createdAt: 0, updatedAt: 0,
      approvedAt: null, approvedBy: null, sourceConversation: null,
    });
    await expect(ops.getBrief(DEFAULT_WORKSPACE, "sb-foreign")).rejects.toThrow(NotFoundError);
    await expect(ops.updateBrief(DEFAULT_WORKSPACE, "sb-foreign", { title: "x" }, "op-1")).rejects.toThrow(NotFoundError);
    await expect(ops.deleteBrief(DEFAULT_WORKSPACE, "sb-foreign")).rejects.toThrow(NotFoundError);
  });

  it("scopes reads to the caller's workspace (other-workspace briefs stay hidden)", async () => {
    const { ops, store } = setup();
    const project = await mkProject(ops);
    await ops.createBrief(DEFAULT_WORKSPACE, project.id, { title: "Mine" });
    await store.putSolutionBrief({
      id: "sb-foreign2", workspaceId: "other", projectId: "elsewhere", title: "Other's",
      problem: "", approach: "", optionsConsidered: [], risks: [], acceptanceCriteria: [],
      openQuestions: [], status: "draft", featureId: null, createdAt: 0, updatedAt: 0,
      approvedAt: null, approvedBy: null, sourceConversation: null,
    });
    const listed = await ops.listBriefs(DEFAULT_WORKSPACE);
    expect(listed.map((b) => b.workspaceId)).toEqual([DEFAULT_WORKSPACE]);
  });

  it("Snapshot carries solutionBriefs through the store", async () => {
    const { ops } = setup();
    const project = await mkProject(ops);
    await ops.createBrief(DEFAULT_WORKSPACE, project.id, { title: "B1" });
    const snap = await ops.snapshot(DEFAULT_WORKSPACE);
    expect(snap.solutionBriefs.length).toBe(1);
    expect(snap.solutionBriefs[0]!.title).toBe("B1");
  });

  it("a task can carry {kind:'brief', briefId} provenance (S7 groundwork)", async () => {
    const { ops, store } = setup();
    const project = await mkProject(ops);
    const brief = await ops.createBrief(DEFAULT_WORKSPACE, project.id, { title: "B1" });
    const task = await ops.createTask(DEFAULT_WORKSPACE, project.id, {
      text: "spawned from the brief",
      source: { kind: "brief", briefId: brief.id },
    });
    expect(await store.getTask(task.id)).toMatchObject({ source: { kind: "brief", briefId: brief.id } });
  });
});
