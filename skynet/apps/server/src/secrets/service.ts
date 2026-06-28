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

/** Server env var that supplies each provider's key when no stored key exists. */
export const PROVIDER_ENV_VAR: Record<ProviderId, string> = {
  claude: "ANTHROPIC_API_KEY",
  codex: "OPENAI_API_KEY",
  gemini: "GEMINI_API_KEY",
  cursor: "CURSOR_API_KEY",
  copilot: "GITHUB_TOKEN",
};

/** Providers that currently have a key in the server environment (live). */
export function envBackedProviders(): ProviderId[] {
  return (Object.keys(PROVIDER_ENV_VAR) as ProviderId[]).filter(
    (p) => !!process.env[PROVIDER_ENV_VAR[p]],
  );
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
    // Precedence: a stored key (set in Settings) overrides the server env var;
    // the env var is the fallback when no key is stored.
    const key = masterKey();
    if (key) {
      const record = await this.store.get(workspaceId, provider);
      if (record) {
        try {
          return open(record.ciphertext, key);
        } catch {
          // A key IS stored but won't decrypt (tampered, or the master key rotated).
          // Don't silently use a different (env) credential without saying so. We
          // still fall back to env so the agent can run, but the operator must see this.
          console.warn(
            `[secrets] stored ${provider} key for workspace "${workspaceId}" failed to decrypt ` +
              `(wrong/rotated SKYNET_MASTER_KEY?) — falling back to ambient env. Re-set the key.`,
          );
        }
      }
    }
    return process.env[PROVIDER_ENV_VAR[provider]] || undefined;
  }
}

function makeStore(): SecretStore {
  return config.store === "postgres" && config.databaseUrl
    ? new PostgresSecretStore(config.databaseUrl)
    : new MemorySecretStore();
}

/** Process-wide singleton, configured from the environment. */
export const secretService = new SecretService(makeStore());
