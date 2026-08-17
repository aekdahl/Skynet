// Token-by-token streaming for the CLI runners — regression coverage for the
// vendor-specific "how do you tell a delta chunk apart from the complete
// message" logic, since (unlike Claude's SDK) neither Gemini's nor Cursor's
// wire protocol marks that boundary explicitly. Traced against each vendor's
// CURRENT released source, not guessed:
//   - Gemini: google-gemini/gemini-cli main — packages/cli/src/nonInteractiveCli.ts
//     (each GeminiEventType.Content chunk is written immediately as
//     {type:"message", role:"assistant", content:<chunk>, delta:true} — no
//     separate final event exists on the wire).
//   - Cursor: the shipped `cursor-agent` CLI's bundled source (2026.06.19
//     build) — see isConsolidatedAssistantEvent's doc comment in cursor.ts.
import { describe, it, expect } from "vitest";
import { gemini } from "../packages/runner-sdk/src/gemini.js";
import { isConsolidatedAssistantEvent } from "../packages/runner-sdk/src/cursor.js";
import type { ParseCtx } from "../packages/runner-sdk/src/cli-runner.js";

describe("Gemini token streaming (message + delta:true chunks)", () => {
  it("a delta chunk previews live and buffers — no persisted line yet", () => {
    const ctx: ParseCtx = {};
    const line = JSON.stringify({ type: "message", role: "assistant", content: "Hel", delta: true });
    expect(gemini.parseLine(line, ctx)).toEqual({ kind: "delta", text: "Hel" });
    expect(ctx.geminiDelta).toBe("Hel");
  });

  it("buffers across multiple chunks", () => {
    const ctx: ParseCtx = {};
    gemini.parseLine(JSON.stringify({ type: "message", role: "assistant", content: "Hel", delta: true }), ctx);
    gemini.parseLine(JSON.stringify({ type: "message", role: "assistant", content: "lo", delta: true }), ctx);
    expect(ctx.geminiDelta).toBe("Hello");
  });

  it("flushes the buffered text as ONE persisted line ahead of the next real event", () => {
    const ctx: ParseCtx = {};
    gemini.parseLine(JSON.stringify({ type: "message", role: "assistant", content: "Hello", delta: true }), ctx);
    const toolLine = JSON.stringify({ type: "tool_use", name: "run_shell" });
    expect(gemini.parseLine(toolLine, ctx)).toEqual([
      { kind: "chat", text: "Hello" },
      { kind: "tool", label: "run_shell" },
    ]);
    expect(ctx.geminiDelta).toBeUndefined(); // consumed
  });

  it("a user-role message (delta absent) is not treated as a chunk — flushes then logs it", () => {
    const ctx: ParseCtx = {};
    gemini.parseLine(JSON.stringify({ type: "message", role: "assistant", content: "partial", delta: true }), ctx);
    const userLine = JSON.stringify({ type: "message", role: "user", content: "some tool result" });
    expect(gemini.parseLine(userLine, ctx)).toEqual([
      { kind: "chat", text: "partial" },
      { kind: "chat", text: "some tool result" },
    ]);
  });

  it("returns a bare event (not a 1-element array) when there's nothing to flush — no shape change for the common case", () => {
    const ctx: ParseCtx = {};
    expect(gemini.parseLine(JSON.stringify({ type: "tool_use", name: "read_file" }), ctx)).toEqual({
      kind: "tool",
      label: "read_file",
    });
  });
});

describe("Cursor token streaming (isConsolidatedAssistantEvent)", () => {
  it("a raw delta chunk (timestamp_ms present, no model_call_id) is NOT consolidated", () => {
    expect(
      isConsolidatedAssistantEvent({
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "Hel" }] },
        session_id: "s1",
        timestamp_ms: 1700000000000,
      }),
    ).toBe(false);
  });

  it("the pre-tool-call flush (model_call_id set) IS consolidated", () => {
    expect(
      isConsolidatedAssistantEvent({
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "Hello" }] },
        session_id: "s1",
        timestamp_ms: 1700000000000,
        model_call_id: "call-1",
      }),
    ).toBe(true);
  });

  it("the pre-result flush (no timestamp_ms at all) IS consolidated — matches pre-existing behavior with --stream-partial-output off, where every assistant event takes this shape", () => {
    expect(
      isConsolidatedAssistantEvent({
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "Done." }] },
        session_id: "s1",
      }),
    ).toBe(true);
  });
});
