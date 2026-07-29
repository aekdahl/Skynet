// Durations shown in the UI (heartbeat "… ago", HITL waits, elapsed) must roll up
// as they grow — never a raw "8498s ago". fmtWait is the shared formatter the
// heartbeat/wait renderers use; this locks its boundaries.
import { describe, it, expect } from "vitest";
import { fmtWait } from "../apps/web/src/lib/derive.js";

describe("fmtWait — rolls up so time never reads as raw seconds", () => {
  it("seconds under a minute", () => {
    expect(fmtWait(0)).toBe("0s");
    expect(fmtWait(8)).toBe("8s");
    expect(fmtWait(59)).toBe("59s");
  });
  it("minutes+seconds under an hour", () => {
    expect(fmtWait(60)).toBe("1m 00s");
    expect(fmtWait(90)).toBe("1m 30s");
  });
  it("hours+minutes under a day (the reported 8498s case)", () => {
    expect(fmtWait(8498)).toBe("2h 21m");
    expect(fmtWait(79062)).toBe("21h 57m");
  });
  it("days+hours beyond a day", () => {
    expect(fmtWait(200000)).toBe("2d 07h");
  });
  it("clamps negatives to 0", () => {
    expect(fmtWait(-5)).toBe("0s");
  });
});
