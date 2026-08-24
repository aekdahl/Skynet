// The "New repo" owner picker + repo creation, per GitHub account. Pins the
// live report: "The Algorithma-se org is not visible at all, despite adding a
// new pat for it" — two gaps compounding:
//   1. listRepoOwners/createRepo only ever used the workspace DEFAULT
//      connection; a pinned business/personal PAT credential was invisible to
//      the whole create-project flow.
//   2. Org listing (`/user/orgs`) fails for most fine-grained PATs (needs an
//      org "Members: read" permission tokens usually aren't minted with) and
//      the failure was silently swallowed — so even the right token showed
//      only the personal login. Fixed by deriving org owners from the repos
//      the token can actually SEE when the org endpoint yields nothing.
import { describe, it, expect, beforeAll } from "vitest";
import { GithubService } from "../apps/server/src/github/service.js";
import { MemoryGithubStore } from "../apps/server/src/github/memory.js";
import { resetMasterKeyCache } from "../apps/server/src/secrets/crypto.js";
import { secretService } from "../apps/server/src/secrets/index.js";
import type { GitProvider } from "../apps/server/src/github/types.js";
import type { GithubRepo } from "@skynet/shared";

// Only the methods this suite's flows call — same partial-fake style as
// tests/github-pat.test.ts (vitest transforms via esbuild, no interface check).
class FakeProvider implements Partial<GitProvider> {
  readonly id = "fake";
  /** login reported per token, so a test can tell WHICH token was used. */
  viewers: Record<string, string> = {};
  /** repo list per token. */
  repoLists: Record<string, GithubRepo[]> = {};
  /** org list per token; a token absent here THROWS (the fine-grained-PAT shape). */
  orgLists: Record<string, string[]> = {};
  lastCreateToken?: string;
  lastCreateOrg?: string;
  async viewer(token: string) {
    const login = this.viewers[token];
    if (!login) throw new Error("401 Bad credentials");
    return { login };
  }
  async listRepos(token: string): Promise<GithubRepo[]> {
    return this.repoLists[token] ?? [];
  }
  async listOrgs(token: string): Promise<string[]> {
    const orgs = this.orgLists[token];
    if (!orgs) throw new Error("403 Resource not accessible by personal access token");
    return orgs;
  }
  async createRepo(token: string, spec: { name: string; private: boolean; org?: string }): Promise<GithubRepo> {
    this.lastCreateToken = token;
    this.lastCreateOrg = spec.org;
    const owner = spec.org ?? this.viewers[token] ?? "unknown";
    return { id: 99, name: `${owner}/${spec.name}`, defaultBranch: "main", private: spec.private, selected: true };
  }
}

const repo = (full: string): GithubRepo => ({ id: Math.floor(Math.random() * 1e6), name: full, defaultBranch: "main", private: true, selected: false });

describe("listRepoOwners — per-credential + org derivation", () => {
  beforeAll(() => {
    process.env.SKYNET_MASTER_KEY = Buffer.alloc(32, 5).toString("base64");
    resetMasterKeyCache();
  });

  it("a pinned credential lists THAT account's owners, not the default connection's", async () => {
    const fake = new FakeProvider();
    const svc = new GithubService(new MemoryGithubStore(), fake as unknown as GitProvider, false);
    // Default connection = the personal PAT (sees only the user).
    fake.viewers["github_pat_PERSONAL"] = "aekdahl";
    fake.orgLists["github_pat_PERSONAL"] = [];
    await svc.connectViaPat("ws-o", "github_pat_PERSONAL");
    // A separately-added org PAT, stored as a named credential.
    fake.viewers["github_pat_ORG"] = "aekdahl";
    fake.orgLists["github_pat_ORG"] = ["Algorithma-se"];
    const cred = await secretService.createCredential("ws-o", "github", "Algorithma-se", "github_pat_ORG", "op", 1);

    const viaDefault = await svc.listRepoOwners("ws-o");
    expect(viaDefault.map((o) => o.login)).toEqual(["aekdahl"]);

    const viaCred = await svc.listRepoOwners("ws-o", cred.id);
    expect(viaCred).toEqual([
      { login: "aekdahl", type: "user" },
      { login: "Algorithma-se", type: "org" },
    ]);
  });

  it("THE FIX: /user/orgs failing (fine-grained PAT) no longer hides the org — it's derived from visible repos", async () => {
    const fake = new FakeProvider();
    const svc = new GithubService(new MemoryGithubStore(), fake as unknown as GitProvider, false);
    fake.viewers["github_pat_FG"] = "aekdahl";
    // No orgLists entry → listOrgs THROWS for this token (the exact
    // fine-grained-PAT shape GitHub returns without Members:read)...
    fake.repoLists["github_pat_FG"] = [repo("Algorithma-se/platform"), repo("Algorithma-se/site"), repo("aekdahl/dotfiles")];
    const cred = await secretService.createCredential("ws-fg", "github", "Algorithma-se", "github_pat_FG", "op", 1);

    const owners = await svc.listRepoOwners("ws-fg", cred.id);
    // ...but the org still shows up, inferred from the repos the token CAN see.
    expect(owners).toEqual([
      { login: "aekdahl", type: "user" },
      { login: "Algorithma-se", type: "org" },
    ]);
  });

  it("an unknown credential id yields [] (never a crash, never the default connection's list)", async () => {
    const fake = new FakeProvider();
    const svc = new GithubService(new MemoryGithubStore(), fake as unknown as GitProvider, false);
    fake.viewers["github_pat_PERSONAL"] = "aekdahl";
    await svc.connectViaPat("ws-x", "github_pat_PERSONAL");
    expect(await svc.listRepoOwners("ws-x", "cred-github-gone")).toEqual([]);
  });
});

describe("createRepo — per-credential", () => {
  beforeAll(() => {
    process.env.SKYNET_MASTER_KEY = Buffer.alloc(32, 5).toString("base64");
    resetMasterKeyCache();
  });

  it("creates AS the pinned account's token, under the chosen org", async () => {
    const fake = new FakeProvider();
    const svc = new GithubService(new MemoryGithubStore(), fake as unknown as GitProvider, false);
    fake.viewers["github_pat_PERSONAL"] = "aekdahl";
    fake.orgLists["github_pat_PERSONAL"] = [];
    await svc.connectViaPat("ws-c", "github_pat_PERSONAL");
    fake.viewers["github_pat_ORG"] = "aekdahl";
    const cred = await secretService.createCredential("ws-c", "github", "Algorithma-se", "github_pat_ORG", "op", 1);

    const created = await svc.createRepo(
      "ws-c",
      { name: "new-thing", private: true, owner: "Algorithma-se" },
      { githubCredentialId: cred.id },
    );
    expect(fake.lastCreateToken).toBe("github_pat_ORG"); // the ORG account's token, not the default's
    expect(fake.lastCreateOrg).toBe("Algorithma-se");
    expect(created.name).toBe("Algorithma-se/new-thing");
    // Registered on the default connection's snapshot so pickers list it.
    expect((await svc.get("ws-c"))?.repos.some((r) => r.name === "Algorithma-se/new-thing")).toBe(true);
  });

  it("no credential → the default connection's token, exactly as before", async () => {
    const fake = new FakeProvider();
    const svc = new GithubService(new MemoryGithubStore(), fake as unknown as GitProvider, false);
    fake.viewers["github_pat_PERSONAL"] = "aekdahl";
    fake.orgLists["github_pat_PERSONAL"] = [];
    await svc.connectViaPat("ws-d", "github_pat_PERSONAL");

    const created = await svc.createRepo("ws-d", { name: "mine", private: false, owner: "aekdahl" });
    expect(fake.lastCreateToken).toBe("github_pat_PERSONAL");
    expect(fake.lastCreateOrg).toBeUndefined(); // owner === the user → a /user/repos create
    expect(created.name).toBe("aekdahl/mine");
  });

  it("a credential with no stored token fails loudly, pointing at Integrations", async () => {
    const fake = new FakeProvider();
    const svc = new GithubService(new MemoryGithubStore(), fake as unknown as GitProvider, false);
    await expect(
      svc.createRepo("ws-e", { name: "x", private: true }, { githubCredentialId: "cred-github-gone" }),
    ).rejects.toThrow(/no stored token/i);
  });
});
