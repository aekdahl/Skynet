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
import type { GitProvider, GithubIssue, MergeResult, PrRef, PrStatus } from "./types.js";
import { gitBin } from "../git-bin.js";

const exec = promisify(execFile);

/** Strip a token from a message (git echoes the authed remote URL on failure),
 *  so a clone/push error can never leak the credential into logs or the UI. */
export function redactToken(msg: string, token: string): string {
  return token ? msg.split(token).join("***") : msg;
}

const b64url = (input: string | Buffer): string => Buffer.from(input).toString("base64url");

/** The `rel="next"` URL from a GitHub `Link` header (`<url>; rel="next", …`),
 *  or null on the last page. GitHub is the source of truth for the next page —
 *  more robust than guessing `page+1` (it stops exactly when there's no more). */
export function parseNextLink(header: string | null): string | null {
  if (!header) return null;
  for (const part of header.split(",")) {
    const m = part.match(/<([^>]+)>\s*;\s*rel="next"/);
    if (m) return m[1]!;
  }
  return null;
}

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

  /**
   * GET every page of a paginated GitHub list endpoint, following the
   * `Link: rel="next"` header until the last page — so a workspace with more than
   * one page of repos/installations gets ALL of them, not just the first 100.
   * `pick` selects the array out of each page's body (identity for the array
   * endpoints; a selector for the wrapped ones like `{ repositories: [...] }`).
   * Bounded by a hard page cap so a pathological account can't loop unbounded.
   */
  private async paginate<T>(token: string, path: string, pick: (body: unknown) => T[]): Promise<T[]> {
    const out: T[] = [];
    // The `next` URL is absolute (GitHub returns a full href); page 1 is relative.
    let url: string | null = `${this.apiBase}${path}`;
    for (let page = 0; page < 50 && url; page++) {
      const res = await fetch(url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`GitHub API GET ${path} → ${res.status}: ${text.slice(0, 300)}`);
      }
      out.push(...pick(await res.json()));
      url = parseNextLink(res.headers.get("link"));
    }
    return out;
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
    // Paginated — a user with >100 repos would otherwise silently lose everything
    // past the first page (and `sort=updated` made the LEAST-recent ones vanish).
    const repos = await this.paginate<{ id: number; full_name: string; default_branch: string; private: boolean }>(
      token,
      "/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member",
      (b) => b as Array<{ id: number; full_name: string; default_branch: string; private: boolean }>,
    );
    return repos.map((r) => ({ id: r.id, name: r.full_name, defaultBranch: r.default_branch, private: r.private, selected: false }));
  }

  /** Orgs the token's user belongs to (login only). PAT/user-token path; an App
   *  installation token can't list a user's orgs and will throw (caller catches). */
  async listOrgs(token: string): Promise<string[]> {
    const orgs = await this.paginate<{ login: string }>(token, "/user/orgs?per_page=100", (b) => b as Array<{ login: string }>);
    return orgs.map((o) => o.login);
  }

  /** Create a new repo under the user (`org` omitted) or an org, initialized with
   *  a README so it has a default branch to clone. Returns it as a GithubRepo. */
  async createRepo(
    token: string,
    spec: { name: string; private: boolean; description?: string; org?: string },
  ): Promise<GithubRepo> {
    const path = spec.org ? `/orgs/${spec.org}/repos` : "/user/repos";
    const r = await this.api<{ id: number; full_name: string; default_branch: string; private: boolean }>(
      token,
      "POST",
      path,
      { name: spec.name, private: spec.private, description: spec.description, auto_init: true },
    );
    return { id: r.id, name: r.full_name, defaultBranch: r.default_branch, private: r.private, selected: true };
  }

  async listIssues(token: string, repo: string): Promise<GithubIssue[]> {
    // GitHub's /issues returns PRs too — they carry a `pull_request` key. Drop
    // them so import brings in real issues only. Paginated.
    type Raw = { number: number; title: string; body: string | null; html_url: string; state: string; pull_request?: unknown };
    const raw = await this.paginate<Raw>(token, `/repos/${repo}/issues?state=open&per_page=100`, (b) => b as Raw[]);
    return raw
      .filter((i) => !i.pull_request)
      .map((i) => ({ number: i.number, title: i.title, body: i.body ?? "", url: i.html_url, state: i.state === "closed" ? "closed" : "open" }));
  }

  async commentIssue(token: string, repo: string, number: number, body: string): Promise<void> {
    await this.api(token, "POST", `/repos/${repo}/issues/${number}/comments`, { body });
  }

  async setIssueState(token: string, repo: string, number: number, state: "open" | "closed"): Promise<void> {
    await this.api(token, "PATCH", `/repos/${repo}/issues/${number}`, { state });
  }

  async getIssueLabels(token: string, repo: string, number: number): Promise<string[]> {
    const issue = await this.api<{ labels: Array<string | { name: string }> }>(token, "GET", `/repos/${repo}/issues/${number}`);
    return issue.labels.map((l) => (typeof l === "string" ? l : l.name));
  }

  // Manual re-sync's reconcile pass needs an issue's CURRENT open/closed state —
  // listIssues only ever returns open ones (?state=open), so a closed issue is
  // otherwise invisible to it. Piggybacks the same single-issue GET as
  // getIssueLabels rather than duplicating it as a second call.
  async getIssue(token: string, repo: string, number: number): Promise<{ state: "open" | "closed"; labels: string[] }> {
    const issue = await this.api<{ state: string; labels: Array<string | { name: string }> }>(
      token,
      "GET",
      `/repos/${repo}/issues/${number}`,
    );
    return {
      state: issue.state === "closed" ? "closed" : "open",
      labels: issue.labels.map((l) => (typeof l === "string" ? l : l.name)),
    };
  }

  async setIssueLabels(token: string, repo: string, number: number, labels: string[]): Promise<void> {
    // Replace-all — GitHub auto-creates any label name that doesn't exist yet
    // on the repo, so no separate label-creation call is needed.
    await this.api(token, "PUT", `/repos/${repo}/issues/${number}/labels`, { labels });
  }

  async getFile(token: string, repo: string, path: string): Promise<{ content: string; sha: string } | null> {
    try {
      const r = await this.api<{ content?: string; encoding?: string; sha: string }>(
        token,
        "GET",
        `/repos/${repo}/contents/${path.replace(/^\/+/, "")}`,
      );
      const content = r.encoding === "base64" && r.content ? Buffer.from(r.content, "base64").toString("utf8") : r.content ?? "";
      return { content, sha: r.sha };
    } catch {
      return null; // absent file/repo/dir
    }
  }

  async putFile(token: string, repo: string, path: string, content: string, sha: string, message: string): Promise<void> {
    await this.api(token, "PUT", `/repos/${repo}/contents/${path.replace(/^\/+/, "")}`, {
      message,
      content: Buffer.from(content, "utf8").toString("base64"),
      sha,
    });
  }

  async listInstallations(token: string): Promise<GithubInstallation[]> {
    type Inst = { id: number; account: { login: string; type: string }; app_slug: string };
    const insts = await this.paginate<Inst>(
      token,
      "/user/installations?per_page=100",
      (b) => (b as { installations?: Inst[] }).installations ?? [],
    );
    return insts.map((i) => ({
      id: i.id,
      account: i.account.login,
      type: i.account.type === "Organization" ? "Organization" : "User",
      appSlug: i.app_slug,
    }));
  }

  async listInstallationRepos(token: string, installationId: number): Promise<GithubRepo[]> {
    type Repo = { id: number; full_name: string; default_branch: string; private: boolean };
    const repos = await this.paginate<Repo>(
      token,
      `/user/installations/${installationId}/repositories?per_page=100`,
      (b) => (b as { repositories?: Repo[] }).repositories ?? [],
    );
    return repos.map((r) => ({ id: r.id, name: r.full_name, defaultBranch: r.default_branch, private: r.private, selected: false }));
  }

  // Redacts the token from any error git surfaces (git echoes the authed
  // remote URL — and Node's execFile puts the full command line, token
  // included, into the thrown error's message/cmd on failure) since this
  // error propagates into the run log, which is both persisted and
  // broadcast live to the operator's UI.
  async pushBranch(token: string, repo: string, worktreePath: string, branch: string, force: boolean): Promise<void> {
    // Token-authenticated HTTPS remote; the worktree is checked out on `branch`.
    const remote = `https://x-access-token:${token}@github.com/${repo}.git`;
    const args = ["-C", worktreePath, "push", remote, `${branch}:refs/heads/${branch}`];
    if (force) args.push("--force-with-lease");
    try {
      await exec(gitBin(), args);
    } catch (err) {
      const msg = (err as { stderr?: string; message?: string }).stderr || (err as Error).message || String(err);
      throw new Error(redactToken(msg, token));
    }
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
    try {
      const pr = await this.api<{ number: number; html_url: string }>(token, "POST", `/repos/${repo}/pulls`, {
        title,
        head,
        base,
        body,
      });
      return { number: pr.number, url: pr.html_url };
    } catch (err) {
      // An open PR for this head branch may already exist — e.g. a "rework"
      // re-push updates the same branch, and GitHub 422s a duplicate open. Reuse
      // the existing PR instead of failing, so the ready-to-merge record refreshes.
      const owner = repo.split("/")[0];
      const existing = await this.api<Array<{ number: number; html_url: string }>>(
        token,
        "GET",
        `/repos/${repo}/pulls?head=${encodeURIComponent(`${owner}:${head}`)}&state=open`,
      ).catch(() => [] as Array<{ number: number; html_url: string }>);
      if (existing.length) return { number: existing[0]!.number, url: existing[0]!.html_url };
      throw err;
    }
  }

  async prStatus(token: string, repo: string, num: number): Promise<PrStatus> {
    const pr = await this.api<{ state: string; merged: boolean; mergeable: boolean | null; head: { sha: string } }>(
      token,
      "GET",
      `/repos/${repo}/pulls/${num}`,
    );
    const state: PrStatus["state"] = pr.merged ? "merged" : pr.state === "closed" ? "closed" : "open";
    const mergeable = pr.mergeable ?? null;

    let checks: PrStatus["checks"] = "none";
    let runs: PrStatus["runs"] = [];
    try {
      const res = await this.api<{ total_count: number; check_runs: { name: string; conclusion: string | null }[] }>(
        token,
        "GET",
        `/repos/${repo}/commits/${pr.head.sha}/check-runs`,
      );
      if (res.total_count > 0) {
        runs = res.check_runs.map((r) => ({
          name: r.name,
          state: r.conclusion === null ? "pending" : r.conclusion === "success" || r.conclusion === "neutral" || r.conclusion === "skipped" ? "pass" : "fail",
        }));
        if (runs.some((r) => r.state === "pending")) checks = "pending";
        else if (runs.some((r) => r.state === "fail")) checks = "failing";
        else checks = "passing";
      }
    } catch {
      /* checks are best-effort metadata */
    }
    return { state, checks, mergeable, runs };
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
    try {
      await exec(gitBin(), ["-C", worktreePath, "fetch", remote, baseBranch]);
      await exec(gitBin(), ["-C", worktreePath, "merge", "--no-edit", "FETCH_HEAD"]);
    } catch (err) {
      const msg = (err as { stderr?: string; message?: string }).stderr || (err as Error).message || String(err);
      throw new Error(redactToken(msg, token));
    }
  }
}
