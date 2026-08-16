// Scoped service tokens back MCP / programmatic access. A token resolves to a
// workspace-scoped Principal carrying an explicit scope set; the raw secret is
// exposed only at creation, and it flows through the same auth resolution humans
// use — so workspace isolation holds for automated callers too.
import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_WORKSPACE } from "@skynet/shared";
import { configureAuth, hasScope, resolvePrincipal, type Principal } from "../apps/server/src/auth.js";
import { MemoryServiceTokenStore, StoreServiceTokenStore } from "../apps/server/src/auth/service-tokens.js";
import { FileStore } from "../apps/server/src/store/file.js";

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

describe("project-scoped tokens", () => {
  it("carries a project allowlist onto the principal and the metadata", async () => {
    const store = new MemoryServiceTokenStore();
    const created = await store.create({
      workspaceId: DEFAULT_WORKSPACE, operatorId: "mcp:proj", scopes: ["observe", "author"],
      label: "proj", projectIds: ["p-1", "p-2"],
    });
    // The confinement rides the principal, so every scope-check site sees it.
    expect(await store.resolve(created.token)).toEqual({
      workspaceId: DEFAULT_WORKSPACE, operatorId: "mcp:proj", scopes: ["observe", "author"], projectIds: ["p-1", "p-2"],
    });
    // And surfaces in the non-secret listing for the UI.
    expect((await store.list(DEFAULT_WORKSPACE))[0]).toMatchObject({ projectIds: ["p-1", "p-2"] });
  });

  it("an empty / omitted allowlist means workspace-wide (no projectIds on the principal)", async () => {
    const store = new MemoryServiceTokenStore();
    const wide = await store.create({ workspaceId: DEFAULT_WORKSPACE, operatorId: "mcp:wide", scopes: ["observe"], label: "wide", projectIds: [] });
    const principal = await store.resolve(wide.token);
    expect(principal).not.toHaveProperty("projectIds"); // undefined = all projects
    expect((await store.list(DEFAULT_WORKSPACE))[0]).toMatchObject({ projectIds: [] });
  });

  it("survives the durable round-trip (hash-only store)", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "skynet-tok-")), "db.json");
    const fs = FileStore.create(path);
    const minted = await new StoreServiceTokenStore(fs).create({
      workspaceId: DEFAULT_WORKSPACE, operatorId: "mcp:proj", scopes: ["author"], label: "proj", projectIds: ["p-9"],
    });
    fs.flush();
    const reopened = new StoreServiceTokenStore(FileStore.create(path));
    expect(await reopened.resolve(minted.token)).toMatchObject({ projectIds: ["p-9"] });
    expect((await reopened.list(DEFAULT_WORKSPACE))[0]).toMatchObject({ projectIds: ["p-9"] });
  });
});

describe("durable service-token store (Store-backed, hash-only)", () => {
  const tmpDb = () => join(mkdtempSync(join(tmpdir(), "skynet-tok-")), "db.json");
  const base = { workspaceId: DEFAULT_WORKSPACE, operatorId: "mcp:research", scopes: ["observe", "author"] as const, label: "research" };

  it("survives a restart — a token minted before reload still resolves", async () => {
    const path = tmpDb();
    const fs = FileStore.create(path);
    const minted = await new StoreServiceTokenStore(fs).create({ ...base });
    expect(minted.token.startsWith("skynet_pat_")).toBe(true);
    fs.flush(); // FileStore debounces writes ~150ms; a real restart is seconds later — force it now.

    // A fresh FileStore from the same file is exactly what a restarted process does.
    const reopened = new StoreServiceTokenStore(FileStore.create(path));
    expect(await reopened.resolve(minted.token)).toEqual({
      workspaceId: DEFAULT_WORKSPACE, operatorId: "mcp:research", scopes: ["observe", "author"],
    });
    const list = await reopened.list(DEFAULT_WORKSPACE);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: minted.id, last4: minted.token.slice(-4) });
    expect(await reopened.revoke(minted.id)).toBe(true);
    expect(await reopened.resolve(minted.token)).toBeUndefined();
  });

  it("never writes the raw token to disk — only a hash + last4", async () => {
    const path = tmpDb();
    const fs = FileStore.create(path);
    const minted = await new StoreServiceTokenStore(fs).create({ ...base });
    fs.flush();
    const onDisk = readFileSync(path, "utf8");
    expect(onDisk).not.toContain(minted.token); // the raw secret must NOT be persisted
    expect(onDisk).toContain(minted.token.slice(-4)); // last4 fingerprint is fine
  });

  it("honors an expiry across the durable path", async () => {
    const store = new StoreServiceTokenStore(FileStore.create(tmpDb()));
    const minted = await store.create({ ...base, ttlMs: -1 }); // already expired
    expect(await store.resolve(minted.token)).toBeUndefined();
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
    configureAuth({
      sessions: {
        create: async () => { throw new Error("unused"); },
        resolve: async () => undefined,
        destroy: async () => {},
        elevate: async () => undefined,
      },
      serviceTokens,
    });
    const created = await serviceTokens.create({ workspaceId: "resistance", operatorId: "mcp:x", scopes: ["approver"], label: "x" });

    const principal = await resolvePrincipal(created.token);
    expect(principal).toEqual({ workspaceId: "resistance", operatorId: "mcp:x", scopes: ["approver"] });
  });
});
