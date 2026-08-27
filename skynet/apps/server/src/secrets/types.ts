// ─── Secret store types ───────────────────────────────────────────────────
// The persistence seam for sealed provider keys. Adapters store only ciphertext
// + safe metadata; decryption happens in the service, never in the store.
//
// A record is one CREDENTIAL: a named key for a provider. Keyed by (workspace,
// id). The DEFAULT credential for a provider has `id === provider` — that's the
// historical single key, so existing rows need no migration.

import type { CredentialProvider, SecretAuditEntry } from "@skynet/shared";

// Re-exported so the rest of secrets/* can import it from this local module,
// same convention as CredentialProvider above.
export type { SecretAuditEntry };

export interface SecretRecord {
  /** Credential id an agent references. Equals the provider for the provider's
   *  single "default" credential (back-compat with pre-credential rows). */
  id: string;
  /** Display name for a named credential; "" for the default (→ catalog name). */
  name: string;
  workspaceId: string;
  provider: CredentialProvider;
  /** base64(iv|tag|ciphertext) — see crypto.seal. Never the raw key. */
  ciphertext: string;
  last4: string;
  /** Claude-compatible endpoint this credential talks to (Moonshot, Z.ai, a
   *  LiteLLM proxy, …), or null/undefined for the vendor's own API. Stored in
   *  PLAINTEXT deliberately — it's a routing target, not a secret, and the
   *  operator must be able to see where a runner's traffic is going. */
  baseUrl?: string | null;
  updatedAt: number;
  updatedBy: string;
}

/** A workspace credential store. Pluggable: memory (dev) or Postgres. Keyed by
 *  (workspaceId, credentialId) — the default credential's id is the provider. */
export interface SecretStore {
  put(record: SecretRecord): Promise<void>;
  get(workspaceId: string, id: string): Promise<SecretRecord | undefined>;
  list(workspaceId: string): Promise<SecretRecord[]>;
  delete(workspaceId: string, id: string): Promise<void>;
  recordAudit(entry: SecretAuditEntry): Promise<void>;
  /** Newest first. */
  listAudit(workspaceId: string): Promise<SecretAuditEntry[]>;
}
