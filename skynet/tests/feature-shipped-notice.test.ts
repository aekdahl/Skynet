// S12 follow-through: once a Feature's whole batch of tasks finishes (every
// sibling merged), a `feature.shipped` ServerEvent fires exactly once — the
// signal Telegram's bridge turns into a "🚀 Feature shipped" notice (see
// telegram/notices.ts's featureShippedNotice + its wiring in telegram/index.ts).
// Same real-git harness as tests/brief-threading.test.ts's section 3 (that
// file drives the SAME local-merge completion path to test the brief's
// building→done transition; this one tests the sibling notification instead).
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_WORKSPACE } from "@skynet/shared";
import type { Agent, Feature, HitlItem, Project, ProviderId, Resolution, ServerEvent, Task, TaskRun } from "@skynet/shared";
import type { RunnerEvents, RunnerHandle, RunnerProvider, StartSpec } from "@skynet/runner-sdk";
import type { Bus } from "../apps/server/src/bus.js";

class RecordingBus implements Bus {
  events: { ws: string; event: ServerEvent }[] = [];
  publish(ws: string, event: ServerEvent): void {
    this.events.push({ ws, event });
  }
  subscribe(): () => void {
    return () => {};
  }
}

class OneTaskProvider implements RunnerProvider {
  readonly id: ProviderId = "claude";
  async start(spec: StartSpec, events: RunnerEvents): Promise<RunnerHandle> {
    writeFileSync(join(spec.cwd!, `${spec.runId}.txt`), `work for ${spec.runId}\n`);
    setTimeout(() => events.onCompleted(spec.runId, spec.branch), 0);
    return { runId: spec.runId, provider: this.id, async pause() {}, async resume() {}, async message() {}, async stop() {} };
  }
}

let Hub: typeof import("../apps/server/src/hub.js").Hub;
let Orchestrator: typeof import("../apps/server/src/orchestrator.js").Orchestrator;
let MemoryStore: typeof import("../apps/server/src/store/memory.js").MemoryStore;
let repo: string, worktreesDir: string;

const waitFor = async (pred: () => Promise<boolean> | boolean, ms = 8000) => {
  const dl = Date.now() + ms;
  while (Date.now() < dl) {
    if (await pred()) return;
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error("timeout");
};

beforeAll(async () => {
  repo = mkdtempSync(join(tmpdir(), "skynet-feature-shipped-repo-"));
  worktreesDir = mkdtempSync(join(tmpdir(), "skynet-feature-shipped-wt-"));
  execFileSync("git", ["init", "-b", "main", repo]);
  execFileSync("git", ["-C", repo, "config", "user.email", "t@t.local"]);
  execFileSync("git", ["-C", repo, "config", "user.name", "T"]);
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

describe("feature.shipped notice event (real git)", () => {
  async function runTaskToDone(store: any, orch: any, taskId: string, projectId: string): Promise<void> {
    await orch.assignTask(projectId, taskId);
    const findOpenDiff = async (): Promise<HitlItem | undefined> => {
      const task = await store.getTask(taskId);
      if (!task?.runId) return undefined;
      return (await store.listQueue(DEFAULT_WORKSPACE)).find((h: HitlItem) => h.kind === "diff" && h.runId === task.runId && !h.resolvedAt);
    };
    await waitFor(async () => (await findOpenDiff()) != null);
    const item = (await findOpenDiff())!;
    const resolution: Resolution = { action: "approve", optionIndex: null, guidance: null, targetBranch: null, memoryNote: null, by: "op-1", at: Date.now() };
    await orch.deliver(item, resolution);
    await waitFor(async () => (await store.getTask(taskId))?.state === "done");
  }

  const setup = async () => {
    const store = new MemoryStore({ seed: false });
    const bus = new RecordingBus();
    const hub = new Hub(store, bus);
    const orch = new Orchestrator(store, hub, new OneTaskProvider());
    const project: Project = {
      id: "p1", workspaceId: DEFAULT_WORKSPACE, name: "P", goal: "", runIds: [],
      status: "active", repoPath: repo, gitBacked: true, repo: null,
    } as Project;
    await store.putProject(project);
    await store.putAgent({ id: "a1", workspaceId: DEFAULT_WORKSPACE, name: "a1", provider: "claude", model: "opus-4.8", status: "idle", idleSince: 0 } as Agent);
    return { store, bus, orch };
  };

  const shippedEvents = (bus: RecordingBus) => bus.events.filter((e) => e.event.type === "feature.shipped");

  it("fires exactly once, with the right project/feature ids and task count, once every sibling task is done", async () => {
    const { store, bus, orch } = await setup();
    const feature: Feature = {
      id: "f1", workspaceId: DEFAULT_WORKSPACE, projectId: "p1", name: "Rate limiting",
      description: null, status: "active", milestoneId: null, archived: false, createdAt: Date.now(), pr: null,
    };
    await store.putFeature(feature);
    await store.putTask({ id: "t1", workspaceId: DEFAULT_WORKSPACE, projectId: "p1", text: "add limiter middleware", state: "backlog", runId: null, featureId: "f1" } as Task);
    await store.putTask({ id: "t2", workspaceId: DEFAULT_WORKSPACE, projectId: "p1", text: "add limiter tests", state: "backlog", runId: null, featureId: "f1" } as Task);

    await runTaskToDone(store, orch, "t1", "p1");
    expect(shippedEvents(bus)).toHaveLength(0); // t2 still open — not shipped yet

    await runTaskToDone(store, orch, "t2", "p1");
    await waitFor(async () => (await store.getFeature("f1"))?.status === "shipped");

    const fired = shippedEvents(bus);
    expect(fired).toHaveLength(1); // exactly once
    const event = fired[0]!.event as Extract<ServerEvent, { type: "feature.shipped" }>;
    expect(event.featureId).toBe("f1");
    expect(event.projectId).toBe("p1");
    expect(event.taskCount).toBe(2);
    expect(fired[0]!.ws).toBe(DEFAULT_WORKSPACE);
  }, 20_000);

  it("does NOT fire for a feature that was already shipped, even if the completion path re-processes it", async () => {
    const { store, bus, orch } = await setup();
    const feature: Feature = {
      id: "f2", workspaceId: DEFAULT_WORKSPACE, projectId: "p1", name: "Already done",
      // Simulates the race this guards against: by the time completeFeatureMerged
      // reads the feature, it's already marked shipped (e.g. a racing sibling
      // completion got there first).
      description: null, status: "shipped", milestoneId: null, archived: false, createdAt: Date.now(), pr: null,
    };
    await store.putFeature(feature);
    await store.putTask({ id: "t3", workspaceId: DEFAULT_WORKSPACE, projectId: "p1", text: "solo task", state: "backlog", runId: null, featureId: "f2" } as Task);

    await runTaskToDone(store, orch, "t3", "p1");
    // The merge/status-write path still runs (idempotent no-op on status) —
    // give it a beat to settle, then confirm no notice fired.
    await new Promise((r) => setTimeout(r, 300));
    expect(shippedEvents(bus)).toHaveLength(0);
    expect((await store.getFeature("f2"))?.status).toBe("shipped"); // still shipped, just never re-notified
  }, 20_000);
});
