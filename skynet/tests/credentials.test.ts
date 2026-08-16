// Provider credentials: a provider can have several named keys ("Claude — personal",
// "Claude for Business"). The DEFAULT credential's id IS the provider (back-compat),
// named ones get their own id + key; resolution is by credential id.
process.env.SKYNET_MASTER_KEY = Buffer.alloc(32, 9).toString("base64");

import { describe, it, expect, beforeEach } from "vitest";
import { SecretService, UnknownCredentialError } from "../apps/server/src/secrets/service.js";
import { MemorySecretStore } from "../apps/server/src/secrets/memory.js";

describe("provider credentials", () => {
  let svc: SecretService;
  beforeEach(() => {
    svc = new SecretService(new MemorySecretStore());
  });

  it("default credential: id === provider, resolves its key, marked isDefault", async () => {
    await svc.setKey("w", "claude", "sk-default", "op", 1);
    expect(await svc.resolve("w", "claude")).toBe("sk-default");
    const list = await svc.list("w");
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ id: "claude", provider: "claude", isDefault: true, last4: "ault" });
  });

  it("a named credential resolves its own key, independent of the default", async () => {
    await svc.setKey("w", "claude", "sk-default", "op", 1);
    const meta = await svc.createCredential("w", "claude", "Claude for Business", "sk-biz", "op", 2);
    expect(meta).toMatchObject({ provider: "claude", name: "Claude for Business", isDefault: false });
    expect(meta.id).not.toBe("claude");
    expect(await svc.resolve("w", meta.id)).toBe("sk-biz");
    expect(await svc.resolve("w", "claude")).toBe("sk-default"); // default untouched
    expect((await svc.list("w")).length).toBe(2);
  });

  it("env fallback applies to the DEFAULT credential only", async () => {
    process.env.OPENAI_API_KEY = "env-codex";
    try {
      // default (id === provider) → ambient env when nothing is stored
      expect(await svc.resolve("w", "codex")).toBe("env-codex");
      // a named credential without a stored key does NOT fall back to env
      expect(await svc.resolve("w", "cred-codex-xyz")).toBeUndefined();
    } finally {
      delete process.env.OPENAI_API_KEY;
    }
  });

  it("rotating a named credential preserves its provider + name", async () => {
    const meta = await svc.createCredential("w", "gemini", "Team Gemini", "g1", "op", 1);
    await svc.setKey("w", meta.id, "g2", "op", 2);
    expect(await svc.resolve("w", meta.id)).toBe("g2");
    expect((await svc.list("w")).find((m) => m.id === meta.id)).toMatchObject({
      provider: "gemini",
      name: "Team Gemini",
      isDefault: false,
    });
  });

  it("rejects setting a key for an unknown, non-provider id", async () => {
    await expect(svc.setKey("w", "cred-bogus", "k", "op", 1)).rejects.toBeInstanceOf(UnknownCredentialError);
  });

  // "fly" (a project-pinned Fly.io API token, like "github" a PAT) is NOT a
  // fleet ProviderId — it only ever exists as a NAMED credential via
  // createCredential, same as an additional GitHub account. See
  // apps/web/src/views/integrations.tsx's FlyAccounts / GithubAccounts.
  it("fly: a named credential round-trips through create/resolve/delete", async () => {
    const meta = await svc.createCredential("w", "fly", "Personal", "fo1_abc123", "op", 1);
    expect(meta).toMatchObject({ provider: "fly", name: "Personal", isDefault: false });
    expect(await svc.resolve("w", meta.id)).toBe("fo1_abc123");
    expect((await svc.list("w")).map((m) => m.provider)).toContain("fly");
    await svc.delete("w", meta.id);
    expect(await svc.resolve("w", meta.id)).toBeUndefined();
  });
  it("fly: setting a bare \"fly\" id (no prior named credential) is rejected — it's not a fleet ProviderId default", async () => {
    await expect(svc.setKey("w", "fly", "fo1_x", "op", 1)).rejects.toBeInstanceOf(UnknownCredentialError);
  });
  it("fly and github credentials coexist independently in the same workspace", async () => {
    const fly = await svc.createCredential("w", "fly", "Fly org", "fo1_x", "op", 1);
    const gh = await svc.createCredential("w", "github", "Work GitHub", "ghp_x", "op", 2);
    expect(await svc.resolve("w", fly.id)).toBe("fo1_x");
    expect(await svc.resolve("w", gh.id)).toBe("ghp_x");
    expect((await svc.list("w")).length).toBe(2);
  });

  it("delete removes only the targeted credential", async () => {
    await svc.setKey("w", "claude", "sk-default", "op", 1);
    const biz = await svc.createCredential("w", "claude", "Biz", "sk-biz", "op", 2);
    await svc.delete("w", biz.id);
    expect(await svc.resolve("w", biz.id)).toBeUndefined();
    expect(await svc.resolve("w", "claude")).toBe("sk-default");
  });
});
