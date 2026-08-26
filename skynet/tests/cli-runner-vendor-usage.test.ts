// CLI usage fidelity — regression coverage for the actual wire shapes each
// vendor CLI emits (not just the generic usageFromJson scanner already covered
// by runner-usage.test.ts). Payloads here are traced against the vendors'
// CURRENT released source/CLI, not guessed:
//   - Codex: codex-cli 0.147.0 — codex-rs/protocol/src/protocol.rs (TokenCountEvent).
//   - Gemini: google-gemini/gemini-cli main — packages/core/src/output/
//     stream-json-formatter.ts (StreamJsonFormatter.convertToStreamStats).
//   - OpenCode: opencode-ai 1.18.18 — captured from real `opencode run --format
//     json` invocations with a live ANTHROPIC_API_KEY (a plain reply, a bash
//     tool call, a file write, and a fatal auth error), field names/nesting
//     verbatim from those runs.
//   - Kimi Code: kimi-code 0.38.0 (official native install.sh binary) —
//     captured from real `kimi -p ... --output-format stream-json` invocations
//     configured via KIMI_MODEL_* against a live ANTHROPIC_API_KEY (a plain
//     reply, a successful bash call, a FAILING bash call, and a file write),
//     field names/nesting verbatim from those runs. See kimi.ts's file header
//     for the full capture notes (including the fatal-auth-error path, which
//     never emits a JSON line — just a non-zero exit, already handled generically
//     by cli-runner.ts).
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
import { opencode } from "../packages/runner-sdk/src/opencode.js";
import { kimi } from "../packages/runner-sdk/src/kimi.js";
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

describe("OpenCode event parsing (real --format json shapes, see file header)", () => {
  it("buildArgs: run, structured json, --auto (own-permission-config auto-reject workaround), model, task", () => {
    const args = opencode.buildArgs({
      runId: "r1",
      projectId: "p1",
      task: "fix the bug",
      model: "anthropic/claude-sonnet-5",
      branch: "agent/r1",
    });
    expect(args).toEqual(["run", "--format", "json", "--auto", "-m", "anthropic/claude-sonnet-5", "fix the bug"]);
  });

  it("a step_start event carries nothing useful — ignored", () => {
    const line = JSON.stringify({
      type: "step_start",
      part: { id: "prt_1", messageID: "msg_1", sessionID: "ses_1", type: "step-start" },
    });
    expect(opencode.parseLine(line, {})).toEqual({ kind: "ignore" });
  });

  it("a text event → chat (the base decides log vs. chat-reply)", () => {
    const line = JSON.stringify({
      type: "text",
      part: { id: "prt_2", type: "text", text: "PONG" },
    });
    expect(opencode.parseLine(line, {})).toEqual({ kind: "chat", text: "PONG" });
  });

  it("a completed tool_use → tool, labelled from state.title (real bash + write shapes)", () => {
    const bash = JSON.stringify({
      type: "tool_use",
      part: { type: "tool", tool: "bash", state: { status: "completed", title: "echo hi-from-opencode" } },
    });
    expect(opencode.parseLine(bash, {})).toEqual({ kind: "tool", label: "echo hi-from-opencode" });

    const write = JSON.stringify({
      type: "tool_use",
      part: { type: "tool", tool: "write", state: { status: "completed", title: "greet.txt" } },
    });
    expect(opencode.parseLine(write, {})).toEqual({ kind: "tool", label: "greet.txt" });
  });

  it("a rejected tool_use (permission denied) → a log line naming what failed, not a silent tool bump", () => {
    const line = JSON.stringify({
      type: "tool_use",
      part: { type: "tool", tool: "bash", state: { status: "error", title: "echo x", error: "The user rejected permission to use this specific tool call." } },
    });
    expect(opencode.parseLine(line, {})).toEqual({
      kind: "log",
      line: "✕ echo x: The user rejected permission to use this specific tool call.",
    });
  });

  it("step_finish tokens/cost are PER-STEP, not cumulative — parseLine accumulates them itself", () => {
    const ctx = {};
    const step1 = JSON.stringify({
      type: "step_finish",
      part: { type: "step-finish", reason: "tool-calls", tokens: { total: 8263, input: 3, output: 58, reasoning: 0, cache: { write: 334, read: 7868 } }, cost: 0.0014973 },
    });
    expect(opencode.parseLine(step1, ctx)).toEqual({
      kind: "usage",
      usage: { inputTokens: 3, outputTokens: 58, costUsd: 0.0014973, turns: 1, durationMs: null },
    });

    // A second step in the SAME run (same ctx) — its own small delta, but the
    // reported usage must be the RUNNING SUM, matching onUsage's documented
    // "cumulative totals for the run" contract.
    const step2 = JSON.stringify({
      type: "step_finish",
      part: { type: "step-finish", reason: "stop", tokens: { total: 8302, input: 6, output: 20, reasoning: 0, cache: { write: 74, read: 8202 } }, cost: 0.0010187 },
    });
    expect(opencode.parseLine(step2, ctx)).toEqual({
      kind: "usage",
      usage: { inputTokens: 9, outputTokens: 78, costUsd: 0.002516, turns: 2, durationMs: null },
    });
  });

  it("a fatal error event surfaces the vendor's own message (the process then exits non-zero — cli-runner.ts's base handles the actual failure)", () => {
    const line = JSON.stringify({
      type: "error",
      error: { name: "APIError", data: { message: "API key is invalid.", statusCode: 401 } },
    });
    expect(opencode.parseLine(line, {})).toEqual({ kind: "log", line: "error: API key is invalid." });
  });

  it("a non-JSON line (e.g. the FSEvents startup warning) passes through as a raw log line", () => {
    expect(opencode.parseLine("error: Error starting FSEvents stream", {})).toEqual({
      kind: "log",
      line: "error: Error starting FSEvents stream",
    });
  });

  it("no live decision/message channel — run is one-shot headless (see file header)", () => {
    expect(opencode.encodeDecision(undefined, {})).toBeNull();
    expect(opencode.encodeMessage("anything")).toBeNull();
  });
});

describe("Kimi Code event parsing (real -p --output-format stream-json shapes, see kimi.ts header)", () => {
  it("buildArgs: -p, the task, structured json — model selection happens entirely via env, not argv", () => {
    const args = kimi.buildArgs({
      runId: "r1",
      projectId: "p1",
      task: "fix the bug",
      model: "anthropic/claude-sonnet-5",
      branch: "agent/r1",
    });
    expect(args).toEqual(["-p", "fix the bug", "--output-format", "stream-json"]);
  });

  it("env: a '<type>/<id>' model routes to that KIMI_MODEL_PROVIDER_TYPE, verified live against anthropic", () => {
    const env = kimi.env!({
      runId: "r1",
      projectId: "p1",
      task: "fix the bug",
      model: "anthropic/claude-sonnet-5",
      branch: "agent/r1",
      apiKey: "sk-ant-real",
    });
    expect(env).toEqual({
      KIMI_MODEL_NAME: "claude-sonnet-5",
      KIMI_MODEL_API_KEY: "sk-ant-real",
      KIMI_MODEL_PROVIDER_TYPE: "anthropic",
    });
  });

  it("env: a bare model id defaults to the 'kimi' (Moonshot-native) backend", () => {
    const env = kimi.env!({
      runId: "r1",
      projectId: "p1",
      task: "fix the bug",
      model: "kimi-for-coding",
      branch: "agent/r1",
      apiKey: "sk-moonshot",
    });
    expect(env).toEqual({
      KIMI_MODEL_NAME: "kimi-for-coding",
      KIMI_MODEL_API_KEY: "sk-moonshot",
      KIMI_MODEL_PROVIDER_TYPE: "kimi",
    });
  });

  it("env: no apiKey → inherit ambient env (e.g. a prior `kimi login`), no KIMI_MODEL_* vars at all", () => {
    const env = kimi.env!({ runId: "r1", projectId: "p1", task: "x", model: "kimi-for-coding", branch: "agent/r1" });
    expect(env).toEqual({});
  });

  it("a meta line (version banner, resume hint) carries nothing useful — ignored", () => {
    expect(kimi.parseLine(JSON.stringify({ role: "meta", type: "system.version", version: "0.38.0" }), {})).toEqual({ kind: "ignore" });
    expect(
      kimi.parseLine(
        JSON.stringify({ role: "meta", type: "session.resume_hint", session_id: "session_abc", command: "kimi -r session_abc", content: "To resume this session: kimi -r session_abc" }),
        {},
      ),
    ).toEqual({ kind: "ignore" });
  });

  it("an assistant tool_calls line → tool, labelled from the parsed arguments (real Bash shape)", () => {
    const line = JSON.stringify({
      role: "assistant",
      tool_calls: [{ type: "function", id: "toolu_01AeAVSNqF8d6KeUK9mf7q67", function: { name: "Bash", arguments: '{"command":"cat note.txt"}' } }],
    });
    expect(kimi.parseLine(line, {})).toEqual([{ kind: "tool", label: "cat note.txt" }]);
  });

  it("an assistant tool_calls line for Write → tool, labelled from the file path (real shape)", () => {
    const line = JSON.stringify({
      role: "assistant",
      tool_calls: [{ type: "function", id: "toolu_01GbKS7t2RcyComPoNjgdGRE", function: { name: "Write", arguments: '{"path":"marker.txt","content":"hello"}' } }],
    });
    expect(kimi.parseLine(line, {})).toEqual([{ kind: "tool", label: "marker.txt" }]);
  });

  it("a tool-result line — success and failure both land here as plain text, no error flag; ignored either way", () => {
    const success = JSON.stringify({ role: "tool", tool_call_id: "toolu_1", content: "line one\n" });
    expect(kimi.parseLine(success, {})).toEqual({ kind: "ignore" });
    const failure = JSON.stringify({ role: "tool", tool_call_id: "toolu_2", content: "Process exited with code 1\nCommand failed with exit code: 1." });
    expect(kimi.parseLine(failure, {})).toEqual({ kind: "ignore" });
  });

  it("a plain assistant reply → chat (the base decides log vs. chat-reply)", () => {
    expect(kimi.parseLine(JSON.stringify({ role: "assistant", content: "DONE" }), {})).toEqual({ kind: "chat", text: "DONE" });
  });

  it("never reports usage — this vendor's stream-json mode carries no token/cost field (see file header)", () => {
    // Every real captured line above already asserts its own kind; this just
    // confirms the defensive usageFromJson call can't accidentally fire on one.
    const line = JSON.stringify({ role: "assistant", content: "DONE" });
    const ev = kimi.parseLine(line, {});
    expect(Array.isArray(ev) ? ev.some((e) => e.kind === "usage") : ev.kind === "usage").toBe(false);
  });

  it("a non-JSON line passes through as a raw log line", () => {
    expect(kimi.parseLine("some non-json startup banner", {})).toEqual({ kind: "log", line: "some non-json startup banner" });
  });

  it("no live decision/message channel — -p mode runs under a fixed auto-permission policy (see file header)", () => {
    expect(kimi.encodeDecision(undefined, {})).toBeNull();
    expect(kimi.encodeMessage("anything")).toBeNull();
  });
});
