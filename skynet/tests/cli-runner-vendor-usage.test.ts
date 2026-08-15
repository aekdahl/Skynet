// CLI usage fidelity — regression coverage for the actual wire shapes each
// vendor CLI emits (not just the generic usageFromJson scanner already covered
// by runner-usage.test.ts). Payloads here are traced against the vendors'
// CURRENT released source/CLI, not guessed:
//   - Codex: codex-cli 0.147.0 — codex-rs/protocol/src/protocol.rs (TokenCountEvent).
//   - Gemini: google-gemini/gemini-cli main — packages/core/src/output/
//     stream-json-formatter.ts (StreamJsonFormatter.convertToStreamStats).
// Cursor's --output-format stream-json is confirmed current via `cursor-agent
// --help`, but a live authenticated run needs a separate CURSOR_API_KEY beyond
// the interactive CLI login this environment had — its case below documents
// the STANDARD Claude-Code-SDK-style result shape the existing parser already
// targets, not an independently-captured payload.
//   - Copilot: @github/copilot 1.0.80 — a LIVE authenticated `copilot -p ...
//     --output-format json` run against this environment's signed-in CLI (not
//     a fixture guessed from docs). See packages/runner-sdk/src/copilot.ts's
//     file header for the full capture notes (including the permission-denial
//     behavior this vendor's approval gate is keyed off).
import { describe, it, expect } from "vitest";
import { codex } from "../packages/runner-sdk/src/codex.js";
import { gemini } from "../packages/runner-sdk/src/gemini.js";
import { buildUsage, durationFromResultUsage } from "../packages/runner-sdk/src/copilot.js";
import { usageFromJson } from "../packages/runner-sdk/src/cli-runner.js";

describe("Codex usage parsing (real TokenCountEvent shape)", () => {
  it("unwraps msg.info.total_token_usage — the generic scanner alone finds nothing here", () => {
    const line = JSON.stringify({
      id: "sub-1",
      msg: {
        type: "token_count",
        info: {
          total_token_usage: {
            input_tokens: 1200,
            cached_input_tokens: 400,
            cache_write_input_tokens: 0,
            output_tokens: 340,
            reasoning_output_tokens: 50,
            total_tokens: 1540,
          },
          last_token_usage: {
            input_tokens: 300,
            cached_input_tokens: 100,
            cache_write_input_tokens: 0,
            output_tokens: 80,
            reasoning_output_tokens: 10,
            total_tokens: 380,
          },
          model_context_window: 200000,
        },
        rate_limits: null,
      },
    });
    expect(codex.parseLine(line, {})).toEqual({
      kind: "usage",
      usage: { inputTokens: 1200, outputTokens: 340, costUsd: null, turns: 0, durationMs: null },
    });
  });

  it("falls back to last_token_usage when info has no total (never throws on a partial shape)", () => {
    const line = JSON.stringify({
      id: "sub-1",
      msg: { type: "token_count", info: { last_token_usage: { input_tokens: 50, output_tokens: 10 } } },
    });
    expect(codex.parseLine(line, {})).toEqual({
      kind: "usage",
      usage: { inputTokens: 50, outputTokens: 10, costUsd: null, turns: 0, durationMs: null },
    });
  });

  it("ignores a token_count event with no info yet (early in the session) — no fake zero row", () => {
    const line = JSON.stringify({ id: "sub-1", msg: { type: "token_count", info: null } });
    expect(codex.parseLine(line, {})).toEqual({ kind: "ignore" });
  });
});

describe("Gemini usage parsing (real stream-json result shape)", () => {
  it("defaults buildArgs to --output-format stream-json — text mode never reports usage", () => {
    const args = gemini.buildArgs({
      runId: "r1",
      projectId: "p1",
      task: "do the thing",
      model: "gemini-2.5-pro",
      branch: "agent/r1",
    });
    expect(args).toEqual(["-m", "gemini-2.5-pro", "--output-format", "stream-json", "-p", "do the thing"]);
  });

  it("reads the final result event's flat stats.{input_tokens,output_tokens,duration_ms}", () => {
    const line = JSON.stringify({
      type: "result",
      timestamp: "2026-08-12T18:08:24.205Z",
      status: "success",
      stats: {
        total_tokens: 1840,
        input_tokens: 1500,
        output_tokens: 340,
        cached: 200,
        input: 1500,
        duration_ms: 4521,
        tool_calls: 2,
        models: { "gemini-2.5-pro": { total_tokens: 1840, input_tokens: 1500, output_tokens: 340, cached: 200, input: 1500 } },
      },
    });
    expect(gemini.parseLine(line, {})).toEqual({
      kind: "usage",
      usage: { inputTokens: 1500, outputTokens: 340, costUsd: null, turns: 0, durationMs: 4521 },
    });
  });

  it("text-mode fallback never fabricates usage from a plain log line", () => {
    expect(gemini.parseLine("Running the test suite...", {})).toEqual({
      kind: "tool",
      label: "Running the test suite...",
    });
  });
});

describe("Cursor usage shape (standard Claude-Code-SDK-style result.usage — see file header)", () => {
  it("the existing extraction (ev.usage ?? ev) reads a nested result.usage block", () => {
    const usage = usageFromJson({ input_tokens: 900, output_tokens: 210, total_cost_usd: 0.12 });
    expect(usage).toEqual({ inputTokens: 900, outputTokens: 210, costUsd: 0.12, turns: 0, durationMs: null });
  });
});

describe("Copilot usage (real --output-format json shapes — see file header)", () => {
  // A live `copilot -p "say hello" --output-format json` run. The assistant
  // message carried a real outputTokens count; the terminal `result` line —
  // which is NOT wrapped in the {data:...} envelope every other event uses —
  // carried usage.totalApiDurationMs. Neither an input-token count nor a $
  // cost appears anywhere in the stream; copilot.ts's onResult() sums
  // outputTokens across every assistant.message it saw and passes that
  // total, plus a turn count and the result's duration, into buildUsage().
  const assistantMessage = {
    type: "assistant.message",
    data: {
      messageId: "b44ff5e9-8850-4ea1-a632-fe44adbf3fcb",
      model: "gpt-5-mini",
      content: "Hello!",
      toolRequests: [],
      turnId: "0",
      outputTokens: 238,
    },
  };
  const result = {
    type: "result",
    timestamp: "2026-08-15T20:54:13.309Z",
    sessionId: "38955f10-4602-401b-a053-13fa4256bc48",
    exitCode: 0,
    usage: {
      premiumRequests: 0,
      totalApiDurationMs: 3907,
      sessionDurationMs: 7238,
      codeChanges: { linesAdded: 0, linesRemoved: 0, filesModified: [] },
    },
  };

  it("combines the summed outputTokens with the result's duration (real captured shape)", () => {
    const durationMs = durationFromResultUsage(result.usage);
    const usage = buildUsage(assistantMessage.data.outputTokens, 1, durationMs);
    expect(usage).toEqual({ inputTokens: 0, outputTokens: 238, costUsd: null, turns: 1, durationMs: 3907 });
  });

  it("prefers totalApiDurationMs over sessionDurationMs when both are present", () => {
    expect(durationFromResultUsage(result.usage)).toBe(3907);
  });

  it("falls back to sessionDurationMs when totalApiDurationMs is absent", () => {
    expect(durationFromResultUsage({ sessionDurationMs: 5200, premiumRequests: 0 })).toBe(5200);
  });

  it("returns 0 (not undefined/NaN) when a result carries no duration at all", () => {
    expect(durationFromResultUsage({ premiumRequests: 0 })).toBe(0);
  });

  it("never fabricates an input-token count or a $ cost — this protocol reports neither", () => {
    const usage = buildUsage(500, 2, 9000);
    expect(usage?.inputTokens).toBe(0);
    expect(usage?.costUsd).toBeNull();
  });

  it("returns null when nothing was ever produced (no fake zero row)", () => {
    expect(buildUsage(0, 0, 0)).toBeNull();
  });
});
