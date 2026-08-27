// Steward-driven board tidy: priority-sort every non-done column by title +
// description (one LLM call per column), archive everything currently in
// Done. Drives the real Operations.organizeBoard with an injected `organizeAsk`
// test seam (steward/organize.ts's `ask` param) — no real LLM call, no key.
import { describe, it, expect } from "vitest";
import { DEFAULT_WORKSPACE } from "@skynet/shared";
import type { Agent, Project, Task } from "@skynet/shared";
import { Hub } from "../apps/server/src/hub.js";
import { Orchestrator } from "../apps/server/src/orchestrator.js";
import { Operations } from "../apps/server/src/operations.js";
import { MemoryStore } from "../apps/server/src/store/memory.js";
import type { Bus } from "../apps/server/src/bus.js";
import type { RunnerProvider } from "@skynet/runner-sdk";

class NullBus implements Bus {
  publish(): void {}
  subscribe(): () => void {
    return () => {};
  }
}
const provider: RunnerProvider = {
  id: "claude",
  async start(spec, _events) {
    return { runId: spec.runId, provider: "claude", async pause() {}, async resume() {}, async message() {}, async stop() {} };
  },
};

const setup = async (organizeAsk?: (prompt: string) => Promise<string>) => {
  const store = new MemoryStore({ seed: false });
  const hub = new Hub(store, new NullBus());
  const orchestrator = new Orchestrator(store, hub, provider);
  const ops = new Operations({ store, hub, orchestrator, organizeAsk });
  await store.putProject({
    id: "p1", workspaceId: DEFAULT_WORKSPACE, name: "P", goal: "ship fast", runIds: [],
    status: "active", repoPath: null, gitBacked: false,
  } as Project);
  await store.putAgent({ id: "a1", workspaceId: DEFAULT_WORKSPACE, name: "a1", provider: "claude", model: "opus-4.8", status: "idle", idleSince: 0 } as Agent);
  return { store, ops };
};

const mkTask = (id: string, text: string, state: Task["state"], order: number): Task =>
  ({ id, workspaceId: DEFAULT_WORKSPACE, projectId: "p1", text, description: null, state, runId: null, order }) as Task;

describe("organizeBoard: Steward priority-sorts columns and archives Done", () => {
  it("reorders a column to the ask's returned priority order", async () => {
    const { store, ops } = await setup(async () => JSON.stringify({ order: ["t3", "t1", "t2"] }));
    await store.putTask(mkTask("t1", "low priority polish", "backlog", 0));
    await store.putTask(mkTask("t2", "medium thing", "backlog", 1));
    await store.putTask(mkTask("t3", "critical security fix", "backlog", 2));

    const result = await ops.organizeBoard(DEFAULT_WORKSPACE, "p1");
    expect(result.reordered).toBe(3);

    const backlog = (await store.listTasks(DEFAULT_WORKSPACE))
      .filter((t) => t.state === "backlog")
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    expect(backlog.map((t) => t.id)).toEqual(["t3", "t1", "t2"]);
  });

  it("archives every current Done task, but never reorders Done", async () => {
    const { store, ops } = await setup(async () => JSON.stringify({ order: ["t1"] }));
    await store.putTask(mkTask("d1", "shipped feature A", "done", 0));
    await store.putTask(mkTask("d2", "shipped feature B", "done", 1));

    const result = await ops.organizeBoard(DEFAULT_WORKSPACE, "p1");
    expect(result.archived).toBe(2);

    const tasks = await store.listTasks(DEFAULT_WORKSPACE);
    expect(tasks.find((t) => t.id === "d1")?.archived).toBe(true);
    expect(tasks.find((t) => t.id === "d2")?.archived).toBe(true);
  });

  it("a column with fewer than 2 tasks is left alone — no ask call needed", async () => {
    let called = false;
    const { store, ops } = await setup(async () => {
      called = true;
      return JSON.stringify({ order: ["t1"] });
    });
    await store.putTask(mkTask("t1", "the only task in todo", "todo", 0));

    const result = await ops.organizeBoard(DEFAULT_WORKSPACE, "p1");
    expect(result.reordered).toBe(0);
    expect(called).toBe(false);
  });

  it("an unreadable reply degrades to leaving that column's order UNCHANGED — never throws, never loses a task", async () => {
    const { store, ops } = await setup(async () => "not json at all");
    await store.putTask(mkTask("t1", "first", "backlog", 0));
    await store.putTask(mkTask("t2", "second", "backlog", 1));

    const result = await ops.organizeBoard(DEFAULT_WORKSPACE, "p1");
    expect(result.reordered).toBe(0);
    const backlog = (await store.listTasks(DEFAULT_WORKSPACE))
      .filter((t) => t.state === "backlog")
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    expect(backlog.map((t) => t.id)).toEqual(["t1", "t2"]); // unchanged
  });

  it("a reply that drops/invents ids is repaired, not trusted blind — every real task still ends up placed exactly once", async () => {
    // Drops t2, duplicates t1, invents a nonexistent "ghost" id.
    const { store, ops } = await setup(async () => JSON.stringify({ order: ["t3", "t1", "t1", "ghost"] }));
    await store.putTask(mkTask("t1", "first", "backlog", 0));
    await store.putTask(mkTask("t2", "second", "backlog", 1));
    await store.putTask(mkTask("t3", "third", "backlog", 2));

    await ops.organizeBoard(DEFAULT_WORKSPACE, "p1");
    const backlog = (await store.listTasks(DEFAULT_WORKSPACE))
      .filter((t) => t.state === "backlog")
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    // t3, t1 as given (deduped), then t2 appended (omitted by the model, never dropped).
    expect(backlog.map((t) => t.id)).toEqual(["t3", "t1", "t2"]);
  });

  it("retries once on an unreadable first reply, then applies a valid second reply", async () => {
    let calls = 0;
    const { store, ops } = await setup(async () => {
      calls++;
      return calls === 1 ? "garbage" : JSON.stringify({ order: ["t2", "t1"] });
    });
    await store.putTask(mkTask("t1", "first", "backlog", 0));
    await store.putTask(mkTask("t2", "second", "backlog", 1));

    await ops.organizeBoard(DEFAULT_WORKSPACE, "p1");
    expect(calls).toBe(2);
    const backlog = (await store.listTasks(DEFAULT_WORKSPACE))
      .filter((t) => t.state === "backlog")
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
    expect(backlog.map((t) => t.id)).toEqual(["t2", "t1"]);
  });
});
