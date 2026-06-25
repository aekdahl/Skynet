// ─── Secrets module ───────────────────────────────────────────────────────
// Per-workspace provider credentials, encrypted at rest (AES-256-GCM envelope
// under SKYNET_MASTER_KEY) and injected into runners by the orchestrator. The
// raw key is write-only over the API and never logged.

import type { ProviderInfo } from "@skynet/shared";
import { secretService } from "./service.js";

export type { SecretStore, SecretRecord } from "./types.js";
export { SecretService, secretService, SecretsDisabledError } from "./service.js";
export { registerSecretsRoutes } from "./routes.js";

/**
 * A provider is "available" (selectable in create-agent) when its credential is
 * configured — either via server env (baked into p.available at seed) or a key
 * stored for this workspace. Overlay the per-workspace secret state here so the
 * snapshot reflects keys set through Settings.
 */
export async function withSecretAvailability(
  providers: ProviderInfo[],
  workspaceId: string,
): Promise<ProviderInfo[]> {
  const configured = new Set((await secretService.list(workspaceId)).map((m) => m.provider));
  return providers.map((p) => ({ ...p, available: Boolean(p.available) || configured.has(p.id) }));
}
