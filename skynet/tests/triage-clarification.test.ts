// Triage clarifying questions. Triage could already decide a task was
// "unclear", but had nowhere to say WHAT was unclear and no way to resolve it —
// the task parked in `triage` forever and an agent later burned its whole turn
// budget rediscovering the same ambiguity, escalating with "no acceptance
// criteria to aim at". Now triage names what it needs, Steward drafts a
// proposed answer, and the operator's own words go into the task brief.
import { describe, it, expect } from "vitest";
import type { ProviderId, ServerEvent, Task } from "@skynet/shared";
import { DEFAULT_WORKSPACE } from "@skynet/shared";
import { splitEstMinutesTag } from "../apps/server/src/orchestrator.js";
import { Hub } from "../apps/server/src/hub.js";
import { NotFoundError, Operations } from "../apps/server/src/operations.js";
import { Orchestrator } from "../apps/server/src/orchestrator.js";
import { MemoryStore } from "../apps/server/src/store/memory.js";
import type { Bus } from "../apps/server/src/bus.js";
import type { RunnerEvents, RunnerHandle, RunnerProvider, StartSpec } from "@skynet/runner-sdk";

class RecordingBus implements Bus {
  events: ServerEvent[] = [];
  publish(_ws: string, event: ServerEvent): void { this.events.push(event); }
  subscribe(): () => void { return () => {}; }
}
class NoopProvider implements RunnerProvider {
  readonly id: ProviderId = "claude";
  async start(spec: StartSpec, _e: RunnerEvents): Promise<RunnerHandle> {
    return { runId: spec.runId, provider: this.id, async pause() {}, async resume() {}, async message() {}, async stop() {} };
  }
}

describe("splitEstMinutesTag — questions", () => {
  it("parses a questions array alongside clarity", () => {
    const t = splitEstMinutesTag('Looks under-specified.\n{"clarity":"unclear","questions":["Which auth flow?","What counts as done?"]}');
    expect(t.clarity).toBe("unclear");
    expect(t.questions).toEqual(["Which auth flow?", "What counts as done?"]);
    expect(t.body).toBe("Looks under-specified.");
  });

  it("questions alone is enough to recognise the tag (body still stripped)", () => {
    const t = splitEstMinutesTag('Body here.\n{"questions":["Which database?"]}');
    expect(t.questions).toEqual(["Which database?"]);
    expect(t.body).toBe("Body here.");
  });

  it("a missing questions field stays null, not an empty array — missing is not 'asked nothing'", () => {
    expect(splitEstMinutesTag('x\n{"clarity":"clear","estMinutes":5}').questions).toBeNull();
  });

  it("drops non-strings and blanks, caps at 5, and truncates a runaway question", () => {
    const t = splitEstMinutesTag(
      'x\n' + JSON.stringify({ questions: ["a", "", 42, null, "b", "c", "d", "e", "f", "x".repeat(500)] }),
    );
    expect(t.questions!.length).toBe(5);
    expect(t.questions!.slice(0, 3)).toEqual(["a", "b", "c"]);
    expect(t.questions!.every((q) => q.length <= 200)).toBe(true);
  });

  it("a malformed questions value doesn't drop the other fields", () => {
    const t = splitEstMinutesTag('x\n{"clarity":"unclear","estMinutes":30,"questions":"not an array"}');
    expect(t.clarity).toBe("unclear");
    expect(t.estMinutes).toBe(30);
    expect(t.questions).toBeNull();
  });
});

// ── Operations: answering appends the operator's words + re-triages ────────
const setup = () => {
  const store = new MemoryStore({ seed: false });
  const bus = new RecordingBus();
  const hub = new Hub(store, bus);
  const orchestrator = new Orchestrator(store, hub, new NoopProvider());
  const ops = new Operations({ store, hub, orchestrator });
  return { store, bus, hub, ops };
};

const withClarification = async (ops: Operations, store: MemoryStore, over: Partial<Task> = {}) => {
  const project = await ops.createProject(DEFAULT_WORKSPACE, { name: "P", goal: "" });
  const task = await ops.createTask(DEFAULT_WORKSPACE, project.id, { text: "Add auth" });
  const parked: Task = {
    ...task,
    state: "triage",
    description: "Original brief.",
    clarification: { questions: ["Which auth flow?", "What counts as done?"], draft: "Use device-code.", askedAt: 1 },
    ...over,
  };
  await store.putTask(parked);
  return { project, task: parked };
};

describe("Operations.answerClarification", () => {
  it("appends the operator's answer (and the questions it answers) to the description", async () => {
    const { ops, store } = setup();
    const { project, task } = await withClarification(ops, store);
    const updated = await ops.answerClarification(DEFAULT_WORKSPACE, task.id, "  Use OAuth device-code; done = a passing e2e login test.  ");

    // The original brief survives — this is an append, never a replace.
    expect(updated.description).toContain("Original brief.");
    // The operator's own words, verbatim (trimmed), never model-rewritten.
    expect(updated.description).toContain("Use OAuth device-code; done = a passing e2e login test.");
    // The questions are recorded alongside, so the answer reads in context later.
    expect(updated.description).toContain("Which auth flow?");
    expect(updated.description).toContain("What counts as done?");
    expect(updated.projectId).toBe(project.id);
  });

  it("clears the clarification and sends the task back to backlog for RE-triage", async () => {
    const { ops, store } = setup();
    const { task } = await withClarification(ops, store);
    const updated = await ops.answerClarification(DEFAULT_WORKSPACE, task.id, "answered");
    // Not promoted straight to todo: the answer may change effort/risk/grouping,
    // so the clarity call is re-made with the missing information in hand.
    expect(updated.state).toBe("backlog");
    expect(updated.clarification).toBeNull();
  });

  it("refuses when the task has no open questions — nothing to answer", async () => {
    const { ops, store } = setup();
    const { task } = await withClarification(ops, store, { clarification: null });
    await expect(ops.answerClarification(DEFAULT_WORKSPACE, task.id, "hi")).rejects.toThrow(/no open clarifying questions/i);
  });

  it("404s for an unknown / foreign-workspace task", async () => {
    const { ops } = setup();
    await expect(ops.answerClarification(DEFAULT_WORKSPACE, "no-such-task", "hi")).rejects.toThrow(NotFoundError);
  });

  it("handles a task with no prior description without leaving stray whitespace", async () => {
    const { ops, store } = setup();
    const { task } = await withClarification(ops, store, { description: null });
    const updated = await ops.answerClarification(DEFAULT_WORKSPACE, task.id, "just this");
    expect(updated.description!.startsWith("---")).toBe(true);
    expect(updated.description).toContain("just this");
  });

  it("publishes the update so every open board reflects it", async () => {
    const { ops, store, bus } = setup();
    const { task } = await withClarification(ops, store);
    await ops.answerClarification(DEFAULT_WORKSPACE, task.id, "answered");
    expect(bus.events.some((e) => e.type === "task.upserted")).toBe(true);
  });
});
