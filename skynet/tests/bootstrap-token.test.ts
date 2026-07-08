// Headless/sandbox deploys (e.g. Daytona) inject a bootstrap secret via env so
// the creating agent can call /mcp without a human login. These guard that the
// secret is registered verbatim, scoped as configured, with invalid scopes
// dropped and approver never granted by accident.
import { describe, it, expect, vi, afterEach } from "vitest";
import { DEFAULT_WORKSPACE } from "@skynet/shared";
import { parseBootstrapScopes } from "../apps/server/src/auth/bootstrap.js";

describe("parseBootstrapScopes", () => {
  it("keeps valid scopes and drops unknown ones", () => {
    expect(parseBootstrapScopes("observe, author , bogus")).toEqual({ scopes: ["observe", "author"], dropped: ["bogus"] });
  });
  it("falls back to a safe default (never approver) when empty/all-invalid", () => {
    expect(parseBootstrapScopes("")).toEqual({ scopes: ["observe", "author"], dropped: [] });
    expect(parseBootstrapScopes("nope").scopes).toEqual(["observe", "author"]);
  });
  it("honours an explicit approver grant", () => {
    expect(parseBootstrapScopes("observe,approver").scopes).toEqual(["observe", "approver"]);
  });
});

describe("seedBootstrapToken (env-driven)", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("registers the env token verbatim so the agent can resolve it", async () => {
    vi.stubEnv("SKYNET_BOOTSTRAP_TOKEN", "skynet_pat_bootstrap_test");
    vi.stubEnv("SKYNET_BOOTSTRAP_SCOPES", "observe,author,bogus");
    vi.resetModules(); // re-read config with the stubbed env
    const { MemoryServiceTokenStore } = await import("../apps/server/src/auth/service-tokens.js");
    const { seedBootstrapToken } = await import("../apps/server/src/auth/bootstrap.js");

    const store = new MemoryServiceTokenStore();
    const result = await seedBootstrapToken(store);
    expect(result).toMatchObject({ scopes: ["observe", "author"], workspaceId: DEFAULT_WORKSPACE, dropped: ["bogus"] });

    // The exact secret the agent injected resolves to a scoped principal.
    const principal = await store.resolve("skynet_pat_bootstrap_test");
    expect(principal).toMatchObject({ operatorId: "mcp:bootstrap", scopes: ["observe", "author"] });
  });

  it("is a no-op when no bootstrap token is configured", async () => {
    vi.resetModules();
    const { MemoryServiceTokenStore } = await import("../apps/server/src/auth/service-tokens.js");
    const { seedBootstrapToken } = await import("../apps/server/src/auth/bootstrap.js");
    expect(await seedBootstrapToken(new MemoryServiceTokenStore())).toBeNull();
  });
});
