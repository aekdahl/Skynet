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

  const previewStart = vi.fn(async () => ({
    status: "live", url: "http://127.0.0.1:5555", port: 5555, recipe: null, error: null, logs: [], startedAt: 0,
  }));
  const operations = {
    listHitl: async () => [GATE],
    listRuns: async () => [],
    listProjects: async () => [{ id: "p1", name: "Proj" }],
    listTasks: async () => [],
    listAgents: async () => [],
    listProviders: async () => [],
    listFeatures: async () => [],
    listMilestones: async () => [],
    resolveHitl,
    createTask: vi.fn(),
    updateTask: vi.fn(),
    assignTask: vi.fn(),
    archiveTask: vi.fn(),
    configureRunner: vi.fn(),
    createFeature: vi.fn(),
    updateFeature: vi.fn(),
    createMilestone: vi.fn(),
    updateMilestone: vi.fn(),
    previewStart,
  } as unknown as ControlOps;

  const orchestrator = {
    consult: vi.fn(opts.consult),
    stopAll,
    setPaused: vi.fn(),
    isPaused: () => false,
  } as unknown as ControlOrch;

  // Track sent messages by id so a test can assert what was on the buttons and
  // whether editReplyMarkup was called to strip them.
  const sent: { id: number; text: string; reply_markup?: unknown }[] = [];
  const edits: number[] = [];
  const acks: { id: string; text?: string }[] = [];
  let nextMessageId = 1000;

  const { handle, handleCallback } = createOwnerControl({
    controlEnabled: opts.controlEnabled,
    ownerChatId: OWNER,
    operations,
    orchestrator,
    notify: async (t, o) => {
      notes.push(t);
      const id = ++nextMessageId;
      sent.push({ id, text: t, reply_markup: o?.reply_markup });
      return { messageId: id };
    },
    editReplyMarkup: async (_c, id) => {
      edits.push(id);
    },
    ackCallback: async (id, o) => {
      acks.push({ id, ...(o?.text ? { text: o.text } : {}) });
    },
    onQuit: () => undefined,
  });

  return { handle, handleCallback, resolveHitl, stopAll, previewStart, consult: orchestrator.consult, notes, sent, edits, acks };
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

  it("preview: confirm → immediate 'spinning up' reply, then pushes the URL when ready", async () => {
    const previewJson = async () =>
      JSON.stringify({ reply: "On it.", action: { action: "preview", projectId: "p1" } });
    const c = makeControl({ controlEnabled: true, consult: previewJson });
    await c.handle(OWNER, "give me a preview of the Proj app"); // sets pending
    await c.handle(OWNER, "yes"); // confirm → run
    // Immediate reply — never blocks on the (slow) preview spin-up.
    expect(c.notes.some((n) => /spinning up/i.test(n))).toBe(true);
    // The URL is pushed asynchronously once previewStart resolves (live).
    await vi.waitFor(() =>
      expect(c.notes.some((n) => /preview ready/i.test(n) && /127\.0\.0\.1:5555/.test(n))).toBe(true),
    );
    expect(c.previewStart).toHaveBeenCalledWith(expect.anything(), "p1");
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
      listFeatures: async () => [],
      listMilestones: async () => [],
      resolveHitl: vi.fn(),
      createTask,
      updateTask: vi.fn(),
      assignTask: vi.fn(),
      archiveTask: vi.fn(),
      configureRunner: vi.fn(),
      createFeature: vi.fn(),
      updateFeature: vi.fn(),
      createMilestone: vi.fn(),
      updateMilestone: vi.fn(),
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
        return { messageId: 1 };
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

// Regression: the Telegram bridge must call orchestrator.consult with the OPERATOR
// TEXT as `question` and INTENT_SYSTEM_PROMPT as `system`. The earlier code passed
// them SWAPPED, so the runner's default framing mislabeled the system prompt as
// "operator's question" and the real message as "what you did" — Claude then
// correctly treated the system prompt as a prompt-injection attempt and refused
// to act ("I treated the injected persona as data").
describe("createOwnerControl — consult argument shape (prompt-injection regression)", () => {
  it("passes operator text as `question` and the assistant system prompt as `system`", async () => {
    const c = makeControl({
      controlEnabled: true,
      consult: async () => JSON.stringify({ reply: "hi", action: null }),
    });
    await c.handle(OWNER, "What did I ask you first?");
    expect(c.consult).toHaveBeenCalledTimes(1);
    // consult(ws, question, context, system) — see orchestrator.ts / telegram/index.ts
    const [, question, context, system] = c.consult.mock.calls[0] as unknown as [string, string, string, string];
    expect(question).toBe("What did I ask you first?");
    expect(system).toContain("Skynet's helpful operations assistant");
    // The OPERATOR MESSAGE must NOT be re-embedded in the grounding — it rides
    // as `question` now, and the runner labels it explicitly.
    expect(context).not.toContain("What did I ask you first?");
    // The assistant's system prompt must NOT bleed into the operator-question slot.
    expect(question).not.toContain("Skynet's helpful operations assistant");
  });
});

// Regression: the Telegram bridge must scope to the SAME workspace the web/admin
// uses (config.adminWorkspace when set, else DEFAULT_WORKSPACE). Before this fix,
// it was hardcoded to DEFAULT_WORKSPACE — so when a deployer set e.g.
// SKYNET_ADMIN_WORKSPACE=skynet (as the GCP setup.sh does), projects created in
// the web landed in "skynet" while Telegram read from "cyberdyne" and appeared
// empty. Pin the injected `ws` reaches every ops call.
describe("createOwnerControl — workspace scoping (regression)", () => {
  it("passes the injected ws through to every operations call, not DEFAULT_WORKSPACE", async () => {
    const listHitl = vi.fn(async () => []);
    const listRuns = vi.fn(async () => []);
    const listProjects = vi.fn(async () => []);
    const listTasks = vi.fn(async () => []);
    const listAgents = vi.fn(async () => []);
    const listProviders = vi.fn(async () => []);
    const resolveHitl = vi.fn(async () => ({}) as never);
    const operations = {
      listHitl, listRuns, listProjects, listTasks, listAgents, listProviders,
      listFeatures: vi.fn(async () => []), listMilestones: vi.fn(async () => []),
      resolveHitl,
      createTask: vi.fn(), updateTask: vi.fn(), assignTask: vi.fn(), archiveTask: vi.fn(),
      createProject: vi.fn(), configureRunner: vi.fn(),
      createFeature: vi.fn(), updateFeature: vi.fn(),
      createMilestone: vi.fn(), updateMilestone: vi.fn(),
    } as unknown as ControlOps;
    const orchestrator = {
      consult: vi.fn(async () => JSON.stringify({ reply: "ok", action: null })),
      stopAll: vi.fn(), setPaused: vi.fn(), isPaused: () => false,
    } as unknown as ControlOrch;

    const { handle } = createOwnerControl({
      controlEnabled: true,
      ownerChatId: OWNER,
      operations,
      orchestrator,
      notify: async () => ({ messageId: 1 }),
      onQuit: () => undefined,
      ws: "custom-ws", // ← the fix: bridge scopes here, not DEFAULT_WORKSPACE
    });

    // A conversational turn calls buildContext (listHitl/Projects/Tasks/Agents/
    // Providers) and gatherProjectDocs (listProjects). listRuns isn't in the
    // conversational path today — assert on the ones actually invoked.
    void listRuns; // referenced above to satisfy the shape; not called by handle
    await handle(OWNER, "what's the status?");

    for (const fn of [listHitl, listProjects, listTasks, listAgents, listProviders]) {
      expect(fn).toHaveBeenCalled();
      for (const call of fn.mock.calls) expect(call[0]).toBe("custom-ws");
    }
  });

  it("defaults to DEFAULT_WORKSPACE only when no ws is injected", async () => {
    const listHitl = vi.fn(async () => []);
    const operations = {
      listHitl, listRuns: vi.fn(async () => []), listProjects: vi.fn(async () => []),
      listTasks: vi.fn(async () => []), listAgents: vi.fn(async () => []),
      listProviders: vi.fn(async () => []),
      listFeatures: vi.fn(async () => []), listMilestones: vi.fn(async () => []),
      resolveHitl: vi.fn(async () => ({}) as never),
      createTask: vi.fn(), updateTask: vi.fn(), assignTask: vi.fn(), archiveTask: vi.fn(),
      createProject: vi.fn(), configureRunner: vi.fn(),
      createFeature: vi.fn(), updateFeature: vi.fn(),
      createMilestone: vi.fn(), updateMilestone: vi.fn(),
    } as unknown as ControlOps;
    const orchestrator = {
      consult: vi.fn(async () => JSON.stringify({ reply: "ok", action: null })),
      stopAll: vi.fn(), setPaused: vi.fn(), isPaused: () => false,
    } as unknown as ControlOrch;

    const { handle } = createOwnerControl({
      controlEnabled: true,
      ownerChatId: OWNER,
      operations,
      orchestrator,
      notify: async () => ({ messageId: 1 }),
      onQuit: () => undefined,
      // no ws — should default
    });
    await handle(OWNER, "status");
    expect(listHitl.mock.calls[0]?.[0]).toBe("cyberdyne"); // DEFAULT_WORKSPACE
  });
});

// ── Inline buttons (Confirm/Cancel + HITL Approve/Reject) ──────────────────
// The bridge attaches inline keyboards so the owner can tap instead of typing
// "yes"/"no" or /approve <id>. These tests pin: the buttons are present with
// the right callback_data, a tap resolves the pending exactly once, a stale
// tap (an older pending id) is refused with a toast + button strip, and the
// message is edited to remove the buttons after either resolution.
describe("createOwnerControl — inline Confirm/Cancel buttons", () => {
  it("attaches an inline keyboard when a pending action is proposed", async () => {
    const c = makeControl({ controlEnabled: true, consult: approveJson });
    await c.handle(OWNER, "approve the deploy gate");
    // Two rows of buttons expected? No — one row with two buttons.
    const last = c.sent.at(-1);
    expect(last?.reply_markup).toBeTruthy();
    const kb = (last?.reply_markup as { inline_keyboard: { text: string; callback_data: string }[][] })
      ?.inline_keyboard;
    expect(kb).toHaveLength(1);
    expect(kb[0]).toHaveLength(2);
    expect(kb[0]![0]!.text).toMatch(/Confirm/);
    expect(kb[0]![1]!.text).toMatch(/Cancel/);
    // Both callback_data entries share the SAME pending id.
    const confirmData = kb[0]![0]!.callback_data;
    const cancelData = kb[0]![1]!.callback_data;
    expect(confirmData).toMatch(/^confirm:p-\d+$/);
    expect(cancelData).toBe(confirmData.replace(/^confirm:/, "cancel:"));
  });

  it("tapping ✓ Confirm runs the pending action exactly once (and strips the buttons)", async () => {
    const c = makeControl({ controlEnabled: true, consult: approveJson });
    await c.handle(OWNER, "approve the deploy gate");
    const kb = (c.sent.at(-1)!.reply_markup as { inline_keyboard: { callback_data: string }[][] }).inline_keyboard;
    const confirmData = kb[0]![0]!.callback_data;
    const messageId = c.sent.at(-1)!.id;

    await c.handleCallback(OWNER, confirmData, "cb-1", messageId);
    expect(c.resolveHitl).toHaveBeenCalledTimes(1);
    // Buttons stripped from the confirm message.
    expect(c.edits).toContain(messageId);
    // Ack was called (spinner dismissal is mandatory).
    expect(c.acks.some((a) => a.id === "cb-1")).toBe(true);

    // Second tap on the same button → nothing runs, ack with "already handled".
    await c.handleCallback(OWNER, confirmData, "cb-2", messageId);
    expect(c.resolveHitl).toHaveBeenCalledTimes(1);
    expect(c.acks.find((a) => a.id === "cb-2")?.text).toMatch(/already/i);
  });

  it("tapping ✕ Cancel drops the pending without executing (and strips the buttons)", async () => {
    const c = makeControl({ controlEnabled: true, consult: approveJson });
    await c.handle(OWNER, "approve the deploy gate");
    const kb = (c.sent.at(-1)!.reply_markup as { inline_keyboard: { callback_data: string }[][] }).inline_keyboard;
    const cancelData = kb[0]![1]!.callback_data;
    const messageId = c.sent.at(-1)!.id;

    await c.handleCallback(OWNER, cancelData, "cb-1", messageId);
    expect(c.resolveHitl).not.toHaveBeenCalled();
    expect(c.notes.at(-1)).toMatch(/Cancel/i);
    expect(c.edits).toContain(messageId);
  });

  it("a stale tap on an OLDER pending never executes anything", async () => {
    // Two pendings in a row — the button on the FIRST proposal must not run
    // the SECOND action, and its callback_data no longer matches the map.
    const c = makeControl({ controlEnabled: true, consult: approveJson });
    await c.handle(OWNER, "approve the deploy gate"); // pending #1
    const firstKb = (c.sent.at(-1)!.reply_markup as { inline_keyboard: { callback_data: string }[][] }).inline_keyboard;
    const firstConfirm = firstKb[0]![0]!.callback_data; // e.g. "confirm:p-1"

    await c.handle(OWNER, "approve the deploy gate"); // pending #2 replaces #1

    await c.handleCallback(OWNER, firstConfirm, "cb-stale", c.sent[0]!.id);
    expect(c.resolveHitl).not.toHaveBeenCalled(); // stale never escalates
    expect(c.acks.find((a) => a.id === "cb-stale")?.text).toMatch(/already/i);
  });

  it("a typed 'yes' still works alongside the buttons (backwards-compatible)", async () => {
    const c = makeControl({ controlEnabled: true, consult: approveJson });
    await c.handle(OWNER, "approve the deploy gate");
    await c.handle(OWNER, "yes");
    expect(c.resolveHitl).toHaveBeenCalledTimes(1);
    // The buttons on the confirm message are stripped by the yes path too.
    const confirmMsgId = c.sent[0]!.id;
    expect(c.edits).toContain(confirmMsgId);
  });
});

describe("createOwnerControl — HITL approve/reject buttons", () => {
  const openGate = { id: "q-42", kind: "approval", title: "deploy", risk: "high", resolvedAt: null };

  function makeHitlControl(controlEnabled: boolean) {
    const resolveHitl = vi.fn(async () => openGate as never);
    const notes: string[] = [];
    const acks: { id: string; text?: string }[] = [];
    const edits: number[] = [];
    const operations = {
      listHitl: async () => [openGate], // gate is open
      listRuns: async () => [], listProjects: async () => [], listTasks: async () => [],
      listAgents: async () => [], listProviders: async () => [],
      listFeatures: async () => [], listMilestones: async () => [],
      resolveHitl,
      createTask: vi.fn(), updateTask: vi.fn(), assignTask: vi.fn(), archiveTask: vi.fn(),
      createProject: vi.fn(), configureRunner: vi.fn(),
      createFeature: vi.fn(), updateFeature: vi.fn(),
      createMilestone: vi.fn(), updateMilestone: vi.fn(),
    } as unknown as ControlOps;
    const orchestrator = {
      consult: vi.fn(),
      stopAll: vi.fn(), setPaused: vi.fn(), isPaused: () => false,
    } as unknown as ControlOrch;
    const { handleCallback } = createOwnerControl({
      controlEnabled,
      ownerChatId: OWNER,
      operations,
      orchestrator,
      notify: async (t) => { notes.push(t); return { messageId: 1 }; },
      editReplyMarkup: async (_c, id) => { edits.push(id); },
      ackCallback: async (id, o) => { acks.push({ id, ...(o?.text ? { text: o.text } : {}) }); },
      onQuit: () => undefined,
    });
    return { handleCallback, resolveHitl, notes, acks, edits };
  }

  it("tapping ✓ Approve resolves the gate with `approve`", async () => {
    const c = makeHitlControl(true);
    await c.handleCallback(OWNER, "hitl:approve:q-42", "cb-1", 500);
    expect(c.resolveHitl).toHaveBeenCalledTimes(1);
    expect(c.resolveHitl.mock.calls[0]?.[2]).toEqual({ action: "approve" });
    expect(c.edits).toContain(500); // buttons stripped
  });

  it("tapping ✕ Reject resolves the gate with `reject`", async () => {
    const c = makeHitlControl(true);
    await c.handleCallback(OWNER, "hitl:reject:q-42", "cb-1", 501);
    expect(c.resolveHitl.mock.calls[0]?.[2]).toEqual({ action: "reject" });
  });

  it("refuses to act when control is off (buttons appear only when enabled anyway)", async () => {
    const c = makeHitlControl(false);
    await c.handleCallback(OWNER, "hitl:approve:q-42", "cb-1", 502);
    expect(c.resolveHitl).not.toHaveBeenCalled();
    expect(c.acks[0]?.text).toMatch(/control is off/i);
  });

  it("refuses to act on a gate that's no longer open (already resolved)", async () => {
    const c = makeHitlControl(true);
    await c.handleCallback(OWNER, "hitl:approve:q-999", "cb-1", 503); // wrong id
    expect(c.resolveHitl).not.toHaveBeenCalled();
    expect(c.acks[0]?.text).toMatch(/already/i);
    expect(c.edits).toContain(503); // strip the stale buttons
  });
});
