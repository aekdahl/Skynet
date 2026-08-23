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
