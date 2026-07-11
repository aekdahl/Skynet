// ─── MCP bootstrap token ──────────────────────────────────────────────────
// Headless / sandbox deploys (e.g. a Daytona sandbox an agent spins up) have no
// human to log in and mint a token. Instead the creating agent injects a strong
// random secret via SKYNET_BOOTSTRAP_TOKEN; at boot we register it as a scoped
// service token, so the agent can immediately call /mcp with it. Opt-in only —
// unset means no bootstrap token exists and tokens are minted solely via the UI.

import { DEFAULT_WORKSPACE } from "@skynet/shared";
import { config } from "../config.js";
import { SCOPES, type Scope } from "../auth.js";
import type { ServiceTokenStore } from "./service-tokens.js";

export interface BootstrapResult {
  scopes: Scope[];
  workspaceId: string;
  dropped: string[]; // scope strings that were ignored as invalid
}

/** Parse a comma-separated scope list, dropping unknown values. */
export function parseBootstrapScopes(raw: string): { scopes: Scope[]; dropped: string[] } {
  const valid = new Set<string>(SCOPES);
  const scopes: Scope[] = [];
  const dropped: string[] = [];
  for (const part of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
    if (valid.has(part)) scopes.push(part as Scope);
    else dropped.push(part);
  }
  // Fall back to a safe default (never approver) if nothing valid was given.
  return { scopes: scopes.length > 0 ? scopes : ["observe", "author"], dropped };
}

/**
 * Register the env-provided bootstrap token, if any. Returns null when no
 * bootstrap token is configured, else the scopes/workspace it was granted (for
 * a log line — the secret itself is never logged).
 */
export async function seedBootstrapToken(store: ServiceTokenStore): Promise<BootstrapResult | null> {
  const token = config.mcpBootstrapToken;
  if (!token) return null;
  const { scopes, dropped } = parseBootstrapScopes(config.mcpBootstrapScopes);
  const workspaceId = config.mcpBootstrapWorkspace || DEFAULT_WORKSPACE;
  await store.create({ token, workspaceId, operatorId: "mcp:bootstrap", scopes, label: "bootstrap", ttlMs: null });
  return { scopes, workspaceId, dropped };
}
