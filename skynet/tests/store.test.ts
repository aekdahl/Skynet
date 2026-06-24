// Store adapters: the in-memory and Postgres stores must behave identically
// behind the Store interface (store.ts) — that's the whole point of the seam.
// One shared contract runs against MemoryStore always; against PostgresStore
// when DATABASE_URL is set (CI provides one, so both adapters are exercised).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Snapshot, DEFAULT_WORKSPACE, type AuditRecord, type Project } from "@skynet/shared";
import type { Store } from "../apps/server/src/store/store.js";
import { MemoryStore } from "../apps/server/src/store/memory.js";
import { FileStore } from "../apps/server/src/store/file.js";

function storeContract(name: string, make: () => Promise<Store>) {
  describe(`Store contract — ${name}`, () => {
    let store: Store;
    beforeAll(async () => { store = await make(); });

    it("snapshot returns a schema-valid, seeded workspace", async () => {
      const snap = await store.snapshot(DEFAULT_WORKSPACE);
      expect(() => Snapshot.parse(snap)).not.toThrow();
      expect(snap.agents.length).toBeGreaterThan(0);
      expect(snap.providers.length).toBeGreaterThan(0);
    });

    it("lists are workspace-scoped", async () => {
      const here = await store.listAgents(DEFAULT_WORKSPACE);
      const elsewhere = await store.listAgents("no-such-workspace");
      expect(here.length).toBeGreaterThan(0);
      expect(elsewhere).toEqual([]);
      expect(here.every((a) => a.workspaceId === DEFAULT_WORKSPACE)).toBe(true);
    });

    it("put → get → delete round-trips a project", async () => {
      const project: Project = {
        id: "ws-test-proj", workspaceId: DEFAULT_WORKSPACE, name: "Test", goal: "g",
        agentIds: [], status: "active",
      };
      await store.putProject(project);
      expect(await store.getProject("ws-test-proj")).toEqual(project);
      await store.deleteProject("ws-test-proj");
      expect(await store.getProject("ws-test-proj")).toBeUndefined();
    });

    it("appendLog appends to an existing agent's log", async () => {
      const [agent] = await store.listAgents(DEFAULT_WORKSPACE);
      expect(agent).toBeDefined();
      const before = (await store.getAgent(agent!.id))!.log.length;
      await store.appendLog(agent!.id, 123_456, "a fresh log line");
      const after = (await store.getAgent(agent!.id))!.log;
      expect(after.length).toBe(before + 1);
      expect(after.at(-1)).toEqual({ at: 123_456, line: "a fresh log line" });
    });

    it("recordAudit → listAudit returns newest-first, workspace-scoped", async () => {
      const base: Omit<AuditRecord, "at" | "hitlId"> = {
        workspaceId: DEFAULT_WORKSPACE, agentId: "billing", action: "approve",
        operatorId: "op-1", payload: { k: 1 },
      };
      await store.recordAudit({ ...base, hitlId: "audit-a", at: 1_000 });
      await store.recordAudit({ ...base, hitlId: "audit-b", at: 2_000 });
      await store.recordAudit({ ...base, workspaceId: "other-ws", hitlId: "audit-c", at: 3_000 });

      const trail = await store.listAudit(DEFAULT_WORKSPACE);
      const ours = trail.filter((e) => e.hitlId.startsWith("audit-"));
      expect(ours.map((e) => e.hitlId)).toEqual(["audit-b", "audit-a"]); // newest first
      expect(trail.some((e) => e.workspaceId === "other-ws")).toBe(false);
    });
  });
}

storeContract("memory", async () => new MemoryStore());

// File-backed store: same contract, plus a real persistence round-trip.
const tmpDb = (tag: string) => join(tmpdir(), `skynet-${tag}-${Date.now()}-${process.pid}.json`);
storeContract("file", async () => FileStore.create(tmpDb("contract"), true));

describe("FileStore persistence", () => {
  it("round-trips state through the JSON file across reopen", async () => {
    const path = tmpDb("persist");
    const a = FileStore.create(path, false); // fresh, empty
    await a.putProject({
      id: "fp1", workspaceId: DEFAULT_WORKSPACE, name: "Persisted", goal: "g",
      agentIds: [], status: "active",
    });
    a.flush(); // force the write now (bypass the debounce)

    const b = FileStore.create(path, false); // reopen from disk
    const got = await b.getProject("fp1");
    expect(got).toBeTruthy();
    expect(got!.name).toBe("Persisted");
  });
});

// Postgres adapter — only when a database is reachable (CI sets DATABASE_URL).
const dbUrl = process.env.DATABASE_URL;
const describePg = dbUrl ? describe : describe.skip;
describePg("Store contract — postgres (DATABASE_URL set)", () => {
  // Re-declare via storeContract once the module is dynamically imported.
  let store: Store;
  beforeAll(async () => {
    const { PostgresStore } = await import("../apps/server/src/store/postgres.js");
    store = await PostgresStore.create(dbUrl!, true);
  });
  afterAll(async () => {
    // best-effort: PostgresStore holds a pool; let the process exit close it.
  });

  it("snapshot returns a schema-valid, seeded workspace", async () => {
    const snap = await store.snapshot(DEFAULT_WORKSPACE);
    expect(() => Snapshot.parse(snap)).not.toThrow();
    expect(snap.agents.length).toBeGreaterThan(0);
  });

  it("put → get → delete round-trips a project", async () => {
    const project: Project = {
      id: "pg-test-proj", workspaceId: DEFAULT_WORKSPACE, name: "PG", goal: "g",
      agentIds: [], status: "active",
    };
    await store.putProject(project);
    expect(await store.getProject("pg-test-proj")).toEqual(project);
    await store.deleteProject("pg-test-proj");
    expect(await store.getProject("pg-test-proj")).toBeUndefined();
  });

  it("recordAudit → listAudit returns newest-first", async () => {
    await store.recordAudit({
      workspaceId: DEFAULT_WORKSPACE, hitlId: "pg-audit-a", agentId: "billing",
      action: "approve", operatorId: "op-1", at: 1_000, payload: null,
    });
    await store.recordAudit({
      workspaceId: DEFAULT_WORKSPACE, hitlId: "pg-audit-b", agentId: "billing",
      action: "reject", operatorId: "op-1", at: 2_000, payload: null,
    });
    const trail = await store.listAudit(DEFAULT_WORKSPACE);
    const ours = trail.filter((e) => e.hitlId.startsWith("pg-audit-"));
    expect(ours.map((e) => e.hitlId)).toEqual(["pg-audit-b", "pg-audit-a"]);
  });
});
