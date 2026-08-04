// A failed preview must say WHY. The dev server's stderr is captured into the
// preview logs; previewExitReason folds the tail of that into the failure message
// so "exited (code 1)" becomes actionable (e.g. "…vite: command not found")
// everywhere the error surfaces (the Telegram notice + the preview UI).
import { describe, it, expect } from "vitest";
import { previewLogTail, previewExitReason } from "../apps/server/src/preview/project-preview.js";

describe("preview failure reason", () => {
  it("previewLogTail: empty / whitespace-only logs add nothing", () => {
    expect(previewLogTail([])).toBe("");
    expect(previewLogTail(["   ", "\t", ""])).toBe("");
  });

  it("previewLogTail: joins the last 3 non-blank lines", () => {
    expect(previewLogTail(["a", "b", "c", "d"])).toBe(" — b / c / d");
    expect(previewLogTail(["", "sh: vite: command not found", ""])).toBe(" — sh: vite: command not found");
  });

  it("previewLogTail: caps a very long tail with a leading ellipsis", () => {
    const long = "x".repeat(1000);
    const out = previewLogTail([long]);
    expect(out.startsWith(" — …")).toBe(true);
    expect(out.length).toBeLessThanOrEqual(410); // " — …" + ≤400 chars
  });

  it("previewExitReason: code + output tail", () => {
    expect(previewExitReason(1, ["Error: Cannot find module 'vite'"])).toBe(
      "preview process exited (code 1) — Error: Cannot find module 'vite'",
    );
  });

  it("previewExitReason: unknown code, no logs", () => {
    expect(previewExitReason(null, [])).toBe("preview process exited (code ?)");
  });
});
