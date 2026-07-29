// Telegram notification copy must read like a human wrote it — lead with the
// run's task title + its project, never the raw ids that made the originals
// unreadable ("Gate q-diff-pin-the-node-docker-image-to-a-d-1-20 …", "Run
// pin-the-node-docker-image-to-a-d-1 needs attention").
import { describe, it, expect } from "vitest";
import type { HitlItem } from "@skynet/shared";
import { gateNotice, reviewNotice, completedNotice } from "../apps/server/src/telegram/notices.js";

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
