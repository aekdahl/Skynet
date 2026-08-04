// parseRepoRef turns whatever repo reference an operator pastes (a URL from the
// browser, an SSH clone string, or a bare slug) into the canonical "owner/repo"
// Skynet binds projects to. These pin the shapes it accepts and, importantly,
// what it rejects so garbage can't be bound as a repo.
import { describe, it, expect } from "vitest";
import { parseRepoRef } from "../apps/server/src/github/repo-ref.js";

describe("parseRepoRef", () => {
  it("passes a bare owner/repo slug through unchanged", () => {
    expect(parseRepoRef("acme/app")).toBe("acme/app");
  });

  it("normalizes HTTPS web and clone URLs (with/without .git and trailing slash)", () => {
    expect(parseRepoRef("https://github.com/acme/app")).toBe("acme/app");
    expect(parseRepoRef("https://github.com/acme/app.git")).toBe("acme/app");
    expect(parseRepoRef("https://github.com/acme/app/")).toBe("acme/app");
  });

  it("normalizes SSH clone URLs (scp-like and ssh://)", () => {
    expect(parseRepoRef("git@github.com:acme/app.git")).toBe("acme/app");
    expect(parseRepoRef("ssh://git@github.com/acme/app.git")).toBe("acme/app");
  });

  it("drops extra path segments and surrounding whitespace", () => {
    expect(parseRepoRef("  https://github.com/acme/app/tree/main  ")).toBe("acme/app");
  });

  it("preserves the dots/dashes/underscores GitHub allows in names", () => {
    expect(parseRepoRef("https://github.com/my-org/some.repo_name")).toBe("my-org/some.repo_name");
  });

  it("returns null for things that aren't a repo reference", () => {
    expect(parseRepoRef("")).toBeNull();
    expect(parseRepoRef("   ")).toBeNull();
    expect(parseRepoRef("just-owner")).toBeNull();
    expect(parseRepoRef("https://github.com/acme")).toBeNull();
    expect(parseRepoRef("not a url")).toBeNull();
  });
});
