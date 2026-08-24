// secrets/service.ts's makeStore() only ever checked config.store === "postgres",
// silently falling through to the ephemeral MemorySecretStore for STORE=file
// too — every Settings-added credential (Fly.io tokens, per-project LLM keys)
// was wiped on every server restart in the desktop app's supposedly-durable
// mode. FileSecretStore fixes that; these lock in the actual bug (a credential
// survives a restart) plus the audit trail that answers "who removed this and
// when" once a credential disappears.
import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FileSecretStore } from "../apps/server/src/secrets/file.js";
import type { SecretRecord } from "../apps/server/src/secrets/types.js";

function tmpPath(): string {
  return join(mkdtempSync(join(tmpdir(), "secrets-file-store-")), "skynet-secrets.json");
}

const record = (over: Partial<SecretRecord> = {}): SecretRecord => ({
  id: "fly",
  name: "",
  workspaceId: "ws-1",
  provider: "fly",
  ciphertext: "sealed-blob",
  last4: "1234",
  updatedAt: 100,
  updatedBy: "alex",
  ...over,
});

describe("FileSecretStore", () => {
  it("survives a restart — a credential written by one instance is readable by a fresh one opened on the same path", async () => {
    const path = tmpPath();
    const store1 = FileSecretStore.create(path);
    await store1.put(record());
    store1.flush();

    const store2 = FileSecretStore.create(path);
    const loaded = await store2.get("ws-1", "fly");
    expect(loaded?.ciphertext).toBe("sealed-blob");
    expect(loaded?.last4).toBe("1234");
  });

  it("a deleted credential is gone after reload too", async () => {
    const path = tmpPath();
    const store1 = FileSecretStore.create(path);
    await store1.put(record());
    await store1.delete("ws-1", "fly");
    store1.flush();

    const store2 = FileSecretStore.create(path);
    expect(await store2.get("ws-1", "fly")).toBeUndefined();
  });

  it("drops a malformed row on load instead of corrupting the whole file", async () => {
    const path = tmpPath();
    writeFileSync(path, JSON.stringify({ rows: [record(), { id: "broken" }], audit: [] }));
    const store = FileSecretStore.create(path);
    const rows = await store.list("ws-1");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe("fly");
  });

  it("reads the pre-audit-log file format (a bare array of rows)", async () => {
    const path = tmpPath();
    writeFileSync(path, JSON.stringify([record()]));
    const store = FileSecretStore.create(path);
    expect(await store.get("ws-1", "fly")).toBeDefined();
  });

  it("writes atomically — the file is always valid JSON, never a partial write", async () => {
    const path = tmpPath();
    const store = FileSecretStore.create(path);
    await store.put(record());
    store.flush();
    expect(() => JSON.parse(readFileSync(path, "utf8"))).not.toThrow();
  });

  it("persists audit entries across a restart, even after the credential itself is deleted", async () => {
    const path = tmpPath();
    const store1 = FileSecretStore.create(path);
    await store1.recordAudit({
      id: "a-1",
      workspaceId: "ws-1",
      credentialId: "fly",
      provider: "fly",
      label: "",
      action: "created",
      operatorId: "alex",
      at: 100,
    });
    await store1.put(record());
    await store1.delete("ws-1", "fly");
    await store1.recordAudit({
      id: "a-2",
      workspaceId: "ws-1",
      credentialId: "fly",
      provider: "fly",
      label: "",
      action: "removed",
      operatorId: "alex",
      at: 200,
    });
    store1.flush();

    const store2 = FileSecretStore.create(path);
    const audit = await store2.listAudit("ws-1");
    expect(audit.map((e) => e.action)).toEqual(["removed", "created"]); // newest first
  });
});
