// Telegram notification copy must read like a human wrote it — lead with the
// run's task title + its project, never the raw ids that made the originals
// unreadable ("Gate q-diff-pin-the-node-docker-image-to-a-d-1-20 …", "Run
// pin-the-node-docker-image-to-a-d-1 needs attention").
import { describe, it, expect } from "vitest";
import type { HitlItem } from "@skynet/shared";
import {
  gateNotice,
  decisionCardHtml,
  reviewNotice,
  completedNotice,
  featureShippedNotice,
  runLink,
  desktopRunLink,
  projectLink,
  desktopProjectLink,
} from "../apps/server/src/telegram/notices.js";

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

// S12 follow-through: a whole feature's batch finished, not just one run —
// distinct wording (and its own emoji) from completedNotice's single-run
// "Shipped" so the two are never confused reading a phone notification, and
// the task count is inferable without opening the app (per the task's own
// "4 of 5 done, 1 needs you" framing — a review ping for the holdout plus
// this notice together tell the whole story).
describe("featureShippedNotice", () => {
  const FEATURE_NAMES = { project: "Takeoff", feature: "Rate limiting" };

  it("names the project AND the feature, and states the task count", () => {
    const msg = featureShippedNotice(FEATURE_NAMES, 4);
    expect(msg).toContain("Feature shipped");
    expect(msg).toContain("Takeoff");
    expect(msg).toContain("Rate limiting");
    expect(msg).toContain("4 tasks done");
  });

  it("singularizes a 1-task batch", () => {
    expect(featureShippedNotice(FEATURE_NAMES, 1)).toContain("1 task done");
  });

  it("appends the link when given (and omits it otherwise)", () => {
    const link = "https://skynet.example.com/#/project/p1";
    expect(featureShippedNotice(FEATURE_NAMES, 2, link)).toContain(link);
    expect(featureShippedNotice(FEATURE_NAMES, 2)).not.toContain("http");
  });

  it("omits the project segment when the project name is empty (lookup failed)", () => {
    const msg = featureShippedNotice({ project: "", feature: "Rate limiting" }, 2);
    expect(msg).not.toContain(" · ");
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

  it("projectLink/desktopProjectLink build the project hash route — a feature has no page of its own yet", () => {
    expect(projectLink("https://skynet.example.com", "p1")).toBe("https://skynet.example.com/#/project/p1");
    expect(projectLink("", "p1")).toBeUndefined();
    expect(desktopProjectLink("p1")).toBe("skynet://project/p1");
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
