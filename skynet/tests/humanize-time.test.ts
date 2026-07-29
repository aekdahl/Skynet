// The one duration formatter for user-facing "how long X has been running / X
// ago" text — SINGLE UNIT only. Never compound: "15m", not "15m 30s"; "2h",
// not "2h 21m". Readers glance at time indicators; stitching two units
// together crossed into cognitive-load territory. This locks the boundaries.
import { describe, it, expect } from "vitest";
import { fmtDurMs, fmtWait } from "../apps/web/src/lib/derive.js";

describe("fmtWait — single-unit at each boundary", () => {
  it("seconds under a minute", () => {
    expect(fmtWait(0)).toBe("0s");
    expect(fmtWait(8)).toBe("8s");
    expect(fmtWait(59)).toBe("59s");
  });
  it("minutes only under an hour (no seconds)", () => {
    expect(fmtWait(60)).toBe("1m");
    expect(fmtWait(90)).toBe("1m"); // floor — no "1m 30s"
    expect(fmtWait(59 * 60 + 59)).toBe("59m");
  });
  it("hours only under a day (no minutes)", () => {
    expect(fmtWait(3600)).toBe("1h");
    expect(fmtWait(8498)).toBe("2h");   // used to be "2h 21m"
    expect(fmtWait(79062)).toBe("21h"); // used to be "21h 57m"
    expect(fmtWait(24 * 3600 - 1)).toBe("23h");
  });
  it("days only beyond a day (no hours)", () => {
    expect(fmtWait(24 * 3600)).toBe("1d");
    expect(fmtWait(200_000)).toBe("2d"); // used to be "2d 07h"
    expect(fmtWait(365 * 86_400)).toBe("365d");
  });
  it("clamps negatives to 0", () => {
    expect(fmtWait(-5)).toBe("0s");
  });
});

describe("fmtDurMs — same rule, ms input", () => {
  it("passes through fmtWait", () => {
    expect(fmtDurMs(0)).toBe("0s");
    expect(fmtDurMs(30_000)).toBe("30s");
    expect(fmtDurMs(90_000)).toBe("1m");
    expect(fmtDurMs(90 * 60_000)).toBe("1h");
    expect(fmtDurMs(48 * 3_600_000)).toBe("2d");
  });
});
