// A credential's endpoint has to survive a key ROTATION. Losing it would
// silently re-point a runner from a cheap Claude-compatible endpoint back to
// Anthropic's own API — the operator rotates a key and starts paying vendor
// prices with nothing in the UI to explain it.
process.env.SKYNET_MASTER_KEY = Buffer.alloc(32, 7).toString("base64");

import { describe, it, expect, beforeEach } from "vitest";
import { SecretService, InvalidEndpointError } from "../apps/server/src/secrets/service.js";
import { MemorySecretStore } from "../apps/server/src/secrets/memory.js";

const WS = "cyberdyne";
const OP = "jordan";

describe("credential endpoints", () => {
  let svc: SecretService;
  beforeEach(() => {
    svc = new SecretService(new MemorySecretStore());
  });

  it("stores and resolves the endpoint separately from the key", async () => {
    await svc.setKey(WS, "claude", "sk-moonshot", OP, 1, "https://api.moonshot.ai/anthropic");
    expect(await svc.resolve(WS, "claude")).toBe("sk-moonshot");
    expect(await svc.resolveEndpoint(WS, "claude")).toBe("https://api.moonshot.ai/anthropic");
  });

  it("a plain key rotation KEEPS the endpoint", async () => {
    await svc.setKey(WS, "claude", "sk-old", OP, 1, "https://api.moonshot.ai/anthropic");
    await svc.setKey(WS, "claude", "sk-new", OP, 2); // no baseUrl argument at all
    expect(await svc.resolve(WS, "claude")).toBe("sk-new");
    expect(await svc.resolveEndpoint(WS, "claude")).toBe("https://api.moonshot.ai/anthropic");
  });

  it("an explicit null clears it back to the vendor's own API", async () => {
    await svc.setKey(WS, "claude", "sk-a", OP, 1, "https://api.moonshot.ai/anthropic");
    await svc.setKey(WS, "claude", "sk-b", OP, 2, null);
    expect(await svc.resolveEndpoint(WS, "claude")).toBeUndefined();
  });

  it("exposes the endpoint in metadata — it's routing, not a secret", async () => {
    await svc.setKey(WS, "claude", "sk-a", OP, 1, "https://api.z.ai/api/anthropic");
    const [meta] = await svc.list(WS);
    expect(meta!.baseUrl).toBe("https://api.z.ai/api/anthropic");
    expect(JSON.stringify(meta)).not.toContain("sk-a"); // …but the key still isn't
  });

  it("a named credential carries its own endpoint, independent of the default", async () => {
    // The mixed-fleet case: one workspace, Anthropic on the default credential
    // and a cheap endpoint on a second one, runners pinned to either.
    await svc.setKey(WS, "claude", "sk-ant", OP, 1);
    const cheap = await svc.createCredential(WS, "claude", "kimi", "sk-kimi", OP, 2, "https://api.moonshot.ai/anthropic");
    expect(await svc.resolveEndpoint(WS, "claude")).toBeUndefined();
    expect(await svc.resolveEndpoint(WS, cheap.id)).toBe("https://api.moonshot.ai/anthropic");
    expect(await svc.resolve(WS, cheap.id)).toBe("sk-kimi");
  });

  it("refuses to store a malformed endpoint", async () => {
    await expect(svc.setKey(WS, "claude", "sk-a", OP, 1, "moonshot.ai")).rejects.toThrow(InvalidEndpointError);
  });

  it("reports no endpoint for a credential that was never given one", async () => {
    await svc.setKey(WS, "claude", "sk-a", OP, 1);
    expect(await svc.resolveEndpoint(WS, "claude")).toBeUndefined();
    expect(await svc.resolveEndpoint(WS, "nonexistent")).toBeUndefined();
  });
});
