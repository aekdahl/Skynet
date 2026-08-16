// Verifier gate: a failing post-merge check must raise a real HITL — not just
// log a truncated line and park the run in review. Drives the REAL orchestrator
// (real MergeEngine, real throwaway git repo) with a scripted provider so the
// whole loop is deterministic and hermetic: fail → gate (full output, merge
// rolled back) → reject bounces the agent with the output as guidance → the
// agent fixes it → re-approve → check passes → auto-commit (green), same as
// before this feature (unchanged behavior, just re-asserted here).

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_WORKSPACE } from "@skynet/shared";
import type { ProviderId, Project, Agent, Task, Resolution, HitlItem } from "@skynet/shared";
import type { RunnerEvents, RunnerHandle, RunnerProvider, StartSpec } from "@skynet/runner-sdk";
import type { Bus } from "../apps/server/src/bus.js";

class NullBus implements Bus {
  publish(): void {}
  subscribe(): () => void { return () => {}; }
}

// Turn 1: writes feature.txt only — no PASS_MARKER, so the project's check
// ("test -f PASS_MARKER") fails post-merge. Revise turn (same worktree, on top
// of the already-committed feature.txt): also writes PASS_MARKER, so the NEXT
// merge attempt's check passes. Captures every prompt it was started with, so
// a test can assert the bounced-back guidance actually carried the check output.
class SpyProvider implements RunnerProvider {
  readonly id: ProviderId = "claude";
  starts = 0;
  tasks: string[] = [];
  async start(spec: StartSpec, events: RunnerEvents): Promise<RunnerHandle> {
    this.starts++;
    this.tasks.push(spec.task);
    writeFileSync(join(spec.cwd!, "feature.txt"), "v1\n");
    if (this.starts > 1) writeFileSync(join(spec.cwd!, "PASS_MARKER"), "ok\n");
    setTimeout(() => events.onCompleted(spec.runId, spec.branch), 0);
    return { runId: spec.runId, provider: this.id, async pause() {}, async resume() {}, async message() {}, async stop() {} };
  }
}

let Hub: typeof import("../apps/server/src/hub.js").Hub;
let Orchestrator: typeof import("../apps/server/src/orchestrator.js").Orchestrator;
let MemoryStore: typeof import("../apps/server/src/store/memory.js").MemoryStore;
let repo: string, worktreesDir: string;

const git = (...args: string[]) =>
  execFileSync("git", ["-C", repo, ...args], { stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
const waitFor = async (pred: () => Promise<boolean>, ms = 5000): Promise<void> => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (await pred()) return; await new Promise((r) => setTimeout(r, 10)); }
  throw new Error("condition not met in time");
};

beforeAll(async () => {
  repo = mkdtempSync(join(tmpdir(), "skynet-verifier-repo-"));
  worktreesDir = mkdtempSync(join(tmpdir(), "skynet-verifier-wt-"));
  execFileSync("git", ["init", "-b", "main", repo]);
  git("config", "user.email", "test@skynet.local");
  git("config", "user.name", "Test");
  writeFileSync(join(repo, "README.md"), "# base\n");
  git("add", "-A");
  git("commit", "-m", "base");
  process.env.STORE = "memory";
  process.env.BUS = "memory";
  process.env.SKYNET_INTEGRATION_REPO = repo;
  process.env.SKYNET_WORKTREES_DIR = worktreesDir;
  process.env.SKYNET_BASE_BRANCH = "main";
  delete process.env.SKYNET_CHECK_CMD; // per-project checkCmd only, for these tests
  delete process.env.RUNNER;
  ({ Hub } = await import("../apps/server/src/hub.js"));
  ({ Orchestrator } = await import("../apps/server/src/orchestrator.js"));
  ({ MemoryStore } = await import("../apps/server/src/store/memory.js"));
});
afterAll(() => {
  rmSync(repo, { recursive: true, force: true });
  rmSync(worktreesDir, { recursive: true, force: true });
});

describe("verifier gate — failing project checks raise a real HITL", () => {
  let seq = 0;
  beforeEach(() => {
    seq++;
    git("checkout", "-f", "main");
    git("branch", "--list", "agent/*").split("\n").filter(Boolean)
      .forEach((b) => { try { git("branch", "-D", b.replace("*", "").trim()); } catch { /* ignore */ } });
  });

  /** One project (own checkCmd) + task, ready to assign. */
  async function setup(checkCmd: string | null) {
    const pid = `p${seq}`;
    const store = new MemoryStore({ seed: false });
    const hub = new Hub(store, new NullBus());
    const provider = new SpyProvider();
    const orchestrator = new Orchestrator(store, hub, provider);
    await store.putProject({
      id: pid, workspaceId: DEFAULT_WORKSPACE, name: "P", goal: "", runIds: [], status: "active",
      repoPath: null, gitBacked: false, checkCmd,
    } as Project);
    await store.putAgent({ id: `a${pid}`, workspaceId: DEFAULT_WORKSPACE, name: `a${pid}`, provider: "claude", model: "opus-4.8", status: "idle", idleSince: 0 } as Agent);
    await store.putTask({ id: `t${pid}`, workspaceId: DEFAULT_WORKSPACE, projectId: pid, text: "add feature", state: "backlog", runId: null } as Task);
    const openGate = async (kind: HitlItem["kind"]): Promise<HitlItem | undefined> =>
      (await store.listQueue(DEFAULT_WORKSPACE)).find((q) => q.kind === kind && q.resolvedAt == null);
    const resolve = async (item: HitlItem, action: Resolution["action"], guidance?: string) => {
      const resolution: Resolution = { action, optionIndex: null, guidance: guidance ?? null, by: "test", at: Date.now() };
      const r = await hub.resolveHitl(item.id, resolution);
      if (r?.resolution?.at === resolution.at) await orchestrator.deliver(item, resolution);
    };
    const run = await orchestrator.assignTask(pid, `t${pid}`);
    return { store, hub, orchestrator, provider, pid, run, openGate, resolve };
  }

  it("check failure: raises a verifier gate with the full output, rolls back the merge", async () => {
    const t = await setup("test -f PASS_MARKER"); // fails on turn 1 (no marker yet)
    await waitFor(async () => (await t.openGate("diff")) != null);
    await t.resolve((await t.openGate("diff"))!, "approve");

    const gate = await waitFor(async () => (await t.openGate("verifier")) != null).then(() => t.openGate("verifier"));
    const item = (await gate)!;
    expect(item.kind).toBe("verifier");
    expect(item.output).toBeTruthy();
    expect((await t.store.getRun(t.run.id))?.status).toBe("review");
    // Rolled back: the integration branch does NOT contain the merged file.
    expect(() => git("cat-file", "-e", `skynet/integration/${t.pid}:feature.txt`)).toThrow();
  });

  it("approve retries the merge + check — still failing, raises a FRESH gate (not stuck reusing the resolved one)", async () => {
    const t = await setup("test -f PASS_MARKER");
    await waitFor(async () => (await t.openGate("diff")) != null);
    await t.resolve((await t.openGate("diff"))!, "approve");
    await waitFor(async () => (await t.openGate("verifier")) != null);
    const first = (await t.openGate("verifier"))!;

    await t.resolve(first, "approve"); // retry — check is still failing
    await waitFor(async () => {
      const g = await t.openGate("verifier");
      return !!g && g.id !== first.id;
    });
    const second = (await t.openGate("verifier"))!;
    expect(second.id).not.toBe(first.id);
    expect((await t.store.listQueue(DEFAULT_WORKSPACE)).find((q) => q.id === first.id)?.resolvedAt).not.toBeNull();
  });

  it("reject bounces the agent with the check output as guidance; once fixed, approve merges and auto-commits (green)", async () => {
    const t = await setup("test -f PASS_MARKER");
    await waitFor(async () => (await t.openGate("diff")) != null);
    await t.resolve((await t.openGate("diff"))!, "approve");
    await waitFor(async () => (await t.openGate("verifier")) != null);
    const failedGate = (await t.openGate("verifier"))!;

    // Plain reject (no typed guidance) — the gate's own output IS the guidance.
    await t.resolve(failedGate, "reject");
    await waitFor(async () => t.provider.starts === 2);
    expect(t.provider.tasks[1]).toContain(failedGate.output!.split("\n")[0]);

    // Revise turn writes PASS_MARKER on top of feature.txt → a fresh diff review.
    await waitFor(async () => (await t.openGate("diff")) != null);
    await t.resolve((await t.openGate("diff"))!, "approve");

    // Check now passes → onMerged fires unconditionally → done (auto-commit on green).
    await waitFor(async () => (await t.store.getRun(t.run.id))?.status === "done");
    expect(git("cat-file", "-e", `skynet/integration/${t.pid}:feature.txt`)).toBeDefined();
    expect(git("cat-file", "-e", `skynet/integration/${t.pid}:PASS_MARKER`)).toBeDefined();
    const task = (await t.store.listTasks(DEFAULT_WORKSPACE)).find((x) => x.id === `t${t.pid}`)!;
    expect(task.state).toBe("done");
  });

  it("per-project checkCmd overrides the workspace default — a passing check merges straight through, no gate", async () => {
    const t = await setup("true"); // always passes
    await waitFor(async () => (await t.openGate("diff")) != null);
    await t.resolve((await t.openGate("diff"))!, "approve");
    await waitFor(async () => (await t.store.getRun(t.run.id))?.status === "done");
    expect(await t.openGate("verifier")).toBeUndefined();
    expect(git("cat-file", "-e", `skynet/integration/${t.pid}:feature.txt`)).toBeDefined();
  });

  it("no project checkCmd and no workspace default — merges straight through as before this feature", async () => {
    const t = await setup(null);
    await waitFor(async () => (await t.openGate("diff")) != null);
    await t.resolve((await t.openGate("diff"))!, "approve");
    await waitFor(async () => (await t.store.getRun(t.run.id))?.status === "done");
    expect(await t.openGate("verifier")).toBeUndefined();
    expect(existsSync(join(worktreesDir))).toBe(true); // sanity: worktrees dir is the one we set up
  });
});
