// ─── MCP server service ───────────────────────────────────────────────────
// Workspace-scoped custom MCP server configs — the "scoped tools" an operator
// gives an agent to act back into their own services (roadmap "Tools via
// MCP"). The ONLY component that sees plaintext secrets: it seals the env/
// header values on write and opens them on read for runner injection. The API
// layer can create/list/delete but never read a value back — list returns
// metadata only (key NAMES, never values, same "safe to show" precedent as
// SecretMeta.last4).

import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import type { CreateMcpServerRequest, McpServerMeta } from "@skynet/shared";
import type { McpServerSpec } from "@skynet/runner-sdk";
import { RESERVED_MCP_NAMES } from "@skynet/runner-sdk";
import { config } from "../config.js";
import { masterKey, open, seal } from "../secrets/crypto.js";
import { MemoryMcpServerStore } from "./memory.js";
import { FileMcpServerStore } from "./file.js";
import { PostgresMcpServerStore } from "./postgres.js";
import type { McpServerRecord, McpServerStore } from "./types.js";

export class McpServersDisabledError extends Error {
  constructor() {
    super("Secret store is disabled — set SKYNET_MASTER_KEY (32 bytes, base64) to enable it");
    this.name = "McpServersDisabledError";
  }
}

export class UnknownMcpServerError extends Error {
  constructor(id: string) {
    super(`Unknown MCP server "${id}"`);
    this.name = "UnknownMcpServerError";
  }
}

export class ReservedMcpServerNameError extends Error {
  constructor(name: string) {
    super(`"${name}" is reserved (used internally for browser tooling or the manager's spawn_worker tool) — pick a different name.`);
    this.name = "ReservedMcpServerNameError";
  }
}

const toMeta = (r: McpServerRecord): McpServerMeta => ({
  id: r.id,
  workspaceId: r.workspaceId,
  name: r.name,
  transport: r.transport,
  command: r.command,
  args: r.args,
  envKeys: r.envKeys,
  url: r.url,
  headerKeys: r.headerKeys,
  updatedAt: r.updatedAt,
  updatedBy: r.updatedBy,
});

export class McpServerService {
  constructor(private store: McpServerStore) {}

  /** True once a master key is configured (the feature is usable) — reuses
   *  the same key/crypto as ../secrets, so both features are enabled/disabled
   *  together by the same SKYNET_MASTER_KEY. */
  get enabled(): boolean {
    return masterKey() !== null;
  }

  async create(workspaceId: string, req: CreateMcpServerRequest, operatorId: string, at: number): Promise<McpServerMeta> {
    if (RESERVED_MCP_NAMES.has(req.name)) throw new ReservedMcpServerNameError(req.name);
    const key = masterKey();
    if (!key) throw new McpServersDisabledError();
    const id = `mcp-${req.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 24)}-${randomUUID().slice(0, 8)}`;
    const record: McpServerRecord =
      req.transport === "remote"
        ? {
            id, workspaceId, name: req.name, transport: "remote", command: "", args: [], url: req.url,
            envKeys: [], headerKeys: Object.keys(req.headers),
            specCiphertext: seal(JSON.stringify({ headers: req.headers }), key),
            updatedAt: at, updatedBy: operatorId,
          }
        : {
            id, workspaceId, name: req.name, transport: "stdio", command: req.command, args: req.args, url: "",
            envKeys: Object.keys(req.env), headerKeys: [],
            specCiphertext: seal(JSON.stringify({ env: req.env }), key),
            updatedAt: at, updatedBy: operatorId,
          };
    await this.store.put(record);
    return toMeta(record);
  }

  /** Metadata for every custom MCP server in the workspace (never secret values). */
  async list(workspaceId: string): Promise<McpServerMeta[]> {
    return (await this.store.list(workspaceId)).map(toMeta);
  }

  async delete(workspaceId: string, id: string): Promise<void> {
    await this.store.delete(workspaceId, id);
  }

  /**
   * Decrypt one server's spec for runner injection — server-internal only,
   * never exposed over the API. Returns undefined when disabled/absent, or
   * when the stored ciphertext fails to decrypt (tampered, or the master key
   * rotated) — logged, not thrown, so a bad record degrades a run to "one
   * fewer tool" rather than blocking it from starting at all.
   */
  async resolve(workspaceId: string, id: string): Promise<McpServerSpec | undefined> {
    const key = masterKey();
    if (!key) return undefined;
    const record = await this.store.get(workspaceId, id);
    if (!record) return undefined;
    try {
      const secret = JSON.parse(open(record.specCiphertext, key)) as { env?: Record<string, string>; headers?: Record<string, string> };
      return record.transport === "remote"
        ? { name: record.name, transport: "remote", url: record.url, ...(secret.headers && Object.keys(secret.headers).length ? { headers: secret.headers } : {}) }
        : { name: record.name, transport: "stdio", command: record.command, args: record.args, ...(secret.env && Object.keys(secret.env).length ? { env: secret.env } : {}) };
    } catch {
      console.warn(`[mcp-servers] stored server "${id}" for workspace "${workspaceId}" failed to decrypt (wrong/rotated SKYNET_MASTER_KEY?) — skipping it for this run.`);
      return undefined;
    }
  }

  /** Resolve a project's `mcpServerIds` into concrete specs for the
   *  orchestrator to hand a runner — skips (and logs) any id that fails to
   *  resolve rather than throwing, so a deleted/undecryptable server never
   *  blocks a run from starting. */
  async resolveMany(workspaceId: string, ids: string[]): Promise<McpServerSpec[]> {
    const resolved = await Promise.all(ids.map((id) => this.resolve(workspaceId, id)));
    return resolved.filter((s): s is McpServerSpec => s !== undefined);
  }
}

function makeStore(): McpServerStore {
  if (config.store === "postgres" && config.databaseUrl) return new PostgresMcpServerStore(config.databaseUrl);
  // STORE=file: persist custom MCP server configs durably too, same as
  // secrets/service.ts's makeStore() does for provider credentials.
  if (config.store === "file") {
    const path = config.mcpServersPath || join(dirname(config.dbPath), "skynet-mcp-servers.json");
    return FileMcpServerStore.create(path);
  }
  return new MemoryMcpServerStore();
}

/** Process-wide singleton, configured from the environment. */
export const mcpServerService = new McpServerService(makeStore());
