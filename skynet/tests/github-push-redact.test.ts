// Security guard: unlike cloneRepo, pushBranch/syncBase used to throw the RAW
// git/Node error straight through on failure — and Node's execFile puts the
// full command line (the token-authenticated remote URL, included as an arg)
// into the thrown error's message. That unredacted message propagates into
// the run log, which is both persisted and broadcast live to the operator's
// UI. This exercises the real GitHubProvider methods (not a fake), against a
// worktreePath that isn't a git repo, so the underlying git command fails
// fast with no network I/O — and asserts the token never survives.
import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GitHubProvider } from "../apps/server/src/github/provider.js";

describe("GitHubProvider push/sync — token redaction on failure", () => {
  const token = "ghp_SUPERSECRET_PUSH_TOKEN";
  const provider = new GitHubProvider("app-id", "dummy-key", "https://api.github.com");

  it("pushBranch never leaks the token in a thrown error", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gh-push-redact-"));
    try {
      // Not a git repo at all — `git -C dir push ...` fails immediately, no
      // network involved, but the rejected error's message still contains
      // the full command line (incl. the token) unless redacted.
      try {
        await provider.pushBranch(token, "acme/app", dir, "agent/x", false);
        expect.unreachable("pushBranch should have thrown");
      } catch (err) {
        expect((err as Error).message).not.toContain(token);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("syncBase never leaks the token in a thrown error", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gh-sync-redact-"));
    try {
      try {
        await provider.syncBase(token, "acme/app", dir, "main");
        expect.unreachable("syncBase should have thrown");
      } catch (err) {
        expect((err as Error).message).not.toContain(token);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
