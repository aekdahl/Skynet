// Project.disallowedTools lets an operator make a tool categorically
// unavailable to a project's agents (e.g. "never Bash"), distinct from the
// existing canUseTool/AUTO_ALLOW mid-run HITL gate (which decides whether an
// AVAILABLE tool call needs review, not whether the tool exists at all).
//
// Two levels are verified:
//  - orchestrator.ts actually threads Project.disallowedTools onto the
//    StartSpec it hands the provider (assignTask is the main entry point;
//    the same field is threaded at every other provider.start() call site —
//    fork, checkpoint restore, decision-resume, revise, escalation-resume —
//    but assignTask is the one every run goes through first).
//  - claude.ts turns StartSpec.disallowedTools into the SDK's own
//    Options.disallowedTools, which — per the SDK's own doc (sdk.d.ts) and
//    its bundled implementation (forwarded verbatim as the CLI's
//    `--disallowedTools` flag) — removes the tool from the model's context
//    entirely, a categorical unavailability rather than a per-call gate.
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import type { ProviderId, Agent, Project, Task, ServerEvent } from "@skynet/shared";
import { DEFAULT_WORKSPACE } from "@skynet/shared";
import { Hub } from "../apps/server/src/hub.js";
import { Orchestrator } from "../apps/server/src/orchestrator.js";
import { MemoryStore } from "../apps/server/src/store/memory.js";
import type { Bus } from "../apps/server/src/bus.js";
import type { RunnerEvents, RunnerHandle, RunnerProvider, StartSpec } from "@skynet/runner-sdk";
import { ClaudeRunnerProvider, __setClaudeTestHooks } from "../packages/runner-sdk/src/claude.js";

class NullBus implements Bus {
  publish(_ws: string, _event: ServerEvent): void {}
  subscribe(): () => void {
    return () => {};
  }
}

// Records the StartSpec every start() call receives, instead of driving a real run.
class RecordingProvider implements RunnerProvider {
  readonly id: ProviderId = "claude";
  specs: StartSpec[] = [];
  async start(spec: StartSpec, _events: RunnerEvents): Promise<RunnerHandle> {
    this.specs.push(spec);
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

const mkFixtures = async (store: MemoryStore, disallowedTools: string[] | null) => {
  const project: Project = {
    id: "p1", workspaceId: DEFAULT_WORKSPACE, name: "Proj", goal: "", runIds: [], status: "active",
    disallowedTools,
  } as Project;
  const runner: Agent = {
    id: "r1", workspaceId: DEFAULT_WORKSPACE, name: "r1",
    provider: "claude", model: "opus-4.8", status: "idle", idleSince: 0,
  };
  const task: Task = {
    id: "t1", workspaceId: DEFAULT_WORKSPACE, projectId: "p1", text: "do the thing", state: "backlog", runId: null,
  };
  await store.putProject(project);
  await store.putAgent(runner);
  await store.putTask(task);
};

describe("orchestrator: Project.disallowedTools → StartSpec", () => {
  it("threads a project's disallowedTools onto the StartSpec handed to the provider", async () => {
    const store = new MemoryStore();
    const hub = new Hub(store, new NullBus());
    const provider = new RecordingProvider();
    const orchestrator = new Orchestrator(store, hub, provider);
    await mkFixtures(store, ["Bash"]);

    await orchestrator.assignTask("p1", "t1");

    expect(provider.specs).toHaveLength(1);
    expect(provider.specs[0]!.disallowedTools).toEqual(["Bash"]);
  });

  it("a project with no restriction (null) hands the provider an unset/null disallowedTools", async () => {
    const store = new MemoryStore();
    const hub = new Hub(store, new NullBus());
    const provider = new RecordingProvider();
    const orchestrator = new Orchestrator(store, hub, provider);
    await mkFixtures(store, null);

    await orchestrator.assignTask("p1", "t1");

    expect(provider.specs[0]!.disallowedTools).toBeFalsy();
  });
});

// Same scripted stand-in as claude-runner-retry.test.ts (pnpm gives runner-sdk
// its own copy of the SDK, so a plain vi.mock wouldn't reach claude.ts's import).
function scriptedQuery() {
  const scripts: Array<Array<Record<string, unknown>>> = [];
  const fn = vi.fn(() => {
    const msgs = scripts.shift() ?? [];
    async function* gen() {
      for (const m of msgs) yield m;
    }
    return Object.assign(gen(), { interrupt: async () => undefined });
  });
  return { fn, push: (s: Array<Record<string, unknown>>) => scripts.push(s) };
}

function fakeEvents() {
  return {
    onLog: vi.fn(),
    onProgress: vi.fn(),
    onHeartbeat: vi.fn(),
    onStatus: vi.fn(),
    onHitl: vi.fn(),
    onCompleted: vi.fn(),
    onFailed: vi.fn(),
    onChatReply: vi.fn(),
    onUsage: vi.fn(),
  } satisfies RunnerEvents;
}

const baseSpec = {
  runId: "a1", projectId: "p1", task: "make it faster",
  model: "sonnet-4.6", branch: "agent/a1", apiKey: "test-key",
};

afterEach(() => __setClaudeTestHooks(null));

describe("claude.ts: StartSpec.disallowedTools → SDK Options.disallowedTools", () => {
  it("passes disallowedTools straight through to the SDK query() options", async () => {
    const q = scriptedQuery();
    __setClaudeTestHooks({ query: q.fn as never });
    q.push([{ type: "system", session_id: "s1" }, { type: "result", subtype: "success", is_error: false, num_turns: 1 }]);

    await new ClaudeRunnerProvider().start({ ...baseSpec, disallowedTools: ["Bash"] }, fakeEvents());

    expect(q.fn).toHaveBeenCalledTimes(1);
    const options = q.fn.mock.calls[0]![0]!.options as { disallowedTools?: string[] };
    expect(options.disallowedTools).toEqual(["Bash"]);
  });

  it("omits disallowedTools (undefined) when the project has no restriction", async () => {
    const q = scriptedQuery();
    __setClaudeTestHooks({ query: q.fn as never });
    q.push([{ type: "system", session_id: "s1" }, { type: "result", subtype: "success", is_error: false, num_turns: 1 }]);

    await new ClaudeRunnerProvider().start({ ...baseSpec, disallowedTools: null }, fakeEvents());

    const options = q.fn.mock.calls[0]![0]!.options as { disallowedTools?: string[] };
    expect(options.disallowedTools).toBeUndefined();
  });

  it("logs the restriction so it's visible in the run's activity log", async () => {
    const q = scriptedQuery();
    __setClaudeTestHooks({ query: q.fn as never });
    q.push([{ type: "system", session_id: "s1" }, { type: "result", subtype: "success", is_error: false, num_turns: 1 }]);
    const events = fakeEvents();

    await new ClaudeRunnerProvider().start({ ...baseSpec, disallowedTools: ["Bash", "WebFetch"] }, events);

    expect(events.onLog).toHaveBeenCalledWith("a1", expect.stringContaining("Bash, WebFetch"));
  });
});
