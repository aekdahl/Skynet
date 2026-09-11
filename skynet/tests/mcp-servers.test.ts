// Custom MCP servers (roadmap "Tools via MCP"): the "scoped tools" store an
// operator uses to give an agent a GitHub/Sentry/Slack (or any) MCP server to
// act back into their own services. Same envelope-encryption trust model as
// ../apps/server/src/secrets — see tests/credentials.test.ts for that pattern,
// mirrored here.
process.env.SKYNET_MASTER_KEY = Buffer.alloc(32, 9).toString("base64");

import { describe, it, expect, beforeEach } from "vitest";
import { McpServerService, ReservedMcpServerNameError } from "../apps/server/src/mcp-servers/service.js";
import { MemoryMcpServerStore } from "../apps/server/src/mcp-servers/memory.js";

describe("custom MCP server store", () => {
  let svc: McpServerService;
  beforeEach(() => {
    svc = new McpServerService(new MemoryMcpServerStore());
  });

  it("a stdio server round-trips through create/list/resolve/delete — metadata never carries the env value", async () => {
    const meta = await svc.create(
      "w",
      { transport: "stdio", name: "Sentry", command: "npx", args: ["-y", "@sentry/mcp-server"], env: { SENTRY_AUTH_TOKEN: "tok_123" } },
      "op",
      1,
    );
    expect(meta).toMatchObject({ name: "Sentry", transport: "stdio", command: "npx", args: ["-y", "@sentry/mcp-server"], envKeys: ["SENTRY_AUTH_TOKEN"] });
    expect(JSON.stringify(meta)).not.toContain("tok_123");

    const list = await svc.list("w");
    expect(list).toHaveLength(1);
    expect(JSON.stringify(list)).not.toContain("tok_123");

    const resolved = await svc.resolve("w", meta.id);
    expect(resolved).toEqual({ name: "Sentry", transport: "stdio", command: "npx", args: ["-y", "@sentry/mcp-server"], env: { SENTRY_AUTH_TOKEN: "tok_123" } });

    await svc.delete("w", meta.id);
    expect(await svc.resolve("w", meta.id)).toBeUndefined();
  });

  it("a remote server round-trips through create/list/resolve — headers never leak into metadata", async () => {
    const meta = await svc.create(
      "w",
      { transport: "remote", name: "Sentry remote", url: "https://mcp.sentry.dev/mcp", headers: { Authorization: "Bearer tok_456" } },
      "op",
      1,
    );
    expect(meta).toMatchObject({ name: "Sentry remote", transport: "remote", url: "https://mcp.sentry.dev/mcp", headerKeys: ["Authorization"] });
    expect(JSON.stringify(meta)).not.toContain("tok_456");

    const resolved = await svc.resolve("w", meta.id);
    expect(resolved).toEqual({ name: "Sentry remote", transport: "remote", url: "https://mcp.sentry.dev/mcp", headers: { Authorization: "Bearer tok_456" } });
  });

  it("rejects a reserved name (browser, skynet-manager)", async () => {
    await expect(svc.create("w", { transport: "stdio", name: "browser", command: "evil", args: [], env: {} }, "op", 1)).rejects.toBeInstanceOf(
      ReservedMcpServerNameError,
    );
    await expect(svc.create("w", { transport: "stdio", name: "skynet-manager", command: "evil", args: [], env: {} }, "op", 1)).rejects.toBeInstanceOf(
      ReservedMcpServerNameError,
    );
  });

  it("resolveMany skips (doesn't throw on) a stale/deleted id, so a run degrades to fewer tools instead of failing to start", async () => {
    const meta = await svc.create("w", { transport: "stdio", name: "Sentry", command: "npx", args: [], env: {} }, "op", 1);
    const resolved = await svc.resolveMany("w", [meta.id, "mcp-does-not-exist"]);
    expect(resolved).toHaveLength(1);
    expect(resolved[0]).toMatchObject({ name: "Sentry" });
  });

  it("two workspaces' servers stay isolated", async () => {
    await svc.create("w1", { transport: "stdio", name: "A", command: "npx", args: [], env: {} }, "op", 1);
    await svc.create("w2", { transport: "stdio", name: "B", command: "npx", args: [], env: {} }, "op", 1);
    expect((await svc.list("w1")).map((s) => s.name)).toEqual(["A"]);
    expect((await svc.list("w2")).map((s) => s.name)).toEqual(["B"]);
  });
});
