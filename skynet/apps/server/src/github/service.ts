// ─── GitHub service ───────────────────────────────────────────────────────
// Owns the per-workspace connection + the guarded push path. The orchestrator
// calls pushAndOpenPr() after an operator approves a diff; the service loads the
// workspace's policy, runs the safety preflight, and only then mints a token and
// performs the remote push + PR. Agents never see any of this.

import { SAFETY_DEFAULTS, type GithubConnection, type GithubInstallation, type GithubRepo, type SafetyPolicy } from "@skynet/shared";
import { config } from "../config.js";
import { MemoryGithubStore } from "./memory.js";
import { GitHubProvider } from "./provider.js";
import { evaluateSafety } from "./safety.js";
import type { GitProvider, GithubConnectionStore, PushRequest, PushResult } from "./types.js";

export class GithubService {
  constructor(
    private store: GithubConnectionStore,
    private provider?: GitProvider,
  ) {}

  /** True once a GitHub App is configured server-side (push/PR is possible). */
  get appConfigured(): boolean {
    return !!this.provider;
  }

  async get(workspaceId: string): Promise<GithubConnection | undefined> {
    return this.store.get(workspaceId);
  }

  /** Record (or refresh) an installation + selected repos for a workspace. */
  async connect(workspaceId: string, installation: GithubInstallation, repos: GithubRepo[]): Promise<GithubConnection> {
    const existing = await this.store.get(workspaceId);
    const connection: GithubConnection = {
      workspaceId,
      connected: true,
      installation,
      repos,
      safety: existing?.safety ?? { ...SAFETY_DEFAULTS },
    };
    await this.store.put(connection);
    return connection;
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
  }

  /**
   * Push the agent branch and open a PR — gated by the workspace's policy.
   * Returns ok:false with the violations when blocked (nothing is pushed), or
   * when GitHub isn't connected / the App isn't configured. Fails closed.
   */
  async pushAndOpenPr(req: PushRequest): Promise<PushResult> {
    const conn = await this.store.get(req.workspaceId);
    if (!conn?.connected || !conn.installation) {
      return { ok: false, pushed: false, violations: [{ rule: "general", message: "GitHub is not connected for this workspace" }] };
    }

    const violations = evaluateSafety(conn.safety, req);
    if (violations.length > 0) return { ok: false, pushed: false, violations };

    if (!this.provider) {
      return { ok: false, pushed: false, violations: [{ rule: "general", message: "GitHub App is not configured on the server" }] };
    }

    const token = await this.provider.installationToken(conn.installation.id);
    await this.provider.pushBranch(token, req.repo, req.worktreePath, req.branch, req.force);
    const pr = await this.provider.openPr(token, req.repo, req.branch, req.baseBranch, req.title, req.body);
    return { ok: true, pushed: true, violations: [], pr };
  }
}

function makeProvider(): GitProvider | undefined {
  if (config.githubAppId && config.githubPrivateKey) {
    return new GitHubProvider(config.githubAppId, config.githubPrivateKey, config.githubApiBase);
  }
  return undefined;
}

/** Process-wide singleton, configured from the environment. */
export const githubService = new GithubService(new MemoryGithubStore(), makeProvider());
