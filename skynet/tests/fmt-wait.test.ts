// fmtWait renders a compact elapsed duration for HITL waits and audit "ago"
// timestamps. Regression: it used to only roll seconds → minutes, so an 8-hour-
// old audit record read "504m 02s ago" instead of "8h 24m". It must now roll up
// into hours and days while keeping second precision for short live waits.
import { describe, it, expect } from "vitest";
import { fmtWait } from "../apps/web/src/lib/derive.js";

describe("fmtWait — rolls up as the duration grows", () => {
  it("shows seconds under a minute", () => {
    expect(fmtWait(0)).toBe("0s");
    expect(fmtWait(5)).toBe("5s");
    expect(fmtWait(59)).toBe("59s");
  });

  it("shows minutes + seconds under an hour", () => {
    expect(fmtWait(60)).toBe("1m 00s");
    expect(fmtWait(125)).toBe("2m 05s");
    expect(fmtWait(59 * 60 + 59)).toBe("59m 59s");
  });

  it("rolls into hours + minutes under a day (the reported bug)", () => {
    expect(fmtWait(60 * 60)).toBe("1h 00m");
    // 504m 02s → 8h 24m, not "504m 02s"
    expect(fmtWait(504 * 60 + 2)).toBe("8h 24m");
    expect(fmtWait(23 * 3600 + 59 * 60)).toBe("23h 59m");
  });

  it("rolls into days + hours beyond a day", () => {
    expect(fmtWait(24 * 3600)).toBe("1d 00h");
    expect(fmtWait(3 * 86400 + 4 * 3600)).toBe("3d 04h");
  });

  it("clamps negatives to 0s", () => {
    expect(fmtWait(-10)).toBe("0s");
  });
});
