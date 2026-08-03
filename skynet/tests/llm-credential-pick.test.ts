// pickLlmCredential decides which stored credential a project's run authenticates
// with. The key guarantee: a project's pinned LLM credential bills its runs to
// that account — but ONLY when the credential is for the run's provider, so a
// mismatched pin can never inject (say) a Claude key into a Codex run.
import { describe, it, expect } from "vitest";
import { pickLlmCredential } from "../apps/server/src/orchestrator.js";

const creds = [
  { id: "cred-claude-biz", provider: "claude" },
  { id: "cred-claude-personal", provider: "claude" },
  { id: "cred-codex-biz", provider: "codex" },
  { id: "gh", provider: "github" }, // a GitHub PAT — never an LLM key
];

describe("pickLlmCredential", () => {
  it("uses the project's pinned credential when it matches the run's provider", () => {
    expect(pickLlmCredential("claude", "cred-claude-biz", "cred-claude-personal", creds)).toBe("cred-claude-biz");
  });

  it("falls back to the agent's credential when the project pin is for a DIFFERENT provider", () => {
    // Project pinned a Claude key, but this run is Codex → don't cross providers.
    expect(pickLlmCredential("codex", "cred-claude-biz", "cred-codex-biz", creds)).toBe("cred-codex-biz");
  });

  it("falls back to the provider default when the project pin mismatches and the agent has no credential", () => {
    expect(pickLlmCredential("gemini", "cred-claude-biz", null, creds)).toBe("gemini");
  });

  it("ignores a pin whose id isn't a known credential", () => {
    expect(pickLlmCredential("claude", "cred-ghost", "cred-claude-personal", creds)).toBe("cred-claude-personal");
  });

  it("with no project pin, uses the agent credential, else the provider default", () => {
    expect(pickLlmCredential("claude", null, "cred-claude-personal", creds)).toBe("cred-claude-personal");
    expect(pickLlmCredential("claude", null, null, creds)).toBe("claude");
  });
});
