// Guards #3 + #6: the module map is resolved from each project's OWN repo
// (`project.repoPath`), not a single static global one, and the diff-review HITL
// reports the modules the changed files ACTUALLY touched (via that per-project
// map) — never the agent's declared-but-empty scope.
//
// Setup pins this precisely: the project's own repo and the server-global
// integration repo BOTH map `src/widget/**`, but to DIFFERENT module ids. The
// scripted agent writes `src/widget/thing.ts`. If the orchestrator read the
// global repo (the old static field) the HITL would carry the global id; a
// correct per-project resolution carries the project's id and never the global
// one. modifiedFiles must also reflect the real changed file.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { DEFAULT_WORKSPACE } from "@skynet/shared";
import type { ProviderId, Project, Agent, Task, HitlItem, PlanStep } from "@skynet/shared";
import type { RunnerEvents, RunnerHandle, RunnerProvider, StartSpec } from "@skynet/runner-sdk";
import type { Bus } from "../apps/server/src/bus.js";

class NullBus implements Bus {
  publish(): void {}
  subscribe(): () => void {
    return () => {};
  }
}

// Writes one file into the module the maps disagree about, then completes.
class ScriptedProvider implements RunnerProvider {
  readonly id: ProviderId = "claude";
  async start(spec: StartSpec, events: RunnerEvents): Promise<RunnerHandle> {
    const plan: PlanStep[] = [{ title: "Add the widget", state: "now" }];
    events.onProgress(spec.runId, 0.5, plan);
    const file = join(spec.cwd!, "src/widget/thing.ts");
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, "export const thing = 1;\n");
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
let globalRepo: string, projectRepo: string, worktreesDir: string;

const initRepo = (dir: string, moduleId: string): void => {
  execFileSync("git", ["init", "-b", "main", dir]);
  const g = (...a: string[]) => execFileSync("git", ["-C", dir, ...a], { stdio: ["ignore", "pipe", "pipe"] });
  g("config", "user.email", "test@skynet.local");
  g("config", "user.name", "Test");
  mkdirSync(join(dir, ".skynet"), { recursive: true });
  // Same glob in both repos, deliberately different module ids, so the id in the
  // HITL tells us which repo's map was read.
  writeFileSync(
    join(dir, ".skynet", "modules.json"),
    JSON.stringify({ modules: [{ id: moduleId, name: moduleId, globs: ["src/widget/**"] }] }),
  );
  writeFileSync(join(dir, "README.md"), "# base\n");
  g("add", "-A");
  g("commit", "-m", "base");
};

const waitFor = async (pred: () => Promise<boolean>, ms = 5000): Promise<void> => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await pred()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error("condition not met in time");
};

beforeAll(async () => {
  globalRepo = mkdtempSync(join(tmpdir(), "skynet-mmf-global-"));
  projectRepo = mkdtempSync(join(tmpdir(), "skynet-mmf-project-"));
  worktreesDir = mkdtempSync(join(tmpdir(), "skynet-mmf-wt-"));
  initRepo(globalRepo, "global/thing"); // what the OLD static field would report
  initRepo(projectRepo, "project/widget"); // what the per-project map must report
  process.env.STORE = "memory";
  process.env.BUS = "memory";
  process.env.SKYNET_INTEGRATION_REPO = globalRepo;
  process.env.SKYNET_WORKTREES_DIR = worktreesDir;
  process.env.SKYNET_BASE_BRANCH = "main";
  delete process.env.RUNNER;
  ({ Hub } = await import("../apps/server/src/hub.js"));
  ({ Orchestrator } = await import("../apps/server/src/orchestrator.js"));
  ({ MemoryStore } = await import("../apps/server/src/store/memory.js"));
});
afterAll(() => {
  for (const d of [globalRepo, projectRepo, worktreesDir]) rmSync(d, { recursive: true, force: true });
});

describe("per-project module map + diff HITL reflects changed files (#3/#6)", () => {
  it("resolves modules from the project's own repo, derived from the real diff", async () => {
    const store = new MemoryStore({ seed: false });
    const hub = new Hub(store, new NullBus());
    const orchestrator = new Orchestrator(store, hub, new ScriptedProvider());

    // A git-backed project bound to its OWN repo (not the global integration repo).
    await store.putProject({
      id: "p1",
      workspaceId: DEFAULT_WORKSPACE,
      name: "P",
      goal: "",
      runIds: [],
      status: "active",
      repoPath: projectRepo,
      gitBacked: true,
      repo: null,
    } as Project);
    await store.putAgent({ id: "r1", workspaceId: DEFAULT_WORKSPACE, name: "r1", provider: "claude", model: "opus-4.8", status: "idle", idleSince: 0 } as Agent);
    await store.putTask({ id: "t1", workspaceId: DEFAULT_WORKSPACE, projectId: "p1", text: "Add the widget", state: "backlog", runId: null } as Task);

    const openDiff = async (): Promise<HitlItem | undefined> =>
      (await store.listQueue(DEFAULT_WORKSPACE)).find((q) => q.kind === "diff" && q.resolvedAt == null);

    const run = await orchestrator.assignTask("p1", "t1");
    // The declared scope is empty — anything the HITL reports must come from the
    // actual changed files, not `agent.modules`.
    expect(run.modules).toEqual([]);

    await waitFor(async () => (await openDiff()) != null);
    const diff = (await openDiff())!;

    // #6: modules derived from the changed file, not the empty declared scope.
    // #3: the id proves the PROJECT's map was read, never the global one.
    expect(diff.diff.modules).toContain("project/widget");
    expect(diff.diff.modules).not.toContain("global/thing");

    // The run now reflects what actually changed (modifiedFiles was never set before).
    const updated = (await store.getRun(run.id))!;
    expect(updated.modifiedFiles).toContain("src/widget/thing.ts");
  });
});
