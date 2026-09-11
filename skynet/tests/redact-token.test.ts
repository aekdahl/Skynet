// Security guard for clone-on-connect: git echoes the token-authenticated remote
// URL in its error output on a failed clone/push, so the token MUST be stripped
// before that message is ever thrown/logged/shown. redactToken is that stripper.
import { describe, it, expect } from "vitest";
import { redactToken } from "../apps/server/src/github/provider.js";

describe("redactToken", () => {
  it("removes the token from a git error that echoed the authed remote URL", () => {
    const token = "ghp_SUPERSECRET123";
    const err = `fatal: could not read from https://x-access-token:${token}@github.com/acme/app.git`;
    const out = redactToken(err, token);
    expect(out).not.toContain(token);
    expect(out).toContain("***");
  });

  it("redacts every occurrence", () => {
    const token = "tok";
    expect(redactToken("tok here and tok there", token)).toBe("*** here and *** there");
  });

  it("is a no-op for an empty token (nothing to redact)", () => {
    expect(redactToken("plain message", "")).toBe("plain message");
  });
});
