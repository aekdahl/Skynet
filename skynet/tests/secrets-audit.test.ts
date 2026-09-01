// Credential audit trail: every add/rotate/remove is recorded (operator +
// timestamp, never the key itself) so "why did Fly.io suddenly show not
// connected" has an answer even after the credential row itself is gone.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { randomBytes } from "node:crypto";
import { SecretService } from "../apps/server/src/secrets/service.js";
import { MemorySecretStore } from "../apps/server/src/secrets/memory.js";

describe("SecretService audit trail", () => {
  const masterKey = randomBytes(32).toString("base64");
  let prevKey: string | undefined;
  let service: SecretService;

  beforeEach(() => {
    prevKey = process.env.SKYNET_MASTER_KEY;
    process.env.SKYNET_MASTER_KEY = masterKey;
    service = new SecretService(new MemorySecretStore());
  });
  afterEach(() => {
    if (prevKey === undefined) delete process.env.SKYNET_MASTER_KEY;
    else process.env.SKYNET_MASTER_KEY = prevKey;
  });

  // "claude" is a real ProviderId, so setKey can create its DEFAULT
  // credential (id === provider) from scratch — "fly"/"github" can't (they're
  // CredentialProvider-only), so those go through createCredential below.
  it("records a 'created' entry the first time a default credential's key is set", async () => {
    await service.setKey("ws-1", "claude", "sk-ant-abc", "alex", 100);
    const audit = await service.listAudit("ws-1");
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ action: "created", credentialId: "claude", provider: "claude", operatorId: "alex", at: 100 });
  });

  it("records a 'rotated' entry (not 'created') when a key is replaced", async () => {
    await service.setKey("ws-1", "claude", "sk-ant-abc", "alex", 100);
    await service.setKey("ws-1", "claude", "sk-ant-def", "sam", 200);
    const audit = await service.listAudit("ws-1");
    expect(audit).toHaveLength(2);
    expect(audit[0]).toMatchObject({ action: "rotated", operatorId: "sam", at: 200 }); // newest first
    expect(audit[1]).toMatchObject({ action: "created", operatorId: "alex", at: 100 });
  });

  it("records a 'removed' entry on delete, which survives after the credential itself is gone", async () => {
    await service.setKey("ws-1", "claude", "sk-ant-abc", "alex", 100);
    await service.delete("ws-1", "claude", "alex", 300);

    expect(await service.list("ws-1")).toHaveLength(0);
    const audit = await service.listAudit("ws-1");
    expect(audit[0]).toMatchObject({ action: "removed", credentialId: "claude", operatorId: "alex", at: 300 });
  });

  it("never records a delete for a credential id that never existed", async () => {
    await service.delete("ws-1", "claude", "alex", 100);
    expect(await service.listAudit("ws-1")).toHaveLength(0);
  });

  it("records a 'created' entry for a named credential", async () => {
    const meta = await service.createCredential("ws-1", "fly", "Work org", "fo1_work", "alex", 100);
    const audit = await service.listAudit("ws-1");
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ action: "created", credentialId: meta.id, label: "Work org" });
  });

  it("audit entries never carry the plaintext key or ciphertext", async () => {
    await service.setKey("ws-1", "claude", "sk-ant-super-secret-token", "alex", 100);
    const audit = await service.listAudit("ws-1");
    const serialized = JSON.stringify(audit);
    expect(serialized).not.toContain("sk-ant-super-secret-token");
    expect(audit[0]).not.toHaveProperty("ciphertext");
  });

  it("scopes audit entries to their workspace", async () => {
    await service.setKey("ws-1", "claude", "sk-ant-a", "alex", 100);
    await service.setKey("ws-2", "claude", "sk-ant-b", "sam", 100);
    expect(await service.listAudit("ws-1")).toHaveLength(1);
    expect(await service.listAudit("ws-2")).toHaveLength(1);
  });
});

// Keys & Budget panel (TASK 20) — the org-owned governance flag. Never
// inferred: no credential-provisioning path in this codebase hands Skynet a
// key without the operator typing/pasting it, so every credential defaults
// to NOT org-owned, and the operator corrects it explicitly when it IS a
// shared/company key.
describe("SecretService orgOwned", () => {
  const masterKey = randomBytes(32).toString("base64");
  let prevKey: string | undefined;
  let service: SecretService;

  beforeEach(() => {
    prevKey = process.env.SKYNET_MASTER_KEY;
    process.env.SKYNET_MASTER_KEY = masterKey;
    service = new SecretService(new MemorySecretStore());
  });
  afterEach(() => {
    if (prevKey === undefined) delete process.env.SKYNET_MASTER_KEY;
    else process.env.SKYNET_MASTER_KEY = prevKey;
  });

  it("defaults false on a brand-new default credential AND a named one", async () => {
    const def = await service.setKey("ws-1", "claude", "sk-ant-a", "alex", 100);
    expect(def.orgOwned).toBe(false);
    const named = await service.createCredential("ws-1", "claude", "second acct", "sk-ant-b", "alex", 100);
    expect(named.orgOwned).toBe(false);
  });

  it("can be set true, comes back true on a fresh list, and is recorded in the audit trail", async () => {
    await service.setKey("ws-1", "claude", "sk-ant-a", "alex", 100);
    const updated = await service.setOrgOwned("ws-1", "claude", true, "sam", 200);
    expect(updated.orgOwned).toBe(true);
    expect((await service.list("ws-1"))[0]!.orgOwned).toBe(true);
    const audit = await service.listAudit("ws-1");
    expect(audit[0]).toMatchObject({ action: "org-owned-changed", credentialId: "claude", operatorId: "sam", at: 200 });
  });

  it("rotating the key does NOT reset orgOwned — a rotation isn't a decision about who owns it", async () => {
    await service.setKey("ws-1", "claude", "sk-ant-a", "alex", 100);
    await service.setOrgOwned("ws-1", "claude", true, "alex", 150);
    const rotated = await service.setKey("ws-1", "claude", "sk-ant-NEW", "alex", 200);
    expect(rotated.orgOwned).toBe(true);
  });

  it("throws for an unknown credential id", async () => {
    await expect(service.setOrgOwned("ws-1", "claude", true, "alex", 100)).rejects.toThrow();
  });
});
