// ─── GitHub service ───────────────────────────────────────────────────────
// Owns the per-workspace connection + the guarded push path. The orchestrator
// calls pushAndOpenPr() after an operator approves a diff; the service loads the
// workspace's policy, runs the safety preflight, and only then mints a token and
// performs the remote push + PR. Agents never see any of this.

import { SAFETY_DEFAULTS, type GithubConnection, type GithubInstallation, type GithubRepo, type SafetyPolicy } from "@skynet/shared";
import { config } from "../config.js";
import { masterKey, open, seal } from "../secrets/crypto.js";
import { mintViaBroker } from "./broker.js";
import type { Store } from "../store/store.js";
import { MemoryGithubStore } from "./memory.js";
import { GitHubProvider } from "./provider.js";
import { evaluateSafety } from "./safety.js";
import type { GitProvider, GithubConnectionStore, PushRequest, PushResult } from "./types.js";

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
    const ready = conn?.connected && (conn.auth === "pat" || !!conn.installation);
    if (!conn || !ready) {
      return { ok: false, pushed: false, violations: [{ rule: "general", message: "GitHub is not connected for this workspace" }] };
    }

    const violations = evaluateSafety(conn.safety, req);
    if (violations.length > 0) return { ok: false, pushed: false, violations };

    if (conn.auth === "app" && !this.appHasCreds) {
      return { ok: false, pushed: false, violations: [{ rule: "general", message: "GitHub App is not configured on the server" }] };
    }

    const token = await this.resolveToken(conn);
    await this.provider.pushBranch(token, req.repo, req.worktreePath, req.branch, req.force);
    const pr = await this.provider.openPr(token, req.repo, req.branch, req.baseBranch, req.title, req.body);
    return { ok: true, pushed: true, violations: [], pr };
  }

  /** Clone a connected repo (owner/name) into `dest` using the workspace's git
   *  token — the token stays inside the service, never returned. This is what
   *  lets a project bound to a GitHub repo get a local checkout on a headless
   *  server (e.g. GCP), so the orchestrator can cut worktrees from it. */
  async cloneRepo(workspaceId: string, repo: string, dest: string): Promise<void> {
    const conn = await this.store.get(workspaceId);
    const ready = conn?.connected && (conn.auth === "pat" || !!conn.installation);
    if (!conn || !ready) throw new Error("GitHub is not connected for this workspace");
    if (conn.auth === "app" && !this.appHasCreds) throw new Error("GitHub App is not configured on the server");
    const token = await this.resolveToken(conn);
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
