// ─── Secret service ───────────────────────────────────────────────────────
// Workspace-scoped provider credentials. The ONLY component that sees plaintext:
// it seals on write and opens on read for runner injection. The API layer can
// set/list/delete but never read a key back — list returns metadata only.

import { randomUUID } from "node:crypto";
import { ProviderId, type SecretMeta } from "@skynet/shared";
import { config } from "../config.js";
import { PROVIDER_ENV_VAR, providerEnvCredential } from "../provider-env.js";
import { fingerprint, masterKey, open, seal } from "./crypto.js";
import { MemorySecretStore } from "./memory.js";
import { PostgresSecretStore } from "./postgres.js";
import type { SecretRecord, SecretStore } from "./types.js";

// Re-exported for existing consumers (secrets/index.js).
export { PROVIDER_ENV_VAR };

/** A provider's DEFAULT credential id is the provider string itself — the
 *  historical single-key path, so old keys + agents keep resolving. */
export const isDefaultCredential = (id: string, provider: ProviderId) => id === provider;

export class SecretsDisabledError extends Error {
  constructor() {
    super("Secret store is disabled — set SKYNET_MASTER_KEY (32 bytes, base64) to enable it");
    this.name = "SecretsDisabledError";
  }
}

/** Setting a key for an id that is neither a known provider (default) nor an
 *  existing named credential. 404/400 at the route. */
export class UnknownCredentialError extends Error {
  constructor(id: string) {
    super(`Unknown credential "${id}" — create it first, or use a provider id for the default.`);
    this.name = "UnknownCredentialError";
  }
}

/** Providers with a credential in the server environment (any accepted var). */
export function envBackedProviders(): ProviderId[] {
  return (Object.keys(PROVIDER_ENV_VAR) as ProviderId[]).filter(providerEnvCredential);
}

const toMeta = (r: SecretRecord): SecretMeta => ({
  id: r.id,
  name: r.name,
  workspaceId: r.workspaceId,
  provider: r.provider,
  isDefault: isDefaultCredential(r.id, r.provider),
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

  private sealRecord(workspaceId: string, id: string, name: string, provider: ProviderId, apiKey: string, operatorId: string, at: number): SecretRecord {
    const key = masterKey();
    if (!key) throw new SecretsDisabledError();
    return {
      id,
      name,
      workspaceId,
      provider,
      ciphertext: seal(apiKey, key),
      last4: fingerprint(apiKey),
      updatedAt: at,
      updatedBy: operatorId,
    };
  }

  /** Store/rotate the key for a credential by id. Works for a provider's default
   *  credential (id === provider) and for named credentials (id preserves the
   *  existing provider + name). Returns safe metadata only. */
  async setKey(
    workspaceId: string,
    id: string,
    apiKey: string,
    operatorId: string,
    at: number,
  ): Promise<SecretMeta> {
    const existing = await this.store.get(workspaceId, id);
    const parsed = ProviderId.safeParse(id);
    // A named credential must already exist (created via createCredential); a
    // default is created on first set, its id being the provider.
    if (!existing && !parsed.success) throw new UnknownCredentialError(id);
    const provider = existing?.provider ?? (parsed.data as ProviderId);
    const record = this.sealRecord(workspaceId, id, existing?.name ?? "", provider, apiKey, operatorId, at);
    await this.store.put(record);
    return toMeta(record);
  }

  /** Create a NAMED credential (a "duplicate" of a provider) with its own key. */
  async createCredential(
    workspaceId: string,
    provider: ProviderId,
    name: string,
    apiKey: string,
    operatorId: string,
    at: number,
  ): Promise<SecretMeta> {
    const id = `cred-${provider}-${randomUUID().slice(0, 8)}`;
    const record = this.sealRecord(workspaceId, id, name.trim(), provider, apiKey, operatorId, at);
    await this.store.put(record);
    return toMeta(record);
  }

  /** Metadata for every credential in the workspace (never the keys). */
  async list(workspaceId: string): Promise<SecretMeta[]> {
    return (await this.store.list(workspaceId)).map(toMeta);
  }

  /** Delete a credential by id (default id === provider). */
  async delete(workspaceId: string, id: string): Promise<void> {
    await this.store.delete(workspaceId, id);
  }

  /**
   * Decrypt a credential's key for runner injection, by credential id. A default
   * credential (id === provider) falls back to the ambient provider env var when
   * no key is stored; a named credential does not (it must carry its own key).
   * Returns undefined when disabled/absent/undecryptable. Server-internal only.
   */
  async resolve(workspaceId: string, credentialId: string): Promise<string | undefined> {
    const key = masterKey();
    if (key) {
      const record = await this.store.get(workspaceId, credentialId);
      if (record) {
        try {
          return open(record.ciphertext, key);
        } catch {
          // A key IS stored but won't decrypt (tampered, or the master key rotated).
          // Don't silently use a different (env) credential without saying so. We
          // still fall back to env (for a default) so the agent can run.
          console.warn(
            `[secrets] stored key "${credentialId}" for workspace "${workspaceId}" failed to decrypt ` +
              `(wrong/rotated SKYNET_MASTER_KEY?) — re-set the key.`,
          );
        }
      }
    }
    // Env fallback applies only to a provider's DEFAULT credential (id === provider).
    const parsed = ProviderId.safeParse(credentialId);
    return parsed.success ? process.env[PROVIDER_ENV_VAR[parsed.data]] || undefined : undefined;
  }
}

function makeStore(): SecretStore {
  return config.store === "postgres" && config.databaseUrl
    ? new PostgresSecretStore(config.databaseUrl)
    : new MemorySecretStore();
}

/** Process-wide singleton, configured from the environment. */
export const secretService = new SecretService(makeStore());
