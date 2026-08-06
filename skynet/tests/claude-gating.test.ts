// Regression for the no-over-gating fix: the Claude runner must not raise a
// blocking mid-run approval for trivial file edits (a one-word comment fix
// shouldn't pause for sign-off) — edits are reviewed wholesale in the end-of-run
// diff review. The genuinely risky/irreversible surface (shell + unknown tools)
// must still gate. Mirrors eval scenarios `no-over-gating` and `risky-command-gate`.
import { describe, it, expect, afterEach } from "vitest";
import { isAutoAllowed, browserMcpServers } from "../packages/runner-sdk/src/claude.js";

describe("Claude runner tool-gating policy", () => {
  it("auto-allows read-only tools and file edits (no per-edit approval)", () => {
    for (const t of [
      "Read", "LS", "Glob", "Grep", "NotebookRead", "TodoWrite",
      "Edit", "MultiEdit", "Write", "NotebookEdit",
    ]) {
      expect(isAutoAllowed(t)).toBe(true);
    }
  });

  it("gates shell commands and unrecognized tools", () => {
    expect(isAutoAllowed("Bash")).toBe(false); // risky/irreversible — must gate
    expect(isAutoAllowed("SomeFutureTool")).toBe(false); // fail closed on unknown
  });

  it("gates browser (Playwright MCP) tools — nav/click ride the normal HITL gate", () => {
    // MCP tools arrive as `mcp__<server>__<tool>`; none are in AUTO_ALLOW, so they
    // fall through to the approval gate like any other non-read action.
    for (const t of ["mcp__browser__browser_navigate", "mcp__browser__browser_click"]) {
      expect(isAutoAllowed(t)).toBe(false);
    }
  });
});

describe("browser MCP opt-in wiring", () => {
  afterEach(() => {
    delete process.env.SKYNET_BROWSER_MCP_COMMAND;
  });

  it("is off by default — no MCP server unless the run opts in", () => {
    expect(browserMcpServers(false)).toBeUndefined();
  });

  it("hands the SDK a headless Playwright server when enabled", () => {
    const servers = browserMcpServers(true)!;
    expect(servers).toBeDefined();
    expect(servers.browser).toEqual({
      command: "npx",
      args: ["-y", "@playwright/mcp@latest", "--headless", "--isolated"],
    });
  });

  it("honours SKYNET_BROWSER_MCP_COMMAND to pin/override the launch command", () => {
    process.env.SKYNET_BROWSER_MCP_COMMAND = "node ./mcp.js --port 0";
    expect(browserMcpServers(true)!.browser).toEqual({
      command: "node",
      args: ["./mcp.js", "--port", "0"],
    });
  });
});
