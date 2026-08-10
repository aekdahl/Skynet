// Full-autonomy approval level: the ONE opt-in setting where even the diff
// review — otherwise always a human decision, at every other approval level —
// auto-merges with no one in the loop. Guards the two conditions that gate it
// (approvalLevel === "full" AND the project's autonomy toggle) and the one
// safety valve that survives it (an unusually large diff still gates for a
// human). Hermetic: a throwaway git repo + a scripted provider, no LLM calls —
// mirrors tests/full-loop.test.ts but for the unattended path.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_WORKSPACE } from "@skynet/shared";
import type { ProviderId, Project, Agent, Task, HitlItem } from "@skynet/shared";
import type { RunnerEvents, RunnerHandle, RunnerProvider, StartSpec } from "@skynet/runner-sdk";
import type { Bus } from "../apps/server/src/bus.js";

class NullBus implements Bus {
  publish(): void {}
  subscribe(): () => void {
    return () => {};
  }
}

// Writes N files (default 1) into its own worktree, then completes — no HITL
// raised by the provider itself, so the only gate in play is the server-raised
// diff review this suite is testing.
class ScriptedProvider implements RunnerProvider {
  readonly id: ProviderId = "claude";
  constructor(private readonly fileCount = 1) {}
  async start(spec: StartSpec, events: RunnerEvents): Promise<RunnerHandle> {
    for (let i = 0; i < this.fileCount; i++) {
      writeFileSync(join(spec.cwd!, `file-${i}.txt`), `change ${i}\n`);
    }
    setTimeout(() => events.onCompleted(spec.runId, spec.branch), 0);
    return {
      runId: spec.runId,
      provider: this.id,
      async pause() {},
      async resume() {},
      async message() {},
      async stop() {},
    };
  }
}

let Hub: typeof import("../apps/server/src/hub.js").Hub;
let Orchestrator: typeof import("../apps/server/src/orchestrator.js").Orchestrator;
let MemoryStore: typeof import("../apps/server/src/store/memory.js").MemoryStore;
let repo: string, worktreesDir: string;

const git = (...args: string[]) =>
  execFileSync("git", ["-C", repo, ...args], { stdio: ["ignore", "pipe", "pipe"] }).toString().trim();

const waitFor = async (pred: () => Promise<boolean>, ms = 15_000): Promise<void> => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await pred()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("condition not met in time");
};

beforeAll(async () => {
  repo = mkdtempSync(join(tmpdir(), "skynet-full-auto-repo-"));
  worktreesDir = mkdtempSync(join(tmpdir(), "skynet-full-auto-wt-"));
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
  delete process.env.RUNNER;
  ({ Hub } = await import("../apps/server/src/hub.js"));
  ({ Orchestrator } = await import("../apps/server/src/orchestrator.js"));
  ({ MemoryStore } = await import("../apps/server/src/store/memory.js"));
});
afterAll(() => {
  rmSync(repo, { recursive: true, force: true });
  rmSync(worktreesDir, { recursive: true, force: true });
});

describe("full-autonomy approval level — diff review auto-merges unattended", () => {
  beforeEach(() => {
    git("checkout", "-f", "main");
    git("branch", "--list", "agent/*")
      .split("\n")
      .filter(Boolean)
      .forEach((b) => {
        try {
          git("branch", "-D", b.replace("*", "").trim());
        } catch {
          /* ignore */
        }
      });
  });

  /** One project + one run, wired to the given approval level/autonomy, ready to assign. */
  async function setup(approvalLevel: "trusted" | "full", autonomy: boolean, fileCount = 1) {
    const store = new MemoryStore({ seed: false });
    const hub = new Hub(store, new NullBus());
    const provider = new ScriptedProvider(fileCount);
    const orchestrator = new Orchestrator(store, hub, provider);
    const pid = `p-${Math.round(Math.random() * 1e9)}`;
    await store.putProject({
      id: pid, workspaceId: DEFAULT_WORKSPACE, name: "P", goal: "", runIds: [], status: "active",
      approvalLevel, approvalRules: [], autonomy, repoPath: null, gitBacked: false,
    } as Project);
    await store.putAgent({ id: `a-${pid}`, workspaceId: DEFAULT_WORKSPACE, name: "a", provider: "claude", model: "opus-4.8", status: "idle", idleSince: 0 } as Agent);
    await store.putTask({ id: `t-${pid}`, workspaceId: DEFAULT_WORKSPACE, projectId: pid, text: "do it", state: "backlog", runId: null } as Task);
    const run = await orchestrator.assignTask(pid, `t-${pid}`);
    const openDiff = async (): Promise<HitlItem | undefined> =>
      (await store.listQueue(DEFAULT_WORKSPACE)).find((q) => q.runId === run.id && q.kind === "diff" && q.resolvedAt == null);
    return { store, pid, run, openDiff };
  }

  it("full + autonomy on: merges on its own, no open gate, no human resolve", async () => {
    const t = await setup("full", true);
    await waitFor(async () => (await t.store.getRun(t.run.id))?.status === "done");
    expect(await t.openDiff()).toBeUndefined(); // never left open for anyone
    expect(git("show", `skynet/integration/${t.pid}:file-0.txt`)).toContain("change 0");
    const task = (await t.store.listTasks(DEFAULT_WORKSPACE)).find((x) => x.id === `t-${t.pid}`)!;
    expect(task.state).toBe("done");
    // Audited as a policy decision, not a human one.
    const audit = await t.store.listAudit(DEFAULT_WORKSPACE);
    expect(audit.some((a) => a.action === "approve" && a.operatorId === "policy:full-autonomy")).toBe(true);
  });

  it("trusted (not full): diff review still gates for a human", async () => {
    const t = await setup("trusted", true);
    await waitFor(async () => (await t.openDiff()) != null);
    expect(await t.openDiff()).toBeDefined(); // waiting on a human, same as before this change
    expect((await t.store.getRun(t.run.id))?.status).not.toBe("done");
  });

  it("full but autonomy off: the level alone doesn't unlock anything", async () => {
    const t = await setup("full", false);
    await waitFor(async () => (await t.openDiff()) != null);
    expect(await t.openDiff()).toBeDefined(); // autonomy is the master switch — still gates
  });

  it("full + autonomy on, but an unusually large diff: still gates for a human", async () => {
    const t = await setup("full", true, 41); // > 40 files → risk: "high"
    await waitFor(async () => (await t.openDiff()) != null);
    expect(await t.openDiff()).toBeDefined();
    expect((await t.store.getRun(t.run.id))?.status).not.toBe("done");
  });
});
