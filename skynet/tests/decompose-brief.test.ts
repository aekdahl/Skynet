// S7: decompose an APPROVED SolutionBrief into a Feature + ordered, sized,
// linked Tasks — one structured-output LLM call, retried once on an
// unreadable reply, then a thrown error with nothing created. Drives the
// consult through Operations' injected `decomposeConsult` seam (mirrors
// Orchestrator's providerOverride/previewOverride) rather than mocking the
// module-level oneShotText — deterministic and free of Vite's dep-cache
// mocking quirks for a node_modules-resolved package. `parseDecomposition`
// itself (pure, no I/O) is exercised directly too, same "test the parser
// standalone" discipline as task-linter.test.ts.
import { describe, it, expect } from "vitest";
import type { ProviderId, ServerEvent } from "@skynet/shared";
import { DEFAULT_WORKSPACE } from "@skynet/shared";
import { Hub } from "../apps/server/src/hub.js";
import { Orchestrator } from "../apps/server/src/orchestrator.js";
import { NotFoundError, Operations } from "../apps/server/src/operations.js";
import { MemoryStore } from "../apps/server/src/store/memory.js";
import type { Bus } from "../apps/server/src/bus.js";
import type { RunnerEvents, RunnerHandle, RunnerProvider, StartSpec } from "@skynet/runner-sdk";
import { parseDecomposition } from "../apps/server/src/decompose.js";

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

// A queue of canned replies (in call order) the stub consult hands back —
// lets a test script "first attempt fails, second succeeds" etc. while still
// recording every call for assertions.
function stubConsult(replies: string[]) {
  const calls: { prompt: string; model: string }[] = [];
  const fn = async (opts: { prompt: string; model: string; apiKey?: string | null }) => {
    calls.push({ prompt: opts.prompt, model: opts.model });
    const reply = replies[calls.length - 1];
    if (reply === undefined) throw new Error("stubConsult: ran out of queued replies");
    return reply;
  };
  return { fn, calls };
}

const setup = (decomposeConsult?: (opts: { prompt: string; model: string; apiKey?: string | null }) => Promise<string>) => {
  const store = new MemoryStore();
  const bus = new RecordingBus();
  const hub = new Hub(store, bus);
  const orchestrator = new Orchestrator(store, hub, new NoopProvider());
  const ops = new Operations({ store, hub, orchestrator, decomposeConsult });
  return { store, hub, bus, ops };
};

const mkProject = (ops: Operations) => ops.createProject(DEFAULT_WORKSPACE, { name: "P", goal: "ship" });

const GOOD_REPLY = JSON.stringify({
  feature: { name: "Webhook reliability", description: "Idempotent webhook processing." },
  tasks: [
    {
      text: "Add idempotency key column",
      description: "Add a unique idempotency_key column to the webhooks table.",
      acceptanceCriteria: ["migration adds the column", "unique index in place"],
      effort: "small",
      dependsOnIndex: [],
    },
    {
      text: "Reject duplicate webhook posts",
      description: "Use the new column to short-circuit a retried delivery.",
      acceptanceCriteria: ["a replayed webhook is a no-op", "original response still returned"],
      effort: "medium",
      dependsOnIndex: [0],
    },
  ],
});

describe("parseDecomposition — structured", () => {
  it("reads a full plan with sanitized indices", () => {
    const plan = parseDecomposition(GOOD_REPLY);
    expect(plan?.feature.name).toBe("Webhook reliability");
    expect(plan?.tasks).toHaveLength(2);
    expect(plan?.tasks[1]?.dependsOnIndex).toEqual([0]);
  });

  it("drops a forward/self-referencing or out-of-range dependsOnIndex rather than failing the whole plan", () => {
    const reply = JSON.stringify({
      feature: { name: "F" },
      tasks: [
        { text: "A", dependsOnIndex: [0, 1, 99] }, // self, forward, out-of-range — all invalid at index 0
        { text: "B", dependsOnIndex: [0] }, // valid — earlier index
      ],
    });
    const plan = parseDecomposition(reply);
    expect(plan?.tasks[0]?.dependsOnIndex).toEqual([]);
    expect(plan?.tasks[1]?.dependsOnIndex).toEqual([0]);
  });

  it("drops a task missing `text` but keeps the rest", () => {
    const reply = JSON.stringify({ feature: { name: "F" }, tasks: [{ description: "no title" }, { text: "Real task" }] });
    const plan = parseDecomposition(reply);
    expect(plan?.tasks).toHaveLength(1);
    expect(plan?.tasks[0]?.text).toBe("Real task");
  });

  it("returns null for an unreadable reply, a nameless feature, or zero usable tasks", () => {
    expect(parseDecomposition("not json")).toBeNull();
    expect(parseDecomposition(JSON.stringify({ feature: {}, tasks: [{ text: "x" }] }))).toBeNull();
    expect(parseDecomposition(JSON.stringify({ feature: { name: "F" }, tasks: [{ description: "no text" }] }))).toBeNull();
  });

  it("defaults an unrecognized effort to null rather than guessing", () => {
    const reply = JSON.stringify({ feature: { name: "F" }, tasks: [{ text: "T", effort: "xl" }] });
    expect(parseDecomposition(reply)?.tasks[0]?.effort).toBeNull();
  });
});

describe("Operations.decomposeBrief", () => {
  it("rejects a non-approved brief", async () => {
    const consult = stubConsult([GOOD_REPLY]);
    const { ops } = setup(consult.fn);
    const project = await mkProject(ops);
    const brief = await ops.createBrief(DEFAULT_WORKSPACE, project.id, { title: "T", approach: "x" });
    expect(brief.status).toBe("draft");
    await expect(ops.decomposeBrief(DEFAULT_WORKSPACE, project.id, brief.id)).rejects.toThrow(/approved/i);
    expect(consult.calls).toHaveLength(0); // never even asks the model
  });

  it("creates a Feature + linked, sourced, sized tasks from a stubbed-model reply, and links the brief", async () => {
    const consult = stubConsult([GOOD_REPLY]);
    const { ops, store } = setup(consult.fn);
    const project = await mkProject(ops);
    const brief = await ops.createBrief(DEFAULT_WORKSPACE, project.id, {
      title: "Reconcile webhooks", problem: "double-posts", approach: "idempotency key", acceptanceCriteria: ["no dupes"],
    });
    await ops.updateBrief(DEFAULT_WORKSPACE, brief.id, { status: "approved" }, "jordan");

    const { feature, tasks } = await ops.decomposeBrief(DEFAULT_WORKSPACE, project.id, brief.id);

    expect(feature.name).toBe("Webhook reliability");
    expect(feature.projectId).toBe(project.id);
    expect(tasks).toHaveLength(2);
    for (const t of tasks) {
      expect(t.featureId).toBe(feature.id);
      expect(t.state).toBe("backlog"); // NOT todo — triage/linter run normally
      expect(t.source).toEqual({ kind: "brief", briefId: brief.id });
    }
    expect(tasks[0]?.assessmentEffort).toBe("small");
    expect(tasks[0]?.description).toContain("## Acceptance");
    expect(tasks[0]?.description).toContain("migration adds the column");
    expect(tasks[1]?.assessmentEffort).toBe("medium");
    expect(tasks[1]?.dependsOnTaskIds).toEqual([tasks[0]!.id]); // dependsOnIndex resolved to a real task id

    const storedFeature = await store.getFeature(feature.id);
    expect(storedFeature).toBeTruthy();
    const storedBrief = await store.getSolutionBrief(brief.id);
    expect(storedBrief?.featureId).toBe(feature.id);
    expect(storedBrief?.status).toBe("approved"); // S7 does NOT advance to "building" — that's S8
    expect(consult.calls).toHaveLength(1); // no retry needed
  });

  it("rejects a second decompose on the same brief once it's already produced tasks (regenerate = delete first, manual)", async () => {
    const consult = stubConsult([GOOD_REPLY]);
    const { ops } = setup(consult.fn);
    const project = await mkProject(ops);
    const brief = await ops.createBrief(DEFAULT_WORKSPACE, project.id, { title: "T", approach: "x" });
    await ops.updateBrief(DEFAULT_WORKSPACE, brief.id, { status: "approved" }, "jordan");
    await ops.decomposeBrief(DEFAULT_WORKSPACE, project.id, brief.id);

    await expect(ops.decomposeBrief(DEFAULT_WORKSPACE, project.id, brief.id)).rejects.toThrow(/already been decomposed/i);
    expect(consult.calls).toHaveLength(1); // the second call never even asks the model
  });

  it("does NOT reject when the brief merely has a pre-existing featureId from manual linking (idempotency is by content, not by featureId)", async () => {
    const consult = stubConsult([GOOD_REPLY]);
    const { ops } = setup(consult.fn);
    const project = await mkProject(ops);
    const preexisting = await ops.createFeature(DEFAULT_WORKSPACE, project.id, { name: "Pre-existing feature" });
    const brief = await ops.createBrief(DEFAULT_WORKSPACE, project.id, { title: "T", approach: "x", featureId: preexisting.id });
    await ops.updateBrief(DEFAULT_WORKSPACE, brief.id, { status: "approved" }, "jordan");

    await expect(ops.decomposeBrief(DEFAULT_WORKSPACE, project.id, brief.id)).resolves.toBeTruthy();
  });

  it("retries the consult once on an unreadable reply, then throws with NOTHING created", async () => {
    const consult = stubConsult(["not valid json at all", "still not readable"]);
    const { ops, store } = setup(consult.fn);
    const project = await mkProject(ops);
    const brief = await ops.createBrief(DEFAULT_WORKSPACE, project.id, { title: "T", approach: "x" });
    await ops.updateBrief(DEFAULT_WORKSPACE, brief.id, { status: "approved" }, "jordan");

    await expect(ops.decomposeBrief(DEFAULT_WORKSPACE, project.id, brief.id)).rejects.toThrow(/plan|readable/i);
    expect(consult.calls).toHaveLength(2); // retried exactly once
    expect(await store.listFeatures(DEFAULT_WORKSPACE)).toHaveLength(0); // nothing half-created
    expect((await store.listTasks(DEFAULT_WORKSPACE)).filter((t) => t.projectId === project.id)).toHaveLength(0);
    const freshBrief = await store.getSolutionBrief(brief.id);
    expect(freshBrief?.featureId).toBeNull(); // brief itself untouched too
  });

  it("succeeds on the SECOND attempt when the first reply was unreadable", async () => {
    const consult = stubConsult(["garbage", GOOD_REPLY]);
    const { ops } = setup(consult.fn);
    const project = await mkProject(ops);
    const brief = await ops.createBrief(DEFAULT_WORKSPACE, project.id, { title: "T", approach: "x" });
    await ops.updateBrief(DEFAULT_WORKSPACE, brief.id, { status: "approved" }, "jordan");

    const { tasks } = await ops.decomposeBrief(DEFAULT_WORKSPACE, project.id, brief.id);
    expect(tasks).toHaveLength(2);
    expect(consult.calls).toHaveLength(2);
  });

  it("404s for a foreign-workspace project or a brief from a different project", async () => {
    const consult = stubConsult([GOOD_REPLY]);
    const { ops } = setup(consult.fn);
    const project = await mkProject(ops);
    const brief = await ops.createBrief(DEFAULT_WORKSPACE, project.id, { title: "T", approach: "x" });
    await ops.updateBrief(DEFAULT_WORKSPACE, brief.id, { status: "approved" }, "jordan");
    await expect(ops.decomposeBrief(DEFAULT_WORKSPACE, "no-such-project", brief.id)).rejects.toThrow(NotFoundError);

    const otherProject = await mkProject(ops);
    await expect(ops.decomposeBrief(DEFAULT_WORKSPACE, otherProject.id, brief.id)).rejects.toThrow(NotFoundError);
  });
});

describe("dependency-gated auto-pick (S7's ordering intent surviving into tickAutonomy)", () => {
  const idleAgent = { id: "a1", workspaceId: DEFAULT_WORKSPACE, name: "a1", provider: "claude" as const, model: "opus-4.8", status: "idle" as const, idleSince: 0 };

  it("does NOT auto-pick a task whose dependency isn't done yet, then picks it up once the dependency completes", async () => {
    const store = new MemoryStore();
    const hub = new Hub(store, new RecordingBus());
    const provider = new NoopProvider();
    const orch = new Orchestrator(store, hub, provider);
    const project = { id: "p1", workspaceId: DEFAULT_WORKSPACE, name: "P", goal: "", runIds: [], status: "active" as const, autonomy: true, repoPath: null, gitBacked: false };
    await store.putProject(project);
    await store.putAgent(idleAgent);

    const upstream = {
      id: "up", workspaceId: DEFAULT_WORKSPACE, projectId: "p1", text: "upstream", state: "todo" as const,
      runId: null, autoPick: false, assessment: null, reviewVerdict: null, lint: null,
      assignment: { mode: "any" as const, agentIds: [] },
    };
    const downstream = {
      id: "down", workspaceId: DEFAULT_WORKSPACE, projectId: "p1", text: "downstream", state: "todo" as const,
      runId: null, autoPick: true, assessment: null, reviewVerdict: null, lint: null,
      assignment: { mode: "any" as const, agentIds: [] }, dependsOnTaskIds: ["up"],
    };
    await store.putTask(upstream as never);
    await store.putTask(downstream as never);

    await orch.tickAutonomy();
    expect((await store.getTask("down"))?.state).toBe("todo"); // still gated — upstream isn't done

    await store.putTask({ ...upstream, state: "done" } as never);
    await orch.tickAutonomy();
    expect((await store.getTask("down"))?.state).toBe("ongoing"); // dependency satisfied — now picks up
  });
});
