// ─── GitHub integration types ─────────────────────────────────────────────
// The seams the orchestrator talks to. A GitProvider performs the *remote*
// operations (push / PR / merge) authenticated as a GitHub App installation;
// runs never hold credentials, so the safety preflight (safety.ts) cannot be
// bypassed. A GithubConnectionStore persists the per-workspace connection.

import type { GithubConnection, GithubInstallation, GithubRepo, SafetyPolicy } from "@skynet/shared";

/** A single guardrail that failed the preflight. */
export interface SafetyViolation {
  rule: keyof SafetyPolicy | "general";
  message: string;
}

/** Everything the preflight + push need about one integration attempt. */
export interface PushRequest {
  workspaceId: string;
  runId: string;
  repo: string; // "owner/repo"
  branch: string; // the agent branch, e.g. agent/<id>
  baseBranch: string; // PR target (the repo's default branch)
  worktreePath: string; // local worktree to push from
  changedFiles: string[];
  modules: string[]; // modules the changed files map to (from the module map)
  allowedModules: string[]; // the agent's scoped modules ([] = unconstrained)
  force: boolean; // whether this would be a force-push
  title: string;
  body: string;
}

export interface PrRef {
  number: number;
  url: string;
}

export interface PrStatus {
  state: "open" | "closed" | "merged";
  checks: "pending" | "passing" | "failing" | "none";
}

export interface MergeResult {
  merged: boolean;
  reason?: string;
}

/** Outcome of a guarded push+PR attempt. */
export interface PushResult {
  ok: boolean;
  pushed: boolean;
  violations: SafetyViolation[];
  pr?: PrRef;
}

/**
 * The remote git host operations, authenticated per call with a short-lived
 * installation token. Implemented by GitHubProvider; swappable for other hosts.
 */
export interface GitProvider {
  readonly id: string;
  /** Mint (and cache) a short-lived installation access token (App mode). */
  installationToken(installationId: number): Promise<string>;
  /** Validate a token and return the authenticated account (PAT mode). Throws on a bad token. */
  viewer(token: string): Promise<{ login: string }>;
  /** Repos a token can access (PAT mode), as selectable GithubRepo records. */
  listRepos(token: string): Promise<GithubRepo[]>;
  /** App installations the user token can see (broker mode — install picker). */
  listInstallations(token: string): Promise<GithubInstallation[]>;
  /** Repos within one installation the user token can see (broker mode). */
  listInstallationRepos(token: string, installationId: number): Promise<GithubRepo[]>;
  /** Push the agent branch from its worktree to the remote. */
  pushBranch(token: string, repo: string, worktreePath: string, branch: string, force: boolean): Promise<void>;
  cloneRepo(token: string, repo: string, dest: string): Promise<void>;
  openPr(token: string, repo: string, head: string, base: string, title: string, body: string): Promise<PrRef>;
  prStatus(token: string, repo: string, number: number): Promise<PrStatus>;
  mergePr(token: string, repo: string, number: number, method: "merge" | "squash" | "rebase"): Promise<MergeResult>;
  /** Bring the base branch into the agent worktree (keep it current). */
  syncBase(token: string, repo: string, worktreePath: string, baseBranch: string): Promise<void>;
}

/** Persistence seam for the per-workspace GitHub connection (non-secret). */
export interface GithubConnectionStore {
  get(workspaceId: string): Promise<GithubConnection | undefined>;
  put(connection: GithubConnection): Promise<void>;
  delete(workspaceId: string): Promise<void>;
  /** Sealed PAT ciphertext (pat mode). Server-side only; never the plaintext. */
  getToken(workspaceId: string): Promise<string | undefined>;
  putToken(workspaceId: string, ciphertext: string): Promise<void>;
  deleteToken(workspaceId: string): Promise<void>;
}
