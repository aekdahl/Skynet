// ─── Secrets module ───────────────────────────────────────────────────────
// Per-workspace provider credentials, encrypted at rest (AES-256-GCM envelope
// under SKYNET_MASTER_KEY) and injected into runners by the orchestrator. The
// raw key is write-only over the API and never logged.

export type { SecretStore, SecretRecord } from "./types.js";
export { SecretService, secretService, SecretsDisabledError } from "./service.js";
export { registerSecretsRoutes } from "./routes.js";
