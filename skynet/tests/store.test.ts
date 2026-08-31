// Store adapters: the in-memory and Postgres stores must behave identically
// behind the Store interface (store.ts) — that's the whole point of the seam.
// One shared contract runs against MemoryStore always; against PostgresStore
// when DATABASE_URL is set (CI provides one, so both adapters are exercised).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Snapshot, DEFAULT_WORKSPACE, SAFETY_DEFAULTS, type TaskRun, type AuditRecord, type GithubConnection, type PendingRuleAction, type Project, type Proposal, type Rule, type SolutionBrief, type Transition } from "@skynet/shared";
import type { Store } from "../apps/server/src/store/store.js";
import { MemoryStore } from "../apps/server/src/store/memory.js";
import { FileStore } from "../apps/server/src/store/file.js";

// Stores start empty (no demo fixtures), so the contract seeds its own known
// agent + project before asserting on reads.
async function seedContract(store: Store): Promise<void> {
  await store.putProject({
    id: "seed-proj", workspaceId: DEFAULT_WORKSPACE, name: "Seed", goal: "g",
    runIds: ["seed-agent"], status: "active",
  });
  const agent: TaskRun = {
    id: "seed-agent", workspaceId: DEFAULT_WORKSPACE, projectId: "seed-proj",
    name: "Seed agent", status: "running", agentId: null, provider: "claude",
    model: "opus-4.5", branch: "agent/seed-agent", modules: [], progress: 0,
    plan: [], modifiedFiles: [], log: [], startedAt: 0, lastHeartbeatAt: 0,
    visual: false, previewUrl: null, dependsOn: [], parentId: null,
    branchFromStep: null, archived: false,
  };
  await store.putRun(agent);
}

function storeContract(name: string, make: () => Promise<Store>) {
  describe(`Store contract — ${name}`, () => {
    let store: Store;
    beforeAll(async () => { store = await make(); await seedContract(store); });

    it("snapshot returns a schema-valid, seeded workspace", async () => {
      const snap = await store.snapshot(DEFAULT_WORKSPACE);
      expect(() => Snapshot.parse(snap)).not.toThrow();
      expect(snap.runs.length).toBeGreaterThan(0);
      expect(snap.providers.length).toBeGreaterThan(0);
    });

    it("lists are workspace-scoped", async () => {
      const here = await store.listRuns(DEFAULT_WORKSPACE);
      const elsewhere = await store.listRuns("no-such-workspace");
      expect(here.length).toBeGreaterThan(0);
      expect(elsewhere).toEqual([]);
      expect(here.every((a) => a.workspaceId === DEFAULT_WORKSPACE)).toBe(true);
    });

    it("put → get → delete round-trips a project", async () => {
      const project: Project = {
        id: "ws-test-proj", workspaceId: DEFAULT_WORKSPACE, name: "Test", goal: "g",
        runIds: [], status: "active",
      };
      await store.putProject(project);
      expect(await store.getProject("ws-test-proj")).toEqual(project);
      await store.deleteProject("ws-test-proj");
      expect(await store.getProject("ws-test-proj")).toBeUndefined();
    });

    it("appendLog appends to an existing agent's log", async () => {
      const [agent] = await store.listRuns(DEFAULT_WORKSPACE);
      expect(agent).toBeDefined();
      const before = (await store.getRun(agent!.id))!.log.length;
      await store.appendLog(agent!.id, 123_456, "a fresh log line");
      const after = (await store.getRun(agent!.id))!.log;
      expect(after.length).toBe(before + 1);
      expect(after.at(-1)).toEqual({ at: 123_456, line: "a fresh log line" });
    });

    it("recordAudit → listAudit returns newest-first, workspace-scoped", async () => {
      const base: Omit<AuditRecord, "at" | "hitlId"> = {
        workspaceId: DEFAULT_WORKSPACE, runId: "billing", action: "approve",
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

    it("audit archive / delete is per-record and workspace-scoped", async () => {
      const base: Omit<AuditRecord, "at" | "hitlId"> = {
        workspaceId: DEFAULT_WORKSPACE, runId: "billing", action: "approve",
        operatorId: "op-1", payload: { k: 1 },
      };
      await store.recordAudit({ ...base, hitlId: "amx-1", at: 10_000 });
      await store.recordAudit({ ...base, hitlId: "amx-2", at: 11_000 });
      await store.recordAudit({ ...base, workspaceId: "amx-other", hitlId: "amx-3", at: 12_000 });

      // archive is a soft flag — the record stays in the trail
      await store.setAuditArchived(DEFAULT_WORKSPACE, "amx-1", true);
      const afterArchive = await store.listAudit(DEFAULT_WORKSPACE);
      expect(afterArchive.find((e) => e.hitlId === "amx-1")?.archived).toBe(true);
      expect(afterArchive.find((e) => e.hitlId === "amx-2")?.archived ?? false).toBe(false);

      // restore
      await store.setAuditArchived(DEFAULT_WORKSPACE, "amx-1", false);
      expect((await store.listAudit(DEFAULT_WORKSPACE)).find((e) => e.hitlId === "amx-1")?.archived).toBe(false);

      // a foreign-workspace hitlId is not touched
      await store.setAuditArchived(DEFAULT_WORKSPACE, "amx-3", true);
      expect((await store.listAudit("amx-other")).find((e) => e.hitlId === "amx-3")?.archived ?? false).toBe(false);

      // delete removes exactly one record, scoped to the workspace
      await store.deleteAudit(DEFAULT_WORKSPACE, "amx-1");
      const afterDelete = await store.listAudit(DEFAULT_WORKSPACE);
      expect(afterDelete.some((e) => e.hitlId === "amx-1")).toBe(false);
      expect(afterDelete.some((e) => e.hitlId === "amx-2")).toBe(true);
      expect((await store.listAudit("amx-other")).some((e) => e.hitlId === "amx-3")).toBe(true);
    });

    it("audit archive-all / clear are workspace-scoped", async () => {
      const base: Omit<AuditRecord, "at" | "hitlId" | "workspaceId"> = {
        runId: "billing", action: "approve", operatorId: "op-1", payload: {},
      };
      await store.recordAudit({ ...base, workspaceId: "amx-bulk", hitlId: "bulk-1", at: 20_000 });
      await store.recordAudit({ ...base, workspaceId: "amx-bulk", hitlId: "bulk-2", at: 21_000 });
      await store.recordAudit({ ...base, workspaceId: "amx-keep", hitlId: "keep-1", at: 22_000 });

      await store.archiveAllAudit("amx-bulk");
      expect((await store.listAudit("amx-bulk")).every((e) => e.archived === true)).toBe(true);
      expect((await store.listAudit("amx-keep")).every((e) => e.archived ?? false)).toBe(false);

      await store.clearAudit("amx-bulk");
      expect(await store.listAudit("amx-bulk")).toEqual([]);
      expect((await store.listAudit("amx-keep")).some((e) => e.hitlId === "keep-1")).toBe(true);
    });

    it("put → get → list → delete round-trips a solution brief", async () => {
      const brief: SolutionBrief = {
        id: "sb-test-1", workspaceId: DEFAULT_WORKSPACE, projectId: "seed-proj",
        title: "T", problem: "p", approach: "a", optionsConsidered: [], risks: [],
        acceptanceCriteria: [], openQuestions: [], status: "draft", featureId: null,
        createdAt: 1, updatedAt: 1, approvedAt: null, approvedBy: null, sourceConversation: null,
      };
      await store.putSolutionBrief(brief);
      expect(await store.getSolutionBrief("sb-test-1")).toEqual(brief);
      expect((await store.listSolutionBriefs(DEFAULT_WORKSPACE)).some((b) => b.id === "sb-test-1")).toBe(true);
      expect(await store.listSolutionBriefs("no-such-workspace")).toEqual([]);
      // Upsert: a second put with a changed field replaces, not duplicates.
      await store.putSolutionBrief({ ...brief, status: "approved" });
      expect((await store.getSolutionBrief("sb-test-1"))?.status).toBe("approved");
      await store.deleteSolutionBrief("sb-test-1");
      expect(await store.getSolutionBrief("sb-test-1")).toBeUndefined();
    });

    // ── Momentum Rollout kanban rebuild, Phase 0 ──────────────────────────
    it("createTransition → listTransitionsForTask / listTransitionsForProject round-trip, task-scoped and project-scoped", async () => {
      const base: Omit<Transition, "id" | "taskId" | "from" | "to" | "at"> = {
        workspaceId: DEFAULT_WORKSPACE, projectId: "seed-proj",
        actor: "human", actorId: "op-1", ruleId: null, evidence: [],
      };
      await store.createTransition({ ...base, id: "tr-1", taskId: "task-a", from: "backlog", to: "triage", at: 1_000 });
      await store.createTransition({ ...base, id: "tr-2", taskId: "task-a", from: "triage", to: "todo", at: 2_000 });
      await store.createTransition({ ...base, id: "tr-3", taskId: "task-b", from: "backlog", to: "triage", at: 3_000 });
      // A different project's transition must never leak into this project's list.
      await store.createTransition({ ...base, id: "tr-4", taskId: "task-c", projectId: "other-proj", from: "backlog", to: "triage", at: 4_000 });

      const forTaskA = await store.listTransitionsForTask("task-a");
      expect(forTaskA.map((t) => t.id)).toEqual(["tr-1", "tr-2"]); // oldest first
      expect(forTaskA[0]).toEqual({ ...base, id: "tr-1", taskId: "task-a", from: "backlog", to: "triage", at: 1_000 });

      const forProject = await store.listTransitionsForProject("seed-proj");
      expect(forProject.map((t) => t.id)).toEqual(["tr-3", "tr-2", "tr-1"]); // newest first
      expect(forProject.some((t) => t.id === "tr-4")).toBe(false); // scoped to seed-proj only

      const since = await store.listTransitionsForProject("seed-proj", { since: 2_000 });
      expect(since.map((t) => t.id)).toEqual(["tr-3", "tr-2"]);

      const limited = await store.listTransitionsForProject("seed-proj", { limit: 1 });
      expect(limited.map((t) => t.id)).toEqual(["tr-3"]); // newest one only
    });

    it("a machine transition with ruleId:null means the orchestrator itself acted — distinct from a rule-driven move", async () => {
      const orchestratorMove: Transition = {
        id: "tr-orch", workspaceId: DEFAULT_WORKSPACE, projectId: "seed-proj", taskId: "task-d",
        from: "triage", to: "todo", actor: "machine", actorId: null, ruleId: null, evidence: [], at: 5_000,
      };
      const ruleMove: Transition = {
        id: "tr-rule", workspaceId: DEFAULT_WORKSPACE, projectId: "seed-proj", taskId: "task-d",
        from: "todo", to: "ongoing", actor: "machine", actorId: "run-1", ruleId: "rule-1", evidence: ["PR #42 opened"], at: 6_000,
      };
      await store.createTransition(orchestratorMove);
      await store.createTransition(ruleMove);
      const forTask = await store.listTransitionsForTask("task-d");
      expect(forTask.find((t) => t.id === "tr-orch")?.ruleId).toBeNull();
      expect(forTask.find((t) => t.id === "tr-rule")?.ruleId).toBe("rule-1");
    });

    it("put → get → list → delete round-trips a rule, project-scoped", async () => {
      const rule: Rule = {
        id: "rule-test-1", workspaceId: DEFAULT_WORKSPACE, projectId: "seed-proj",
        name: "Auto-advance clean reviews", when: "review approved with no flags",
        conditions: [{ field: "reviewVerdict.decision", op: "eq", value: "approve" }],
        actions: [{ type: "move", params: { to: "done" } }],
        safety: { announceBeforeActing: true, undoWindowMin: 10, pauseAfterUndos: 3, excludePriorities: [] },
        stats: { moves: 0, undos: 0 },
        state: "live", createdAt: 1, archived: false,
      };
      await store.putRule(rule);
      expect(await store.getRule("rule-test-1")).toEqual(rule);
      expect((await store.listRulesForProject("seed-proj")).some((r) => r.id === "rule-test-1")).toBe(true);
      expect(await store.listRulesForProject("no-such-project")).toEqual([]);
      // Upsert: a second put with a changed field replaces, not duplicates.
      await store.putRule({ ...rule, state: "paused" });
      expect((await store.getRule("rule-test-1"))?.state).toBe("paused");
      await store.deleteRule("rule-test-1");
      expect(await store.getRule("rule-test-1")).toBeUndefined();
    });

    it("put → get → list (status-filtered) → delete round-trips a proposal, project-scoped", async () => {
      const proposal: Proposal = {
        id: "prop-test-1", workspaceId: DEFAULT_WORKSPACE, projectId: "seed-proj",
        kind: "suggested_subtask", payload: { text: "add a regression test" },
        status: "pending", createdAt: 1, resolvedAt: null,
      };
      await store.putProposal(proposal);
      expect(await store.getProposal("prop-test-1")).toEqual(proposal);
      expect((await store.listProposalsForProject("seed-proj")).some((p) => p.id === "prop-test-1")).toBe(true);
      expect(await store.listProposalsForProject("seed-proj", { status: "accepted" })).toEqual([]);
      expect((await store.listProposalsForProject("seed-proj", { status: "pending" })).some((p) => p.id === "prop-test-1")).toBe(true);
      // Upsert: accepting a proposal replaces it in place, not duplicates.
      await store.putProposal({ ...proposal, status: "accepted", resolvedAt: 2 });
      expect((await store.getProposal("prop-test-1"))?.status).toBe("accepted");
      expect(await store.listProposalsForProject("seed-proj", { status: "pending" })).toEqual([]);
      await store.deleteProposal("prop-test-1");
      expect(await store.getProposal("prop-test-1")).toBeUndefined();
    });

    it("put → get → list (status-filtered) → delete round-trips a pending rule action, project-scoped, plus the all-workspaces sweep list", async () => {
      const pending: PendingRuleAction = {
        id: "pra-test-1", workspaceId: DEFAULT_WORKSPACE, projectId: "seed-proj", taskId: "task-x", ruleId: "rule-x",
        action: { type: "move_task", params: { toState: "review" } },
        fromState: "ongoing", toState: "review", evidence: ["pr_merged"],
        status: "pending", createdAt: 1, readyAt: 601, undoableUntil: null, transitionId: null,
      };
      await store.putPendingRuleAction(pending);
      expect(await store.getPendingRuleAction("pra-test-1")).toEqual(pending);
      expect((await store.listPendingActionsForProject("seed-proj")).some((a) => a.id === "pra-test-1")).toBe(true);
      expect(await store.listPendingActionsForProject("seed-proj", { status: "finalized" })).toEqual([]);
      expect((await store.listAllPendingActions()).some((a) => a.id === "pra-test-1")).toBe(true);
      // Finalize: upsert replaces, not duplicates.
      await store.putPendingRuleAction({ ...pending, status: "finalized", undoableUntil: 1200, transitionId: "tr-1" });
      expect((await store.getPendingRuleAction("pra-test-1"))?.status).toBe("finalized");
      expect(await store.listPendingActionsForProject("seed-proj", { status: "pending" })).toEqual([]);
      await store.deletePendingRuleAction("pra-test-1");
      expect(await store.getPendingRuleAction("pra-test-1")).toBeUndefined();
    });

    it("put → get → delete round-trips a GitHub connection (one per workspace)", async () => {
      expect(await store.getGithubConnection("ws-gh")).toBeUndefined();
      const conn: GithubConnection = {
        workspaceId: "ws-gh", connected: true,
        installation: { id: 42, account: "acme", type: "Organization", appSlug: "skynet" },
        repos: [{ id: 1, name: "acme/monolith", defaultBranch: "main", private: true, selected: true }],
        safety: { ...SAFETY_DEFAULTS },
      };
      await store.putGithubConnection(conn);
      expect(await store.getGithubConnection("ws-gh")).toEqual(conn);
      // Upsert (one per workspace): a second put replaces, not duplicates.
      await store.putGithubConnection({ ...conn, safety: { ...SAFETY_DEFAULTS, prOnly: false } });
      expect((await store.getGithubConnection("ws-gh"))?.safety.prOnly).toBe(false);
      await store.deleteGithubConnection("ws-gh");
      expect(await store.getGithubConnection("ws-gh")).toBeUndefined();
    });
  });
}

storeContract("memory", async () => new MemoryStore());

// File-backed store: same contract, plus a real persistence round-trip.
const tmpDb = (tag: string) => join(tmpdir(), `skynet-${tag}-${Date.now()}-${process.pid}.json`);
storeContract("file", async () => FileStore.create(tmpDb("contract")));

describe("FileStore persistence", () => {
  it("round-trips state through the JSON file across reopen", async () => {
    const path = tmpDb("persist");
    const a = FileStore.create(path); // fresh, empty
    await a.putProject({
      id: "fp1", workspaceId: DEFAULT_WORKSPACE, name: "Persisted", goal: "g",
      runIds: [], status: "active",
    });
    a.flush(); // force the write now (bypass the debounce)

    const b = FileStore.create(path); // reopen from disk
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
    store = await PostgresStore.create(dbUrl!);
    await seedContract(store);
  });
  afterAll(async () => {
    // best-effort: PostgresStore holds a pool; let the process exit close it.
  });

  it("snapshot returns a schema-valid, seeded workspace", async () => {
    const snap = await store.snapshot(DEFAULT_WORKSPACE);
    expect(() => Snapshot.parse(snap)).not.toThrow();
    expect(snap.runs.length).toBeGreaterThan(0);
  });

  it("put → get → delete round-trips a project", async () => {
    const project: Project = {
      id: "pg-test-proj", workspaceId: DEFAULT_WORKSPACE, name: "PG", goal: "g",
      runIds: [], status: "active",
    };
    await store.putProject(project);
    expect(await store.getProject("pg-test-proj")).toEqual(project);
    await store.deleteProject("pg-test-proj");
    expect(await store.getProject("pg-test-proj")).toBeUndefined();
  });

  it("put → get → delete round-trips a solution brief", async () => {
    const brief: SolutionBrief = {
      id: "pg-sb-1", workspaceId: DEFAULT_WORKSPACE, projectId: "pg-test-proj",
      title: "T", problem: "p", approach: "a", optionsConsidered: [], risks: [],
      acceptanceCriteria: [], openQuestions: [], status: "draft", featureId: null,
      createdAt: 1, updatedAt: 1, approvedAt: null, approvedBy: null, sourceConversation: null,
    };
    await store.putSolutionBrief(brief);
    expect(await store.getSolutionBrief("pg-sb-1")).toEqual(brief);
    await store.deleteSolutionBrief("pg-sb-1");
    expect(await store.getSolutionBrief("pg-sb-1")).toBeUndefined();
  });

  it("recordAudit → listAudit returns newest-first", async () => {
    await store.recordAudit({
      workspaceId: DEFAULT_WORKSPACE, hitlId: "pg-audit-a", runId: "billing",
      action: "approve", operatorId: "op-1", at: 1_000, payload: null,
    });
    await store.recordAudit({
      workspaceId: DEFAULT_WORKSPACE, hitlId: "pg-audit-b", runId: "billing",
      action: "reject", operatorId: "op-1", at: 2_000, payload: null,
    });
    const trail = await store.listAudit(DEFAULT_WORKSPACE);
    const ours = trail.filter((e) => e.hitlId.startsWith("pg-audit-"));
    expect(ours.map((e) => e.hitlId)).toEqual(["pg-audit-b", "pg-audit-a"]);
  });

  // ── Momentum Rollout kanban rebuild, Phase 0 ────────────────────────────
  it("createTransition → listTransitionsForTask / listTransitionsForProject round-trip, task-scoped and project-scoped", async () => {
    const base: Omit<Transition, "id" | "taskId" | "from" | "to" | "at"> = {
      workspaceId: DEFAULT_WORKSPACE, projectId: "pg-test-proj",
      actor: "human", actorId: "op-1", ruleId: null, evidence: [],
    };
    await store.createTransition({ ...base, id: "pg-tr-1", taskId: "pg-task-a", from: "backlog", to: "triage", at: 1_000 });
    await store.createTransition({ ...base, id: "pg-tr-2", taskId: "pg-task-a", from: "triage", to: "todo", at: 2_000 });
    await store.createTransition({ ...base, id: "pg-tr-3", taskId: "pg-task-b", from: "backlog", to: "triage", at: 3_000 });

    const forTaskA = await store.listTransitionsForTask("pg-task-a");
    expect(forTaskA.map((t) => t.id)).toEqual(["pg-tr-1", "pg-tr-2"]); // oldest first
    expect(forTaskA[0]).toEqual({ ...base, id: "pg-tr-1", taskId: "pg-task-a", from: "backlog", to: "triage", at: 1_000 });

    const forProject = await store.listTransitionsForProject("pg-test-proj");
    expect(forProject.map((t) => t.id)).toEqual(["pg-tr-3", "pg-tr-2", "pg-tr-1"]); // newest first

    const since = await store.listTransitionsForProject("pg-test-proj", { since: 2_000 });
    expect(since.map((t) => t.id)).toEqual(["pg-tr-3", "pg-tr-2"]);

    const limited = await store.listTransitionsForProject("pg-test-proj", { limit: 1 });
    expect(limited.map((t) => t.id)).toEqual(["pg-tr-3"]);
  });

  it("put → get → list → delete round-trips a rule, project-scoped", async () => {
    const rule: Rule = {
      id: "pg-rule-1", workspaceId: DEFAULT_WORKSPACE, projectId: "pg-test-proj",
      name: "Auto-advance clean reviews", when: "review approved with no flags",
      conditions: [{ field: "reviewVerdict.decision", op: "eq", value: "approve" }],
      actions: [{ type: "move", params: { to: "done" } }],
      safety: { announceBeforeActing: true, undoWindowMin: 10, pauseAfterUndos: 3, excludePriorities: [] },
      stats: { moves: 0, undos: 0 },
      state: "live", createdAt: 1, archived: false,
    };
    await store.putRule(rule);
    expect(await store.getRule("pg-rule-1")).toEqual(rule);
    expect((await store.listRulesForProject("pg-test-proj")).some((r) => r.id === "pg-rule-1")).toBe(true);
    await store.putRule({ ...rule, state: "paused" });
    expect((await store.getRule("pg-rule-1"))?.state).toBe("paused");
    await store.deleteRule("pg-rule-1");
    expect(await store.getRule("pg-rule-1")).toBeUndefined();
  });

  it("put → get → list (status-filtered) → delete round-trips a proposal, project-scoped", async () => {
    const proposal: Proposal = {
      id: "pg-prop-1", workspaceId: DEFAULT_WORKSPACE, projectId: "pg-test-proj",
      kind: "suggested_subtask", payload: { text: "add a regression test" },
      status: "pending", createdAt: 1, resolvedAt: null,
    };
    await store.putProposal(proposal);
    expect(await store.getProposal("pg-prop-1")).toEqual(proposal);
    expect((await store.listProposalsForProject("pg-test-proj", { status: "pending" })).some((p) => p.id === "pg-prop-1")).toBe(true);
    expect(await store.listProposalsForProject("pg-test-proj", { status: "accepted" })).toEqual([]);
    await store.putProposal({ ...proposal, status: "accepted", resolvedAt: 2 });
    expect((await store.getProposal("pg-prop-1"))?.status).toBe("accepted");
    await store.deleteProposal("pg-prop-1");
    expect(await store.getProposal("pg-prop-1")).toBeUndefined();
  });

  it("put → get → list (status-filtered) → delete round-trips a pending rule action, plus the all-workspaces sweep list", async () => {
    const pending: PendingRuleAction = {
      id: "pg-pra-1", workspaceId: DEFAULT_WORKSPACE, projectId: "pg-test-proj", taskId: "pg-task-x", ruleId: "pg-rule-x",
      action: { type: "move_task", params: { toState: "review" } },
      fromState: "ongoing", toState: "review", evidence: ["pr_merged"],
      status: "pending", createdAt: 1, readyAt: 601, undoableUntil: null, transitionId: null,
    };
    await store.putPendingRuleAction(pending);
    expect(await store.getPendingRuleAction("pg-pra-1")).toEqual(pending);
    expect((await store.listPendingActionsForProject("pg-test-proj", { status: "pending" })).some((a) => a.id === "pg-pra-1")).toBe(true);
    expect((await store.listAllPendingActions()).some((a) => a.id === "pg-pra-1")).toBe(true);
    await store.putPendingRuleAction({ ...pending, status: "finalized", undoableUntil: 1200, transitionId: "pg-tr-1" });
    expect((await store.getPendingRuleAction("pg-pra-1"))?.status).toBe("finalized");
    await store.deletePendingRuleAction("pg-pra-1");
    expect(await store.getPendingRuleAction("pg-pra-1")).toBeUndefined();
  });
});
