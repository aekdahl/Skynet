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
  /** The project's pinned GitHub account (a `github` credential id), or null/absent
   *  for the workspace's default connection. */
  githubCredentialId?: string | null;
}

export interface PrRef {
  number: number;
  url: string;
}

export interface PrStatus {
  state: "open" | "closed" | "merged";
  checks: "pending" | "passing" | "failing" | "none";
  // GitHub's mergeability verdict for the head against its base. `false` = a
  // textual conflict (base moved under the PR); `null` = GitHub is still
  // computing it (retry shortly). Distinguishes a conflict from a policy block.
  mergeable: boolean | null;
  // Per-check-run breakdown behind `checks` — one entry per named CI job
  // (e.g. "lint", "typecheck", "test"), so a reviewer sees which gate actually
  // failed instead of just the aggregate verdict. [] when the repo has none.
  runs: { name: string; state: "pass" | "fail" | "pending" }[];
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
  /** Org logins the token's user belongs to (owner picker for new repos). */
  listOrgs(token: string): Promise<string[]>;
  /** Create a new repo under the user or an org; returns it as a GithubRepo. */
  createRepo(
    token: string,
    spec: { name: string; private: boolean; description?: string; org?: string },
  ): Promise<GithubRepo>;
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
  /** Open issues on a repo (for importing them as tasks). Excludes PRs. */
  listIssues(token: string, repo: string): Promise<GithubIssue[]>;
  /** Add a comment to an issue. */
  commentIssue(token: string, repo: string, number: number, body: string): Promise<void>;
  /** Open or close an issue (write-back on task status change). */
  setIssueState(token: string, repo: string, number: number, state: "open" | "closed"): Promise<void>;
  /** Every label currently on an issue (names only), so a caller can preserve
   *  the ones it doesn't own before replacing the set. */
  getIssueLabels(token: string, repo: string, number: number): Promise<string[]>;
  /** An issue's current open/closed state + labels — unlike listIssues (open
   *  issues only), this also reaches a closed one. Manual re-sync's reconcile
   *  pass needs this to detect drift regardless of which way it went. */
  getIssue(token: string, repo: string, number: number): Promise<{ state: "open" | "closed"; labels: string[] }>;
  /** Replace an issue's ENTIRE label set (GitHub's replace-all semantics). */
  setIssueLabels(token: string, repo: string, number: number, labels: string[]): Promise<void>;
  /** Read a file's decoded text + blob sha (the sha is needed to commit an update).
   *  Returns null if the file/repo is absent. */
  getFile(token: string, repo: string, path: string): Promise<{ content: string; sha: string } | null>;
  /** Commit an updated file (single-file commit via the Contents API). `sha` is
   *  the blob sha from getFile — GitHub rejects a stale sha, so edits are safe.
   *  `attribution` (TASK 28's roadmap-proposal apply path only — every other
   *  caller omits it) sets the commit's author to a real operator identity and
   *  appends a `Co-authored-by:` trailer for the proposing agent. */
  putFile(token: string, repo: string, path: string, content: string, sha: string, message: string, attribution?: GitCommitAttribution): Promise<void>;
}

/** See GitProvider.putFile's own doc comment. Deliberately NOT the same type
 *  as local-repo-write.ts's `CommitAttribution` — same shape, but the two
 *  files own their write paths independently (Contents-API vs local git). */
export interface GitCommitAttribution {
  authorName: string;
  authorEmail: string;
  coAuthor?: { name: string; email: string };
}

/** A GitHub issue, trimmed to what task import needs. */
export interface GithubIssue {
  number: number;
  title: string;
  body: string;
  url: string; // html_url
  state: "open" | "closed";
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
