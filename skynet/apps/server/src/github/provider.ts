// ─── GitHub App provider ──────────────────────────────────────────────────
// Authenticates as a GitHub App installation and performs the remote git
// operations on the fleet's behalf. Zero external deps: the App JWT is signed
// with node:crypto (RS256), tokens are minted via the REST API with fetch, and
// the branch push uses git-over-HTTPS with the token injected as the credential.
//
// Tokens are short-lived (~1h), minted on demand, cached in memory until just
// before expiry, and never persisted or logged.

import { execFile } from "node:child_process";
import { createSign } from "node:crypto";
import { promisify } from "node:util";
import type { GithubInstallation, GithubRepo } from "@skynet/shared";
import type { GitProvider, MergeResult, PrRef, PrStatus } from "./types.js";
import { gitBin } from "../git-bin.js";

const exec = promisify(execFile);

/** Strip a token from a message (git echoes the authed remote URL on failure),
 *  so a clone/push error can never leak the credential into logs or the UI. */
export function redactToken(msg: string, token: string): string {
  return token ? msg.split(token).join("***") : msg;
}

const b64url = (input: string | Buffer): string => Buffer.from(input).toString("base64url");

interface CachedToken {
  token: string;
  expiresAt: number; // epoch ms
}

export class GitHubProvider implements GitProvider {
  readonly id = "github";
  private tokens = new Map<number, CachedToken>();

  constructor(
    private appId: string,
    private privateKey: string,
    private apiBase: string,
  ) {}

  /** Signed App JWT (10-minute lifetime, 60s back-dated for clock skew). */
  private appJwt(): string {
    const nowSec = Math.floor(Date.now() / 1000);
    const header = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
    const payload = b64url(JSON.stringify({ iat: nowSec - 60, exp: nowSec + 540, iss: this.appId }));
    const signer = createSign("RSA-SHA256");
    signer.update(`${header}.${payload}`);
    const signature = signer.sign(this.privateKey).toString("base64url");
    return `${header}.${payload}.${signature}`;
  }

  private async api<T>(token: string, method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.apiBase}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`GitHub API ${method} ${path} → ${res.status}: ${text.slice(0, 300)}`);
    }
    return (await res.json()) as T;
  }

  async installationToken(installationId: number): Promise<string> {
    const cached = this.tokens.get(installationId);
    // Refresh when within 5 minutes of expiry.
    if (cached && cached.expiresAt - Date.now() > 5 * 60_000) return cached.token;

    const minted = await this.api<{ token: string; expires_at: string }>(
      this.appJwt(),
      "POST",
      `/app/installations/${installationId}/access_tokens`,
    );
    this.tokens.set(installationId, { token: minted.token, expiresAt: Date.parse(minted.expires_at) });
    return minted.token;
  }

  async viewer(token: string): Promise<{ login: string }> {
    return this.api<{ login: string }>(token, "GET", "/user");
  }

  async listRepos(token: string): Promise<GithubRepo[]> {
    const repos = await this.api<Array<{ id: number; full_name: string; default_branch: string; private: boolean }>>(
      token,
      "GET",
      "/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member",
    );
    return repos.map((r) => ({ id: r.id, name: r.full_name, defaultBranch: r.default_branch, private: r.private, selected: false }));
  }

  async listInstallations(token: string): Promise<GithubInstallation[]> {
    const data = await this.api<{ installations: Array<{ id: number; account: { login: string; type: string }; app_slug: string }> }>(
      token,
      "GET",
      "/user/installations?per_page=100",
    );
    return (data.installations ?? []).map((i) => ({
      id: i.id,
      account: i.account.login,
      type: i.account.type === "Organization" ? "Organization" : "User",
      appSlug: i.app_slug,
    }));
  }

  async listInstallationRepos(token: string, installationId: number): Promise<GithubRepo[]> {
    const data = await this.api<{ repositories: Array<{ id: number; full_name: string; default_branch: string; private: boolean }> }>(
      token,
      "GET",
      `/user/installations/${installationId}/repositories?per_page=100`,
    );
    return (data.repositories ?? []).map((r) => ({ id: r.id, name: r.full_name, defaultBranch: r.default_branch, private: r.private, selected: false }));
  }

  async pushBranch(token: string, repo: string, worktreePath: string, branch: string, force: boolean): Promise<void> {
    // Token-authenticated HTTPS remote; the worktree is checked out on `branch`.
    const remote = `https://x-access-token:${token}@github.com/${repo}.git`;
    const args = ["-C", worktreePath, "push", remote, `${branch}:refs/heads/${branch}`];
    if (force) args.push("--force-with-lease");
    await exec(gitBin(), args);
  }

  /** Clone `repo` (owner/name) into `dest` over a token-authenticated HTTPS
   *  remote. Used to bring a GitHub repo down onto a headless server (GCP) so
   *  agents have a local checkout to cut worktrees from. The token is redacted
   *  from any error git surfaces (git echoes the remote URL on failure). */
  async cloneRepo(token: string, repo: string, dest: string): Promise<void> {
    const remote = `https://x-access-token:${token}@github.com/${repo}.git`;
    try {
      await exec(gitBin(), ["clone", "--", remote, dest]);
    } catch (err) {
      const msg = (err as { stderr?: string; message?: string }).stderr || (err as Error).message || String(err);
      throw new Error(redactToken(msg, token));
    }
  }

  async openPr(token: string, repo: string, head: string, base: string, title: string, body: string): Promise<PrRef> {
    const pr = await this.api<{ number: number; html_url: string }>(token, "POST", `/repos/${repo}/pulls`, {
      title,
      head,
      base,
      body,
    });
    return { number: pr.number, url: pr.html_url };
  }

  async prStatus(token: string, repo: string, num: number): Promise<PrStatus> {
    const pr = await this.api<{ state: string; merged: boolean; head: { sha: string } }>(
      token,
      "GET",
      `/repos/${repo}/pulls/${num}`,
    );
    const state: PrStatus["state"] = pr.merged ? "merged" : pr.state === "closed" ? "closed" : "open";

    let checks: PrStatus["checks"] = "none";
    try {
      const runs = await this.api<{ total_count: number; check_runs: { conclusion: string | null }[] }>(
        token,
        "GET",
        `/repos/${repo}/commits/${pr.head.sha}/check-runs`,
      );
      if (runs.total_count > 0) {
        const conclusions = runs.check_runs.map((r) => r.conclusion);
        if (conclusions.some((c) => c === null)) checks = "pending";
        else if (conclusions.some((c) => c !== "success" && c !== "neutral" && c !== "skipped")) checks = "failing";
        else checks = "passing";
      }
    } catch {
      /* checks are best-effort metadata */
    }
    return { state, checks };
  }

  async mergePr(token: string, repo: string, num: number, method: "merge" | "squash" | "rebase"): Promise<MergeResult> {
    try {
      const res = await this.api<{ merged: boolean; message?: string }>(token, "PUT", `/repos/${repo}/pulls/${num}/merge`, {
        merge_method: method,
      });
      return { merged: res.merged, reason: res.message };
    } catch (err) {
      // 405 = blocked by branch protection / required reviews — respected, not bypassed.
      return { merged: false, reason: (err as Error).message };
    }
  }

  async syncBase(token: string, repo: string, worktreePath: string, baseBranch: string): Promise<void> {
    const remote = `https://x-access-token:${token}@github.com/${repo}.git`;
    await exec(gitBin(), ["-C", worktreePath, "fetch", remote, baseBranch]);
    await exec(gitBin(), ["-C", worktreePath, "merge", "--no-edit", "FETCH_HEAD"]);
  }
}
