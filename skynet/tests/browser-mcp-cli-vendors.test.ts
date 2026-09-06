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
import { BROWSER_MCP_NAME, mergeMcpConfig, userMcpServerEntries } from "../packages/runner-sdk/src/cli-runner.js";
import type { McpServerSpec, StartSpec } from "../packages/runner-sdk/src/types.js";

const spec = (over: Partial<StartSpec> = {}): StartSpec => ({
  runId: "r1",
  projectId: "p1",
  task: "reproduce the bug",
  model: "gpt-5.2-codex",
  branch: "agent/r1",
  ...over,
});

const STDIO_SERVER: McpServerSpec = {
  name: "sentry",
  transport: "stdio",
  command: "npx",
  args: ["-y", "@sentry/mcp-server"],
  env: { SENTRY_AUTH_TOKEN: "tok_123" },
};
const REMOTE_SERVER: McpServerSpec = {
  name: "sentry-remote",
  transport: "remote",
  url: "https://mcp.sentry.dev/mcp",
  headers: { Authorization: "Bearer tok_456" },
};

describe("userMcpServerEntries/mergeMcpConfig — shared plumbing every vendor builds on", () => {
  it("maps a stdio server to {command,args,env}", () => {
    expect(userMcpServerEntries(spec({ mcpServers: [STDIO_SERVER] }))).toEqual({
      sentry: { command: "npx", args: ["-y", "@sentry/mcp-server"], env: { SENTRY_AUTH_TOKEN: "tok_123" } },
    });
  });

  it("maps a remote server to {type:'http',url,headers}", () => {
    expect(userMcpServerEntries(spec({ mcpServers: [REMOTE_SERVER] }))).toEqual({
      "sentry-remote": { type: "http", url: "https://mcp.sentry.dev/mcp", headers: { Authorization: "Bearer tok_456" } },
    });
  });

  it("skips a reserved name (browser, skynet-manager) defensively", () => {
    const reserved: McpServerSpec = { name: "browser", transport: "stdio", command: "evil", args: [] };
    expect(userMcpServerEntries(spec({ mcpServers: [reserved, STDIO_SERVER] }))).toEqual({
      sentry: { command: "npx", args: ["-y", "@sentry/mcp-server"], env: { SENTRY_AUTH_TOKEN: "tok_123" } },
    });
  });

  it("mergeMcpConfig combines the browser server AND user-configured servers, preserving existing config", () => {
    const merged = mergeMcpConfig({ theme: "dark" }, spec({ browser: true, mcpServers: [STDIO_SERVER] }));
    expect(merged.theme).toBe("dark");
    const servers = merged.mcpServers as Record<string, unknown>;
    expect(servers[BROWSER_MCP_NAME]).toEqual({ command: "npx", args: ["-y", "@playwright/mcp@latest", "--headless", "--isolated"] });
    expect(servers.sentry).toEqual({ command: "npx", args: ["-y", "@sentry/mcp-server"], env: { SENTRY_AUTH_TOKEN: "tok_123" } });
  });

  it("mergeMcpConfig with no browser and no user servers still returns an (empty) mcpServers key", () => {
    const merged = mergeMcpConfig({}, spec({}));
    expect(merged.mcpServers).toEqual({});
  });
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

  it("a user-configured stdio server gets .command/.args/.env.<KEY> overrides — verified live against codex-cli 0.147.0's dotted-key TOML syntax", () => {
    const args = codex.buildArgs(spec({ mcpServers: [STDIO_SERVER] }));
    expect(args).toContain('mcp_servers.sentry.command="npx"');
    expect(args).toContain('mcp_servers.sentry.args=["-y","@sentry/mcp-server"]');
    expect(args).toContain('mcp_servers.sentry.env.SENTRY_AUTH_TOKEN="tok_123"');
  });

  it("a user-configured remote server gets .url + .bearer_token_env_var, and the token rides the child env (not inline) — verified live against `codex mcp add --url/--bearer-token-env-var`", () => {
    const args = codex.buildArgs(spec({ mcpServers: [REMOTE_SERVER] }));
    expect(args).toContain('mcp_servers.sentry-remote.url="https://mcp.sentry.dev/mcp"');
    const bearerIdx = args.findIndex((a) => a.startsWith("mcp_servers.sentry-remote.bearer_token_env_var="));
    expect(bearerIdx).toBeGreaterThan(-1);
    const envVarName = JSON.parse(args[bearerIdx]!.split("=").slice(1).join("="));
    const env = codex.env!(spec({ mcpServers: [REMOTE_SERVER] }));
    expect(env[envVarName]).toBe("tok_456");
  });

  it("a remote server with no Authorization header gets .url but no bearer_token_env_var", () => {
    const noAuth: McpServerSpec = { name: "public", transport: "remote", url: "https://example.com/mcp" };
    const args = codex.buildArgs(spec({ mcpServers: [noAuth] }));
    expect(args).toContain('mcp_servers.public.url="https://example.com/mcp"');
    expect(args.join(" ")).not.toContain("bearer_token_env_var");
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

  it("writes a user-configured server even with browser off (best-effort — not independently verified against gemini-cli's own MCP schema)", () => {
    dir = mkdtempSync(join(tmpdir(), "skynet-gemini-mcp-"));
    gemini.prepareWorktree?.(spec({ mcpServers: [STDIO_SERVER] }), dir);
    const written = JSON.parse(readFileSync(join(dir, ".gemini", "settings.json"), "utf8"));
    expect(written.mcpServers.sentry).toEqual({ command: "npx", args: ["-y", "@sentry/mcp-server"], env: { SENTRY_AUTH_TOKEN: "tok_123" } });
    expect(written.mcpServers.browser).toBeUndefined();
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

  it("the shared config merge (same one prepareMcp writes to .cursor/mcp.json) produces the right shape", () => {
    const merged = mergeMcpConfig({}, spec({ browser: true }));
    expect((merged.mcpServers as Record<string, unknown>)[BROWSER_MCP_NAME]).toEqual({
      command: "npx",
      args: ["-y", "@playwright/mcp@latest", "--headless", "--isolated"],
    });
  });

  it("cursorArgs also adds --approve-mcps for a user-configured server with no browser tooling", () => {
    const args = cursorArgs(spec({ mcpServers: [STDIO_SERVER] }), "do the task", undefined);
    expect(args).toContain("--approve-mcps");
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

  it("merges browser tooling AND a user-configured server into the same --additional-mcp-config flag", () => {
    const args = copilotArgs(spec({ browser: true, mcpServers: [STDIO_SERVER] }), "do the task", { resumeSession: false, primary: true });
    const i = args.indexOf("--additional-mcp-config");
    const parsed = JSON.parse(args[i + 1]!);
    expect(parsed.mcpServers.browser).toEqual({ command: "npx", args: ["-y", "@playwright/mcp@latest", "--headless", "--isolated"] });
    expect(parsed.mcpServers.sentry).toEqual({ command: "npx", args: ["-y", "@sentry/mcp-server"], env: { SENTRY_AUTH_TOKEN: "tok_123" } });
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
