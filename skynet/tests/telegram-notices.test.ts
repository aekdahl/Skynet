// Telegram notification copy must read like a human wrote it — lead with the
// run's task title + its project, never the raw ids that made the originals
// unreadable ("Gate q-diff-pin-the-node-docker-image-to-a-d-1-20 …", "Run
// pin-the-node-docker-image-to-a-d-1 needs attention").
//
// Also covers Phase 1 of the Telegram mobile surface: the rich decision card
// + "request changes" (modify → resume the same agent) + reply-to-resume +
// view diff. The message copy + keyboard are PURE (notices.ts); the
// callback/guidance flow is exercised through createOwnerControl with fakes
// — no live bot, no LLM.
import { describe, it, expect, vi } from "vitest";
import type { HitlItem } from "@skynet/shared";
import {
  gateNotice,
  decisionCardHtml,
  gateHead,
  gateKeyboard,
  reviewNotice,
  completedNotice,
  runLink,
  desktopRunLink,
  esc,
} from "../apps/server/src/telegram/notices.js";
import { createOwnerControl, type ControlOps, type ControlOrch } from "../apps/server/src/telegram/index.js";

const OWNER = "111";
const UGLY_RUN_ID = "pin-the-node-docker-image-to-a-d-1";
const UGLY_GATE_ID = "q-diff-pin-the-node-docker-image-to-a-d-1-20";
const NAMES = { run: "Pin the Node Docker image to a digest", project: "Takeoff" };

// Reconciled fixture builder: the union of fields both original suites'
// HitlItem builders needed (telegram-notices' fuller field set — workspaceId,
// why, raisedAt/expiresAt, resolution, recommended, steps, flags — plus
// telegram-decision-cards' rationale/command/options/diff-file-list shape).
const item = (o: Partial<HitlItem> = {}): HitlItem =>
  ({
    id: UGLY_GATE_ID,
    workspaceId: "w",
    runId: UGLY_RUN_ID,
    kind: "diff",
    title: "Review diff — 21+/2− (1 file)",
    why: "",
    risk: "medium",
    raisedAt: 0,
    expiresAt: null,
    resolvedAt: null,
    resolution: null,
    rationale: null,
    command: null,
    options: null,
    recommended: null,
    steps: null,
    diff: { add: 21, del: 2, modules: ["m1"] },
    flags: [],
    ...o,
  }) as HitlItem;

// The decision-card tests below hinge on the SHORT id ("q-42") baked into
// dozens of callback_data assertions (e.g. "hitl:approve:q-42") — matching
// queue.tsx's real gate ids. `gate()` is a preset built on top of the single
// shared `item()` fixture, not a second independent implementation: a diff
// gate carrying the agent's own rationale + a diff summary + its run.
const gate = (over: Partial<HitlItem> = {}): HitlItem =>
  item({
    id: "q-42",
    runId: "run-1",
    title: "Ready to push",
    diff: { add: 214, del: 18, modules: ["server"], files: ["src/rate-limit.ts", "src/server.ts", "tests/rate-limit.test.ts"] } as never,
    rationale: "Added a token-bucket limiter; returns 429 with Retry-After.",
    resolvedAt: null,
    options: null,
    command: null,
    ...over,
  });

describe("gateNotice", () => {
  it("leads with the task title + project and the diff stats — no raw ids", () => {
    const msg = gateNotice(item({}), NAMES, true);
    expect(msg).toContain("Pin the Node Docker image to a digest");
    expect(msg).toContain("Takeoff");
    expect(msg).toContain("+21 −2");
    expect(msg).toContain("medium risk");
    expect(msg).toContain("Review the changes");
    // Control-mode: buttons carry the id, so it never leaks into the prose.
    expect(msg).not.toContain(UGLY_GATE_ID);
    expect(msg).not.toContain(UGLY_RUN_ID);
    expect(msg).not.toContain("Gate ");
    expect(msg).toContain("Approve or reject below");
  });

  it("falls back to a slash-command hint (with id) when control is off", () => {
    const msg = gateNotice(item({}), NAMES, false);
    expect(msg).toContain(`/approve ${UGLY_GATE_ID}`);
  });

  it("shows the command for an approval gate", () => {
    const msg = gateNotice(item({ kind: "approval", command: "npm run build", diff: null, title: "x" }), NAMES, true);
    expect(msg).toContain("Approve a command");
    expect(msg).toContain("npm run build");
  });

  it("numbers the options for a question gate", () => {
    const msg = gateNotice(item({ kind: "question", diff: null, options: ["Ship it", "Hold"], title: "Ready?" }), NAMES, true);
    expect(msg).toContain("1. Ship it");
    expect(msg).toContain("2. Hold");
  });
});

// Reported live: a merge-conflict card rendered as an unexplained raw `diff
// --cc` dump — no title, no explanation, no list of which files conflicted,
// just a tail-truncated combined-diff snippet cut off mid-sentence. `why` was
// dropped entirely (the web queue card always shows it — queue.tsx), so
// Telegram gave the operator nothing to actually decide on.
describe("merge conflict gate — actionable, not a raw diff dump", () => {
  const mergeConflict = (o: Partial<HitlItem> = {}) =>
    item({
      kind: "merge",
      diff: { add: 0, del: 0, modules: ["m1"], files: [], walkthrough: null, mergeBrief: null, defaultTargetBranch: "main" } as never,
      title: "Merge conflict — 2 files",
      why: "2 file(s) conflict integrating claude/foo. Reconcile yourself and approve to retry, or click Modify (guidance optional — it'll use the conflict below) to have the agent resolve it.",
      flags: ["ROADMAP.md", "apps/server/src/x.ts"],
      output: "Target branch: main\n\n<<<<<<< HEAD\nfoo\n=======\nbar\n>>>>>>> claude/foo\n",
      ...o,
    });

  it("gateNotice leads with the title, the why explanation, and the conflicting files — not just raw output", () => {
    const msg = gateNotice(mergeConflict(), NAMES, true);
    expect(msg).toContain("Merge conflict — 2 files");
    expect(msg).toContain("Reconcile yourself and approve to retry");
    expect(msg).toContain("Conflicts in: ROADMAP.md, apps/server/src/x.ts");
    // The raw conflict text is still present (Modify uses it as guidance) but
    // labeled, not the only content on the card.
    expect(msg).toContain("Conflict (captured before the merge was aborted)");
    expect(msg).toContain("<<<<<<< HEAD");
  });

  it("decisionCardHtml leads with title + why + conflicting-file chips before the raw conflict text", () => {
    const html = decisionCardHtml(mergeConflict(), NAMES, true);
    expect(html).toContain("<b>Merge conflict — 2 files</b>");
    expect(html).toContain("Reconcile yourself and approve to retry");
    expect(html).toContain("<b>Conflicts in:</b>");
    expect(html).toContain("<code>ROADMAP.md</code>");
    expect(html).toContain("<code>apps/server/src/x.ts</code>");
    expect(html).toContain("Conflict (captured before the merge was aborted)");
    // HTML-escaped, since it rides inside a <pre> block.
    expect(html).toContain("&lt;&lt;&lt;&lt;&lt;&lt;&lt; HEAD");
    // Ordering: the explanation comes BEFORE the raw conflict dump, so a
    // truncated preview never leaves the operator with nothing else to go on.
    expect(html.indexOf("Reconcile yourself")).toBeLessThan(html.indexOf("&lt;&lt;&lt;&lt;&lt;&lt;&lt; HEAD"));
  });
});

describe("stuck-review escalation — done, awaiting review, not an alarm", () => {
  // A stuck-review escalation (orchestrator.ts's reapStuckReviews) fires when a
  // run already finished and reached review with no open gate pointing at it —
  // nothing failed. It should read as "done, awaiting your review", not the
  // generic "a run stopped and needs help" alarm every other escalation source
  // (timeout/failures/conflict/turns/stalled/billing) uses.
  const stuckReview = (o: Partial<HitlItem> = {}) =>
    item({
      kind: "escalation",
      diff: null,
      flags: ["stuck-review"],
      title: "Done — awaiting your review",
      why: "the run finished and reached review, but no decision was raised for it — nothing failed, it's just waiting for your review",
      risk: "low",
      ...o,
    });

  it("gateNotice heads with the calm phrasing, not 'stopped and needs help'", () => {
    const msg = gateNotice(stuckReview(), NAMES, true);
    expect(msg).toContain("Done — awaiting your review");
    expect(msg).not.toContain("stopped and needs help");
  });

  it("decisionCardHtml heads with the calm phrasing too", () => {
    const card = decisionCardHtml(stuckReview(), NAMES, true);
    expect(card).toContain("Done — awaiting your review");
    expect(card).not.toContain("stopped and needs help");
  });

  it("gateHead reflects the stuck-review flag, not the generic escalation head", () => {
    expect(gateHead(stuckReview())).toBe("Done — awaiting your review");
  });

  it("a regular (non-stuck-review) escalation keeps the generic alarm head", () => {
    const timedOut = item({ kind: "escalation", diff: null, flags: ["timeout"], title: "x" });
    expect(gateHead(timedOut)).toBe("A run stopped and needs help");
    expect(gateNotice(timedOut, NAMES, true)).toContain("A run stopped and needs help");
  });
});

describe("reviewNotice / completedNotice", () => {
  it("reviewNotice reads human — run + project, no ids, no 'needs attention'", () => {
    const msg = reviewNotice(NAMES);
    expect(msg).toContain("Pin the Node Docker image to a digest");
    expect(msg).toContain("Takeoff");
    expect(msg).not.toContain("needs attention");
    expect(msg).not.toContain(UGLY_RUN_ID);
  });

  it("completedNotice names the run + project", () => {
    const msg = completedNotice(NAMES);
    expect(msg).toContain("Shipped");
    expect(msg).toContain("Pin the Node Docker image to a digest");
    expect(msg).toContain("Takeoff");
    expect(msg).not.toContain(UGLY_RUN_ID);
  });
});

describe("decisionCardHtml — bubble structure (kind label, consequence line, context line)", () => {
  it("leads with an all-caps kind label, project, and a short run tag", () => {
    const html = decisionCardHtml(item({ kind: "approval", command: "npm test", diff: null, title: "x" }), NAMES, true);
    expect(html).toContain("<b>APPROVAL NEEDED</b> · Takeoff · RUN #");
  });

  it("flags medium/high risk with ⚠️, and reads as reassurance at low risk", () => {
    const high = decisionCardHtml(item({ risk: "high" }), NAMES, true);
    expect(high).toContain("⚠️ High risk");
    const medium = decisionCardHtml(item({ risk: "medium" }), NAMES, true);
    expect(medium).toContain("⚠️ Medium risk");
    const low = decisionCardHtml(item({ risk: "low" }), NAMES, true);
    expect(low).toContain("Low risk — reversible");
    expect(low).not.toContain("⚠️");
  });

  it("always states the run is blocked until answered", () => {
    const html = decisionCardHtml(item({}), NAMES, true);
    expect(html).toContain("Agent is idle until you answer.");
  });

  it("a stuck-review escalation gets its own calm kind label, not the generic alarm one", () => {
    const html = decisionCardHtml(item({ kind: "escalation", diff: null, flags: ["stuck-review"], title: "x" }), NAMES, true);
    expect(html).toContain("<b>AWAITING REVIEW</b>");
  });
});

// TASK 30 — a roadmap_edit gate compresses to headline + why + actions, and a
// deletion-flavored proposal (or a held_conflict pair, which always carries
// one — see notices.ts's roadmapEditCardHtml doc comment) gets NO approve
// button on Telegram at all, only "Open in Skynet".
describe("roadmap_edit — compressed card, deletion-safe keyboard", () => {
  const roadmapItem = (o: Partial<HitlItem> = {}) =>
    item({
      kind: "roadmap_edit",
      diff: null,
      command: null,
      title: "Add a note to Phase 1",
      why: "Tracking the follow-up work discussed in review.",
      flags: [],
      ...o,
    });

  it("decisionCardHtml compresses to headline + why, no run-tag/diff-stat header", () => {
    const html = decisionCardHtml(roadmapItem(), NAMES, true);
    expect(html).toContain("ROADMAP EDIT · NEEDS YOUR YES");
    expect(html).toContain("Add a note to Phase 1");
    expect(html).toContain("Tracking the follow-up work discussed in review.");
    expect(html).not.toContain("RUN #"); // no run behind a roadmap_edit item
  });

  it("a non-deletion proposal offers Approve & commit / Reject in the keyboard", () => {
    const kb = gateKeyboard(roadmapItem());
    const datas = kb.inline_keyboard.flat().map((b) => b.callback_data);
    expect(datas).toContain(`hitl:approve:${UGLY_GATE_ID}`);
    expect(datas).toContain(`hitl:reject:${UGLY_GATE_ID}`);
  });

  it("a deletion-flavored proposal gets NO approve action at all — only Open in Skynet", () => {
    const withLink = gateKeyboard(roadmapItem({ flags: ["has_deletion"] }), "", "https://skynet.example.com/#/project/p1");
    const flat = withLink.inline_keyboard.flat();
    expect(flat.some((b) => "callback_data" in b)).toBe(false); // no tappable decision button
    expect(flat.some((b) => "url" in b && b.text.includes("Open in Skynet"))).toBe(true);
    expect(withLink.inline_keyboard).toHaveLength(1); // exactly the one open-link row

    const html = decisionCardHtml(roadmapItem({ flags: ["has_deletion"] }), NAMES, true);
    expect(html).toContain("Removes content");
    expect(html).not.toContain("Tap below");
  });

  it("with no link and a deletion flag, the keyboard is empty — never falls back to an approve button", () => {
    const kb = gateKeyboard(roadmapItem({ flags: ["has_deletion"] }));
    expect(kb.inline_keyboard).toHaveLength(0);
  });
});

describe("deep links", () => {
  it("runLink builds the run hash route, or nothing without a base URL", () => {
    expect(runLink("https://skynet.example.com", UGLY_RUN_ID)).toBe(
      `https://skynet.example.com/#/agent/${UGLY_RUN_ID}`,
    );
    expect(runLink("", UGLY_RUN_ID)).toBeUndefined();
  });

  it("desktopRunLink builds a skynet:// OS-protocol link — no base URL, never undefined", () => {
    expect(desktopRunLink(UGLY_RUN_ID)).toBe(`skynet://agent/${UGLY_RUN_ID}`);
  });

  it("appends the link when given (and omits it otherwise)", () => {
    const link = `https://skynet.example.com/#/agent/${UGLY_RUN_ID}`;
    // review
    expect(reviewNotice(NAMES, link)).toContain(link);
    expect(reviewNotice(NAMES)).not.toContain("http");
    // completed
    expect(completedNotice(NAMES, link)).toContain(link);
    // gate decision card — an HTML <a> the operator can tap
    const card = decisionCardHtml(item({}), NAMES, true, link);
    expect(card).toContain(`<a href="${link}">`);
    expect(decisionCardHtml(item({}), NAMES, true)).not.toContain("<a href");
  });
});

// ── Pure copy + keyboard (Phase 1 decision card) ─────────────────────────────
describe("decisionCardHtml", () => {
  it("renders a rich HTML card: kind label + run tag, run/project, diff summary, and the agent's rationale", () => {
    const html = decisionCardHtml(gate(), { run: "rate-limiter", project: "Takeoff" }, true);
    expect(html).toContain("<b>REVIEW NEEDED</b> · Takeoff · RUN #");
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
    const html = decisionCardHtml(gate({ diff: { add: 1, del: 0, modules: [], files } as never }), { run: "r", project: "" }, true);
    expect(html).toContain("· 12 files");
    expect(html).toContain("<code>src/file0.ts</code>");
    expect(html).toContain("…and 4 more"); // 12 − MAX_FILES_SHOWN(8)
    expect(html).not.toContain("src/file8.ts"); // beyond the shown window
  });

  it("escapes HTML-significant characters in dynamic text", () => {
    const html = decisionCardHtml(
      gate({ diff: null, command: "grep '<a> & <b>' ." }),
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
      gate({ kind: "question", diff: null, command: null, title: "Which formats to support?", options: ["DXF now", "DWG via convert"] }),
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

  it("an approval gate gets the exact 3-row shape: Approve once/Reject, Always allow, Open in Skynet — no View diff or Request changes", () => {
    const kb = gateKeyboard(gate({ kind: "approval", diff: null, command: "deploy" }), "Takeoff", "https://app/#/agent/run-1");
    const flat = kb.inline_keyboard.flat();
    const datas = flat.map((b) => b.callback_data);
    const byData = Object.fromEntries(flat.filter((b) => b.callback_data).map((b) => [b.callback_data, b.text]));
    expect(datas).not.toContain("hitl:diff:q-42");
    expect(datas).not.toContain("hitl:modify:q-42");
    expect(byData["hitl:approve:q-42"]).toBe("Approve once");
    expect(byData["hitl:reject:q-42"]).toMatch(/reject/i);
    // "deploy" has no explicit rule → falls to the default gate/medium risk, which IS rememberable.
    expect(byData["hitl:remember:q-42"]).toContain("Always allow for Takeoff");
    expect(flat.find((b) => b.url)).toEqual({ text: "Open the run in Skynet ↗", url: "https://app/#/agent/run-1" });
  });

  it("omits the 'Always allow' row for a non-rememberable (high-risk/deny) command", () => {
    const kb = gateKeyboard(gate({ kind: "approval", diff: null, command: "git push origin main" }), "Takeoff");
    const datas = kb.inline_keyboard.flat().map((b) => b.callback_data);
    expect(datas).not.toContain("hitl:remember:q-42");
  });

  it("omits the Open-in-Skynet row when no link is given", () => {
    const kb = gateKeyboard(gate({ kind: "approval", diff: null, command: "deploy" }), "Takeoff");
    expect(kb.inline_keyboard.flat().some((b) => b.url)).toBe(false);
  });

  it("renders a button PER option for a decision (question), not an approve/reject gate", () => {
    const kb = gateKeyboard(gate({ kind: "question", diff: null, command: null, options: ["DXF now", "DWG via convert", "All three"] }));
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
    }));
    const byData = Object.fromEntries(kb.inline_keyboard.flat().map((b) => [b.callback_data, b.text]));
    expect(byData["hitl:option:0:q-42"]).toContain("Yes, fix both deploy scripts");
    expect(byData["hitl:option:1:q-42"]).toContain("No, leave as-is");
    expect(Object.keys(byData)).not.toContain("hitl:approve:q-42"); // no single "the" action to approve
  });

  it("an escalation with NO offered choices (e.g. the autonomy-paused notice) still gets the generic Approve/Reject row", () => {
    const kb = gateKeyboard(gate({ kind: "escalation", diff: null, command: null, options: null }));
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
  const question = gate({ kind: "question", diff: null, command: null, title: "Which?", options: ["DXF now", "DWG via convert"] });

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
    });
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

// "Always allow for <project>" — the keyboard's row 2, the same
// Project.approvalRules write path as the web inbox's remember checkbox
// (TASK 16) and the Keys & Budget panel's direct "+ add pattern" (TASK 20).
describe("Always allow (remember)", () => {
  const approvalGate = gate({ kind: "approval", diff: null, command: "npm test" });

  it("tapping it approves AND passes remember:true to resolveHitl", async () => {
    const c = makeControl(true, approvalGate);
    await c.handleCallback(OWNER, "hitl:remember:q-42", "cb-1", 500);
    expect(c.resolveHitl).toHaveBeenCalledTimes(1);
    expect(c.resolveHitl.mock.calls[0]?.[1]).toBe("q-42");
    expect(c.resolveHitl.mock.calls[0]?.[2]).toEqual({ action: "approve", remember: true });
    expect(c.notes.at(-1)).toMatch(/remembered/i);
    expect(c.edits).toContain(500); // buttons stripped
  });

  it("does nothing with control OFF", async () => {
    const c = makeControl(false, approvalGate);
    await c.handleCallback(OWNER, "hitl:remember:q-42", "cb-1", 500);
    expect(c.resolveHitl).not.toHaveBeenCalled();
  });

  it("refuses a stale tap on an already-resolved gate", async () => {
    const c = makeControl(true, approvalGate);
    await c.handleCallback(OWNER, "hitl:remember:q-999", "cb-1", 500);
    expect(c.resolveHitl).not.toHaveBeenCalled();
    expect(c.acks[0]?.text).toMatch(/already/i);
  });
});
