// PAT auth path (the local/desktop GitHub option): a token pasted by the user is
// validated, sealed at rest, and used as the git token — no App, no cloud. We
// verify the token plumbing with a fake provider (no real GitHub calls).
import { describe, it, expect, beforeAll } from "vitest";
import { GithubService } from "../apps/server/src/github/service.js";
import { MemoryGithubStore } from "../apps/server/src/github/memory.js";
import { resetMasterKeyCache } from "../apps/server/src/secrets/crypto.js";
import type { GitProvider, PushRequest } from "../apps/server/src/github/types.js";
import type { GithubRepo } from "@skynet/shared";

// Records the token each op was called with — that's how we prove resolveToken
// handed the PAT (not an installation token) to the git operations.
class FakeProvider implements GitProvider {
  readonly id = "fake";
  lastPushToken?: string;
  lastPrToken?: string;
  async installationToken(): Promise<string> {
    throw new Error("installationToken must not be called in PAT mode");
  }
  async viewer(token: string) {
    if (token === "bad") throw new Error("401 Bad credentials");
    return { login: "octocat" };
  }
  async listRepos(): Promise<GithubRepo[]> {
    return [{ id: 1, name: "octocat/repo", defaultBranch: "main", private: false, selected: false }];
  }
  lastMergeToken?: string;
  lastMergeNumber?: number;
  lastMergeMethod?: string;
  async pushBranch(token: string) { this.lastPushToken = token; }
  async openPr(token: string) { this.lastPrToken = token; return { number: 7, url: "https://gh/pr/7" }; }
  async prStatus() { return { state: "open" as const, checks: "none" as const }; }
  async mergePr(token: string, _repo: string, num: number, method: "merge" | "squash" | "rebase") {
    this.lastMergeToken = token;
    this.lastMergeNumber = num;
    this.lastMergeMethod = method;
    return { merged: true };
  }
  async syncBase() {}
}

const PUSH = (ws: string): PushRequest => ({
  workspaceId: ws, runId: "a1", repo: "octocat/repo", branch: "agent/a1", baseBranch: "main",
  worktreePath: "/tmp/wt", changedFiles: ["x.ts"], modules: [], allowedModules: [], force: false,
  title: "t", body: "b",
});

describe("GitHub PAT auth", () => {
  beforeAll(() => {
    process.env.SKYNET_MASTER_KEY = Buffer.alloc(32, 7).toString("base64");
    resetMasterKeyCache();
  });

  it("connects, seals the token, and uses it for push/PR", async () => {
    const fake = new FakeProvider();
    const svc = new GithubService(new MemoryGithubStore(), fake, false /* no App creds */);

    const conn = await svc.connectViaPat("ws1", "github_pat_SECRET1234");
    expect(conn.auth).toBe("pat");
    expect(conn.connected).toBe(true);
    expect(conn.installation).toBeNull();
    expect(conn.tokenLast4).toBe("1234");
    expect(conn.repos).toHaveLength(1);
    expect(conn.repos[0]!.selected).toBe(true);

    // Drop the guardrails so the preflight passes and we reach the git ops.
    await svc.updateSafety("ws1", { prOnly: false, noForcePush: false, moduleAllowlist: false, approveBeforePush: false });

    const res = await svc.pushAndOpenPr(PUSH("ws1"));
    expect(res.ok).toBe(true);
    expect(res.pr?.number).toBe(7);
    // The PAT plaintext (not an installation token) was used for both ops.
    expect(fake.lastPushToken).toBe("github_pat_SECRET1234");
    expect(fake.lastPrToken).toBe("github_pat_SECRET1234");
  });

  it("merges a PR with the resolved token (approve → merge)", async () => {
    const fake = new FakeProvider();
    const svc = new GithubService(new MemoryGithubStore(), fake, false);
    await svc.connectViaPat("ws3", "github_pat_SECRET1234");

    const res = await svc.mergePr("ws3", "octocat/repo", 7);
    expect(res.merged).toBe(true);
    // The PAT (not an installation token) was used, with the default squash method.
    expect(fake.lastMergeToken).toBe("github_pat_SECRET1234");
    expect(fake.lastMergeNumber).toBe(7);
    expect(fake.lastMergeMethod).toBe("squash");
  });

  it("rejects an invalid token (nothing stored)", async () => {
    const svc = new GithubService(new MemoryGithubStore(), new FakeProvider(), false);
    await expect(svc.connectViaPat("ws2", "bad")).rejects.toThrow();
    expect(await svc.get("ws2")).toBeUndefined();
  });
});
