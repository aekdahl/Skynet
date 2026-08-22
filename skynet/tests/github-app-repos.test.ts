// App/broker auth path: availableRepos() must re-list an installation's repos
// LIVE, same guarantee the PAT path already has (tests/github-pat.test.ts) —
// otherwise the create-project picker (and "Edit repository access") is stuck
// showing whatever was visible at connect time forever, silently missing repos
// added to the org/installation afterward. Reported live: "the listed github
// repos are far from all repos i have access to."
import { describe, it, expect, beforeAll } from "vitest";
import { GithubService } from "../apps/server/src/github/service.js";
import { MemoryGithubStore } from "../apps/server/src/github/memory.js";
import { resetMasterKeyCache } from "../apps/server/src/secrets/crypto.js";
import type { GitProvider } from "../apps/server/src/github/types.js";
import type { GithubInstallation, GithubRepo } from "@skynet/shared";

// Only the methods this suite's flow actually calls — vitest transforms via
// esbuild (no interface type-check on test files), matching the existing
// FakeProvider style in tests/github-pat.test.ts.
class FakeProvider implements Partial<GitProvider> {
  readonly id = "fake";
  instRepos: GithubRepo[] = [{ id: 1, name: "algorithma/one", defaultBranch: "main", private: true, selected: false }];
  async listInstallations(): Promise<GithubInstallation[]> {
    return [{ id: 42, account: "algorithma", type: "Organization", appSlug: "skynet" }];
  }
  async listInstallationRepos(): Promise<GithubRepo[]> {
    return this.instRepos;
  }
}

const INSTALLATION: GithubInstallation = { id: 42, account: "algorithma", type: "Organization", appSlug: "skynet" };

describe("GitHub App/broker auth — availableRepos", () => {
  beforeAll(() => {
    process.env.SKYNET_MASTER_KEY = Buffer.alloc(32, 9).toString("base64");
    resetMasterKeyCache();
  });

  it("re-lists LIVE, picking up repos added after connect, while preserving prior selections", async () => {
    const fake = new FakeProvider();
    const svc = new GithubService(new MemoryGithubStore(), fake as unknown as GitProvider, false);
    await svc.storeUserToken("ws-app", "device-flow-user-token");

    // Connected when only 1 repo existed, and the operator selected it.
    const conn = await svc.connect(
      "ws-app",
      INSTALLATION,
      [{ id: 1, name: "algorithma/one", defaultBranch: "main", private: true, selected: true }],
    );
    expect(conn.repos).toHaveLength(1);

    // The org grows — 2 more repos become visible to the installation.
    fake.instRepos = [
      { id: 1, name: "algorithma/one", defaultBranch: "main", private: true, selected: false },
      { id: 2, name: "algorithma/two", defaultBranch: "main", private: true, selected: false },
      { id: 3, name: "algorithma/three", defaultBranch: "main", private: false, selected: false },
    ];

    const live = await svc.availableRepos("ws-app");
    expect(live.map((r) => r.name)).toEqual(["algorithma/one", "algorithma/two", "algorithma/three"]);
    // The previously-selected repo stays selected...
    expect(live.find((r) => r.id === 1)?.selected).toBe(true);
    // ...but a brand-new repo is NOT silently opted in — the user still
    // chooses it explicitly (via "Edit repository access"), same intent as
    // GitHub's own installation-level access being a separate gate.
    expect(live.find((r) => r.id === 2)?.selected).toBe(false);
    expect(live.find((r) => r.id === 3)?.selected).toBe(false);
    // The stored snapshot is refreshed too, so a subsequent fetchGithub() call
    // sees the full live list, not the stale 1-repo snapshot.
    expect((await svc.get("ws-app"))?.repos).toHaveLength(3);
  });

  it("falls back to the stored snapshot (never throws) when the live re-fetch fails", async () => {
    const fake = new FakeProvider();
    const svc = new GithubService(new MemoryGithubStore(), fake as unknown as GitProvider, false);
    await svc.storeUserToken("ws-fail", "device-flow-user-token");
    await svc.connect(
      "ws-fail",
      INSTALLATION,
      [{ id: 1, name: "algorithma/one", defaultBranch: "main", private: true, selected: true }],
    );

    fake.listInstallationRepos = async () => {
      throw new Error("GitHub unavailable (simulated)");
    };

    const repos = await svc.availableRepos("ws-fail");
    expect(repos).toHaveLength(1); // degraded to the last-known snapshot, not a hard error
    expect(repos[0]!.selected).toBe(true);
  });
});
