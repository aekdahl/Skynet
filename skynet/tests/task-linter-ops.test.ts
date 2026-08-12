// Task linter v0 (assistive), wired into Operations: creating or editing a
// task's text/description kicks a BACKGROUND lint pass (never blocking the
// caller); the result lands on the task via the normal upsert-then-publish
// path, and an operator can dismiss it. `lintTask` (the actual LLM consult)
// is mocked here — its own defensive JSON parsing is covered separately in
// task-linter.test.ts.
import { describe, it, expect, vi } from "vitest";
import type { ProviderId, ServerEvent, TaskLintConcern } from "@skynet/shared";
import { DEFAULT_WORKSPACE } from "@skynet/shared";
import { Hub } from "../apps/server/src/hub.js";
import { Orchestrator } from "../apps/server/src/orchestrator.js";
import { Operations } from "../apps/server/src/operations.js";
import { MemoryStore } from "../apps/server/src/store/memory.js";
import type { Bus } from "../apps/server/src/bus.js";
import type { RunnerEvents, RunnerHandle, RunnerProvider, StartSpec } from "@skynet/runner-sdk";

const lintTask = vi.fn<(text: string, description: string | null) => Promise<TaskLintConcern[]>>();
vi.mock("../apps/server/src/task-linter.js", () => ({
  lintTask: (text: string, description: string | null) => lintTask(text, description),
}));

class RecordingBus implements Bus {
  events: { ws: string; event: ServerEvent }[] = [];
  publish(ws: string, event: ServerEvent): void { this.events.push({ ws, event }); }
  subscribe(): () => void { return () => {}; }
}

class NoopProvider implements RunnerProvider {
  readonly id: ProviderId = "claude";
  async start(spec: StartSpec, _e: RunnerEvents): Promise<RunnerHandle> {
    return { runId: spec.runId, provider: this.id, async pause() {}, async resume() {}, async message() {}, async stop() {} };
  }
}

const setup = () => {
  const store = new MemoryStore();
  const bus = new RecordingBus();
  const hub = new Hub(store, bus);
  const orchestrator = new Orchestrator(store, hub, new NoopProvider());
  const ops = new Operations({ store, hub, orchestrator });
  return { store, hub, bus, ops };
};

const mkProject = async (ops: Operations) =>
  ops.createProject(DEFAULT_WORKSPACE, { name: "P", goal: "ship" });

// The lint pass runs fire-and-forget; give its microtask chain a turn to land.
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("Task linter v0 — Operations wiring", () => {
  it("creating a task starts null and picks up a background lint result", async () => {
    const { ops, store } = setup();
    const project = await mkProject(ops);
    lintTask.mockResolvedValueOnce([{ kind: "vague", note: "no concrete target" }]);
    const created = await ops.createTask(DEFAULT_WORKSPACE, project.id, { text: "fix the thing" });
    expect(created.lint).toBeNull(); // not blocked on the consult
    await flush();
    const after = await store.getTask(created.id);
    expect(after?.lint?.concerns).toEqual([{ kind: "vague", note: "no concrete target" }]);
    expect(after?.lint?.dismissed).toBe(false);
  });

  it("a clean task settles with an empty concerns array, not null", async () => {
    const { ops, store } = setup();
    const project = await mkProject(ops);
    lintTask.mockResolvedValueOnce([]);
    const created = await ops.createTask(DEFAULT_WORKSPACE, project.id, {
      text: "Add a `mergedAt` field to TaskRun and backfill existing rows",
    });
    await flush();
    const after = await store.getTask(created.id);
    expect(after?.lint?.concerns).toEqual([]);
  });

  it("dismissTaskLint marks the current result seen without re-checking", async () => {
    const { ops, store } = setup();
    const project = await mkProject(ops);
    lintTask.mockResolvedValueOnce([{ kind: "no-done-definition", note: "no acceptance criteria" }]);
    const created = await ops.createTask(DEFAULT_WORKSPACE, project.id, { text: "improve things" });
    await flush();
    lintTask.mockClear();
    const dismissed = await ops.dismissTaskLint(DEFAULT_WORKSPACE, created.id);
    expect(dismissed.lint?.dismissed).toBe(true);
    expect(dismissed.lint?.concerns).toEqual([{ kind: "no-done-definition", note: "no acceptance criteria" }]);
    expect(lintTask).not.toHaveBeenCalled();
    // No-op (not an error) when there's nothing to dismiss.
    const again = await ops.dismissTaskLint(DEFAULT_WORKSPACE, created.id);
    expect(again.lint?.dismissed).toBe(true);
  });

  it("editing the task text clears the stale lint and re-checks in the background", async () => {
    const { ops, store } = setup();
    const project = await mkProject(ops);
    lintTask.mockResolvedValueOnce([{ kind: "vague", note: "no concrete target" }]);
    const created = await ops.createTask(DEFAULT_WORKSPACE, project.id, { text: "fix the thing" });
    await flush();
    lintTask.mockResolvedValueOnce([]);
    const updated = await ops.updateTask(DEFAULT_WORKSPACE, created.id, {
      text: "Fix the null-pointer crash in checkout when the cart is empty",
    });
    expect(updated.lint).toBeNull(); // cleared immediately, not left stale
    await flush();
    const after = await store.getTask(created.id);
    expect(after?.lint?.concerns).toEqual([]);
    expect(lintTask).toHaveBeenCalledWith("Fix the null-pointer crash in checkout when the cart is empty", null);
  });

  it("an edit that doesn't touch text/description leaves the lint result alone", async () => {
    const { ops, store } = setup();
    const project = await mkProject(ops);
    lintTask.mockResolvedValueOnce([{ kind: "vague", note: "no concrete target" }]);
    const created = await ops.createTask(DEFAULT_WORKSPACE, project.id, { text: "fix the thing" });
    await flush();
    lintTask.mockClear();
    const updated = await ops.updateTask(DEFAULT_WORKSPACE, created.id, { autoPick: true });
    expect(updated.lint?.concerns).toEqual([{ kind: "vague", note: "no concrete target" }]);
    await flush();
    expect(lintTask).not.toHaveBeenCalled();
  });
});
