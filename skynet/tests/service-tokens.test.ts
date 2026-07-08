// Scoped service tokens back MCP / programmatic access. A token resolves to a
// workspace-scoped Principal carrying an explicit scope set; the raw secret is
// exposed only at creation, and it flows through the same auth resolution humans
// use — so workspace isolation holds for automated callers too.
import { describe, it, expect } from "vitest";
import { DEFAULT_WORKSPACE } from "@skynet/shared";
import { configureAuth, hasScope, resolvePrincipal, type Principal } from "../apps/server/src/auth.js";
import { MemoryServiceTokenStore } from "../apps/server/src/auth/service-tokens.js";

describe("service-token store", () => {
  it("mints a scoped principal and resolves the token back to it", async () => {
    const store = new MemoryServiceTokenStore();
    const created = await store.create({
      workspaceId: DEFAULT_WORKSPACE,
      operatorId: "mcp:research-agent",
      scopes: ["observe", "author"],
      label: "research-agent",
    });
    expect(created.token.startsWith("skynet_pat_")).toBe(true);

    const principal = await store.resolve(created.token);
    expect(principal).toEqual({
      workspaceId: DEFAULT_WORKSPACE,
      operatorId: "mcp:research-agent",
      scopes: ["observe", "author"],
    });
  });

  it("list returns non-secret metadata only (never the raw token)", async () => {
    const store = new MemoryServiceTokenStore();
    const created = await store.create({
      workspaceId: DEFAULT_WORKSPACE, operatorId: "mcp:a", scopes: ["observe"], label: "a",
    });
    const metas = await store.list(DEFAULT_WORKSPACE);
    expect(metas).toHaveLength(1);
    expect(metas[0]).toMatchObject({ id: created.id, label: "a", scopes: ["observe"], last4: created.token.slice(-4) });
    expect(JSON.stringify(metas)).not.toContain(created.token); // secret never leaks
  });

  it("scopes list to the token's own workspace", async () => {
    const store = new MemoryServiceTokenStore();
    await store.create({ workspaceId: DEFAULT_WORKSPACE, operatorId: "mcp:a", scopes: ["observe"], label: "a" });
    await store.create({ workspaceId: "resistance", operatorId: "mcp:b", scopes: ["observe"], label: "b" });
    expect(await store.list(DEFAULT_WORKSPACE)).toHaveLength(1);
    expect(await store.list("resistance")).toHaveLength(1);
  });

  it("revokes by id; a revoked or unknown token no longer resolves", async () => {
    const store = new MemoryServiceTokenStore();
    const created = await store.create({ workspaceId: DEFAULT_WORKSPACE, operatorId: "mcp:a", scopes: ["author"], label: "a" });
    expect(await store.revoke(created.id)).toBe(true);
    expect(await store.resolve(created.token)).toBeUndefined();
    expect(await store.revoke(created.id)).toBe(false); // already gone
    expect(await store.resolve("skynet_pat_nope")).toBeUndefined();
  });

  it("an expired token resolves to undefined (swept on access)", async () => {
    const store = new MemoryServiceTokenStore();
    const created = await store.create({
      workspaceId: DEFAULT_WORKSPACE, operatorId: "mcp:a", scopes: ["author"], label: "a", ttlMs: -1,
    });
    expect(await store.resolve(created.token)).toBeUndefined();
  });
});

describe("scope authority", () => {
  it("a human principal (no scopes) has full authority; a token is narrowed", () => {
    const human: Principal = { workspaceId: DEFAULT_WORKSPACE, operatorId: "jordan" };
    expect(hasScope(human, "approver")).toBe(true);
    expect(hasScope(human, "admin")).toBe(true);

    const authorToken: Principal = { workspaceId: DEFAULT_WORKSPACE, operatorId: "mcp:a", scopes: ["observe", "author"] };
    expect(hasScope(authorToken, "author")).toBe(true);
    expect(hasScope(authorToken, "approver")).toBe(false); // cannot resolve HITL
  });
});

describe("auth resolution wires in service tokens", () => {
  it("resolvePrincipal falls through to a service token after sessions", async () => {
    const serviceTokens = new MemoryServiceTokenStore();
    // AUTH_REQUIRED defaults off in test env, so pass sessions too to prove the
    // service-token path (not the dev open-default) is what resolves the token.
    configureAuth({ sessions: { create: async () => { throw new Error("unused"); }, resolve: async () => undefined, destroy: async () => {} }, serviceTokens });
    const created = await serviceTokens.create({ workspaceId: "resistance", operatorId: "mcp:x", scopes: ["approver"], label: "x" });

    const principal = await resolvePrincipal(created.token);
    expect(principal).toEqual({ workspaceId: "resistance", operatorId: "mcp:x", scopes: ["approver"] });
  });
});
