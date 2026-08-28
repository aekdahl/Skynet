// What a runner on a Claude-compatible endpoint actually authenticates with.
// Live symptom that prompted this: DeepSeek returning
//   "401 Authentication Fails, Your api key: ****f81f is invalid"
// on a credential whose key was fine.
process.env.SKYNET_MASTER_KEY = Buffer.alloc(32, 11).toString("base64");

import { describe, it, expect, beforeEach } from "vitest";
import { applyCredential } from "../packages/runner-sdk/src/claude.js";
import { SecretService } from "../apps/server/src/secrets/service.js";
import { MemorySecretStore } from "../apps/server/src/secrets/memory.js";

const ENDPOINT = "https://api.deepseek.com/anthropic";

describe("no Anthropic credential ever reaches a third-party endpoint", () => {
  it("strips CLAUDE_CODE_OAUTH_TOKEN, which OUTRANKS the gateway token", () => {
    // buildRunnerEnv deliberately preserves this one — it's a real standalone
    // credential. But on a host with a `claude setup-token` subscription, a run
    // pointed at DeepSeek would authenticate with the Anthropic SUBSCRIPTION
    // token: the wrong vendor receives the operator's personal token, and the
    // run 401s citing a key that was never the problem.
    const env = applyCredential(
      { PATH: "/bin", CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-PERSONAL" },
      { apiKey: "sk-deepseek", baseUrl: ENDPOINT },
    );
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    expect(Object.values(env)).not.toContain("sk-ant-oat-PERSONAL");
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("sk-deepseek");
  });

  it("strips both Anthropic credentials at once", () => {
    const env = applyCredential(
      { ANTHROPIC_API_KEY: "sk-ant-key", CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat" },
      { apiKey: "sk-vendor", baseUrl: ENDPOINT },
    );
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  });

  it("leaves a subscription token alone when talking to Anthropic itself", () => {
    // Only a THIRD-PARTY endpoint makes it a leak. With no baseUrl there's
    // nothing to protect against, and stripping it would break subscription auth.
    const env = applyCredential({ CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat" }, { apiKey: "sk-ant" });
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe("sk-ant-oat");
  });
});

describe("a pasted key's trailing whitespace", () => {
  it("never rides into the Authorization header", () => {
    // `Bearer sk-…\n` is malformed, and the vendor rejects it as an invalid
    // key — an error that points the operator at a key which is actually fine.
    const env = applyCredential({}, { apiKey: "sk-deepseek-abc\n", baseUrl: ENDPOINT });
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe("sk-deepseek-abc");
  });

  it("is trimmed on the Anthropic path too", () => {
    expect(applyCredential({}, { apiKey: "  sk-ant-abc  " }).ANTHROPIC_API_KEY).toBe("sk-ant-abc");
  });

  it("treats a whitespace-only key as no key at all", () => {
    const base = { PATH: "/bin" };
    expect(applyCredential(base, { apiKey: "   ", baseUrl: ENDPOINT })).toEqual(base);
  });
});

describe("the stored fingerprint matches what the vendor sees", () => {
  let svc: SecretService;
  beforeEach(() => {
    svc = new SecretService(new MemorySecretStore());
  });

  it("trims before sealing, so last4 is the key the vendor actually gets", async () => {
    // The whole diagnostic value of last4 is comparing it against the vendor's
    // own "your api key: ****f81f" — which is worthless if we fingerprint a
    // string with a newline on the end that we then send differently.
    const meta = await svc.setKey("ws", "claude", "sk-deepseek-f81f\n", "op", 1);
    expect(meta.last4).toBe("f81f");
    expect(await svc.resolve("ws", "claude")).toBe("sk-deepseek-f81f");
  });
});
