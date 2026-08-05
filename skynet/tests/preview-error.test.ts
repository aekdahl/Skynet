// A failed preview must say WHY. The dev server's stderr is captured into the
// preview logs; previewExitReason folds the tail of that into the failure message
// so "exited (code 1)" becomes actionable (e.g. "…vite: command not found")
// everywhere the error surfaces (the Telegram notice + the preview UI).
import { describe, it, expect } from "vitest";
import { previewLogTail, previewExitReason, parsePreviewPorts } from "../apps/server/src/preview/project-preview.js";

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

// Dev servers routinely ignore an injected PORT (Vite always does; a
// `concurrently` script hardcodes its own), so we learn the real port from
// stdout. A "Local:"-style dev-client URL must be preferred over a bare API URL.
describe("parsePreviewPorts", () => {
  it("prefers the Vite 'Local:' dev-client port over the API server's, from a concurrently run", () => {
    // The exact shape the operator reported: server on 8787, Vite client on 5173,
    // while PORT=34511 was injected and honored by neither.
    const out = parsePreviewPorts(
      [
        "[server] [server] listening on http://localhost:8787",
        "[client]   VITE v6.4.3  ready in 888 ms",
        "[client]   ➜  Local:   http://localhost:5173/",
        "[client]   ➜  Network: use --host to expose",
      ].join("\n"),
    );
    expect(out).toContainEqual({ port: 8787, strong: false }); // API server — bare URL
    expect(out).toContainEqual({ port: 5173, strong: true }); // dev client — "Local:" line
    // Only the dev client is a strong (preferred) signal.
    expect(out.filter((e) => e.strong).map((e) => e.port)).toEqual([5173]);
  });

  it("matches localhost / 127.0.0.1 / 0.0.0.0 and ignores non-URL numbers", () => {
    expect(parsePreviewPorts("ready http://127.0.0.1:3000/")).toEqual([{ port: 3000, strong: true }]);
    expect(parsePreviewPorts("serving on http://0.0.0.0:4321")).toEqual([{ port: 4321, strong: false }]);
    expect(parsePreviewPorts("added 166 packages, and audited 167 packages in 9s")).toEqual([]);
  });
});
