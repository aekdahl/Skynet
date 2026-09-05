// End-to-end proof of the manager escalation policy (agent-hierarchy.md §4) in
// the REAL orchestrator: a worker spawned under a manager (Orchestrator.spawnWorker)
// raises a low-risk question/plan gate, and the manager — not the human operator
// — auto-resolves it, through the same raise→resolve→deliver path a human
// approval uses. Hermetic: a throwaway git repo + a scripted provider.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_WORKSPACE } from "@skynet/shared";
import type { ProviderId, Project, Agent, Task, Resolution, HitlItem } from "@skynet/shared";
import type { HitlRaise, RunnerEvents, RunnerHandle, RunnerProvider, StartSpec } from "@skynet/runner-sdk";
import type { Bus } from "../apps/server/src/bus.js";

class NullBus implements Bus {
  publish(): void {}
  subscribe(): () => void {
    return () => {};
  }
}

// Raises exactly one HITL shortly after start, ONLY for a run whose StartSpec
// carries a parentId (i.e. a spawnWorker'd worker, never the manager itself —
// the manager's own run just sits there). Records any resume() delivered back,
// keyed by runId so the manager's and the worker's runs are told apart.
class ScriptedProvider implements RunnerProvider {
  readonly id: ProviderId = "claude";
  resumes: Record<string, Resolution[]> = {};
  constructor(private readonly raise: HitlRaise) {}
  async start(spec: StartSpec, events: RunnerEvents): Promise<RunnerHandle> {
    if (spec.parentId) {
      setTimeout(() => events.onHitl(spec.runId, this.raise), 0);
    }
    return {
      runId: spec.runId,
      provider: this.id,
      async pause() {},
      resume: async (decision?: Resolution) => {
        if (decision) (this.resumes[spec.runId] ??= []).push(decision);
      },
      async message() {},
      async stop() {},
    };
  }
}

let Hub: typeof import("../apps/server/src/hub.js").Hub;
let Orchestrator: typeof import("../apps/server/src/orchestrator.js").Orchestrator;
let MemoryStore: typeof import("../apps/server/src/store/memory.js").MemoryStore;
let repo: string, worktreesDir: string;

const waitFor = async (pred: () => Promise<boolean>, ms = 5000): Promise<void> => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await pred()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("condition not met in time");
};

beforeAll(async () => {
  repo = mkdtempSync(join(tmpdir(), "skynet-mgr-repo-"));
  worktreesDir = mkdtempSync(join(tmpdir(), "skynet-mgr-wt-"));
  execFileSync("git", ["init", "-b", "main", repo]);
  execFileSync("git", ["-C", repo, "config", "user.email", "test@skynet.local"]);
  execFileSync("git", ["-C", repo, "config", "user.name", "Test"]);
  writeFileSync(join(repo, "README.md"), "# base\n");
  execFileSync("git", ["-C", repo, "add", "-A"]);
  execFileSync("git", ["-C", repo, "commit", "-m", "base"]);
  process.env.STORE = "memory";
  process.env.BUS = "memory";
  process.env.SKYNET_INTEGRATION_REPO = repo;
  process.env.SKYNET_WORKTREES_DIR = worktreesDir;
  process.env.SKYNET_BASE_BRANCH = "main";
  delete process.env.RUNNER;
  ({ Hub } = await import("../apps/server/src/hub.js"));
  ({ Orchestrator } = await import("../apps/server/src/orchestrator.js"));
  ({ MemoryStore } = await import("../apps/server/src/store/memory.js"));
});
afterAll(() => {
  rmSync(repo, { recursive: true, force: true });
  rmSync(worktreesDir, { recursive: true, force: true });
});

/** Provisions a manager run, then spawns ONE worker under it whose scripted
 *  agent raises `raise`. Returns handles for asserting on the WORKER's gate. */
async function setupWorker(raise: HitlRaise, approvalLevel: Project["approvalLevel"] = "manual") {
  const store = new MemoryStore({ seed: false });
  const hub = new Hub(store, new NullBus());
  const provider = new ScriptedProvider(raise);
  const orchestrator = new Orchestrator(store, hub, provider);
  const pid = `p-${Math.round(Math.random() * 1e9)}`;
  await store.putProject({
    id: pid, workspaceId: DEFAULT_WORKSPACE, name: "P", goal: "", runIds: [], status: "active",
    // manual — so an approval-kind gate is NEVER auto-approved by the
    // project's own policy, isolating whether the MANAGER touched it.
    approvalLevel, approvalRules: [], repoPath: null, gitBacked: false,
  } as Project);
  // Two idle runners: one manager-role (for the manager task), one
  // worker-role (picked up by spawnWorker's acquireOrProvisionRunner).
  await store.putAgent({ id: `mgr-a-${pid}`, workspaceId: DEFAULT_WORKSPACE, name: "mgr-a", provider: "claude", model: "opus-4.8", status: "idle", idleSince: 0, role: "manager" } as Agent);
  await store.putAgent({ id: `wkr-a-${pid}`, workspaceId: DEFAULT_WORKSPACE, name: "wkr-a", provider: "claude", model: "opus-4.8", status: "idle", idleSince: 0, role: "worker" } as Agent);
  await store.putTask({ id: `t-${pid}`, workspaceId: DEFAULT_WORKSPACE, projectId: pid, text: "own billing", state: "backlog", runId: null } as Task);
  const manager = await orchestrator.assignTask(pid, `t-${pid}`, { role: "manager", area: [] });
  const worker = await orchestrator.spawnWorker(manager.id, "reconcile webhooks", []);
  const openGate = async (): Promise<HitlItem | undefined> =>
    (await store.listQueue(DEFAULT_WORKSPACE)).find((q) => q.runId === worker.id && q.resolvedAt == null);
  const anyGate = async (): Promise<HitlItem | undefined> =>
    (await store.listQueue(DEFAULT_WORKSPACE)).find((q) => q.runId === worker.id);
  return { store, provider, manager, worker, openGate, anyGate };
}

describe("manager escalation policy — auto-resolve in the orchestrator (agent-hierarchy.md §4)", () => {
  it("auto-resolves a low-risk question with a recommended option (picks it, not left for a human)", async () => {
    const t = await setupWorker({
      kind: "question", title: "which webhook first?", why: "two look equally stale",
      risk: "low", rationale: null, command: null, options: ["stripe", "github"], recommended: 1, steps: null, diff: null,
    });
    await waitFor(async () => (t.provider.resumes[t.worker.id]?.length ?? 0) > 0);
    const resolution = t.provider.resumes[t.worker.id]![0]!;
    expect(resolution.action).toBe("option");
    expect(resolution.optionIndex).toBe(1);
    expect(resolution.by).toBe(`manager:${t.manager.id}`);
    expect(await t.openGate()).toBeUndefined(); // raised then resolved — nothing left waiting
    const audit = await t.store.listAudit(DEFAULT_WORKSPACE);
    expect(audit.some((a) => a.action === "option" && a.operatorId === `manager:${t.manager.id}`)).toBe(true);
  });

  it("auto-approves a low-risk delegation plan as proposed", async () => {
    const t = await setupWorker({
      kind: "plan", title: "split into 3 subtasks", why: "decomposing the area",
      risk: "low", rationale: null, command: null, options: null, recommended: null,
      steps: [{ text: "reconcile webhooks", state: "todo" }],
      diff: null,
    });
    await waitFor(async () => (t.provider.resumes[t.worker.id]?.length ?? 0) > 0);
    const resolution = t.provider.resumes[t.worker.id]![0]!;
    expect(resolution.action).toBe("approve");
    expect(resolution.by).toBe(`manager:${t.manager.id}`);
    expect(await t.openGate()).toBeUndefined();
  });

  it("a question with NO recommended option still escalates to a human (no safe default to guess)", async () => {
    const t = await setupWorker({
      kind: "question", title: "which approach?", why: "genuinely unclear",
      risk: "low", rationale: null, command: null, options: ["a", "b"], recommended: null, steps: null, diff: null,
    });
    await waitFor(async () => (await t.anyGate()) != null);
    expect(await t.openGate()).toBeDefined(); // still waiting on a human
    expect(t.provider.resumes[t.worker.id] ?? []).toHaveLength(0);
  });

  it("a medium-risk question is NOT auto-resolved by the manager — escalates as usual", async () => {
    const t = await setupWorker({
      kind: "question", title: "risky call", why: "affects billing",
      risk: "medium", rationale: null, command: null, options: ["a", "b"], recommended: 0, steps: null, diff: null,
    });
    await waitFor(async () => (await t.anyGate()) != null);
    expect(await t.openGate()).toBeDefined();
    expect(t.provider.resumes[t.worker.id] ?? []).toHaveLength(0);
  });

  it("an approval-kind gate (a real command) is untouched by the manager policy — still escalates under a manual project", async () => {
    const t = await setupWorker(
      { kind: "approval", title: "run: npm test", why: "verifying", risk: "low", rationale: null, command: "npm test", options: null, recommended: null, steps: null, diff: null },
      "manual",
    );
    await waitFor(async () => (await t.anyGate()) != null);
    expect(await t.openGate()).toBeDefined(); // manual project policy gates it, manager doesn't step in
    expect(t.provider.resumes[t.worker.id] ?? []).toHaveLength(0);
  });
});
