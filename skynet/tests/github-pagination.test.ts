// GitHub list endpoints are paginated (per_page maxes at 100). The provider must
// follow the `Link: rel="next"` header and return EVERY page — the bug this pins
// is a workspace with >100 repos silently losing everything past the first page
// when creating a project.
import { describe, it, expect, vi, afterEach } from "vitest";
import { GitHubProvider, parseNextLink } from "../apps/server/src/github/provider.js";

const API = "https://api.github.com";

// A GitHub-shaped paged response: an array body + a Link header pointing at the
// next page (absent on the final page).
function page(body: unknown, next?: string): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: next ? { link: `<${next}>; rel="next", <${next}>; rel="last"` } : {},
  });
}

const repo = (n: number) => ({ id: n, full_name: `me/repo-${n}`, default_branch: "main", private: false });

afterEach(() => vi.restoreAllMocks());

describe("parseNextLink", () => {
  it("extracts the rel=next href, or null on the last page", () => {
    expect(parseNextLink(`<${API}/user/repos?page=2>; rel="next", <${API}/user/repos?page=5>; rel="last"`)).toBe(
      `${API}/user/repos?page=2`,
    );
    expect(parseNextLink(`<${API}/user/repos?page=5>; rel="last", <${API}/user/repos?page=1>; rel="first"`)).toBeNull();
    expect(parseNextLink(null)).toBeNull();
  });
});

describe("GitHubProvider.listRepos — pagination", () => {
  it("follows Link headers and returns repos from EVERY page", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(page([repo(1), repo(2)], `${API}/user/repos?page=2`)) // page 1 → has next
      .mockResolvedValueOnce(page([repo(3)])); // page 2 → last

    const provider = new GitHubProvider("app-id", "pk", API);
    const repos = await provider.listRepos("tok");

    expect(fetchMock).toHaveBeenCalledTimes(2); // it kept going past page 1
    expect(repos.map((r) => r.name)).toEqual(["me/repo-1", "me/repo-2", "me/repo-3"]);
    // The follow-up request hit the exact next-page URL GitHub handed back.
    expect(fetchMock.mock.calls[1]?.[0]).toBe(`${API}/user/repos?page=2`);
  });

  it("stops at a single page when there's no next link (no wasted request)", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(page([repo(1)]));
    const provider = new GitHubProvider("app-id", "pk", API);
    const repos = await provider.listRepos("tok");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(repos).toHaveLength(1);
  });
});

describe("GitHubProvider.listInstallationRepos — pagination (wrapped body)", () => {
  it("follows Link headers and unwraps `repositories` from every page", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(page({ total_count: 3, repositories: [repo(1), repo(2)] }, `${API}/next`))
      .mockResolvedValueOnce(page({ total_count: 3, repositories: [repo(3)] }));
    const provider = new GitHubProvider("app-id", "pk", API);
    const repos = await provider.listInstallationRepos("tok", 42);
    expect(repos.map((r) => r.name)).toEqual(["me/repo-1", "me/repo-2", "me/repo-3"]);
  });
});
