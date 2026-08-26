// Telegram notification copy must read like a human wrote it — lead with the
// run's task title + its project, never the raw ids that made the originals
// unreadable ("Gate q-diff-pin-the-node-docker-image-to-a-d-1-20 …", "Run
// pin-the-node-docker-image-to-a-d-1 needs attention").
import { describe, it, expect } from "vitest";
import type { HitlItem } from "@skynet/shared";
import { gateNotice, decisionCardHtml, gateHead, reviewNotice, completedNotice, runLink, desktopRunLink } from "../apps/server/src/telegram/notices.js";

const UGLY_RUN_ID = "pin-the-node-docker-image-to-a-d-1";
const UGLY_GATE_ID = "q-diff-pin-the-node-docker-image-to-a-d-1-20";
const NAMES = { run: "Pin the Node Docker image to a digest", project: "Takeoff" };

const item = (o: Partial<HitlItem>): HitlItem =>
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
