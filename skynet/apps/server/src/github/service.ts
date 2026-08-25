// ─── GitHub service ───────────────────────────────────────────────────────
// Owns the per-workspace connection + the guarded push path. The orchestrator
// calls pushAndOpenPr() after an operator approves a diff; the service loads the
// workspace's policy, runs the safety preflight, and only then mints a token and
// performs the remote push + PR. Agents never see any of this.

import { SAFETY_DEFAULTS, type GithubConnection, type GithubInstallation, type GithubOwner, type GithubRepo, type SafetyPolicy } from "@skynet/shared";
import { config } from "../config.js";
import { masterKey, open, seal } from "../secrets/crypto.js";
import { secretService } from "../secrets/index.js";
import { mintViaBroker } from "./broker.js";
import type { Store } from "../store/store.js";
import { MemoryGithubStore } from "./memory.js";
import { GitHubProvider } from "./provider.js";
import { evaluateSafety } from "./safety.js";
import type { GitProvider, GithubConnectionStore, GithubIssue, MergeResult, PrStatus, PushRequest, PushResult } from "./types.js";

export class GithubService {
  constructor(
    private store: GithubConnectionStore,
    private provider: GitProvider,
    /** Whether server-side App credentials exist (gates the App-install flow). */
    private appHasCreds = false,
  ) {}

  /** Swap the persistence backend. Called at bootstrap to back the connection
   *  with the deployment's Store (file for desktop, Postgres for hosted), so it's
   *  durable wherever the rest of the domain state is. */
  useStore(store: GithubConnectionStore): void {
    this.store = store;
  }

  /** True once a GitHub App is configured server-side (the App-install path is
   *  usable). PAT auth needs no App, so it works regardless. */
  get appConfigured(): boolean {
    return this.appHasCreds;
  }

  async get(workspaceId: string): Promise<GithubConnection | undefined> {
    return this.store.get(workspaceId);
  }

  /** Record (or refresh) an App installation + selected repos for a workspace. */
  async connect(workspaceId: string, installation: GithubInstallation, repos: GithubRepo[]): Promise<GithubConnection> {
    const existing = await this.store.get(workspaceId);
    const connection: GithubConnection = {
      workspaceId,
      connected: true,
      auth: "app",
      installation,
      tokenLast4: null,
      repos,
      safety: existing?.safety ?? { ...SAFETY_DEFAULTS },
    };
    await this.store.put(connection);
    return connection;
  }

  /**
   * Connect via a personal access token (the local/desktop path — no App, no
   * cloud). Validates the token against GitHub, seals it server-side, and lists
   * the repos it can access. The plaintext is never persisted or returned.
   */
  async connectViaPat(workspaceId: string, token: string): Promise<GithubConnection> {
    const key = masterKey();
    if (!key) throw new Error("Secret store is disabled — set SKYNET_MASTER_KEY to store a token");
    await this.provider.viewer(token); // validates; throws on a bad/expired token
    const repos = (await this.provider.listRepos(token)).map((r) => ({ ...r, selected: true }));
    await this.store.putToken(workspaceId, seal(token, key));
    const existing = await this.store.get(workspaceId);
    const connection: GithubConnection = {
      workspaceId,
      connected: true,
      auth: "pat",
      installation: null,
      tokenLast4: token.slice(-4),
      repos,
      safety: existing?.safety ?? { ...SAFETY_DEFAULTS },
    };
    await this.store.put(connection);
    return connection;
  }

  /**
   * The repos a project can currently bind to — fetched LIVE, not from the
   * connect-time snapshot, for BOTH auth modes: a stale snapshot otherwise
   * hides repos added to the org/account (or granted to the App installation)
   * after the connection was made — a connection made before the repo list
   * was paginated (or before newer repos existed) shows a permanently stale
   * subset. Falls back to the stored snapshot if the token is unavailable.
   */
  async availableRepos(workspaceId: string): Promise<GithubRepo[]> {
    const conn = await this.store.get(workspaceId);
    if (!conn?.connected) return [];
    if (conn.auth === "pat") {
      const key = masterKey();
      const ct = await this.store.getToken(workspaceId);
      if (!key || !ct) return conn.repos;
      const repos = (await this.provider.listRepos(open(ct, key))).map((r) => ({ ...r, selected: true }));
      await this.store.put({ ...conn, repos });
      return repos;
    }
    // App/broker connection: re-list the installation's repos live, same as the
    // PAT branch above — otherwise this returns the connect-time snapshot
    // forever, silently missing repos added to the org/account (or granted to
    // the installation) afterward. listInstallationRepos returns every repo
    // fresh with selected:false (it has no notion of the user's prior choice);
    // carry each repo's previous `selected` flag forward by id so this stays a
    // pure live-refresh of the SAME list, not a silent re-opt-in of repos the
    // user deliberately left unselected. Falls back to the stored snapshot only
    // if the user token is unavailable/expired (never a hard error — the picker
    // should degrade, not break).
    if (!conn.installation) return conn.repos;
    try {
      const prevSelected = new Map(conn.repos.map((r) => [r.id, r.selected]));
      const repos = (await this.listInstallationRepos(workspaceId, conn.installation.id)).map((r) => ({
        ...r,
        selected: prevSelected.get(r.id) ?? false,
      }));
      await this.store.put({ ...conn, repos });
      return repos;
    } catch {
      return conn.repos;
    }
  }

  /** The git token for a connection: the stored PAT, or a freshly-minted App
   *  installation token. */
  private async resolveToken(conn: GithubConnection): Promise<string> {
    if (conn.auth === "pat") {
      const key = masterKey();
      const ct = await this.store.getToken(conn.workspaceId);
      if (!key || !ct) throw new Error("GitHub token is unavailable");
      return open(ct, key);
    }
    if (!conn.installation) throw new Error("GitHub App installation is missing");
    // Phase 2: with a broker configured (and no local App key), mint remotely
    // from the stored user token (Device Flow). Otherwise mint locally.
    if (config.githubBrokerUrl && !this.appHasCreds) {
      const key = masterKey();
      const ct = await this.store.getToken(conn.workspaceId);
      if (!key || !ct) throw new Error("GitHub user token is unavailable");
      const { token } = await mintViaBroker(config.githubBrokerUrl, open(ct, key), conn.installation.id);
      return token;
    }
    return this.provider.installationToken(conn.installation.id);
  }

  /**
   * The git token a PROJECT's operations authenticate with. When the project
   * pinned a specific GitHub account (`githubCredentialId` — a stored `github`
   * PAT credential), open that PAT so its repos push to / clone from / bill under
   * THAT account (business vs personal). Otherwise the workspace's default
   * connection token. Central so clone/push/PR/repo-list all agree.
   */
  private async projectToken(workspaceId: string, githubCredentialId: string | null | undefined): Promise<string> {
    if (githubCredentialId) {
      const pat = await secretService.resolve(workspaceId, githubCredentialId);
      if (!pat) throw new Error("The project's GitHub account has no stored token — reconnect it in Integrations.");
      return pat;
    }
    const conn = await this.store.get(workspaceId);
    if (!conn?.connected) throw new Error("GitHub is not connected for this workspace");
    return this.resolveToken(conn);
  }

  // ── Issues (task import + status write-back — see docs/task-source-sync.md) ──
  /** Open issues on a repo, for importing them as tasks. Authenticates with the
   *  project's pinned GitHub account (else the default connection). */
  async listIssues(workspaceId: string, repo: string, githubCredentialId?: string | null): Promise<GithubIssue[]> {
    return this.provider.listIssues(await this.projectToken(workspaceId, githubCredentialId), repo);
  }
  /** Comment on an issue (write-back — e.g. "Skynet opened PR #123"). */
  async commentIssue(workspaceId: string, repo: string, number: number, body: string, githubCredentialId?: string | null): Promise<void> {
    await this.provider.commentIssue(await this.projectToken(workspaceId, githubCredentialId), repo, number, body);
  }
  /** Open/close an issue (write-back — close on done, reopen on regress). */
  async setIssueState(workspaceId: string, repo: string, number: number, state: "open" | "closed", githubCredentialId?: string | null): Promise<void> {
    await this.provider.setIssueState(await this.projectToken(workspaceId, githubCredentialId), repo, number, state);
  }
  /** Every label currently on an issue (write-back — read before replace, so a
   *  label mirror can preserve labels it doesn't own). */
  async getIssueLabels(workspaceId: string, repo: string, number: number, githubCredentialId?: string | null): Promise<string[]> {
    return this.provider.getIssueLabels(await this.projectToken(workspaceId, githubCredentialId), repo, number);
  }
  /** An issue's current open/closed state + labels — manual re-sync's reconcile
   *  pass needs this for a CLOSED issue too, which listIssues never returns. */
  async getIssue(workspaceId: string, repo: string, number: number, githubCredentialId?: string | null): Promise<{ state: "open" | "closed"; labels: string[] }> {
    return this.provider.getIssue(await this.projectToken(workspaceId, githubCredentialId), repo, number);
  }
  /** Replace an issue's entire label set (write-back — kanban-stage mirror). */
  async setIssueLabels(workspaceId: string, repo: string, number: number, labels: string[], githubCredentialId?: string | null): Promise<void> {
    await this.provider.setIssueLabels(await this.projectToken(workspaceId, githubCredentialId), repo, number, labels);
  }

  /** Read a repo file's text + blob sha (for repo-file task import + write-back). */
  async getRepoFileWithSha(workspaceId: string, repo: string, path: string, githubCredentialId?: string | null): Promise<{ content: string; sha: string } | null> {
    return this.provider.getFile(await this.projectToken(workspaceId, githubCredentialId), repo, path);
  }
  /** Commit an updated repo file (single-file Contents-API commit) — the repo-file
   *  write-back path (flip a checklist item when a task completes/reopens). */
  async commitRepoFile(workspaceId: string, repo: string, path: string, content: string, sha: string, message: string, githubCredentialId?: string | null): Promise<void> {
    await this.provider.putFile(await this.projectToken(workspaceId, githubCredentialId), repo, path, content, sha, message);
  }

  /** Repos a given GitHub account can bind to — a pinned credential's PAT lists
   *  ITS repos (the create-project picker for a business/personal account); no
   *  credentialId falls back to the workspace default connection's repos. */
  async reposForCredential(workspaceId: string, githubCredentialId?: string | null): Promise<GithubRepo[]> {
    if (!githubCredentialId) return this.availableRepos(workspaceId);
    const pat = await secretService.resolve(workspaceId, githubCredentialId);
    if (!pat) return [];
    return (await this.provider.listRepos(pat)).map((r) => ({ ...r, selected: true }));
  }

  /** Seal + store a Device-Flow user token (broker mode). The plaintext is never
   *  persisted elsewhere or returned. */
  async storeUserToken(workspaceId: string, userToken: string): Promise<void> {
    const key = masterKey();
    if (!key) throw new Error("Secret store is disabled — set SKYNET_MASTER_KEY");
    await this.store.putToken(workspaceId, seal(userToken, key));
  }

  /** Open the stored Device-Flow user token (broker mode). */
  private async userToken(workspaceId: string): Promise<string> {
    const key = masterKey();
    const ct = await this.store.getToken(workspaceId);
    if (!key || !ct) throw new Error("Not authenticated with GitHub — connect first");
    return open(ct, key);
  }

  /** App installations the user can see (broker-mode install picker). */
  async listInstallations(workspaceId: string): Promise<GithubInstallation[]> {
    return this.provider.listInstallations(await this.userToken(workspaceId));
  }

  /** Repos within one installation (broker-mode repo picker). */
  async listInstallationRepos(workspaceId: string, installationId: number): Promise<GithubRepo[]> {
    return this.provider.listInstallationRepos(await this.userToken(workspaceId), installationId);
  }

  /** Read a single file's text from a connected repo via the GitHub contents
   *  API. Returns null if the file/repo is absent. Read-only; used by the
   *  project assistant to ground answers in repo content (e.g. ROADMAP.md). */
  async readRepoFile(workspaceId: string, repo: string, path: string, ref?: string): Promise<string | null> {
    const conn = await this.store.get(workspaceId);
    if (!conn) throw new Error("GitHub is not connected for this workspace");
    const token = await this.resolveToken(conn);
    const url = `https://api.github.com/repos/${repo}/contents/${path.replace(/^\/+/, "")}${ref ? `?ref=${encodeURIComponent(ref)}` : ""}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github.raw+json", "User-Agent": "skynet" },
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`GitHub contents ${res.status}`);
    return res.text();
  }

  /** Top-level entries of a connected repo (names; directories keep a trailing
   *  slash). Best-effort — returns [] on any error. */
  async listRepoRoot(workspaceId: string, repo: string, ref?: string): Promise<string[]> {
    const conn = await this.store.get(workspaceId);
    if (!conn) return [];
    try {
      const token = await this.resolveToken(conn);
      const url = `https://api.github.com/repos/${repo}/contents${ref ? `?ref=${encodeURIComponent(ref)}` : ""}`;
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "User-Agent": "skynet" },
      });
      if (!res.ok) return [];
      const entries = (await res.json()) as Array<{ name: string; type: string }>;
      return entries.map((e) => (e.type === "dir" ? `${e.name}/` : e.name));
    } catch {
      return [];
    }
  }

  /** Accounts a new repo can be created under: the authenticated user, plus any
   *  orgs the token can see. `githubCredentialId` lists THAT account's owners
   *  (a pinned business/personal PAT — same selector the repo picker takes);
   *  omitted → the workspace default connection. Orgs come from `/user/orgs`
   *  when the token can call it, but that's best-effort twice over: an App
   *  installation token can't list a user's orgs at all, and a FINE-GRAINED PAT
   *  typically can't either (it needs an explicit org "Members: read"
   *  permission most tokens aren't minted with). Silently swallowing that made
   *  a deliberately-added org PAT look broken — the org never appeared as an
   *  owner option ("the Algorithma-se org is not visible at all, despite adding
   *  a new pat for it"). So when org listing yields nothing, DERIVE org owners
   *  from the repos the token can actually see: any owner prefix in the repo
   *  list that isn't the user themself is an org the token works with. */
  async listRepoOwners(workspaceId: string, githubCredentialId?: string | null): Promise<GithubOwner[]> {
    let token: string;
    if (githubCredentialId) {
      const pat = await secretService.resolve(workspaceId, githubCredentialId);
      if (!pat) return [];
      token = pat;
    } else {
      const conn = await this.store.get(workspaceId);
      const ready = conn?.connected && (conn.auth === "pat" || !!conn.installation);
      if (!conn || !ready) return [];
      token = await this.resolveToken(conn);
    }
    const me = await this.provider.viewer(token);
    const owners: GithubOwner[] = [{ login: me.login, type: "user" }];
    let orgs: string[] = [];
    try {
      orgs = await this.provider.listOrgs(token);
    } catch {
      /* fall through to the repo-derived fallback below */
    }
    if (orgs.length === 0) {
      // The org-membership endpoint failed or returned nothing — infer from
      // what the token can reach instead. Best-effort: a listRepos failure
      // just leaves the user as the only owner, same as before.
      try {
        const seen = new Set<string>();
        for (const r of await this.provider.listRepos(token)) {
          const owner = r.name.split("/")[0];
          if (owner && owner !== me.login) seen.add(owner);
        }
        orgs = [...seen];
      } catch {
        /* owners stay user-only */
      }
    }
    for (const org of orgs) owners.push({ login: org, type: "org" });
    return owners;
  }

  /** Create a new GitHub repo for this workspace and register it on the
   *  connection (selected) so it shows up in pickers. `owner` is the user's login
   *  (→ /user/repos) or an org login (→ /orgs/:org/repos). The repo is
   *  auto-initialized so a project bound to it can clone immediately.
   *  `githubCredentialId` creates it AS that pinned account (matching the
   *  owner list that account's picker showed); omitted → default connection. */
  async createRepo(
    workspaceId: string,
    spec: { name: string; private: boolean; owner?: string },
    opts: { description?: string; githubCredentialId?: string | null } = {},
  ): Promise<GithubRepo> {
    let token: string;
    const conn = await this.store.get(workspaceId);
    if (opts.githubCredentialId) {
      const pat = await secretService.resolve(workspaceId, opts.githubCredentialId);
      if (!pat) throw new Error("The selected GitHub account has no stored token — reconnect it in Integrations.");
      token = pat;
    } else {
      const ready = conn?.connected && (conn.auth === "pat" || !!conn.installation);
      if (!conn || !ready) throw new Error("GitHub is not connected for this workspace");
      if (conn.auth === "app" && !this.appHasCreds) throw new Error("GitHub App is not configured on the server");
      token = await this.resolveToken(conn);
    }
    const me = await this.provider.viewer(token);
    const org = spec.owner && spec.owner !== me.login ? spec.owner : undefined;
    const repo = await this.provider.createRepo(token, {
      name: spec.name,
      private: spec.private,
      description: opts.description,
      org,
    });
    // Register on the default connection's snapshot so it shows in pickers —
    // only meaningful when that connection exists (a credential-created repo
    // is reachable through its own account's live listing regardless).
    if (conn?.connected && !conn.repos.some((r) => r.name === repo.name)) {
      await this.store.put({ ...conn, repos: [{ ...repo, selected: true }, ...conn.repos] });
    }
    return repo;
  }

  /** Patch the safety policy. Returns undefined if the workspace isn't connected. */
  async updateSafety(workspaceId: string, patch: Partial<SafetyPolicy>): Promise<GithubConnection | undefined> {
    const existing = await this.store.get(workspaceId);
    if (!existing) return undefined;
    const next: GithubConnection = { ...existing, safety: { ...existing.safety, ...patch } };
    await this.store.put(next);
    return next;
  }

  async disconnect(workspaceId: string): Promise<void> {
    await this.store.delete(workspaceId);
    await this.store.deleteToken(workspaceId);
  }

  /**
   * Push the agent branch and open a PR — gated by the workspace's policy.
   * Returns ok:false with the violations when blocked (nothing is pushed), or
   * when GitHub isn't connected / the App isn't configured. Fails closed.
   */
  async pushAndOpenPr(req: PushRequest): Promise<PushResult> {
    const conn = await this.store.get(req.workspaceId);
    const pinned = !!req.githubCredentialId; // project pinned a specific GitHub account
    if (!pinned) {
      const ready = conn?.connected && (conn.auth === "pat" || !!conn.installation);
      if (!conn || !ready) {
        return { ok: false, pushed: false, violations: [{ rule: "general", message: "GitHub is not connected for this workspace" }] };
      }
    }

    // Safety policy comes from the workspace's default connection (or defaults);
    // it gates every push regardless of which account the token belongs to.
    const violations = evaluateSafety(conn?.safety ?? SAFETY_DEFAULTS, req);
    if (violations.length > 0) return { ok: false, pushed: false, violations };

    if (!pinned && conn!.auth === "app" && !this.appHasCreds) {
      return { ok: false, pushed: false, violations: [{ rule: "general", message: "GitHub App is not configured on the server" }] };
    }

    const token = await this.projectToken(req.workspaceId, req.githubCredentialId);
    await this.provider.pushBranch(token, req.repo, req.worktreePath, req.branch, req.force);
    const pr = await this.provider.openPr(token, req.repo, req.branch, req.baseBranch, req.title, req.body);
    return { ok: true, pushed: true, violations: [], pr };
  }

  /**
   * Merge an open PR via the API — the operator's Skynet approval IS the
   * approval. Returns the provider's result; `merged:false` when GitHub blocks it
   * (branch protection / required checks or reviews), which the caller surfaces
   * rather than pretending the work integrated.
   */
  async mergePr(workspaceId: string, repo: string, prNumber: number, method: "merge" | "squash" | "rebase" = "squash"): Promise<MergeResult> {
    const conn = await this.store.get(workspaceId);
    const ready = conn?.connected && (conn.auth === "pat" || !!conn.installation);
    if (!conn || !ready) throw new Error("GitHub is not connected for this workspace");
    if (conn.auth === "app" && !this.appHasCreds) throw new Error("GitHub App is not configured on the server");
    const token = await this.resolveToken(conn);
    return this.provider.mergePr(token, repo, prNumber, method);
  }

  /** A PR's live state, CI checks, and mergeability — used to explain WHY a merge
   *  was blocked (conflict vs failing/pending checks vs branch protection). */
  async prStatus(workspaceId: string, repo: string, prNumber: number, githubCredentialId?: string | null): Promise<PrStatus> {
    return this.provider.prStatus(await this.projectToken(workspaceId, githubCredentialId), repo, prNumber);
  }

  /** Clone a connected repo (owner/name) into `dest` using the workspace's git
   *  token — the token stays inside the service, never returned. This is what
   *  lets a project bound to a GitHub repo get a local checkout on a headless
   *  server (e.g. GCP), so the orchestrator can cut worktrees from it. */
  async cloneRepo(workspaceId: string, repo: string, dest: string, githubCredentialId?: string | null): Promise<void> {
    // A pinned account clones with ITS PAT; otherwise the workspace default.
    if (!githubCredentialId) {
      const conn = await this.store.get(workspaceId);
      const ready = conn?.connected && (conn.auth === "pat" || !!conn.installation);
      if (!conn || !ready) throw new Error("GitHub is not connected for this workspace");
      if (conn.auth === "app" && !this.appHasCreds) throw new Error("GitHub App is not configured on the server");
    }
    const token = await this.projectToken(workspaceId, githubCredentialId);
    await this.provider.cloneRepo(token, repo, dest);
  }
}

const appHasCreds = (): boolean => !!(config.githubAppId && config.githubPrivateKey);

/** The provider is always constructed — its git ops (push/PR/merge) and the PAT
 *  endpoints (viewer/listRepos) work with any token. Only installationToken()
 *  needs the App key, and it's only reached in App mode. */
function makeProvider(): GitProvider {
  return new GitHubProvider(config.githubAppId ?? "", config.githubPrivateKey ?? "", config.githubApiBase);
}

/** Process-wide singleton, configured from the environment. Persistence starts
 *  in-memory and is upgraded to the deployment's Store via configureGithub(). */
export const githubService = new GithubService(new MemoryGithubStore(), makeProvider(), appHasCreds());

/** Back the connection + token with the main Store (called once at bootstrap).
 *  The connection is non-secret; the token is stored sealed. Both live where the
 *  rest of the workspace's data does — the desktop file, Postgres, or memory. */
export function configureGithub(store: Store): void {
  githubService.useStore({
    get: (ws) => store.getGithubConnection(ws),
    put: (c) => store.putGithubConnection(c),
    delete: (ws) => store.deleteGithubConnection(ws),
    getToken: (ws) => store.getGithubToken(ws),
    putToken: (ws, ct) => store.putGithubToken(ws, ct),
    deleteToken: (ws) => store.deleteGithubToken(ws),
  });
}
