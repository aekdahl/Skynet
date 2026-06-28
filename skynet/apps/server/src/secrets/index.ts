// ─── Secrets module ───────────────────────────────────────────────────────
// Per-workspace provider credentials, encrypted at rest (AES-256-GCM envelope
// under SKYNET_MASTER_KEY) and injected into runners by the orchestrator. The
// raw key is write-only over the API and never logged.

import type { ProviderInfo } from "@skynet/shared";
import { secretService, envBackedProviders } from "./service.js";

export type { SecretStore, SecretRecord } from "./types.js";
export { SecretService, secretService, SecretsDisabledError, envBackedProviders, PROVIDER_ENV_VAR } from "./service.js";
export { registerSecretsRoutes } from "./routes.js";

/**
 * A provider is "available" (selectable in create-agent) when its credential is
 * configured — either a key stored for this workspace OR a server env var.
 * Overlay this per-workspace state so the snapshot reflects keys set in Settings.
 */
export async function withSecretAvailability(
  providers: ProviderInfo[],
  workspaceId: string,
): Promise<ProviderInfo[]> {
  const configured = new Set((await secretService.list(workspaceId)).map((m) => m.provider));
  const env = new Set(envBackedProviders());
  return providers.map((p) => ({ ...p, available: configured.has(p.id) || env.has(p.id) }));
}
