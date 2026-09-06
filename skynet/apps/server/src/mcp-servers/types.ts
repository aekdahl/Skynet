// ─── MCP server store types ───────────────────────────────────────────────
// The persistence seam for a workspace's custom MCP server configs — the
// "scoped tools" an operator gives an agent to act back into their own
// services (GitHub/Sentry/Slack/anything speaking MCP). Deliberately separate
// from ../secrets: a SecretRecord is "one bearer token + one endpoint" for a
// known CredentialProvider; an MCP server is a named launch spec (stdio
// command/args/env, or a remote url/headers) that can carry several secrets
// at once. Adapters store only the sealed spec + safe metadata; decryption
// happens in the service, never in the store — same discipline as secrets/.

export type McpServerTransport = "stdio" | "remote";

export interface McpServerRecord {
  id: string;
  workspaceId: string;
  name: string;
  transport: McpServerTransport;
  /** Plaintext — not a secret; the operator must see what's launched/called.
   *  "" for a remote server. */
  command: string;
  /** Plaintext. Empty for a remote server. */
  args: string[];
  /** Plaintext. "" for a stdio server. */
  url: string;
  /** Plaintext key NAMES only (mirrors SecretMeta.last4's "safe to show"
   *  precedent) — the values live nowhere but `specCiphertext`. */
  envKeys: string[];
  headerKeys: string[];
  /** base64(iv|tag|ciphertext) of JSON.stringify({env} | {headers}) — see
   *  ../secrets/crypto.ts's seal(). Sealing just the secret half (not
   *  command/args/url, which are already plaintext above) keeps this store
   *  from needing its own field-by-field envelope scheme. */
  specCiphertext: string;
  updatedAt: number;
  updatedBy: string;
}

/** A workspace's custom-MCP-server store. Pluggable: memory (dev) or Postgres
 *  — same shape as ../secrets/types.ts's SecretStore. Keyed by
 *  (workspaceId, id). */
export interface McpServerStore {
  put(record: McpServerRecord): Promise<void>;
  get(workspaceId: string, id: string): Promise<McpServerRecord | undefined>;
  list(workspaceId: string): Promise<McpServerRecord[]>;
  delete(workspaceId: string, id: string): Promise<void>;
}
