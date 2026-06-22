// ─── Secret store types ───────────────────────────────────────────────────
// The persistence seam for sealed provider keys. Adapters store only ciphertext
// + safe metadata; decryption happens in the service, never in the store.

import type { ProviderId } from "@skynet/shared";

export interface SecretRecord {
  workspaceId: string;
  provider: ProviderId;
  /** base64(iv|tag|ciphertext) — see crypto.seal. Never the raw key. */
  ciphertext: string;
  last4: string;
  updatedAt: number;
  updatedBy: string;
}

/** A workspace+provider key store. Pluggable: memory (dev) or Postgres. */
export interface SecretStore {
  put(record: SecretRecord): Promise<void>;
  get(workspaceId: string, provider: ProviderId): Promise<SecretRecord | undefined>;
  list(workspaceId: string): Promise<SecretRecord[]>;
  delete(workspaceId: string, provider: ProviderId): Promise<void>;
}
