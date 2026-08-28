// oneShotTextStream now has two transports: a plain HTTP call to the Messages
// API (cheap — no in-process Agent SDK session) when this process has real
// network egress, falling back to the SDK's own query() transport only when
// nested inside another Claude Code session (a raw fetch has no egress
// there). This is what makes the task linter (and every other one-shot
// consult — Steward chat, triage, crystallize, decompose) far cheaper per
// call, which matters when a bulk operation fires many of them at once (the
// incident that prompted this: see tests/task-linter-concurrency.test.ts).
//
// The SSE fixtures below are the REAL response shape captured live against
// the Anthropic API (including the adaptive-thinking block every current
// model — not just fable — emits before its text block), not guessed.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { isNestedClaudeSession, oneShotTextStream } from "../packages/runner-sdk/src/claude.js";

const ORIGINAL_ENV = { ...process.env };

function resetEnv() {
  for (const k of Object.keys(process.env)) {
    if (!(k in ORIGINAL_ENV)) delete process.env[k];
  }
  Object.assign(process.env, ORIGINAL_ENV);
}

// This test suite itself typically runs inside a real Claude Code session
// (vitest launched from within one, same as any other command in this repo),
// so the ambient env genuinely carries other CLAUDE_CODE_* markers — scrub
// ALL of them, not just the one this file happens to set, or the "not
// nested" cases below would fail by correctly observing the REAL ambient
// state rather than the scenario each test means to construct.
function clearNestedMarkers() {
  for (const k of Object.keys(process.env)) {
    if (k.startsWith("CLAUDE_CODE_")) delete process.env[k];
  }
}

describe("isNestedClaudeSession", () => {
  beforeEach(clearNestedMarkers);
  afterEach(resetEnv);

  it("is false with no CLAUDE_CODE_* markers", () => {
    expect(isNestedClaudeSession()).toBe(false);
  });

  it("is true when a nested-session marker is present", () => {
    process.env.CLAUDE_CODE_ENTRYPOINT = "cli";
    expect(isNestedClaudeSession()).toBe(true);
  });

  it("a deliberately-set OAuth token alone does NOT count as nested", () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "sk-test";
    expect(isNestedClaudeSession()).toBe(false);
  });
});

describe("oneShotTextStream — plain-HTTP transport (standalone / not nested)", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    resetEnv();
    clearNestedMarkers();
    process.env.ANTHROPIC_API_KEY = "sk-ant-test-key";
  });
  afterEach(() => {
    global.fetch = originalFetch;
    resetEnv();
  });

  // Real event stream captured live against the Anthropic API for the prompt
  // "Count from 1 to 5, one number per line." — includes the leading
  // `thinking` block every current model emits by default.
  const REAL_SSE = [
    'event: message_start',
    'data: {"type":"message_start","message":{"model":"claude-sonnet-5","id":"msg_1","type":"message","role":"assistant","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":21,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"output_tokens":2}}}',
    '',
    'event: content_block_start',
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}',
    '',
    'event: content_block_delta',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"counting..."}}',
    '',
    'event: content_block_stop',
    'data: {"type":"content_block_stop","index":0}',
    '',
    'event: content_block_start',
    'data: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}',
    '',
    'event: content_block_delta',
    'data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"1\\n2\\n"}}',
    '',
    'event: content_block_delta',
    'data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"3\\n4\\n5"}}',
    '',
    'event: content_block_stop',
    'data: {"type":"content_block_stop","index":1}',
    '',
    'event: message_delta',
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"input_tokens":21,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"output_tokens":32}}',
    '',
    'event: message_stop',
    'data: {"type":"message_stop"}',
    '',
  ].join("\n");

  it("streams only the text block's deltas, skipping the thinking block entirely", async () => {
    global.fetch = vi.fn(async () => new Response(REAL_SSE, { status: 200 })) as unknown as typeof fetch;

    const chunks: string[] = [];
    for await (const delta of oneShotTextStream({ prompt: "Count from 1 to 5.", model: "sonnet-5" })) {
      chunks.push(delta);
    }
    expect(chunks.join("")).toBe("1\n2\n3\n4\n5");
    expect(chunks.length).toBeGreaterThan(1); // genuinely streamed, not one final blob
  });

  it("maps the Fleet catalog slug to the raw API's model id (claude-<slug>, dots to dashes)", async () => {
    const fetchMock = vi.fn(async () => new Response(REAL_SSE, { status: 200 }));
    global.fetch = fetchMock as unknown as typeof fetch;

    for await (const _ of oneShotTextStream({ prompt: "hi", model: "opus-4.8" })) void _;

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe("claude-opus-4-8");
  });

  it("reports usage from the merged message_start + message_delta events", async () => {
    global.fetch = vi.fn(async () => new Response(REAL_SSE, { status: 200 })) as unknown as typeof fetch;

    let usage: { inputTokens: number; outputTokens: number } | undefined;
    for await (const _ of oneShotTextStream({
      prompt: "hi",
      model: "sonnet-5",
      onUsage: (u) => { usage = u; },
    })) void _;

    expect(usage?.inputTokens).toBe(21);
    expect(usage?.outputTokens).toBe(32); // the message_delta's cumulative total, not message_start's placeholder (2)
  });

  it("uses the Authorization Bearer header (not x-api-key) for a Claude-compatible endpoint credential", async () => {
    const fetchMock = vi.fn(async () => new Response(REAL_SSE, { status: 200 }));
    global.fetch = fetchMock as unknown as typeof fetch;
    delete process.env.ANTHROPIC_API_KEY;

    for await (const _ of oneShotTextStream({
      prompt: "hi",
      model: "glm-5.3-flash",
      apiKey: "gateway-token",
      baseUrl: "https://api.z.ai/api/anthropic",
    })) void _;

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.z.ai/api/anthropic/v1/messages");
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer gateway-token");
    expect(headers["x-api-key"]).toBeUndefined();
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe("glm-5.3-flash"); // an unlisted vendor slug passes through verbatim, unmapped
  });

  it("a non-2xx response yields the same apologetic fallback as the SDK path, never throws", async () => {
    global.fetch = vi.fn(
      async () => new Response('{"type":"error","error":{"message":"model: bogus not found"}}', { status: 404 }),
    ) as unknown as typeof fetch;

    const chunks: string[] = [];
    for await (const delta of oneShotTextStream({ prompt: "hi", model: "bogus" })) chunks.push(delta);
    expect(chunks.join("")).toContain("couldn't look into that right now");
  });

  it("a network-level throw (fetch itself rejects) is caught the same way", async () => {
    global.fetch = vi.fn(async () => { throw new Error("ECONNRESET"); }) as unknown as typeof fetch;

    const chunks: string[] = [];
    for await (const delta of oneShotTextStream({ prompt: "hi", model: "sonnet-5" })) chunks.push(delta);
    expect(chunks.join("")).toContain("couldn't look into that right now");
  });
});
