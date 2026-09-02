// Phase 2: the /inbox digest, quiet hours, and the live "shipped" card copy.
// Pure builders + the /inbox handler (read-only, works with control OFF).
import { describe, it, expect, vi } from "vitest";
import {
  digestText,
  shippedCardHtml,
  resolvedCardHtml,
  dailyDigestHtml,
  nextDigestDelayMs,
  inQuietHours,
  parseQuietHours,
} from "../apps/server/src/telegram/notices.js";
import { decide } from "../apps/server/src/telegram/commands.js";
import { createOwnerControl, type ControlOps, type ControlOrch } from "../apps/server/src/telegram/index.js";

const OWNER = "111";

describe("digestText", () => {
  it("leads with the counts, then lists the open decisions", () => {
    const t = digestText({
      gates: [
        { head: "Review the changes", run: "rate-limiter" },
        { head: "Approve a command", run: "db-migrate" },
      ],
      running: 3,
      done: 5,
    });
    expect(t).toContain("<b>2 waiting on you</b> · 3 running · 5 done");
    expect(t).toContain("Review the changes — rate-limiter");
    expect(t).toContain("Approve a command — db-migrate");
  });

  it("says so plainly when nothing needs a decision", () => {
    const t = digestText({ gates: [], running: 1, done: 0 });
    expect(t).toContain("0 waiting on you");
    expect(t).toMatch(/nothing needs a decision/i);
  });

  it("caps the list and notes the overflow", () => {
    const gates = Array.from({ length: 9 }, (_, i) => ({ head: "Review", run: `run-${i}` }));
    const t = digestText({ gates, running: 0, done: 0 });
    expect(t).toMatch(/and 3 more/); // 9 − 6 shown
  });

  it("escapes dynamic text", () => {
    const t = digestText({ gates: [{ head: "Review", run: "a & <b>" }], running: 0, done: 0 });
    expect(t).toContain("a &amp; &lt;b&gt;");
  });
});

describe("shippedCardHtml", () => {
  it("renders the in-place 'done' state, escaped", () => {
    expect(shippedCardHtml({ run: "rate-limiter", project: "A & B" })).toBe(
      "✅ <b>Shipped</b> · A &amp; B\nrate-limiter",
    );
  });
});

// The gap closed by this task: a Telegram card used to just lose its buttons
// on resolution ("Gate X approved." arrived as a SEPARATE line); this is what
// edits the card itself in place — fired identically whether the resolution
// came from a Telegram tap or the web inbox (see index.ts's `hitl.resolved`
// handler, which is the only thing that decides WHEN to call this).
describe("resolvedCardHtml", () => {
  it("reads 'you' for a Telegram-originated resolution — no name directory exists for the single-owner chat id", () => {
    const html = resolvedCardHtml({ run: "rate-limiter", project: "Takeoff" }, { action: "approve", by: "telegram:111", at: new Date(2026, 0, 1, 15, 42).getTime() });
    expect(html).toContain("✅ Approved by you");
    expect(html).toContain("Takeoff");
    expect(html).toContain("rate-limiter");
    expect(html).toMatch(/3:42\s*PM/i);
  });

  it("shows a web operatorId verbatim — same as the audit trail", () => {
    const html = resolvedCardHtml({ run: "r", project: "" }, { action: "reject", by: "jordan", at: 0 });
    expect(html).toContain("🚫 Rejected by jordan");
  });

  it("covers every resolution action, not just approve/reject", () => {
    expect(resolvedCardHtml({ run: "r", project: "" }, { action: "modify", by: "jordan", at: 0 })).toContain("✏️ Changes requested");
    expect(resolvedCardHtml({ run: "r", project: "" }, { action: "option", by: "jordan", at: 0 })).toContain("✅ Answered");
  });
});

describe("dailyDigestHtml — scheduled evening summary", () => {
  it("names the longest-waiting gate as what needs you most, in a lime 'DIGEST · HH:00' header", () => {
    const html = dailyDigestHtml({
      hour: 18,
      gates: [{ head: "Review the changes", run: "rate-limiter" }, { head: "Approve a command", run: "db-migrate" }],
      running: 2,
      done: 5,
      spentUsd: 12.5,
      capUsd: null,
    });
    expect(html).toContain("🟢 <b>DIGEST · 18:00</b>");
    expect(html).toContain("Review the changes on rate-limiter needs you most.");
    expect(html).toContain("2 runs active, 5 finished today.");
    expect(html).toContain("2 decisions are open in total.");
  });

  it("reads plainly when nothing is waiting", () => {
    const html = dailyDigestHtml({ hour: 18, gates: [], running: 3, done: 1, spentUsd: 0, capUsd: null });
    expect(html).toContain("Nothing needs a decision right now.");
    expect(html).toContain("Autonomy is running the rest without you.");
  });

  it("shows a plain spend figure with no cap set, and a mini bar once one is", () => {
    const noCap = dailyDigestHtml({ hour: 18, gates: [], running: 0, done: 0, spentUsd: 4.5, capUsd: null });
    expect(noCap).toContain("$4.50 spent today");
    expect(noCap).not.toContain("▓");
    const withCap = dailyDigestHtml({ hour: 18, gates: [], running: 0, done: 0, spentUsd: 5, capUsd: 10 });
    expect(withCap).toContain("$5.00 of $10.00 spent today");
    expect(withCap).toContain("▓▓▓▓▓░░░░░"); // 50% of a 10-cell bar
  });

  it("escapes dynamic gate text", () => {
    const html = dailyDigestHtml({ hour: 18, gates: [{ head: "Review <danger>", run: "a & b" }], running: 0, done: 0, spentUsd: 0, capUsd: null });
    expect(html).toContain("Review &lt;danger&gt;");
    expect(html).toContain("a &amp; b");
  });
});

describe("nextDigestDelayMs", () => {
  it("counts down to today's occurrence when it hasn't passed yet", () => {
    const now = new Date(2026, 0, 1, 9, 0, 0);
    expect(nextDigestDelayMs(18, now)).toBe(9 * 60 * 60 * 1000);
  });

  it("rolls over to tomorrow once the hour has already passed", () => {
    const now = new Date(2026, 0, 1, 20, 0, 0);
    expect(nextDigestDelayMs(18, now)).toBe(22 * 60 * 60 * 1000);
  });

  it("fires immediately-ish (24h out) at the exact minute", () => {
    const now = new Date(2026, 0, 1, 18, 0, 0);
    expect(nextDigestDelayMs(18, now)).toBe(24 * 60 * 60 * 1000);
  });
});

describe("quiet hours", () => {
  it("parses a valid range and rejects junk", () => {
    expect(parseQuietHours("22-7")).toEqual({ start: 22, end: 7 });
    expect(parseQuietHours("9 - 17")).toEqual({ start: 9, end: 17 });
    expect(parseQuietHours(undefined)).toBeNull();
    expect(parseQuietHours("nope")).toBeNull();
    expect(parseQuietHours("25-3")).toBeNull();
  });

  it("wraps midnight for start > end (22:00–06:59)", () => {
    const at = (h: number) => new Date(2026, 0, 1, h, 0, 0);
    const r = { start: 22, end: 7 };
    expect(inQuietHours(at(23), r)).toBe(true);
    expect(inQuietHours(at(3), r)).toBe(true);
    expect(inQuietHours(at(7), r)).toBe(false); // end is exclusive
    expect(inQuietHours(at(12), r)).toBe(false);
  });

  it("handles a same-day range and a null range", () => {
    const at = (h: number) => new Date(2026, 0, 1, h, 0, 0);
    expect(inQuietHours(at(10), { start: 9, end: 17 })).toBe(true);
    expect(inQuietHours(at(18), { start: 9, end: 17 })).toBe(false);
    expect(inQuietHours(at(3), null)).toBe(false);
  });
});

describe("/inbox command", () => {
  it("parses to the read-only inbox action even with control OFF", () => {
    expect(decide({ chatId: OWNER, ownerChatId: OWNER, controlEnabled: false, text: "/inbox" }).kind).toBe("inbox");
  });

  it("sends the digest with resolved run names + counts", async () => {
    const notes: string[] = [];
    const operations = {
      listHitl: async () => [
        { id: "q-1", runId: "run-1", kind: "diff", title: "t", risk: "low", resolvedAt: null },
      ],
      listRuns: async () => [
        { id: "run-1", name: "rate-limiter", status: "running" },
        { id: "run-2", name: "cacher", status: "done" },
      ],
      listProjects: async () => [],
      listTasks: async () => [],
      listAgents: async () => [],
      listProviders: async () => [],
      resolveHitl: vi.fn(),
      createTask: vi.fn(),
      assignTask: vi.fn(),
      archiveTask: vi.fn(),
      createProject: vi.fn(),
      configureRunner: vi.fn(),
    } as unknown as ControlOps;
    const orchestrator = { consult: vi.fn(), stopAll: vi.fn(), setPaused: vi.fn(), isPaused: () => false } as unknown as ControlOrch;
    const { handle } = createOwnerControl({
      controlEnabled: false, // read-only digest works regardless
      ownerChatId: OWNER,
      operations,
      orchestrator,
      notify: async (t) => { notes.push(t); return { messageId: 1 }; },
      onQuit: () => undefined,
    });

    await handle(OWNER, "/inbox");
    const body = notes.at(-1)!;
    expect(body).toContain("1 waiting on you");
    expect(body).toContain("1 running");
    expect(body).toContain("1 done");
    expect(body).toContain("Review the changes — rate-limiter"); // gate's run name, not id
  });
});
