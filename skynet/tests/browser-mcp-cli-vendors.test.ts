// Browser tools for coding agents (MCP), extended from Claude-only to the CLI
// vendor runners. Each vendor wires spec.browser its own way — verified live
// against the real CLI (--help, and for Codex/Cursor a real invocation
// checked with `codex mcp list` / `cursor-agent mcp list`), not memory:
//   - Codex: no project-local config file — `-c mcp_servers.<name>.*=…`
//     per-invocation overrides (codex-cli 0.147.0).
//   - Gemini: file-based only — .gemini/settings.json's mcpServers key
//     (gemini-cli 0.55.1; `--help` has no config-override flag).
//   - Cursor: file-based (.cursor/mcp.json) + a one-time approval a headless
//     run can't satisfy interactively, granted via --approve-mcps instead of
//     the persistent, global `mcp enable` (cursor-agent 2026.06.19).
//   - Copilot: a real per-invocation flag, --additional-mcp-config <json>
//     (@github/copilot 1.0.80).
// Hermes is deliberately untouched — no evidence it supports MCP.
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codex } from "../packages/runner-sdk/src/codex.js";
import { gemini } from "../packages/runner-sdk/src/gemini.js";
import { cursorArgs } from "../packages/runner-sdk/src/cursor.js";
import { copilotArgs } from "../packages/runner-sdk/src/copilot.js";
import { BROWSER_MCP_NAME, mergeBrowserMcpConfig } from "../packages/runner-sdk/src/cli-runner.js";
import type { StartSpec } from "../packages/runner-sdk/src/types.js";

const spec = (over: Partial<StartSpec> = {}): StartSpec => ({
  runId: "r1",
  projectId: "p1",
  task: "reproduce the bug",
  model: "gpt-5.2-codex",
  branch: "agent/r1",
  ...over,
});

describe("Codex — browser MCP via -c overrides (no file ever written)", () => {
  it("adds mcp_servers.browser.command/.args when spec.browser is true", () => {
    const args = codex.buildArgs(spec({ browser: true }));
    expect(args).toContain("-c");
    const i = args.indexOf("mcp_servers.browser.command=\"npx\"");
    expect(i).toBeGreaterThan(-1);
    expect(args[i - 1]).toBe("-c");
    const argsIdx = args.findIndex((a) => a.startsWith("mcp_servers.browser.args="));
    expect(argsIdx).toBeGreaterThan(-1);
    expect(args[argsIdx]).toBe(
      'mcp_servers.browser.args=["-y","@playwright/mcp@latest","--headless","--isolated"]',
    );
    // The task prompt is still the trailing positional arg.
    expect(args[args.length - 1]).toBe("reproduce the bug");
  });

  it("adds nothing when spec.browser is false or unset — same argv as before this existed", () => {
    const withFalse = codex.buildArgs(spec({ browser: false }));
    const withUnset = codex.buildArgs(spec({}));
    expect(withFalse).toEqual(withUnset);
    expect(withFalse.join(" ")).not.toContain("mcp_servers");
  });
});

describe("Gemini — browser MCP via .gemini/settings.json (project-local worktree)", () => {
  let dir: string;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("writes mcpServers.browser into the worktree when spec.browser is true", () => {
    dir = mkdtempSync(join(tmpdir(), "skynet-gemini-mcp-"));
    gemini.prepareWorktree?.(spec({ browser: true }), dir);
    const written = JSON.parse(readFileSync(join(dir, ".gemini", "settings.json"), "utf8"));
    expect(written.mcpServers.browser).toEqual({
      command: "npx",
      args: ["-y", "@playwright/mcp@latest", "--headless", "--isolated"],
    });
  });

  it("merges onto an existing settings.json instead of clobbering it", () => {
    dir = mkdtempSync(join(tmpdir(), "skynet-gemini-mcp-"));
    mkdirSync(join(dir, ".gemini"), { recursive: true });
    writeFileSync(
      join(dir, ".gemini", "settings.json"),
      JSON.stringify({ theme: "dark", mcpServers: { other: { command: "foo", args: [] } } }),
    );
    gemini.prepareWorktree?.(spec({ browser: true }), dir);
    const written = JSON.parse(readFileSync(join(dir, ".gemini", "settings.json"), "utf8"));
    expect(written.theme).toBe("dark");
    expect(written.mcpServers.other).toEqual({ command: "foo", args: [] });
    expect(written.mcpServers.browser.command).toBe("npx");
  });

  it("writes nothing when spec.browser is false or unset", () => {
    dir = mkdtempSync(join(tmpdir(), "skynet-gemini-mcp-"));
    gemini.prepareWorktree?.(spec({ browser: false }), dir);
    expect(() => readFileSync(join(dir, ".gemini", "settings.json"), "utf8")).toThrow();
  });
});

describe("Cursor — browser MCP via .cursor/mcp.json + --approve-mcps", () => {
  it("cursorArgs adds --approve-mcps when spec.browser is true", () => {
    const args = cursorArgs(spec({ browser: true }), "do the task", undefined);
    expect(args).toContain("--approve-mcps");
  });

  it("cursorArgs adds nothing when spec.browser is false or unset", () => {
    const withFalse = cursorArgs(spec({ browser: false }), "do the task", undefined);
    const withUnset = cursorArgs(spec({}), "do the task", undefined);
    expect(withFalse).toEqual(withUnset);
    expect(withFalse).not.toContain("--approve-mcps");
  });

  it("the shared config merge (same one prepareBrowserMcp writes to .cursor/mcp.json) produces the right shape", () => {
    const merged = mergeBrowserMcpConfig({});
    expect((merged.mcpServers as Record<string, unknown>)[BROWSER_MCP_NAME]).toEqual({
      command: "npx",
      args: ["-y", "@playwright/mcp@latest", "--headless", "--isolated"],
    });
  });
});

describe("Copilot — browser MCP via --additional-mcp-config", () => {
  it("adds --additional-mcp-config with the mcpServers.browser shape when spec.browser is true", () => {
    const args = copilotArgs(spec({ browser: true }), "do the task", { resumeSession: false, primary: true });
    const i = args.indexOf("--additional-mcp-config");
    expect(i).toBeGreaterThan(-1);
    expect(JSON.parse(args[i + 1]!)).toEqual({
      mcpServers: { browser: { command: "npx", args: ["-y", "@playwright/mcp@latest", "--headless", "--isolated"] } },
    });
  });

  it("adds nothing when spec.browser is false or unset", () => {
    const withFalse = copilotArgs(spec({ browser: false }), "do the task", { resumeSession: false, primary: true });
    const withUnset = copilotArgs(spec({}), "do the task", { resumeSession: false, primary: true });
    expect(withFalse).toEqual(withUnset);
    expect(withFalse).not.toContain("--additional-mcp-config");
  });
});

describe("SKYNET_BROWSER_MCP_COMMAND override — same knob as claude.ts, applies to every vendor", () => {
  const ORIGINAL = process.env.SKYNET_BROWSER_MCP_COMMAND;
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.SKYNET_BROWSER_MCP_COMMAND;
    else process.env.SKYNET_BROWSER_MCP_COMMAND = ORIGINAL;
  });

  it("codex.buildArgs honors a pinned command", () => {
    process.env.SKYNET_BROWSER_MCP_COMMAND = "npx @playwright/mcp@0.1.2 --headless";
    const args = codex.buildArgs(spec({ browser: true }));
    expect(args).toContain('mcp_servers.browser.command="npx"');
    expect(args).toContain('mcp_servers.browser.args=["@playwright/mcp@0.1.2","--headless"]');
  });
});
