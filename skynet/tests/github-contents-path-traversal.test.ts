// Security finding (Aug 2026 audit): getFile/putFile built the Contents API
// URL as `/repos/${repo}/contents/${path}` with no `.`/`..` rejection.
// `fetch`'s URL parser normalizes dot-segments per the URL spec, so a
// crafted path like `../../otherOwner/otherRepo/contents/secret.txt` walks
// back OUT of `{repo}` entirely and retargets the request at a different
// repo the same installation/token can reach — a read (getFile,
// GitHubService.readRepoFile) or write (putFile, reachable via the
// `import_repo_file` MCP tool and the task-source write-back path) into a
// repo the caller was never scoped to. safeRepoPath (provider.ts) is the one
// choke point every Contents API caller now routes through.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { GitHubProvider, safeRepoPath } from "../apps/server/src/github/provider.js";

describe("safeRepoPath", () => {
  it("passes an ordinary path through unchanged", () => {
    expect(safeRepoPath("README.md")).toBe("README.md");
    expect(safeRepoPath("docs/roadmap.md")).toBe("docs/roadmap.md");
  });

  it("strips a leading/trailing slash, matching the old behavior", () => {
    expect(safeRepoPath("/README.md")).toBe("README.md");
    expect(safeRepoPath("docs/roadmap.md/")).toBe("docs/roadmap.md");
  });

  it("percent-encodes a segment with special characters", () => {
    expect(safeRepoPath("a file (draft).md")).toBe("a%20file%20(draft).md");
  });

  it("rejects a `..` segment that would walk out of the repo", () => {
    expect(() => safeRepoPath("../../otherOwner/otherRepo/contents/secret.txt")).toThrow(/unsafe repo path/i);
  });

  it("rejects a bare `..` and a bare `.` segment", () => {
    expect(() => safeRepoPath("..")).toThrow(/unsafe repo path/i);
    expect(() => safeRepoPath(".")).toThrow(/unsafe repo path/i);
  });

  it("rejects a `..` segment buried in the middle of an otherwise-normal path", () => {
    expect(() => safeRepoPath("docs/../../secret.txt")).toThrow(/unsafe repo path/i);
  });

  it("rejects an internal empty segment (a literal double slash)", () => {
    expect(() => safeRepoPath("docs//roadmap.md")).toThrow(/unsafe repo path/i);
  });

  it("a segment containing a literal encoded slash can't smuggle in an extra path level post-validation", () => {
    // "%2f" is not "/" at validation time (segments are split on the RAW "/"
    // first) — it's just an ordinary character within a single segment, so
    // it's re-encoded (the literal "%" becomes "%25") rather than ever being
    // interpreted as a path separator.
    expect(safeRepoPath("a%2f..%2f..%2fsecret.txt")).toBe("a%252f..%252f..%252fsecret.txt");
  });
});

describe("GitHubProvider.getFile / putFile — path-traversal rejection", () => {
  const token = "ghp_TEST_TOKEN";
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ content: "aGVsbG8=", encoding: "base64", sha: "abc123" }),
    });
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("getFile requests exactly the safe, encoded path for an ordinary file — no surprise rewriting", async () => {
    const provider = new GitHubProvider("app-id", "dummy-key", "https://api.github.com");
    await provider.getFile(token, "acme/app", "docs/roadmap.md");
    expect(fetchMock).toHaveBeenCalledWith("https://api.github.com/repos/acme/app/contents/docs/roadmap.md", expect.anything());
  });

  it("getFile throws on a traversal path and NEVER calls fetch — the malicious path never reaches the network", async () => {
    const provider = new GitHubProvider("app-id", "dummy-key", "https://api.github.com");
    await expect(provider.getFile(token, "acme/app", "../../other/repo/contents/secret.txt")).rejects.toThrow(/unsafe repo path/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("putFile throws on a traversal path and never calls fetch — closes the write leg too", async () => {
    const provider = new GitHubProvider("app-id", "dummy-key", "https://api.github.com");
    await expect(provider.putFile(token, "acme/app", "../../other/repo/contents/secret.txt", "pwned", undefined, "msg")).rejects.toThrow(
      /unsafe repo path/i,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
