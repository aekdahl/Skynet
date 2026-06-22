// ─── Secret service ───────────────────────────────────────────────────────
// Workspace-scoped provider credentials. The ONLY component that sees plaintext:
// it seals on write and opens on read for runner injection. The API layer can
// set/list/delete but never read a key back — list returns metadata only.

import type { ProviderId, SecretMeta } from "@skynet/shared";
import { config } from "../config.js";
import { fingerprint, masterKey, open, seal } from "./crypto.js";
import { MemorySecretStore } from "./memory.js";
import { PostgresSecretStore } from "./postgres.js";
import type { SecretRecord, SecretStore } from "./types.js";

export class SecretsDisabledError extends Error {
  constructor() {
    super("Secret store is disabled — set SKYNET_MASTER_KEY (32 bytes, base64) to enable it");
    this.name = "SecretsDisabledError";
  }
}

const toMeta = (r: SecretRecord): SecretMeta => ({
  workspaceId: r.workspaceId,
  provider: r.provider,
  last4: r.last4,
  updatedAt: r.updatedAt,
  updatedBy: r.updatedBy,
});

export class SecretService {
  constructor(private store: SecretStore) {}

  /** True once a master key is configured (the feature is usable). */
  get enabled(): boolean {
    return masterKey() !== null;
  }

  /** Store/rotate a workspace's provider key. Returns safe metadata only. */
  async set(
    workspaceId: string,
    provider: ProviderId,
    apiKey: string,
    operatorId: string,
    at: number,
  ): Promise<SecretMeta> {
    const key = masterKey();
    if (!key) throw new SecretsDisabledError();
    const record: SecretRecord = {
      workspaceId,
      provider,
      ciphertext: seal(apiKey, key),
      last4: fingerprint(apiKey),
      updatedAt: at,
      updatedBy: operatorId,
    };
    await this.store.put(record);
    return toMeta(record);
  }

  /** Metadata for every provider key in the workspace (never the keys). */
  async list(workspaceId: string): Promise<SecretMeta[]> {
    return (await this.store.list(workspaceId)).map(toMeta);
  }

  async delete(workspaceId: string, provider: ProviderId): Promise<void> {
    await this.store.delete(workspaceId, provider);
  }

  /**
   * Decrypt a workspace's provider key for runner injection. Returns undefined
   * when disabled, absent, or undecryptable — callers fall back to ambient env.
   * Server-internal only; never expose the result over the wire.
   */
  async resolve(workspaceId: string, provider: ProviderId): Promise<string | undefined> {
    const key = masterKey();
    if (!key) return undefined;
    const record = await this.store.get(workspaceId, provider);
    if (!record) return undefined;
    try {
      return open(record.ciphertext, key);
    } catch {
      return undefined; // tampered or wrong master key — fail closed to env
    }
  }
}

function makeStore(): SecretStore {
  return config.store === "postgres" && config.databaseUrl
    ? new PostgresSecretStore(config.databaseUrl)
    : new MemorySecretStore();
}

/** Process-wide singleton, configured from the environment. */
export const secretService = new SecretService(makeStore());
