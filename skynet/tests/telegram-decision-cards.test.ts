// Phase 1 of the Telegram mobile surface: the rich decision card + "request
// changes" (modify → resume the same agent) + reply-to-resume + view diff.
// The message copy + keyboard are PURE (notices.ts); the callback/guidance flow
// is exercised through createOwnerControl with fakes — no live bot, no LLM.
import { describe, it, expect, vi } from "vitest";
import { decisionCardHtml, gateKeyboard, esc } from "../apps/server/src/telegram/notices.js";
import { createOwnerControl, type ControlOps, type ControlOrch } from "../apps/server/src/telegram/index.js";
import type { HitlItem } from "@skynet/shared";

const OWNER = "111";

// A diff gate carrying the agent's own rationale + a diff summary + its run.
const gate = (over: Partial<HitlItem> = {}): HitlItem =>
  ({
    id: "q-42",
    runId: "run-1",
    kind: "diff",
    title: "Ready to push",
    risk: "medium",
    diff: { add: 214, del: 18, files: 3 },
    rationale: "Added a token-bucket limiter; returns 429 with Retry-After.",
    resolvedAt: null,
    options: null,
    command: null,
    ...over,
  }) as unknown as HitlItem;

// ── Pure copy + keyboard ─────────────────────────────────────────────────────
describe("decisionCardHtml", () => {
  it("renders a rich HTML card: head, run/project, diff summary, and the agent's rationale", () => {
    const html = decisionCardHtml(gate(), { run: "rate-limiter", project: "Takeoff" }, true);
    expect(html).toContain("<b>Review the changes</b> · Takeoff");
    expect(html).toContain("rate-limiter");
    expect(html).toContain("<code>+214 −18</code>");
    expect(html).toContain("medium risk");
    expect(html).toContain("<i>"); // the agent's rationale, italicized
    expect(html).toContain("Retry-After");
    expect(html).toMatch(/reply to this message/i); // control on → guidance hint
  });

  it("escapes HTML-significant characters in dynamic text", () => {
    const html = decisionCardHtml(
      gate({ diff: null, command: "grep '<a> & <b>' ." } as Partial<HitlItem>),
      { run: "runner <1>", project: "A & B" },
      true,
    );
    expect(html).toContain("A &amp; B");
    expect(html).toContain("runner &lt;1&gt;");
    expect(html).toContain("&lt;a&gt; &amp; &lt;b&gt;");
    expect(html).not.toContain("<a>"); // never an unescaped tag from user data
  });

  it("falls back to slash-command instructions when control is off", () => {
    const html = decisionCardHtml(gate(), { run: "r", project: "" }, false);
    expect(html).toContain("/approve q-42");
  });
});

describe("gateKeyboard", () => {
  it("offers Approve, Request changes, View diff (for a diff gate), and Reject", () => {
    const kb = gateKeyboard(gate());
    const flat = kb.inline_keyboard.flat();
    const byData = Object.fromEntries(flat.map((b) => [b.callback_data, b.text]));
    expect(byData["hitl:approve:q-42"]).toMatch(/approve/i);
    expect(byData["hitl:modify:q-42"]).toMatch(/request changes/i);
    expect(byData["hitl:diff:q-42"]).toMatch(/view diff/i);
    expect(byData["hitl:reject:q-42"]).toMatch(/reject/i);
  });

  it("omits View diff for a gate with no diff to show", () => {
    const kb = gateKeyboard(gate({ kind: "approval", diff: null, command: "deploy" } as Partial<HitlItem>));
    const datas = kb.inline_keyboard.flat().map((b) => b.callback_data);
    expect(datas).not.toContain("hitl:diff:q-42");
    expect(datas).toContain("hitl:modify:q-42");
  });
});

describe("esc", () => {
  it("escapes only &, <, >", () => {
    expect(esc(`a & b <c> "d"`)).toBe(`a &amp; b &lt;c&gt; "d"`);
  });
});

// ── The interactive flow (createOwnerControl) ────────────────────────────────
function makeControl(controlEnabled = true) {
  const g = gate();
  const resolveHitl = vi.fn(async () => g as never);
  const runDiff = vi.fn(async () => ({ patch: "diff --git a/x b/x\n+added\n-removed", add: 1, del: 1, files: ["x.ts"] }));
  const notes: string[] = [];
  const acks: { id: string; text?: string }[] = [];
  const edits: number[] = [];
  const operations = {
    listHitl: async () => [g],
    listRuns: async () => [],
    listProjects: async () => [],
    listTasks: async () => [],
    listAgents: async () => [],
    listProviders: async () => [],
    resolveHitl,
    runDiff,
    createTask: vi.fn(),
    assignTask: vi.fn(),
    archiveTask: vi.fn(),
    createProject: vi.fn(),
    configureRunner: vi.fn(),
  } as unknown as ControlOps;
  const orchestrator = { consult: vi.fn(), stopAll: vi.fn(), setPaused: vi.fn(), isPaused: () => false } as unknown as ControlOrch;
  const ctl = createOwnerControl({
    controlEnabled,
    ownerChatId: OWNER,
    operations,
    orchestrator,
    notify: async (t) => { notes.push(t); return { messageId: 1 }; },
    editReplyMarkup: async (_c, id) => { edits.push(id); },
    ackCallback: async (id, o) => { acks.push({ id, ...(o?.text ? { text: o.text } : {}) }); },
    onQuit: () => undefined,
  });
  return { ...ctl, resolveHitl, runDiff, notes, acks, edits };
}

describe("Request changes → resume the same agent", () => {
  it("tapping ✏️ arms guidance capture without resolving anything", async () => {
    const c = makeControl();
    await c.handleCallback(OWNER, "hitl:modify:q-42", "cb-1", 500);
    expect(c.resolveHitl).not.toHaveBeenCalled();
    expect(c.notes.at(-1)).toMatch(/reply with the changes/i);
    expect(c.acks.some((a) => a.id === "cb-1")).toBe(true);
  });

  it("the NEXT message after ✏️ is delivered as `modify` guidance (resumes the agent)", async () => {
    const c = makeControl();
    await c.handleCallback(OWNER, "hitl:modify:q-42", "cb-1", 500);
    await c.handle(OWNER, "also add a Retry-After to the health check");
    expect(c.resolveHitl).toHaveBeenCalledTimes(1);
    expect(c.resolveHitl.mock.calls[0]?.[1]).toBe("q-42");
    expect(c.resolveHitl.mock.calls[0]?.[2]).toEqual({ action: "modify", guidance: "also add a Retry-After to the health check" });
    expect(c.edits).toContain(500); // the card's buttons get stripped
  });

  it("a real slash command after ✏️ is NOT swallowed as guidance", async () => {
    const c = makeControl();
    await c.handleCallback(OWNER, "hitl:modify:q-42", "cb-1", 500);
    await c.handle(OWNER, "/status");
    expect(c.resolveHitl).not.toHaveBeenCalled(); // deferred to the command
  });

  it("replying to a decision card routes the reply into that gate's guidance", async () => {
    const c = makeControl();
    c.noteCard(700, "q-42", "run-1"); // the bridge registers the sent card
    await c.handle(OWNER, "tweak the error message", 700);
    expect(c.resolveHitl).toHaveBeenCalledTimes(1);
    expect(c.resolveHitl.mock.calls[0]?.[2]).toEqual({ action: "modify", guidance: "tweak the error message" });
  });

  it("does nothing with control OFF", async () => {
    const c = makeControl(false);
    c.noteCard(700, "q-42", "run-1");
    await c.handle(OWNER, "change this", 700);
    expect(c.resolveHitl).not.toHaveBeenCalled();
  });
});

describe("View diff", () => {
  it("fetches the run's patch and sends it, without resolving the gate", async () => {
    const c = makeControl();
    await c.handleCallback(OWNER, "hitl:diff:q-42", "cb-1", 500);
    expect(c.runDiff).toHaveBeenCalledWith(expect.anything(), "run-1");
    expect(c.resolveHitl).not.toHaveBeenCalled(); // viewing ≠ deciding
    expect(c.notes.at(-1)).toContain("diff --git");
    expect(c.edits).not.toContain(500); // decision buttons stay put
  });
});
