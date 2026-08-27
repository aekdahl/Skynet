// Phase 1 of alternative-provider support: a credential can name a
// Claude-COMPATIBLE endpoint (Moonshot/Kimi, Z.ai/GLM, MiniMax, a proxy), and
// the Claude runner talks to it instead of api.anthropic.com.
//
// Why route a cheap model through the Agent SDK rather than writing a new
// adapter: the SDK path is the ONLY one with the full agent loop — canUseTool
// gating, question/plan/escalation HITL, resume-with-guidance, per-model cost
// metering. Every CLI-backed runner (hermes.ts says so outright: "there is no
// live HITL gate here") is second-class. Swapping the endpoint keeps the whole
// harness and changes only who bills the tokens.
import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ClaudeRunnerProvider,
  applyCredential,
  __setClaudeTestHooks,
} from "../packages/runner-sdk/src/claude.js";
import { normalizeBaseUrl, InvalidEndpointError } from "../apps/server/src/secrets/service.js";
import type { RunnerEvents } from "../packages/runner-sdk/src/types.js";

describe("applyCredential — the two auth shapes are strictly exclusive", () => {
  it("a plain key authenticates the vendor API", () => {
    const env = applyCredential({ PATH: "/bin" }, { apiKey: "sk-ant-real" });
    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant-real");
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
  });

  it("a credential with an endpoint rides as the gateway bearer token", () => {
    const env = applyCredential({ PATH: "/bin" }, { apiKey: "sk-moonshot", baseUrl: "https://api.moonshot.ai/anthropic" });
    expect(env.ANTHROPIC_BASE_URL).toBe("https://api.moonshot.ai/anthropic");
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("sk-moonshot");
  });

  it("NEVER sends an inherited Anthropic key to a third-party endpoint", () => {
    // The security property. The server's own ANTHROPIC_API_KEY is in the
    // ambient env of every runner; if it survived alongside a third-party
    // ANTHROPIC_BASE_URL, the operator's real Anthropic key would be handed to
    // whoever they pointed the credential at.
    const env = applyCredential(
      { PATH: "/bin", ANTHROPIC_API_KEY: "sk-ant-THE-REAL-ONE" },
      { apiKey: "sk-moonshot", baseUrl: "https://api.moonshot.ai/anthropic" },
    );
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(Object.values(env)).not.toContain("sk-ant-THE-REAL-ONE");
  });

  it("does not let a stale key shadow the endpoint and silently bill the expensive API", () => {
    // ANTHROPIC_API_KEY takes precedence over a gateway (buildRunnerEnv
    // documents the same order), so leaving it set would quietly keep billing
    // Anthropic while the operator believed they'd moved to a cheap endpoint.
    const env = applyCredential({ ANTHROPIC_API_KEY: "sk-ant" }, { apiKey: "sk-cheap", baseUrl: "https://api.z.ai/api/anthropic" });
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("sk-cheap");
  });

  it("leaves the env untouched when there's no credential to apply", () => {
    const base = { PATH: "/bin", ANTHROPIC_API_KEY: "ambient" };
    expect(applyCredential(base, { apiKey: null, baseUrl: "https://x.test" })).toEqual(base);
  });
});

describe("normalizeBaseUrl — an endpoint decides where the repo's contents go", () => {
  it("accepts an absolute https endpoint and drops a trailing slash", () => {
    expect(normalizeBaseUrl("https://api.moonshot.ai/anthropic/")).toBe("https://api.moonshot.ai/anthropic");
  });

  it("treats blank and null alike as 'the vendor's own API'", () => {
    expect(normalizeBaseUrl("")).toBeNull();
    expect(normalizeBaseUrl("   ")).toBeNull();
    expect(normalizeBaseUrl(null)).toBeNull();
    expect(normalizeBaseUrl(undefined)).toBeNull();
  });

  it("rejects a typo rather than silently falling back to the expensive API", () => {
    // Silently ignoring this is the expensive failure: the operator thinks
    // they're on a cheap endpoint and gets billed by Anthropic all month.
    expect(() => normalizeBaseUrl("api.moonshot.ai/anthropic")).toThrow(InvalidEndpointError);
    expect(() => normalizeBaseUrl("not a url")).toThrow(InvalidEndpointError);
  });

  it("rejects a non-http scheme", () => {
    expect(() => normalizeBaseUrl("file:///etc/passwd")).toThrow(InvalidEndpointError);
    expect(() => normalizeBaseUrl("ftp://example.test")).toThrow(InvalidEndpointError);
  });
});

// ─── end-to-end through the runner ─────────────────────────────────────────

function scriptedQuery() {
  const scripts: Array<Array<Record<string, unknown>>> = [];
  const fn = vi.fn(() => {
    const msgs = scripts.shift() ?? [];
    async function* gen() {
      for (const m of msgs) yield m;
    }
    return Object.assign(gen(), { interrupt: async () => undefined });
  });
  return { fn, push: (s: Array<Record<string, unknown>>) => scripts.push(s) };
}

const fakeEvents = () =>
  ({
    onLog: vi.fn(), onProgress: vi.fn(), onHeartbeat: vi.fn(), onStatus: vi.fn(),
    onHitl: vi.fn(), onCompleted: vi.fn(), onFailed: vi.fn(), onChatReply: vi.fn(), onUsage: vi.fn(),
  }) satisfies RunnerEvents;

const sys = { type: "system", session_id: "s1" };
const ok = { type: "result", subtype: "success", is_error: false, num_turns: 1 };
const dirs: string[] = [];
afterEach(() => {
  __setClaudeTestHooks(null);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("the Claude runner honours a credential's endpoint", () => {
  it("hands the SDK subprocess the compatible endpoint, and no Anthropic key", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "skynet-endpoint-"));
    dirs.push(cwd);
    const q = scriptedQuery();
    __setClaudeTestHooks({ query: q.fn as never });
    q.push([sys, ok]);

    await new ClaudeRunnerProvider().start(
      {
        runId: "a1", projectId: "p1", task: "t", model: "kimi-k2", branch: "agent/a1",
        apiKey: "sk-moonshot", baseUrl: "https://api.moonshot.ai/anthropic", cwd,
      },
      fakeEvents(),
    );
    await vi.waitFor(() => expect(q.fn).toHaveBeenCalledTimes(1), { timeout: 2000, interval: 20 });

    const env = (q.fn.mock.calls[0]![0]!.options as { env: Record<string, string> }).env;
    expect(env.ANTHROPIC_BASE_URL).toBe("https://api.moonshot.ai/anthropic");
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("sk-moonshot");
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it("still uses the vendor API when the credential names no endpoint", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "skynet-endpoint-"));
    dirs.push(cwd);
    const q = scriptedQuery();
    __setClaudeTestHooks({ query: q.fn as never });
    q.push([sys, ok]);

    await new ClaudeRunnerProvider().start(
      { runId: "a1", projectId: "p1", task: "t", model: "sonnet-4.6", branch: "agent/a1", apiKey: "sk-ant", cwd },
      fakeEvents(),
    );
    await vi.waitFor(() => expect(q.fn).toHaveBeenCalledTimes(1), { timeout: 2000, interval: 20 });

    const env = (q.fn.mock.calls[0]![0]!.options as { env: Record<string, string> }).env;
    expect(env.ANTHROPIC_API_KEY).toBe("sk-ant");
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
  });

  it("keeps the full agent loop on the cheap endpoint — canUseTool is still installed", async () => {
    // The entire point of Phase 1: a cheaper model does NOT mean a degraded
    // runner. If this ever stops being wired, the gate/HITL machinery is gone
    // and the run silently becomes ungoverned.
    const cwd = mkdtempSync(join(tmpdir(), "skynet-endpoint-"));
    dirs.push(cwd);
    const q = scriptedQuery();
    __setClaudeTestHooks({ query: q.fn as never });
    q.push([sys, ok]);

    await new ClaudeRunnerProvider().start(
      { runId: "a1", projectId: "p1", task: "t", model: "kimi-k2", branch: "agent/a1", apiKey: "k", baseUrl: "https://api.z.ai/api/anthropic", cwd },
      fakeEvents(),
    );
    await vi.waitFor(() => expect(q.fn).toHaveBeenCalledTimes(1), { timeout: 2000, interval: 20 });

    const options = q.fn.mock.calls[0]![0]!.options as { canUseTool?: unknown; maxTurns?: number };
    expect(typeof options.canUseTool).toBe("function");
    expect(options.maxTurns).toBeGreaterThan(0);
  });
});
