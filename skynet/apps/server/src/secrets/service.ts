// ─── Secret service ───────────────────────────────────────────────────────
// Workspace-scoped provider credentials. The ONLY component that sees plaintext:
// it seals on write and opens on read for runner injection. The API layer can
// set/list/delete but never read a key back — list returns metadata only.

import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { ProviderId, ratesFor, vendorForBaseUrl, type CredentialProvider, type EndpointSmokeResult, type SecretMeta } from "@skynet/shared";
import { smokeTestEndpoint } from "@skynet/runner-sdk";
import { config } from "../config.js";

// Model used for a smoke test on a credential with no catalogued vendor (i.e.
// Anthropic itself, or a custom endpoint). Cheap on purpose — the probe reads
// one small file, so the smallest model proves as much as the largest.
const DEFAULT_SMOKE_MODEL = "haiku";
import { PROVIDER_ENV_VAR, providerEnvCredential } from "../provider-env.js";
import { fingerprint, masterKey, open, seal } from "./crypto.js";
import { MemorySecretStore } from "./memory.js";
import { FileSecretStore } from "./file.js";
import { PostgresSecretStore } from "./postgres.js";
import type { SecretAuditEntry, SecretRecord, SecretStore } from "./types.js";
import { verifyProviderCredential, type VerifyCredentialResult } from "./verify.js";

// Re-exported for existing consumers (secrets/index.js).
export { PROVIDER_ENV_VAR };

/** A provider's DEFAULT credential id is the provider string itself — the
 *  historical single-key path, so old keys + agents keep resolving. */
export const isDefaultCredential = (id: string, provider: CredentialProvider) => id === provider;

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

/** A credential's endpoint wasn't an absolute http(s) URL. Surfaced as a 400 —
 *  never silently dropped (see normalizeBaseUrl). */
export class InvalidEndpointError extends Error {
  constructor(value: string) {
    super(`"${value}" is not a valid endpoint URL — use an absolute https:// address, or leave it blank for the vendor's own API.`);
    this.name = "InvalidEndpointError";
  }
}

/** Providers with a credential in the server environment (any accepted var). */
export function envBackedProviders(): ProviderId[] {
  return (Object.keys(PROVIDER_ENV_VAR) as ProviderId[]).filter(providerEnvCredential);
}

/**
 * Validate + canonicalise a Claude-compatible endpoint.
 *
 * This value is injected as ANTHROPIC_BASE_URL into a runner subprocess, i.e.
 * it decides where an agent's prompts (and the repo contents they carry) get
 * sent. So it is validated, not trusted: only absolute http(s) URLs, and the
 * trailing slash is dropped so the same endpoint typed two ways is one value.
 * Anything unparseable is rejected loudly rather than silently ignored — a
 * typo'd endpoint that fell back to the vendor would bill the expensive API
 * while the operator believed they were on a cheap one.
 */
export function normalizeBaseUrl(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new InvalidEndpointError(trimmed);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new InvalidEndpointError(trimmed);
  return url.toString().replace(/\/+$/, "");
}

const toMeta = (r: SecretRecord): SecretMeta => ({
  id: r.id,
  name: r.name,
  workspaceId: r.workspaceId,
  provider: r.provider,
  isDefault: isDefaultCredential(r.id, r.provider),
  last4: r.last4,
  baseUrl: r.baseUrl ?? null,
  paused: r.paused ?? null,
  orgOwned: r.orgOwned ?? false,
  updatedAt: r.updatedAt,
  updatedBy: r.updatedBy,
});

export class SecretService {
  constructor(private store: SecretStore) {}

  /** True once a master key is configured (the feature is usable). */
  get enabled(): boolean {
    return masterKey() !== null;
  }

  private sealRecord(workspaceId: string, id: string, name: string, provider: CredentialProvider, apiKey: string, operatorId: string, at: number, baseUrl?: string | null, paused?: SecretRecord["paused"], orgOwned?: boolean): SecretRecord {
    const key = masterKey();
    if (!key) throw new SecretsDisabledError();
    return {
      id,
      name,
      workspaceId,
      provider,
      // Trimmed at the boundary every write goes through, so the stored key,
      // its last4 fingerprint, and what a runner sends are all the same string.
      // Pasted keys routinely carry a trailing newline; storing it makes the
      // displayed fingerprint disagree with the vendor's, which is exactly the
      // clue an operator needs when a key is rejected.
      ciphertext: seal(apiKey.trim(), key),
      last4: fingerprint(apiKey.trim()),
      baseUrl: normalizeBaseUrl(baseUrl),
      paused: paused ?? null,
      // Governance flag never re-derived on rotation (a key rotation isn't a
      // decision about WHO owns it) — defaults false only for a brand-new
      // record, same "never inferred" stance as SecretMeta.orgOwned's own doc.
      orgOwned: orgOwned ?? false,
      updatedAt: at,
      updatedBy: operatorId,
    };
  }

  private async audit(
    record: Pick<SecretRecord, "workspaceId" | "id" | "provider" | "name">,
    action: SecretAuditEntry["action"],
    operatorId: string,
    at: number,
  ): Promise<void> {
    const entry: SecretAuditEntry = {
      id: randomUUID(),
      workspaceId: record.workspaceId,
      credentialId: record.id,
      provider: record.provider,
      label: record.name,
      action,
      operatorId,
      at,
    };
    await this.store.recordAudit(entry);
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
    baseUrl?: string | null,
  ): Promise<SecretMeta> {
    const existing = await this.store.get(workspaceId, id);
    const parsed = ProviderId.safeParse(id);
    // A named credential must already exist (created via createCredential); a
    // default is created on first set, its id being the provider.
    if (!existing && !parsed.success) throw new UnknownCredentialError(id);
    const provider = existing?.provider ?? (parsed.data as ProviderId);
    // `undefined` = a plain key rotation, which must not silently re-point an
    // endpoint-backed credential at the vendor. Explicit `null` clears it.
    const endpoint = baseUrl === undefined ? existing?.baseUrl : baseUrl;
    // A rotation must NOT silently un-pause. If a key was benched because
    // something was wrong with it, replacing the key is a step toward fixing
    // that — not a decision to put it back to work, which stays explicit.
    // Same carry-forward for orgOwned: rotating the key doesn't change who owns it.
    const record = this.sealRecord(workspaceId, id, existing?.name ?? "", provider, apiKey, operatorId, at, endpoint, existing?.paused ?? null, existing?.orgOwned ?? false);
    await this.store.put(record);
    await this.audit(record, existing ? "rotated" : "created", operatorId, at);
    return toMeta(record);
  }

  /** Create a NAMED credential (a "duplicate" of a provider) with its own key. */
  async createCredential(
    workspaceId: string,
    provider: CredentialProvider,
    name: string,
    apiKey: string,
    operatorId: string,
    at: number,
    baseUrl?: string | null,
  ): Promise<SecretMeta> {
    const id = `cred-${provider}-${randomUUID().slice(0, 8)}`;
    const record = this.sealRecord(workspaceId, id, name.trim(), provider, apiKey, operatorId, at, baseUrl);
    await this.store.put(record);
    await this.audit(record, "created", operatorId, at);
    return toMeta(record);
  }

  /** Metadata for every credential in the workspace (never the keys). */
  async list(workspaceId: string): Promise<SecretMeta[]> {
    return (await this.store.list(workspaceId)).map(toMeta);
  }

  /** Lifecycle events (created/rotated/removed) for every credential in the
   *  workspace, newest first — survives past a credential's own deletion. */
  async listAudit(workspaceId: string): Promise<SecretAuditEntry[]> {
    return this.store.listAudit(workspaceId);
  }

  /** Delete a credential by id (default id === provider). */
  async delete(workspaceId: string, id: string, operatorId: string, at: number): Promise<void> {
    const existing = await this.store.get(workspaceId, id);
    await this.store.delete(workspaceId, id);
    if (existing) await this.audit(existing, "removed", operatorId, at);
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

  /**
   * Bench or un-bench a credential.
   *
   * Durable on purpose. The in-memory quota breaker (`depletedKeys` in the
   * orchestrator) is auto-learned and SHOULD evaporate on restart, because the
   * key may have been topped up. A deliberate pause is the opposite: it exists
   * because a human or Steward decided this key must not be used, and a deploy
   * is not a decision to resume.
   *
   * Stopping the runs already on the key is the CALLER's job (see
   * Operations.pauseCredential) — this layer owns the secret, not the fleet.
   */
  async setPaused(
    workspaceId: string,
    credentialId: string,
    paused: { by: string; reason: string } | null,
    at: number,
  ): Promise<SecretMeta> {
    const record = await this.store.get(workspaceId, credentialId);
    if (!record) throw new UnknownCredentialError(credentialId);
    const next: SecretRecord = { ...record, paused: paused ? { at, by: paused.by, reason: paused.reason } : null };
    await this.store.put(next);
    await this.audit(next, paused ? "paused" : "resumed", paused?.by ?? "operator", at);
    return toMeta(next);
  }

  /** Is this credential benched? Consulted on every assignment decision, so it
   *  reads through the store rather than a cache that could go stale mid-run. */
  async isPaused(workspaceId: string, credentialId: string): Promise<boolean> {
    const record = await this.store.get(workspaceId, credentialId);
    return !!record?.paused;
  }

  /** Set the org-owned governance flag (see SecretMeta.orgOwned) — an
   *  operator's explicit correction, never auto-detected. Audited like every
   *  other credential lifecycle change. */
  async setOrgOwned(workspaceId: string, credentialId: string, orgOwned: boolean, operatorId: string, at: number): Promise<SecretMeta> {
    const record = await this.store.get(workspaceId, credentialId);
    if (!record) throw new UnknownCredentialError(credentialId);
    const next: SecretRecord = { ...record, orgOwned };
    await this.store.put(next);
    await this.audit(next, "org-owned-changed", operatorId, at);
    return toMeta(next);
  }

  /**
   * Run ONE tiny real task on this credential and report what the endpoint's
   * compatibility layer actually did — see smokeTestEndpoint.
   *
   * Picks a default model from the catalog when the caller doesn't name one, so
   * the operator isn't asked to guess a model id before they've used the vendor.
   */
  async smokeTest(workspaceId: string, credentialId: string, model?: string): Promise<EndpointSmokeResult> {
    const record = await this.store.get(workspaceId, credentialId);
    const parsed = ProviderId.safeParse(credentialId);
    if (!record && !parsed.success) throw new UnknownCredentialError(credentialId);
    const apiKey = await this.resolve(workspaceId, credentialId);
    const baseUrl = await this.resolveEndpoint(workspaceId, credentialId);
    const vendor = vendorForBaseUrl(baseUrl);
    const chosen = model?.trim() || vendor?.models[0]?.id || DEFAULT_SMOKE_MODEL;
    return smokeTestEndpoint({ apiKey, baseUrl, model: chosen, rates: ratesFor(baseUrl, chosen) });
  }

  /**
   * The Claude-compatible endpoint a credential points at, or undefined for the
   * vendor's own API. Deliberately separate from {@link resolve}: the key is a
   * secret and the endpoint is not, and every caller needs both independently.
   */
  async resolveEndpoint(workspaceId: string, credentialId: string): Promise<string | undefined> {
    const record = await this.store.get(workspaceId, credentialId);
    return record?.baseUrl || undefined;
  }

  /**
   * Live-verify a credential's key against its vendor — the same key
   * `resolve` would hand a runner (stored key, else an env fallback for a
   * default credential). Never throws for a bad/unreachable key, only for an
   * id that names neither a stored credential nor a known provider.
   */
  async verify(workspaceId: string, id: string): Promise<VerifyCredentialResult> {
    const record = await this.store.get(workspaceId, id);
    const parsed = ProviderId.safeParse(id);
    if (!record && !parsed.success) throw new UnknownCredentialError(id);
    const provider: CredentialProvider = record?.provider ?? (parsed.data as ProviderId);
    const apiKey = await this.resolve(workspaceId, id);
    if (!apiKey) return { ok: false, message: "No key is set for this credential (and no environment fallback)." };
    // Verify against the endpoint this credential actually talks to — see
    // verifyProviderCredential.
    const baseUrl = await this.resolveEndpoint(workspaceId, id);
    return verifyProviderCredential(provider, apiKey, baseUrl);
  }
}

function makeStore(): SecretStore {
  if (config.store === "postgres" && config.databaseUrl) return new PostgresSecretStore(config.databaseUrl);
  // STORE=file: persist credentials durably too, same as everything else the
  // desktop app manages — not just the in-memory (restart-wipes-it) default.
  // Defaults next to the main data file, same convention as
  // complianceKeyPath / the MFA recovery-code file.
  if (config.store === "file") {
    const path = config.secretsPath || join(dirname(config.dbPath), "skynet-secrets.json");
    return FileSecretStore.create(path);
  }
  return new MemorySecretStore();
}

/** Process-wide singleton, configured from the environment. */
export const secretService = new SecretService(makeStore());
