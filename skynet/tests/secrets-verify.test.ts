// Live credential verify — Guided Provider Connect's missing half: a stored
// key is no longer just "present", it's actually tried against the vendor.
// These lock in per-provider endpoint routing and message extraction on both
// the ok and failing paths, without ever hitting a real vendor.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { verifyProviderCredential } from "../apps/server/src/secrets/verify.js";

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

function mockResponse(ok: boolean, body: unknown): void {
  fetchMock.mockResolvedValue({
    ok,
    status: ok ? 200 : 401,
    statusText: "Unauthorized",
    text: async () => JSON.stringify(body),
  } as unknown as Response);
}

describe("verifyProviderCredential", () => {
  it("claude — a good key hits Anthropic's models endpoint and reports ok", async () => {
    mockResponse(true, { data: [] });
    const result = await verifyProviderCredential("claude", "sk-ant-good");
    expect(result.ok).toBe(true);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.anthropic.com/v1/models");
    expect((init as RequestInit).headers).toMatchObject({ "x-api-key": "sk-ant-good", "anthropic-version": "2023-06-01" });
  });

  it("claude — surfaces Anthropic's OWN error message, not a generic failure", async () => {
    mockResponse(false, { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } });
    const result = await verifyProviderCredential("claude", "sk-ant-bad");
    expect(result.ok).toBe(false);
    expect(result.message).toBe("invalid x-api-key");
  });

  it("codex — routes to OpenAI's models endpoint with a Bearer key", async () => {
    mockResponse(false, { error: { message: "Incorrect API key provided: fake.", type: "invalid_request_error" } });
    const result = await verifyProviderCredential("codex", "fake");
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/incorrect api key/i);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.openai.com/v1/models");
    expect((init as RequestInit).headers).toMatchObject({ authorization: "Bearer fake" });
  });

  it("gemini — routes to the Generative Language API via the x-goog-api-key header", async () => {
    mockResponse(true, { models: [] });
    await verifyProviderCredential("gemini", "good-key");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://generativelanguage.googleapis.com/v1beta/models");
    expect((init as RequestInit).headers).toMatchObject({ "x-goog-api-key": "good-key" });
  });

  it("hermes — routes to OpenRouter's key-info endpoint", async () => {
    mockResponse(false, { error: { message: "User not found.", code: 401 } });
    const result = await verifyProviderCredential("hermes", "fake");
    expect(result.message).toBe("User not found.");
    const [url] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://openrouter.ai/api/v1/auth/key");
  });

  it("cursor — routes to Cursor's account endpoint, a CLI-login vendor verified by its own key shape", async () => {
    mockResponse(false, { code: "error", message: "Invalid User API Key" });
    const result = await verifyProviderCredential("cursor", "fake");
    expect(result.message).toBe("Invalid User API Key");
    const [url] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.cursor.com/v0/me");
  });

  it("copilot and github — both are GitHub tokens, so both verify against the same GitHub user endpoint", async () => {
    mockResponse(false, { message: "Bad credentials" });
    const copilot = await verifyProviderCredential("copilot", "fake");
    const github = await verifyProviderCredential("github", "fake");
    expect(copilot.message).toBe("Bad credentials");
    expect(github.message).toBe("Bad credentials");
    for (const [url, init] of fetchMock.mock.calls) {
      expect(url).toBe("https://api.github.com/user");
      expect((init as RequestInit).headers).toMatchObject({ authorization: "Bearer fake" });
    }
  });

  it("fly — a good token hits the GraphQL viewer query and reports ok with the account email", async () => {
    mockResponse(true, { data: { viewer: { email: "ops@acme.dev" } } });
    const result = await verifyProviderCredential("fly", "fo1_good");
    expect(result.ok).toBe(true);
    expect(result.message).toMatch(/ops@acme\.dev/);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.fly.io/graphql");
    const req = init as RequestInit;
    expect(req.method).toBe("POST");
    expect(req.headers).toMatchObject({ authorization: "Bearer fo1_good" });
    expect(JSON.parse(req.body as string)).toEqual({ query: "{ viewer { email } }" });
  });

  it("fly — a rejected token surfaces GraphQL's own error, not a generic failure", async () => {
    mockResponse(true, { errors: [{ message: "Unauthorized" }] });
    const result = await verifyProviderCredential("fly", "fo1_bad");
    expect(result.ok).toBe(false);
    expect(result.message).toBe("Unauthorized");
  });

  it("fly — a non-200 (bad token) surfaces the HTTP status", async () => {
    mockResponse(false, {});
    const result = await verifyProviderCredential("fly", "fo1_bad");
    expect(result.ok).toBe(false);
    expect(result.message).toBe("401 Unauthorized");
  });

  it("opencode — verified the same way as claude (its stored key is injected as ANTHROPIC_API_KEY)", async () => {
    mockResponse(false, { type: "error", error: { type: "authentication_error", message: "invalid x-api-key" } });
    const result = await verifyProviderCredential("opencode", "sk-ant-bad");
    expect(result.ok).toBe(false);
    expect(result.message).toBe("invalid x-api-key");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.anthropic.com/v1/models");
    expect((init as RequestInit).headers).toMatchObject({ "x-api-key": "sk-ant-bad" });
  });

  it("kimi — a bad key hits Moonshot's OpenAI-compatible models endpoint (real captured error shape)", async () => {
    mockResponse(false, { error: { message: "Invalid Authentication", type: "invalid_authentication_error" } });
    const result = await verifyProviderCredential("kimi", "sk-moonshot-bad");
    expect(result.ok).toBe(false);
    expect(result.message).toBe("Invalid Authentication");
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.moonshot.ai/v1/models");
    expect((init as RequestInit).headers).toMatchObject({ authorization: "Bearer sk-moonshot-bad" });
  });

  it("never throws on a network failure — comes back as {ok:false, message}", async () => {
    fetchMock.mockRejectedValue(new Error("getaddrinfo ENOTFOUND"));
    const result = await verifyProviderCredential("claude", "sk-ant-x");
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/ENOTFOUND/);
  });

  it("falls back to the HTTP status when the vendor's error body isn't JSON", async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, statusText: "Internal Server Error", text: async () => "<html>oops</html>" } as unknown as Response);
    const result = await verifyProviderCredential("claude", "sk-ant-x");
    expect(result.ok).toBe(false);
    expect(result.message).toBe("500 Internal Server Error");
  });
});
