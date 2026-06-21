// ─── Auth (minimal, pluggable) ────────────────────────────────────────────
// Maps a bearer token / ?token= to a Principal { workspaceId, operatorId }.
// Phase B ships a small dev token map; SSO and per-workspace credentials land
// later. Enforcement is gated by AUTH_REQUIRED so the dev flow stays open.

import { DEFAULT_WORKSPACE } from "@skynet/shared";
import { config } from "./config.js";

export interface Principal {
  workspaceId: string;
  operatorId: string;
}

// Dev tokens — two workspaces so isolation is demonstrable.
const TOKENS: Record<string, Principal> = {
  "dev-cyberdyne": { workspaceId: DEFAULT_WORKSPACE, operatorId: "jordan" },
  "dev-resistance": { workspaceId: "resistance", operatorId: "kyle" },
};

const DEV_DEFAULT: Principal = { workspaceId: DEFAULT_WORKSPACE, operatorId: "operator" };

/** Extract a token from an Authorization header or a ?token= query value. */
export function tokenFrom(authHeader?: string, queryToken?: string): string | undefined {
  if (queryToken) return queryToken;
  if (authHeader?.startsWith("Bearer ")) return authHeader.slice(7).trim();
  return undefined;
}

/**
 * Resolve a principal. When AUTH_REQUIRED is off, an absent/unknown token falls
 * back to the dev default workspace (keeps the local flow open). When on, only a
 * valid token resolves; otherwise undefined → caller returns 401.
 */
export function resolvePrincipal(token?: string): Principal | undefined {
  if (token && TOKENS[token]) return TOKENS[token];
  if (config.authRequired) return undefined;
  return DEV_DEFAULT;
}
