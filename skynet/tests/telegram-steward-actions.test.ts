// Steward's project/task actions now EXECUTE over Telegram — the same 10-kind
// board mutations the in-app assistant runs. A focused-project change request
// enqueues Steward's proposed action(s); "yes" runs the head, "accept all" runs
// the whole batch, anything else cancels. askSteward (the repo tool-loop) is
// mocked so no live LLM is involved; resolveFocusedProject + parseConfirmation
// stay REAL — that's the wiring under test.
import { vi, describe, it, expect, beforeEach } from "vitest";

// Hoisted so the vi.mock factory can close over it without a TDZ error.
const { askStewardMock } = vi.hoisted(() => ({ askStewardMock: vi.fn() }));
vi.mock("../apps/server/src/steward/assistant.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../apps/server/src/steward/assistant.js")>();
  return { ...actual, askSteward: askStewardMock };
});

import { createOwnerControl, type ControlOps, type ControlOrch } from "../apps/server/src/telegram/index.js";
import type { AssistantAction } from "../apps/server/src/steward/assistant.js";

const OWNER = "owner-chat";
const WEB = { id: "p-web", name: "Web", repoPath: "/repos/web" };

/** A control handler whose focused project ("Web") has a local checkout, with
 *  board-mutation spies wired to the widened ControlOps slice. */
function makeControl() {
  const spies = {
    createTask: vi.fn(async () => ({ id: "t-new", text: "x" }) as never),
    transitionTask: vi.fn(async () => ({}) as never),
    updateTask: vi.fn(async () => ({}) as never),
    moveTask: vi.fn(async () => ({}) as never),
    deleteTask: vi.fn(async () => undefined as never),
    updateProject: vi.fn(async (_ws: string, _id: string, patch: unknown) => ({ id: WEB.id, name: (patch as { name?: string }).name ?? WEB.name }) as never),
  };
  const operations = {
    listHitl: async () => [],
    listRuns: async () => [],
    listProjects: async () => [WEB],
    listTasks: async () => [],
    listAgents: async () => [],
    listProviders: async () => [],
    resolveHitl: vi.fn(),
    createProject: vi.fn(),
    assignTask: vi.fn(),
    archiveTask: vi.fn(),
    configureRunner: vi.fn(),
    ...spies,
  } as unknown as ControlOps;

  const consult = vi.fn(async () => null); // must NOT be reached on the focused path
  const orchestrator = { consult, stopAll: vi.fn(), setPaused: vi.fn(), isPaused: () => false } as unknown as ControlOrch;
  const notes: string[] = [];
  const { handle } = createOwnerControl({
    controlEnabled: true,
    ownerChatId: OWNER,
    operations,
    orchestrator,
    notify: async (t: string) => void notes.push(t),
    onQuit: () => undefined,
  });
  return { handle, notes, consult, ...spies };
}

const act = (a: Partial<AssistantAction> & Pick<AssistantAction, "kind" | "summary">): AssistantAction => a as AssistantAction;
/** Shape askSteward returns: {reply, action, actions}. */
const steward = (reply: string, actions: AssistantAction[]) => ({ reply, action: actions[0] ?? null, actions });

beforeEach(() => askStewardMock.mockReset());

describe("Steward actions over Telegram — batch confirm", () => {
  it("a change request enqueues the proposals and asks to confirm (nothing runs yet)", async () => {
    askStewardMock.mockResolvedValueOnce(
      steward("I'll add both.", [
        act({ kind: "add_task", text: "Write onboarding docs", summary: 'Create task: "Write onboarding docs"' }),
        act({ kind: "add_task", text: "Add smoke tests", summary: 'Create task: "Add smoke tests"' }),
      ]),
    );
    const c = makeControl();
    await c.handle(OWNER, "add two tasks to Web");
    expect(c.createTask).not.toHaveBeenCalled();
    expect(c.consult).not.toHaveBeenCalled(); // handled on the focused path, no workspace fallback
    expect(c.notes.at(-1)).toMatch(/2 changes/i);
    expect(c.notes.at(-1)).toMatch(/accept all/i);
    expect(c.notes.at(-1)).toMatch(/onboarding docs/i);
  });

  it('"accept all" applies the whole batch', async () => {
    askStewardMock.mockResolvedValueOnce(
      steward("Adding both.", [
        act({ kind: "add_task", text: "A", summary: 'Create task: "A"' }),
        act({ kind: "add_task", text: "B", summary: 'Create task: "B"' }),
      ]),
    );
    const c = makeControl();
    await c.handle(OWNER, "add tasks to Web");
    await c.handle(OWNER, "accept all");
    expect(c.createTask).toHaveBeenCalledTimes(2);
  });

  it('"yes" runs only the head and re-offers the rest', async () => {
    askStewardMock.mockResolvedValueOnce(
      steward("Two changes.", [
        act({ kind: "add_task", text: "A", summary: 'Create task: "A"' }),
        act({ kind: "add_task", text: "B", summary: 'Create task: "B"' }),
      ]),
    );
    const c = makeControl();
    await c.handle(OWNER, "add tasks to Web");
    await c.handle(OWNER, "yes");
    expect(c.createTask).toHaveBeenCalledTimes(1);
    expect(c.notes.at(-1)).toMatch(/1 more pending/i);
    await c.handle(OWNER, "yes");
    expect(c.createTask).toHaveBeenCalledTimes(2);
  });

  it('"no" cancels the whole queue (nothing runs)', async () => {
    askStewardMock.mockResolvedValueOnce(
      steward("Proposed.", [act({ kind: "add_task", text: "A", summary: 'Create task: "A"' })]),
    );
    const c = makeControl();
    await c.handle(OWNER, "add a task to Web");
    await c.handle(OWNER, "no thanks");
    expect(c.createTask).not.toHaveBeenCalled();
    expect(c.notes.at(-1)).toMatch(/cancelled/i);
  });

  it("routes each board-action kind to the matching operation", async () => {
    askStewardMock.mockResolvedValueOnce(
      steward("Applying.", [
        act({ kind: "move_task", taskId: "t-1", to: "todo", summary: "Move t-1 → todo" }),
        act({ kind: "set_status", status: "paused", summary: "Pause project" }),
        act({ kind: "remove_task", taskId: "t-9", summary: "Remove t-9" }),
      ]),
    );
    const c = makeControl();
    await c.handle(OWNER, "make changes to Web");
    await c.handle(OWNER, "accept all");
    expect(c.transitionTask).toHaveBeenCalledWith(expect.any(String), "t-1", "todo", expect.any(String));
    expect(c.updateProject).toHaveBeenCalledWith(expect.any(String), WEB.id, { status: "paused" });
    expect(c.deleteTask).toHaveBeenCalledWith(expect.any(String), "t-9");
  });

  it("answers a plain question without proposing anything", async () => {
    askStewardMock.mockResolvedValueOnce(steward("Web ships the marketing site.", []));
    const c = makeControl();
    await c.handle(OWNER, "what does Web do?");
    expect(c.notes.at(-1)).toMatch(/marketing site/i);
    // Nothing pending — a follow-up "yes" must NOT execute anything.
    await c.handle(OWNER, "yes");
    expect(c.createTask).not.toHaveBeenCalled();
  });
});
