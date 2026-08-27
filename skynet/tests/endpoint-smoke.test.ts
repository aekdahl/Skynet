// The endpoint smoke test. Verifying a key proves it AUTHENTICATES; this proves
// the endpoint can actually drive Skynet's agent loop. The distinction is the
// whole point: a compatibility shim can authenticate perfectly and still never
// emit a tool call, which silently kills every approval, question and
// escalation — and nobody would attribute that to the endpoint.
import { describe, it, expect, vi, afterEach } from "vitest";
import { smokeTestEndpoint, __setClaudeTestHooks } from "../packages/runner-sdk/src/claude.js";
import { ratesFor } from "@skynet/shared";

/** A scripted vendor: replays messages, and optionally answers a tool call. */
function scriptedQuery(opts: { emitTool?: boolean; emitStream?: boolean; answer?: string; usage?: Record<string, unknown> | null; throws?: string }) {
  const fn = vi.fn((call: { options: { canUseTool?: (n: string, i: Record<string, unknown>) => Promise<unknown> } }) => {
    async function* gen() {
      if (opts.throws) throw new Error(opts.throws);
      yield { type: "system", session_id: "s1" };
      if (opts.emitTool) {
        // A real vendor round-trip: the model asks for a tool, our gate decides.
        await call.options.canUseTool?.("Read", { file_path: "skynet-probe.txt" });
      }
      if (opts.emitStream) {
        yield { type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: opts.answer ?? "" } } };
      }
      yield { type: "assistant", message: { content: [{ type: "text", text: opts.answer ?? "" }] } };
      yield {
        type: "result",
        subtype: "success",
        is_error: false,
        num_turns: 2,
        ...(opts.usage === null ? {} : { modelUsage: opts.usage ?? { m: { inputTokens: 900, outputTokens: 20 } } }),
      };
    }
    return Object.assign(gen(), { interrupt: async () => undefined });
  });
  return fn;
}

const OK = "skynet-endpoint-ok";
const byId = (r: { checks: Array<{ id: string; status: string }> }, id: string) => r.checks.find((c) => c.id === id)!;

afterEach(() => __setClaudeTestHooks(null));

describe("smokeTestEndpoint", () => {
  it("passes a fully working endpoint", async () => {
    __setClaudeTestHooks({ query: scriptedQuery({ emitTool: true, emitStream: true, answer: OK }) as never });
    const r = await smokeTestEndpoint({ apiKey: "k", baseUrl: "https://api.deepseek.com/anthropic", model: "deepseek-v4-flash", rates: ratesFor("https://api.deepseek.com/anthropic", "deepseek-v4-flash") });
    expect(r.ok).toBe(true);
    expect(byId(r, "auth").status).toBe("pass");
    expect(byId(r, "tools").status).toBe("pass");
    expect(byId(r, "toolResult").status).toBe("pass");
    expect(byId(r, "streaming").status).toBe("pass");
    expect(byId(r, "usage").status).toBe("pass");
    expect(r.vendor).toBe("DeepSeek");
  });

  it("FAILS an endpoint that authenticates but never emits a tool call", async () => {
    // The scenario this whole probe exists for. Verify would report a healthy
    // key; every gate, HITL and escalation in Skynet would be dead.
    __setClaudeTestHooks({ query: scriptedQuery({ emitTool: false, emitStream: true, answer: OK }) as never });
    const r = await smokeTestEndpoint({ apiKey: "k", baseUrl: "https://api.example/anthropic", model: "m" });
    expect(r.ok).toBe(false);
    expect(byId(r, "auth").status).toBe("pass");
    expect(byId(r, "tools").status).toBe("fail");
    expect(byId(r, "tools").critical).toBe(true);
    expect(byId(r, "tools").detail).toContain("escalations");
  });

  it("FAILS when the tool result never makes it back to the model", async () => {
    __setClaudeTestHooks({ query: scriptedQuery({ emitTool: true, emitStream: true, answer: "I couldn't read it" }) as never });
    const r = await smokeTestEndpoint({ apiKey: "k", baseUrl: null, model: "haiku" });
    expect(r.ok).toBe(false);
    expect(byId(r, "toolResult").status).toBe("fail");
  });

  it("FAILS when no usage comes back — spend would be untrackable", async () => {
    __setClaudeTestHooks({ query: scriptedQuery({ emitTool: true, emitStream: true, answer: OK, usage: null }) as never });
    const r = await smokeTestEndpoint({ apiKey: "k", baseUrl: null, model: "haiku" });
    expect(r.ok).toBe(false);
    expect(byId(r, "usage").status).toBe("fail");
  });

  it("treats missing streaming as a real but NON-blocking gap", async () => {
    // Skynet works without token-level deltas — the live log just updates per
    // turn instead of per token. Failing the whole endpoint for that would be
    // wrong, so it reports but doesn't block.
    __setClaudeTestHooks({ query: scriptedQuery({ emitTool: true, emitStream: false, answer: OK }) as never });
    const r = await smokeTestEndpoint({ apiKey: "k", baseUrl: null, model: "haiku" });
    expect(byId(r, "streaming").status).toBe("fail");
    expect(byId(r, "streaming").critical).toBe(false);
    expect(r.ok).toBe(true);
  });

  it("SKIPS the downstream checks when auth fails, rather than reporting a wall of red", async () => {
    // With no session there's nothing to say about tools or streaming; claiming
    // they failed would send someone debugging the wrong thing.
    __setClaudeTestHooks({ query: scriptedQuery({ throws: "401 invalid api key" }) as never });
    const r = await smokeTestEndpoint({ apiKey: "bad", baseUrl: "https://api.moonshot.ai/anthropic", model: "kimi-k2.7-code" });
    expect(r.ok).toBe(false);
    expect(byId(r, "auth").status).toBe("fail");
    expect(byId(r, "auth").detail).toContain("401");
    for (const id of ["tools", "toolResult", "streaming", "usage"]) expect(byId(r, id).status).toBe("skip");
  });

  it("does NOT report a bad key as authenticated when the SDK returns an ERROR result", async () => {
    // Found live against a real endpoint with a fake key. An SDK result is a
    // success|error union, and a rejected key comes back as an error RESULT,
    // not a thrown exception — so nothing threw, a (zero-filled) usage object
    // existed, and `auth` reported a cheerful pass for a credential that had
    // authenticated with nothing at all.
    const fn = vi.fn(() => {
      async function* gen() {
        yield { type: "system", session_id: "s1" };
        yield { type: "result", subtype: "error_during_execution", is_error: true, result: "invalid api key", num_turns: 0 };
      }
      return Object.assign(gen(), { interrupt: async () => undefined });
    });
    __setClaudeTestHooks({ query: fn as never });
    const r = await smokeTestEndpoint({ apiKey: "sk-fake", baseUrl: "https://api.moonshot.ai/anthropic", model: "kimi-k2.7-code" });
    expect(r.ok).toBe(false);
    expect(byId(r, "auth").status).toBe("fail");
    for (const id of ["tools", "toolResult", "streaming", "usage"]) expect(byId(r, id).status).toBe("skip");
  });

  it("does not mistake an all-zero usage object for a live session", async () => {
    // `usage` is an object even when every counter is zero, so truthiness alone
    // called a completely empty session "reachable".
    __setClaudeTestHooks({ query: scriptedQuery({ emitTool: false, emitStream: false, answer: "", usage: { m: { inputTokens: 0, outputTokens: 0 } } }) as never });
    const r = await smokeTestEndpoint({ apiKey: "k", baseUrl: null, model: "haiku" });
    expect(byId(r, "auth").status).toBe("fail");
  });

  it("flags an unpriced endpoint, since its reported cost would be wrong", async () => {
    __setClaudeTestHooks({ query: scriptedQuery({ emitTool: true, emitStream: true, answer: OK }) as never });
    const r = await smokeTestEndpoint({ apiKey: "k", baseUrl: "https://custom.example/anthropic", model: "mystery", rates: null });
    expect(byId(r, "pricing").status).toBe("skip");
    expect(byId(r, "pricing").detail).toContain("misreported");
    expect(r.ok).toBe(true); // reported, but not a blocker
  });

  it("surfaces the catalog's known caveats, which no live probe can see", async () => {
    // DeepSeek ignores MCP fields, so browser tools vanish — invisible to a
    // probe that doesn't use them, but decisive for review runs.
    __setClaudeTestHooks({ query: scriptedQuery({ emitTool: true, emitStream: true, answer: OK }) as never });
    const r = await smokeTestEndpoint({ apiKey: "k", baseUrl: "https://api.deepseek.com/anthropic", model: "deepseek-v4-flash" });
    expect(r.caveat).toContain("MCP");
  });

  it("prices the probe itself when rates are known", async () => {
    __setClaudeTestHooks({
      query: scriptedQuery({ emitTool: true, emitStream: true, answer: OK, usage: { m: { inputTokens: 1_000_000, outputTokens: 1_000_000 } } }) as never,
    });
    const rates = ratesFor("https://api.deepseek.com/anthropic", "deepseek-v4-flash")!;
    const r = await smokeTestEndpoint({ apiKey: "k", baseUrl: "https://api.deepseek.com/anthropic", model: "deepseek-v4-flash", rates });
    expect(r.costUsd).toBeCloseTo(0.44 + 1.32, 6);
  });
});
