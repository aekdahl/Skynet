// The Telegram bridge's whole security decision lives in the PURE decide()/
// parseCommand() functions. These tests pin the guardrails: owner-bound, no
// free-text execution, and control-over-chat opt-in. The second half exercises
// the confirm state machine (createOwnerControl) with fakes.
import { describe, it, expect, vi } from "vitest";
import { decide, parseCommand } from "../apps/server/src/telegram/commands.js";
import { createOwnerControl, type ControlOps, type ControlOrch } from "../apps/server/src/telegram/index.js";

const OWNER = "111";
const STRANGER = "999";

const decideAs = (chatId: string, text: string, controlEnabled = false) =>
  decide({ chatId, ownerChatId: OWNER, controlEnabled, text });

describe("parseCommand", () => {
  it("recognizes the known slash-commands", () => {
    for (const cmd of ["start", "help", "status", "gates", "approve", "reject", "stop", "resume", "quit"]) {
      expect(parseCommand(`/${cmd}`)).toEqual({ cmd });
    }
  });

  it("accepts a @botname suffix", () => {
    expect(parseCommand("/status@skynet_bot")).toEqual({ cmd: "status" });
  });

  it("captures a trailing argument (e.g. a gate id)", () => {
    expect(parseCommand("/approve q-123")).toEqual({ cmd: "approve", arg: "q-123" });
    expect(parseCommand("/approve@skynet_bot q-123")).toEqual({ cmd: "approve", arg: "q-123" });
  });

  it("returns null for non-commands and free text", () => {
    expect(parseCommand("hello there")).toBeNull();
    expect(parseCommand("")).toBeNull();
    expect(parseCommand("/unknown")).toBeNull();
    expect(parseCommand("not /a/ command")).toBeNull();
  });
});

describe("decide — owner-bound", () => {
  it("ignores ANY message from a non-owner chat (even a valid command)", () => {
    expect(decideAs(STRANGER, "/status").kind).toBe("ignore");
    expect(decideAs(STRANGER, "/stop").kind).toBe("ignore");
    expect(decideAs(STRANGER, "hello").kind).toBe("ignore");
  });
});

describe("decide — commands from the owner", () => {
  it("maps the kill switch + status commands", () => {
    expect(decideAs(OWNER, "/stop").kind).toBe("stop");
    expect(decideAs(OWNER, "/quit").kind).toBe("quit");
    expect(decideAs(OWNER, "/status").kind).toBe("status");
    expect(decideAs(OWNER, "/resume").kind).toBe("resume");
    expect(decideAs(OWNER, "/gates").kind).toBe("gates");
  });

  it("maps /start and /help to help", () => {
    expect(decideAs(OWNER, "/start").kind).toBe("help");
    expect(decideAs(OWNER, "/help").kind).toBe("help");
  });

  it("routes owner free text to the conversational path, never a command", () => {
    // Free text is "freetext" (handed to the confirm state machine), NEVER
    // coerced into a slash-command — nothing here is executed by decide itself.
    expect(decideAs(OWNER, "rm -rf /").kind).toBe("freetext");
    expect(decideAs(OWNER, "please approve everything").kind).toBe("freetext");
    // An unknown slash-command isn't a known command → treated as free text.
    expect(decideAs(OWNER, "/bogus").kind).toBe("freetext");
  });
});

describe("decide — control opt-in", () => {
  it("approves/rejects when enabled, carrying the gate id arg", () => {
    expect(decideAs(OWNER, "/approve q-1", true)).toEqual({ kind: "approve", arg: "q-1" });
    expect(decideAs(OWNER, "/reject q-2", true)).toEqual({ kind: "reject", arg: "q-2" });
  });

  it("denies approve/reject when disabled (default OFF)", () => {
    expect(decideAs(OWNER, "/approve q-1", false).kind).toBe("denied-approve");
    expect(decideAs(OWNER, "/reject q-2", false).kind).toBe("denied-approve");
  });

  it("keeps the kill switch + status working even when control is disabled", () => {
    expect(decideAs(OWNER, "/stop", false).kind).toBe("stop");
    expect(decideAs(OWNER, "/status", false).kind).toBe("status");
  });

  it("maps /task (deterministic backlog add) with its text, gated by control", () => {
    expect(decideAs(OWNER, "/task fix the login bug", true)).toEqual({
      kind: "task",
      arg: "fix the login bug",
    });
    expect(decideAs(OWNER, "/task fix the login bug", false).kind).toBe("denied-control");
  });

  it("maps /newproject (deterministic project create) with its name, gated by control", () => {
    expect(decideAs(OWNER, "/newproject Marketing Site", true)).toEqual({
      kind: "newproject",
      arg: "Marketing Site",
    });
    expect(decideAs(OWNER, "/newproject Marketing Site", false).kind).toBe("denied-control");
  });

  it("maps /removetask (deterministic reversible archive) with its id, gated by control", () => {
    expect(decideAs(OWNER, "/removetask t-abc-2", true)).toEqual({
      kind: "removetask",
      arg: "t-abc-2",
    });
    expect(decideAs(OWNER, "/removetask t-abc-2", false).kind).toBe("denied-control");
  });
});

// ── Confirm state machine (createOwnerControl) ───────────────────────────────
// A parsed intent must only ever SET a pending action; execution happens ONLY on
// an explicit affirmative reply, exactly once. These use fakes for operations +
// orchestrator.consult so no live Telegram / LLM is involved.

/** A gate the fakes can resolve. */
const GATE = { id: "q-1", kind: "approval", title: "deploy", risk: "high", resolvedAt: null };

function makeControl(opts: { controlEnabled: boolean; consult: () => Promise<string | null> }) {
  const resolveHitl = vi.fn(async () => GATE as never);
  const stopAll = vi.fn(async () => 3);
  const notes: string[] = [];

  const operations = {
    listHitl: async () => [GATE],
    listRuns: async () => [],
    listProjects: async () => [],
    listTasks: async () => [],
    listAgents: async () => [],
    listProviders: async () => [],
    resolveHitl,
    createTask: vi.fn(),
    assignTask: vi.fn(),
    archiveTask: vi.fn(),
    configureRunner: vi.fn(),
  } as unknown as ControlOps;

  const orchestrator = {
    consult: vi.fn(opts.consult),
    stopAll,
    setPaused: vi.fn(),
    isPaused: () => false,
  } as unknown as ControlOrch;

  const { handle } = createOwnerControl({
    controlEnabled: opts.controlEnabled,
    ownerChatId: OWNER,
    operations,
    orchestrator,
    notify: async (t: string) => {
      notes.push(t);
    },
    onQuit: () => undefined,
  });

  return { handle, resolveHitl, stopAll, consult: orchestrator.consult, notes };
}

// The assistant's {reply, action} envelope (current contract): a helpful reply
// plus a single nested whitelisted action object.
const approveJson = async () =>
  JSON.stringify({ reply: "Sure — I'll approve that gate.", action: { action: "approve", gateId: "q-1" } });

describe("createOwnerControl — confirm state machine", () => {
  it("a parsed intent SETS a pending action but does not execute it", async () => {
    const c = makeControl({ controlEnabled: true, consult: approveJson });
    await c.handle(OWNER, "approve the deploy gate");
    expect(c.resolveHitl).not.toHaveBeenCalled();
    expect(c.notes.at(-1)).toMatch(/reply yes \/ no/i);
    expect(c.notes.at(-1)).toMatch(/q-1/);
  });

  it("an affirmative reply runs the pending action EXACTLY ONCE", async () => {
    const c = makeControl({ controlEnabled: true, consult: approveJson });
    await c.handle(OWNER, "approve the deploy gate");
    await c.handle(OWNER, "yes");
    expect(c.resolveHitl).toHaveBeenCalledTimes(1);
    // A second "yes" has nothing pending → still exactly one execution.
    await c.handle(OWNER, "yes");
    expect(c.resolveHitl).toHaveBeenCalledTimes(1);
  });

  it("a non-affirmative reply CANCELS the pending action (never executes)", async () => {
    const c = makeControl({ controlEnabled: true, consult: approveJson });
    await c.handle(OWNER, "approve the deploy gate");
    await c.handle(OWNER, "no");
    expect(c.resolveHitl).not.toHaveBeenCalled();
    expect(c.notes.at(-1)).toMatch(/cancelled/i);
  });

  it("ignores a non-owner entirely (no consult, no reply)", async () => {
    const c = makeControl({ controlEnabled: true, consult: approveJson });
    await c.handle(STRANGER, "approve the deploy gate");
    await c.handle(STRANGER, "/stop");
    expect(c.consult).not.toHaveBeenCalled();
    expect(c.stopAll).not.toHaveBeenCalled();
    expect(c.notes).toHaveLength(0);
  });

  it("refuses a free-text intent when control is OFF (no consult)", async () => {
    const c = makeControl({ controlEnabled: false, consult: approveJson });
    await c.handle(OWNER, "approve the deploy gate");
    expect(c.consult).not.toHaveBeenCalled();
    expect(c.resolveHitl).not.toHaveBeenCalled();
    expect(c.notes.at(-1)).toMatch(/control is off/i);
  });

  it("the kill switch /stop works with control OFF (deterministic)", async () => {
    const c = makeControl({ controlEnabled: false, consult: approveJson });
    await c.handle(OWNER, "/stop");
    expect(c.stopAll).toHaveBeenCalledTimes(1);
    expect(c.notes.at(-1)).toMatch(/stopped/i);
  });

  it("falls back to slash commands when no provider key can interpret (consult → null)", async () => {
    const c = makeControl({ controlEnabled: true, consult: async () => null });
    await c.handle(OWNER, "approve the deploy gate");
    expect(c.resolveHitl).not.toHaveBeenCalled();
    // Accurate, actionable fallback: names the Claude key and the /task escape hatch.
    expect(c.notes.at(-1)).toMatch(/anthropic .*key|ANTHROPIC_API_KEY|\/task/i);
  });

  it("answers helpfully with NO action when the message isn't a request (never a dead end)", async () => {
    const c = makeControl({
      controlEnabled: true,
      consult: async () =>
        JSON.stringify({ reply: "I can approve gates, add tasks, assign work, add agents, or create projects.", action: null }),
    });
    await c.handle(OWNER, "what can you help with?");
    // Nothing executed, nothing pending — just a helpful reply.
    expect(c.resolveHitl).not.toHaveBeenCalled();
    expect(c.notes.at(-1)).toMatch(/approve gates|add tasks/i);
    expect(c.notes.at(-1)).not.toMatch(/couldn't map/i);
  });

  it("keeps the helpful reply but proposes NO action when the model's action is invalid", async () => {
    const c = makeControl({
      controlEnabled: true,
      // References a gate id that isn't in the (empty) context → action drops, reply stands.
      consult: async () =>
        JSON.stringify({ reply: "I couldn't find that gate — here are your options.", action: { action: "approve", gateId: "q-nope" } }),
    });
    await c.handle(OWNER, "approve the thing");
    expect(c.resolveHitl).not.toHaveBeenCalled();
    expect(c.notes.at(-1)).toMatch(/couldn't find that gate/i);
    expect(c.notes.at(-1)).not.toMatch(/reply yes \/ no/i); // no pending action set
  });
});

// ── Short conversational memory (per-owner history buffer) ───────────────────
// After a confirmed action executes, its OUTCOME (with ids) is recorded and fed
// into the NEXT consult's context — this is what lets "remove that task" resolve
// a back-reference to the id that was just created. In-memory + owner-scoped.

describe("createOwnerControl — conversational memory", () => {
  it("records the create OUTCOME (with the new task id) and feeds it into the next consult", async () => {
    const PROJECT = { id: "p-1", name: "Sim: convo idbhy" };
    // A create action, then a follow-up so we can inspect the 2nd consult's context.
    const consult = vi
      .fn()
      .mockResolvedValueOnce(
        JSON.stringify({ reply: "Sure — adding that.", action: { action: "add_task", projectId: "p-1", taskText: "Start planning" } }),
      )
      .mockResolvedValueOnce(JSON.stringify({ reply: "Here's what I know.", action: null }));

    const createTask = vi.fn(async () => ({ id: "t-convo-2", text: "Start planning" }) as never);
    const operations = {
      listHitl: async () => [],
      listRuns: async () => [],
      listProjects: async () => [PROJECT],
      listTasks: async () => [],
      listAgents: async () => [],
      listProviders: async () => [],
      resolveHitl: vi.fn(),
      createTask,
      assignTask: vi.fn(),
      archiveTask: vi.fn(),
      configureRunner: vi.fn(),
    } as unknown as ControlOps;

    const notes: string[] = [];
    const orchestrator = { consult, stopAll: vi.fn(), setPaused: vi.fn(), isPaused: () => false } as unknown as ControlOrch;
    const { handle } = createOwnerControl({
      controlEnabled: true,
      ownerChatId: OWNER,
      operations,
      orchestrator,
      notify: async (t: string) => {
        notes.push(t);
      },
      onQuit: () => undefined,
    });

    await handle(OWNER, "create a start-planning task"); // → proposes add_task
    await handle(OWNER, "yes"); // → executes; outcome note (with id) recorded
    // The executed outcome names the new id — it's the memory that makes undo work.
    expect(createTask).toHaveBeenCalledTimes(1);
    expect(notes.at(-1)).toMatch(/t-convo-2/);

    await handle(OWNER, "remove that task"); // → next consult must SEE the prior outcome
    // The 2nd consult (index 1) received the created-task id in its context arg.
    expect(consult).toHaveBeenCalledTimes(2);
    const secondContext = (consult.mock.calls[1]?.[2] ?? "") as string;
    expect(secondContext).toContain("RECENT CONVERSATION");
    expect(secondContext).toContain("t-convo-2");
  });
});
