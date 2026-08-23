// The orchestrator-side half of the model-mismatch warning (see
// claude-model-mismatch.test.ts for the runner-sdk detection + non-blocking
// raise). A `notice` HITL is never gating anything in the runner — it's fired
// without a matching canUseTool Promise — so dismissing it must not try to
// `resume()` a live runner or fall into the "no live runner attached" log line
// real gates hit when their session is already gone.
import { describe, it, expect, vi } from "vitest";
import type { Agent, HitlItem, Project, Resolution, ServerEvent, TaskRun } from "@skynet/shared";
import { DEFAULT_WORKSPACE } from "@skynet/shared";
import { Hub } from "../apps/server/src/hub.js";
import { Orchestrator } from "../apps/server/src/orchestrator.js";
import { MemoryStore } from "../apps/server/src/store/memory.js";
import type { Bus } from "../apps/server/src/bus.js";
import type { RunnerEvents, RunnerHandle, RunnerProvider, StartSpec } from "@skynet/runner-sdk";

class NullBus implements Bus {
  publish(_ws: string, _e: ServerEvent): void {}
  subscribe(): () => void {
    return () => {};
  }
}

class FakeProvider implements RunnerProvider {
  readonly id = "claude" as const;
  async start(spec: StartSpec, _e: RunnerEvents): Promise<RunnerHandle> {
    return { runId: spec.runId, provider: this.id, async pause() {}, async resume() {}, async message() {}, async stop() {} };
  }
  async consult(): Promise<string> {
    return "ok";
  }
}

const project: Project = {
  id: "p1", workspaceId: DEFAULT_WORKSPACE, name: "P", goal: "", runIds: [],
  status: "active", autonomy: true, repoPath: null, gitBacked: false,
};
const run: TaskRun = {
  id: "r1", workspaceId: DEFAULT_WORKSPACE, projectId: "p1", name: "run r1", status: "running",
  agentId: "a1", provider: "claude", model: "sonnet-5", branch: "agent/r1", modules: [],
  progress: 0.5, plan: [], usage: null, modifiedFiles: [], log: [], startedAt: 0,
  lastHeartbeatAt: 0, visual: false, previewUrl: null, dependsOn: [], parentId: null,
  branchFromStep: null, archived: false,
};
const agent: Agent = {
  id: "a1", workspaceId: DEFAULT_WORKSPACE, name: "a1", provider: "claude",
  model: "sonnet-5", status: "busy", idleSince: 0,
};

const noticeItem: HitlItem = {
  id: "q-r1-1", workspaceId: DEFAULT_WORKSPACE, runId: "r1", kind: "notice",
  title: "Model mismatch — this run isn't using the model you picked",
  why: 'requested "sonnet-5" but this session is actually running "claude-sonnet-4-6"',
  risk: "low", raisedAt: 0, expiresAt: null, resolvedAt: 0,
  resolution: null, rationale: null, command: null, options: null, recommended: null,
  steps: null, diff: null, output: null, flags: [], sourceBranchOverride: null,
};
const resolution: Resolution = { action: "approve", optionIndex: null, guidance: null, targetBranch: null, memoryNote: null, by: "operator", at: 1 };

describe("orchestrator: notice-kind HITL is a plain dismiss", () => {
  it("deliver() returns without touching the run — no live-runner resume, no 'not delivered' fallback log", async () => {
    const store = new MemoryStore();
    const hub = new Hub(store, new NullBus());
    const provider = new FakeProvider();
    const orch = new Orchestrator(store, hub, provider);
    await store.putProject(project);
    await store.putAgent(agent);
    await store.putRun(run);

    const runLogSpy = vi.spyOn(hub, "runLog");

    // No live handle attached for r1 (this test never went through
    // assignTask/start) — a real gate kind would fall through to
    // resumeDecisionOnFreshRunner and then the "not delivered" log line.
    // A notice must short-circuit before any of that.
    await orch.deliver(noticeItem, resolution);

    expect(runLogSpy).not.toHaveBeenCalledWith("r1", expect.stringContaining("not delivered"));
  });

  it("the same early-return applies regardless of which action dismissed it (approve/reject/modify)", async () => {
    const store = new MemoryStore();
    const hub = new Hub(store, new NullBus());
    const provider = new FakeProvider();
    const orch = new Orchestrator(store, hub, provider);
    await store.putProject(project);
    await store.putAgent(agent);
    await store.putRun(run);
    const runLogSpy = vi.spyOn(hub, "runLog");

    for (const action of ["approve", "reject", "modify"] as const) {
      await expect(orch.deliver(noticeItem, { ...resolution, action })).resolves.toBeUndefined();
    }
    expect(runLogSpy).not.toHaveBeenCalledWith("r1", expect.stringContaining("not delivered"));
  });
});
