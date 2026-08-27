// Regression test for a live incident: a bulk task-creation path (GitHub-
// issue resync, brief decomposition, repo-file import) calls
// Operations.createTask once per new task, and createTask fires the
// background task linter (maybeLintTask) fully unthrottled — each lint call
// is a real in-process Claude Agent SDK session (lintTask -> oneShotText),
// not a cheap HTTP call. A resync that pulled in a large batch of
// never-before-seen GitHub issues fired dozens of these concurrently inside
// the app's own process, exhausted host memory, and wedged the whole VM
// (2026-08-27). Operations now bounds concurrent lint calls via
// withLintSlot; this proves the cap actually holds under a burst of
// concurrent task creation.
import { describe, it, expect } from "vitest";
import { DEFAULT_WORKSPACE } from "@skynet/shared";
import type { Project, ProviderId } from "@skynet/shared";
import type { RunnerEvents, RunnerHandle, RunnerProvider, StartSpec } from "@skynet/runner-sdk";
import { Hub } from "../apps/server/src/hub.js";
import { Orchestrator } from "../apps/server/src/orchestrator.js";
import { Operations } from "../apps/server/src/operations.js";
import { MemoryStore } from "../apps/server/src/store/memory.js";
import type { Bus } from "../apps/server/src/bus.js";

class NullBus implements Bus {
  publish(): void {}
  subscribe(): () => void {
    return () => {};
  }
}

// Never actually invoked — createTask/lintTaskNow never touch the
// orchestrator — but Operations requires one to construct.
class UnusedProvider implements RunnerProvider {
  readonly id: ProviderId = "claude";
  async start(_spec: StartSpec, _events: RunnerEvents): Promise<RunnerHandle> {
    throw new Error("not used by this test");
  }
}

describe("task-linter bulk-import concurrency cap", () => {
  it("never runs more than 3 lint calls at once, even when 20 tasks are created at the same instant", async () => {
    const store = new MemoryStore({ seed: false });
    const hub = new Hub(store, new NullBus());
    const orchestrator = new Orchestrator(store, hub, new UnusedProvider());

    let inFlight = 0;
    let maxObservedInFlight = 0;
    let totalCalls = 0;
    const lintConsult = async () => {
      totalCalls++;
      inFlight++;
      maxObservedInFlight = Math.max(maxObservedInFlight, inFlight);
      // Yield long enough that a burst of concurrent createTask calls would
      // all overlap here if nothing throttled them.
      await new Promise((r) => setTimeout(r, 20));
      inFlight--;
      return [];
    };

    const ops = new Operations({ store, hub, orchestrator, lintConsult });
    const project: Project = {
      id: "p1", workspaceId: DEFAULT_WORKSPACE, name: "P", goal: "", runIds: [],
      status: "active", repoPath: null, gitBacked: false,
    } as Project;
    await store.putProject(project);

    // Simulate a bulk import: many tasks created back-to-back with no await
    // between them, exactly like resyncProjectSource's / decomposeBrief's loop.
    await Promise.all(
      Array.from({ length: 20 }, (_, i) => ops.createTask(DEFAULT_WORKSPACE, "p1", { text: `issue ${i}` })),
    );

    // The fire-and-forget lints are still draining after createTask resolves
    // (createTask doesn't await them) — wait for them all to finish.
    await new Promise((r) => setTimeout(r, 500));

    expect(totalCalls).toBe(20); // every task still gets linted eventually
    expect(maxObservedInFlight).toBeLessThanOrEqual(3); // but never more than the cap at once
    expect(maxObservedInFlight).toBeGreaterThan(1); // and the cap isn't accidentally serializing everything to 1
  });
});
