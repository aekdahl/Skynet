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
    diff: { add: 214, del: 18, modules: ["server"], files: ["src/rate-limit.ts", "src/server.ts", "tests/rate-limit.test.ts"] },
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

  it("lists the changed files + touched areas so it's approvable without opening the diff", () => {
    const html = decisionCardHtml(gate(), { run: "rate-limiter", project: "Takeoff" }, true);
    expect(html).toContain("· 3 files"); // count on the stats line
    expect(html).toContain("<code>src/rate-limit.ts</code>");
    expect(html).toContain("<code>tests/rate-limit.test.ts</code>");
    expect(html).toContain("Areas: server");
  });

  it("collapses a long file list into “…and N more”", () => {
    const files = Array.from({ length: 12 }, (_, i) => `src/file${i}.ts`);
    const html = decisionCardHtml(gate({ diff: { add: 1, del: 0, modules: [], files } } as Partial<HitlItem>), { run: "r", project: "" }, true);
    expect(html).toContain("· 12 files");
    expect(html).toContain("<code>src/file0.ts</code>");
    expect(html).toContain("…and 4 more"); // 12 − MAX_FILES_SHOWN(8)
    expect(html).not.toContain("src/file8.ts"); // beyond the shown window
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

  it("frames a decision (question with options) as a numbered selection, showing the question", () => {
    const html = decisionCardHtml(
      gate({ kind: "question", diff: null, command: null, title: "Which formats to support?", options: ["DXF now", "DWG via convert"] } as Partial<HitlItem>),
      { run: "r", project: "" },
      true,
    );
    expect(html).toContain("Which formats to support?"); // the question itself is shown
    expect(html).toContain("Choose one:");
    expect(html).toContain("1. DXF now");
    expect(html).toContain("2. DWG via convert");
    expect(html).toMatch(/tap your choice/i); // clearly a selection, not approve/reject
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

  it("renders a button PER option for a decision (question), not an approve/reject gate", () => {
    const kb = gateKeyboard(gate({ kind: "question", diff: null, command: null, options: ["DXF now", "DWG via convert", "All three"] } as Partial<HitlItem>));
    const byData = Object.fromEntries(kb.inline_keyboard.flat().map((b) => [b.callback_data, b.text]));
    expect(byData["hitl:option:0:q-42"]).toContain("DXF now");
    expect(byData["hitl:option:1:q-42"]).toContain("DWG via convert");
    expect(byData["hitl:option:2:q-42"]).toContain("All three");
    expect(byData["hitl:modify:q-42"]).toMatch(/other/i); // free-text answer
    expect(byData["hitl:reject:q-42"]).toMatch(/reject/i);
    expect(Object.keys(byData)).not.toContain("hitl:approve:q-42"); // a choice, not approve/reject
  });

  // Regression: an `escalation` carries the SAME kind of options (the agent's
  // own offered choices — buildEscalationRaise in claude.ts), but this branch
  // used to check `kind === "question"` only — an escalation with options fell
  // through to the generic Approve/Reject row, and tapping Approve silently
  // discarded the pick (deliverEscalation has no `approve` case, so it fell
  // through to its catch-all relaunch with EMPTY guidance).
  it("also renders a button PER option for an escalation with offered choices — not just Approve/Reject", () => {
    const kb = gateKeyboard(gate({
      kind: "escalation", diff: null, command: null,
      options: ["Yes, fix both deploy scripts (Recommended)", "No, leave as-is"],
    } as Partial<HitlItem>));
    const byData = Object.fromEntries(kb.inline_keyboard.flat().map((b) => [b.callback_data, b.text]));
    expect(byData["hitl:option:0:q-42"]).toContain("Yes, fix both deploy scripts");
    expect(byData["hitl:option:1:q-42"]).toContain("No, leave as-is");
    expect(Object.keys(byData)).not.toContain("hitl:approve:q-42"); // no single "the" action to approve
  });

  it("an escalation with NO offered choices (e.g. the autonomy-paused notice) still gets the generic Approve/Reject row", () => {
    const kb = gateKeyboard(gate({ kind: "escalation", diff: null, command: null, options: null } as Partial<HitlItem>));
    const datas = kb.inline_keyboard.flat().map((b) => b.callback_data);
    expect(datas).toContain("hitl:approve:q-42");
  });
});

describe("esc", () => {
  it("escapes only &, <, >", () => {
    expect(esc(`a & b <c> "d"`)).toBe(`a &amp; b &lt;c&gt; "d"`);
  });
});

// ── The interactive flow (createOwnerControl) ────────────────────────────────
function makeControl(controlEnabled = true, gateItem?: HitlItem) {
  const g = gateItem ?? gate();
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

describe("Choose a decision option", () => {
  const question = gate({ kind: "question", diff: null, command: null, title: "Which?", options: ["DXF now", "DWG via convert"] } as Partial<HitlItem>);

  it("tapping an option resolves that gate with the chosen index (agent resumes on the choice)", async () => {
    const c = makeControl(true, question);
    await c.handleCallback(OWNER, "hitl:option:1:q-42", "cb-1", 500);
    expect(c.resolveHitl).toHaveBeenCalledTimes(1);
    expect(c.resolveHitl.mock.calls[0]?.[1]).toBe("q-42");
    expect(c.resolveHitl.mock.calls[0]?.[2]).toEqual({ action: "option", optionIndex: 1 });
    expect(c.notes.at(-1)).toMatch(/DWG via convert|resuming/i); // confirms the chosen answer
    expect(c.edits).toContain(500); // buttons stripped after deciding
  });

  it("does nothing with control OFF", async () => {
    const c = makeControl(false, question);
    await c.handleCallback(OWNER, "hitl:option:0:q-42", "cb-1", 500);
    expect(c.resolveHitl).not.toHaveBeenCalled();
  });

  // Regression: an escalation gate has no `option` resolve action (deliverEscalation
  // only understands modify/reject/reassign/dismiss) — tapping a per-option button
  // must resolve the SAME way the web app's escalation option buttons do: `modify`
  // with the picked text as guidance. Resolving with `action:"option"` here used to
  // silently discard the pick (relaunches with empty guidance instead).
  it("tapping an option on an ESCALATION resolves as `modify` with the picked text as guidance, not `option`", async () => {
    const escalation = gate({
      kind: "escalation", diff: null, command: null, title: "Weak DB/store/redis defaults in compose",
      options: ["Yes, fix both deploy scripts (Recommended)", "No, leave as-is"],
    } as Partial<HitlItem>);
    const c = makeControl(true, escalation);
    await c.handleCallback(OWNER, "hitl:option:0:q-42", "cb-1", 500);
    expect(c.resolveHitl).toHaveBeenCalledTimes(1);
    expect(c.resolveHitl.mock.calls[0]?.[1]).toBe("q-42");
    expect(c.resolveHitl.mock.calls[0]?.[2]).toEqual({ action: "modify", guidance: "Yes, fix both deploy scripts (Recommended)" });
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
